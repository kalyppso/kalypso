//! Docker and Podman (and anything else speaking the Docker API: OrbStack,
//! Colima). Podman is driven through its Docker-compatible API, so one code
//! path serves both.

use std::collections::HashMap;
#[cfg(unix)]
use std::path::PathBuf;

use async_trait::async_trait;
use bollard::container::{
    Config, CreateContainerOptions, InspectContainerOptions, LogOutput, RemoveContainerOptions, StartContainerOptions, StopContainerOptions,
};
use bollard::exec::{CreateExecOptions, ResizeExecOptions, StartExecOptions, StartExecResults};
use bollard::image::CreateImageOptions;
use bollard::models::{HostConfig, Mount, MountTypeEnum};
use bollard::network::CreateNetworkOptions;
use bollard::system::EventsOptions;
use bollard::Docker;
use futures_util::stream::BoxStream;
use futures_util::{StreamExt, TryStreamExt};

use super::provider::{ExecStream, ProviderInfo, SandboxProvider};
use super::{NewSandbox, SandboxStatusEvent};
use crate::error::{KalypsoError, Result};

/// KALYPSO's own commands (secret delivery, port forwards) run as root inside the
/// sandbox, whatever user the image defaults to. Capabilities stay dropped.
const EXEC_USER: &str = "0";

pub struct OciProvider {
    docker: Docker,
    kind: &'static str,
    /// The engine runs in a VM (Docker Desktop, Podman machine), so sandboxes can't
    /// mount the host's gateway socket and reach it through the relay instead.
    vm: bool,
    /// One relay change at a time per provider (creating it twice would conflict).
    relay_lock: tokio::sync::Mutex<()>,
}

/// The gateway relay: one small container per namespace that forwards sandbox traffic to
/// the host's sandbox gateway port. Pinned, so it can't change under us.
pub const RELAY_IMAGE: &str = "docker.io/alpine/socat:1.8.0.3";
const RELAY_PORT: u16 = 8080;

impl OciProvider {
    /// Find a reachable engine: `DOCKER_HOST` first, then the usual places Docker,
    /// Podman, OrbStack and Colima put their sockets (named pipes on Windows).
    pub async fn detect() -> Option<Self> {
        for (endpoint, kind) in candidates().await {
            let Some(docker) = connect(&endpoint) else { continue };
            if docker.ping().await.is_ok() {
                let vm = runs_in_vm(&docker).await;
                tracing::info!(kind, endpoint, vm, "container runtime connected");
                return Some(Self { docker, kind, vm, relay_lock: tokio::sync::Mutex::new(()) });
            }
        }
        None
    }

    pub fn docker(&self) -> &Docker {
        &self.docker
    }

    /// The host port sandboxes reach through the relay, when this engine needs one.
    fn relay(&self) -> Option<u16> {
        if self.vm || crate::gateway::socket_dir().is_none() {
            crate::gateway::sandbox_port()
        } else {
            None
        }
    }

    /// Make sure the namespace's relay runs and forwards to `port`, and is on every
    /// sandbox gateway network of the namespace (a recreated relay must rejoin them).
    async fn ensure_relay(&self, ns: &str, port: u16) -> Result<()> {
        let _guard = self.relay_lock.lock().await;
        let name = relay_name(ns);
        let current = match self.docker.inspect_container(&name, None::<InspectContainerOptions>).await {
            Ok(info) => Some(info),
            Err(bollard::errors::Error::DockerResponseServerError { status_code: 404, .. }) => None,
            Err(e) => return Err(rt_err(e)),
        };
        let same_port = current
            .as_ref()
            .and_then(|i| i.config.as_ref()?.labels.as_ref()?.get("kalypso.gw_port").cloned())
            .is_some_and(|p| p == port.to_string());
        let mut fresh = false;
        match current {
            Some(info) if same_port => {
                if info.state.and_then(|s| s.running) != Some(true) {
                    self.docker.start_container(&name, None::<StartContainerOptions<String>>).await.map_err(rt_err)?;
                }
            }
            other => {
                if other.is_some() {
                    let opts = Some(RemoveContainerOptions { force: true, ..Default::default() });
                    self.docker.remove_container(&name, opts).await.map_err(rt_err)?;
                }
                self.pull(RELAY_IMAGE).await?;
                let labels = HashMap::from([
                    ("kalypso.ns".to_string(), ns.to_string()),
                    ("kalypso.role".to_string(), "gateway-relay".to_string()),
                    ("kalypso.gw_port".to_string(), port.to_string()),
                ]);
                let host = |limits: bool| HostConfig {
                    // Out to the host only; sandboxes come in over their own internal networks.
                    network_mode: Some("bridge".into()),
                    extra_hosts: Some(vec!["host.kalypso:host-gateway".into()]),
                    readonly_rootfs: Some(true),
                    cap_drop: Some(vec!["ALL".into()]),
                    security_opt: Some(vec!["no-new-privileges".into()]),
                    memory: limits.then_some(32 * 1024 * 1024),
                    pids_limit: limits.then_some(128),
                    restart_policy: Some(bollard::models::RestartPolicy {
                        name: Some(bollard::models::RestartPolicyNameEnum::UNLESS_STOPPED),
                        maximum_retry_count: None,
                    }),
                    ..Default::default()
                };
                let config = |limits: bool| Config {
                    image: Some(RELAY_IMAGE.to_string()),
                    cmd: Some(vec![format!("TCP-LISTEN:{RELAY_PORT},fork,reuseaddr,max-children=128"), format!("TCP:host.kalypso:{port}")]),
                    labels: Some(labels.clone()),
                    host_config: Some(host(limits)),
                    ..Default::default()
                };
                let opts = || Some(CreateContainerOptions { name: name.clone(), platform: None });
                match self.docker.create_container(opts(), config(true)).await {
                    Ok(_) => {}
                    Err(e) if e.to_string().contains("cgroup") => {
                        self.docker.create_container(opts(), config(false)).await.map_err(rt_err)?;
                    }
                    Err(e) => return Err(rt_err(e)),
                }
                self.docker.start_container(&name, None::<StartContainerOptions<String>>).await.map_err(rt_err)?;
                fresh = true;
                tracing::info!(ns, port, "gateway relay started");
            }
        }
        if fresh {
            let filters = HashMap::from([("label".to_string(), vec![format!("kalypso.gw={ns}")])]);
            let nets = self.docker.list_networks(Some(bollard::network::ListNetworksOptions { filters })).await.map_err(rt_err)?;
            for n in nets.into_iter().filter_map(|n| n.name) {
                self.join_relay(ns, &n).await?;
            }
        }
        Ok(())
    }

    /// Put the relay on a sandbox's gateway network, as `gateway.kalypso`.
    async fn join_relay(&self, ns: &str, net: &str) -> Result<()> {
        let config = bollard::network::ConnectNetworkOptions {
            container: relay_name(ns),
            endpoint_config: bollard::models::EndpointSettings { aliases: Some(vec!["gateway.kalypso".into()]), ..Default::default() },
        };
        match self.docker.connect_network(net, config).await {
            Ok(()) => Ok(()),
            // Already on it.
            Err(e) if e.to_string().contains("already") || e.to_string().contains("exists") => Ok(()),
            Err(e) => Err(rt_err(e)),
        }
    }

    async fn pull(&self, image: &str) -> Result<()> {
        if self.docker.inspect_image(image).await.is_ok() {
            return Ok(());
        }
        tracing::info!(image, "pulling image");
        self.docker
            .create_image(Some(CreateImageOptions { from_image: image, ..Default::default() }), None, None)
            .try_collect::<Vec<_>>()
            .await
            .map_err(rt_err)?;
        Ok(())
    }
}

#[async_trait]
impl SandboxProvider for OciProvider {
    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            kind: self.kind.into(),
            label: if self.kind == "podman" { "Podman" } else { "Docker" }.into(),
            isolation: "container".into(),
            network_modes: vec!["isolated".into(), "namespace".into(), "internet".into()],
            resource_limits: true,
            remote: false,
        }
    }

    // Sandboxes made through Docker keep working under Podman and vice versa.
    fn handles(&self, kind: &str) -> bool {
        kind == "docker" || kind == "podman"
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    /// The namespace's internal network: sandboxes on it can reach each other but nothing else.
    async fn prepare_namespace(&self, ns: &str) -> Result<()> {
        let name = network_name(ns);
        if self.docker.inspect_network::<String>(&name, None).await.is_ok() {
            return Ok(());
        }
        self.docker
            .create_network(CreateNetworkOptions {
                name: name.clone(),
                driver: "bridge".into(),
                internal: true,
                labels: HashMap::from([("kalypso.ns".to_string(), ns.to_string())]),
                ..Default::default()
            })
            .await
            .map_err(rt_err)?;
        Ok(())
    }

    async fn teardown_namespace(&self, ns: &str) -> Result<()> {
        let opts = Some(RemoveContainerOptions { force: true, ..Default::default() });
        match self.docker.remove_container(&relay_name(ns), opts).await {
            Ok(()) | Err(bollard::errors::Error::DockerResponseServerError { status_code: 404, .. }) => {}
            Err(e) => return Err(rt_err(e)),
        }
        match self.docker.remove_network(&network_name(ns)).await {
            Ok(()) => Ok(()),
            Err(bollard::errors::Error::DockerResponseServerError { status_code: 404, .. }) => Ok(()),
            Err(e) => Err(rt_err(e)),
        }
    }

    async fn create(&self, ns: &str, id: &str, spec: &NewSandbox) -> Result<String> {
        self.pull(&spec.image).await?;
        // VM engines: a private internal network per sandbox, shared only with the
        // namespace's relay, is how it reaches the gateway in every network mode.
        let relay = self.relay();
        let gw_net = gateway_network_name(ns, id);
        if relay.is_some() {
            self.docker
                .create_network(CreateNetworkOptions {
                    name: gw_net.clone(),
                    driver: "bridge".into(),
                    internal: true,
                    labels: HashMap::from([
                        ("kalypso.ns".to_string(), ns.to_string()),
                        ("kalypso.gw".to_string(), ns.to_string()),
                        ("kalypso.sandbox".to_string(), id.to_string()),
                    ]),
                    ..Default::default()
                })
                .await
                .map_err(rt_err)?;
        }
        let network_mode = match spec.network.as_str() {
            // No network at all, except the relay on VM engines.
            "isolated" if relay.is_some() => gw_net.clone(),
            "isolated" => "none".to_string(),
            "namespace" => {
                self.prepare_namespace(ns).await?;
                network_name(ns)
            }
            // TODO(#33): route through the egress proxy with the namespace allow-list.
            _ => "bridge".to_string(),
        };
        let labels = HashMap::from([("kalypso.ns".to_string(), ns.to_string()), ("kalypso.sandbox".to_string(), id.to_string())]);
        // Anonymous volume: removed together with the container.
        let mut mounts = vec![Mount { target: Some("/work".into()), typ: Some(MountTypeEnum::VOLUME), ..Default::default() }];
        // The model gateway's socket: the only way out to a model, whatever the network mode.
        // A local engine sees the host's files; a VM-backed one (Docker Desktop) cannot pass sockets.
        if let Some(dir) = crate::gateway::socket_dir().filter(|_| relay.is_none()) {
            mounts.push(Mount {
                source: Some(dir.display().to_string()),
                target: Some(crate::gateway::SANDBOX_SOCKET_DIR.into()),
                typ: Some(MountTypeEnum::BIND),
                read_only: Some(true),
                ..Default::default()
            });
        }
        let host = |limits: bool| HostConfig {
            // A tiny init as PID 1 so stop signals are handled and containers stop promptly.
            init: Some(true),
            readonly_rootfs: Some(true),
            cap_drop: Some(vec!["ALL".into()]),
            security_opt: Some(vec!["no-new-privileges".into()]),
            network_mode: Some(network_mode.clone()),
            nano_cpus: limits.then_some((spec.cpu * 1e9) as i64),
            memory: limits.then(|| spec.mem_mb * 1024 * 1024),
            tmpfs: Some(HashMap::from([
                ("/tmp".to_string(), "rw,size=256m".to_string()),
                ("/run/kalypso/secrets".to_string(), "rw,size=1m,mode=0700".to_string()),
            ])),
            mounts: Some(mounts.clone()),
            ..Default::default()
        };
        let config = |limits: bool| Config {
            image: Some(spec.image.clone()),
            // Idle until KALYPSO execs into it, whatever the image would run by default.
            entrypoint: Some(vec!["sleep".to_string()]),
            cmd: Some(vec!["infinity".to_string()]),
            working_dir: Some("/work".into()),
            labels: Some(labels.clone()),
            env: relay.map(|_| vec![format!("KALYPSO_GATEWAY_URL={}", crate::gateway::RELAY_URL)]),
            host_config: Some(host(limits)),
            ..Default::default()
        };
        let opts = || Some(CreateContainerOptions { name: container_name(ns, id), platform: None });
        let created = match self.docker.create_container(opts(), config(true)).await {
            Ok(r) => r,
            // Rootless engines without cgroup delegation reject resource limits.
            Err(e) if e.to_string().contains("cgroup") => {
                tracing::warn!(error = %e, "resource limits unsupported here; creating without them");
                self.docker.create_container(opts(), config(false)).await.map_err(rt_err)?
            }
            Err(e) => return Err(rt_err(e)),
        };
        if let Some(port) = relay {
            self.ensure_relay(ns, port).await?;
            self.join_relay(ns, &gw_net).await?;
            if network_mode != gw_net {
                let config =
                    bollard::network::ConnectNetworkOptions { container: container_name(ns, id), endpoint_config: Default::default() };
                self.docker.connect_network(&gw_net, config).await.map_err(rt_err)?;
            }
        }
        Ok(created.id)
    }

    async fn start(&self, ns: &str, id: &str) -> Result<()> {
        // The relay may be gone (engine restarted, KALYPSO on a new port): bring it back first.
        if let Some(port) = self.relay() {
            self.ensure_relay(ns, port).await?;
        }
        self.docker.start_container(&container_name(ns, id), None::<StartContainerOptions<String>>).await.map_err(rt_err)
    }

    async fn resume(&self, ns: &str, id: &str) -> Result<()> {
        self.docker.unpause_container(&container_name(ns, id)).await.map_err(rt_err)
    }

    async fn pause(&self, ns: &str, id: &str) -> Result<()> {
        self.docker.pause_container(&container_name(ns, id)).await.map_err(rt_err)
    }

    async fn stop(&self, ns: &str, id: &str) -> Result<()> {
        self.docker.stop_container(&container_name(ns, id), Some(StopContainerOptions { t: 5 })).await.map_err(rt_err)
    }

    async fn remove(&self, ns: &str, id: &str) -> Result<()> {
        let opts = Some(RemoveContainerOptions { force: true, v: true, ..Default::default() });
        match self.docker.remove_container(&container_name(ns, id), opts).await {
            Ok(()) | Err(bollard::errors::Error::DockerResponseServerError { status_code: 404, .. }) => {}
            Err(e) => return Err(rt_err(e)),
        }
        // Its gateway network, if it had one: take the relay off it, then remove it.
        let net = gateway_network_name(ns, id);
        if self.docker.inspect_network::<String>(&net, None).await.is_ok() {
            let leave = bollard::network::DisconnectNetworkOptions { container: relay_name(ns), force: true };
            let _ = self.docker.disconnect_network(&net, leave).await;
            match self.docker.remove_network(&net).await {
                Ok(()) | Err(bollard::errors::Error::DockerResponseServerError { status_code: 404, .. }) => {}
                Err(e) => tracing::warn!(network = net, error = %e, "could not remove a sandbox gateway network"),
            }
        }
        Ok(())
    }

    async fn status(&self, ns: &str, id: &str) -> Result<&'static str> {
        let info = self.docker.inspect_container(&container_name(ns, id), None::<InspectContainerOptions>).await.map_err(rt_err)?;
        let state = info.state.unwrap_or_default();
        Ok(if state.paused == Some(true) {
            "paused"
        } else if state.running == Some(true) {
            "running"
        } else {
            "stopped"
        })
    }

    async fn exec(&self, ns: &str, id: &str, cmd: &[&str], detach: bool) -> Result<(i64, String)> {
        let created = self
            .docker
            .create_exec(
                &container_name(ns, id),
                CreateExecOptions {
                    cmd: Some(cmd.to_vec()),
                    user: Some(EXEC_USER),
                    attach_stdout: Some(!detach),
                    attach_stderr: Some(!detach),
                    ..Default::default()
                },
            )
            .await
            .map_err(rt_err)?;
        let mut out = String::new();
        match self.docker.start_exec(&created.id, Some(StartExecOptions { detach, ..Default::default() })).await.map_err(rt_err)? {
            StartExecResults::Attached { mut output, .. } => {
                while let Some(chunk) = output.next().await {
                    out.push_str(&chunk.map_err(rt_err)?.to_string());
                }
            }
            StartExecResults::Detached => return Ok((0, out)),
        }
        let code = self.docker.inspect_exec(&created.id).await.map_err(rt_err)?.exit_code.unwrap_or(-1);
        Ok((code, out))
    }

    async fn exec_with_stdin(&self, ns: &str, id: &str, cmd: &[&str], input: &[u8]) -> Result<i64> {
        use tokio::io::AsyncWriteExt;
        let created = self
            .docker
            .create_exec(
                &container_name(ns, id),
                CreateExecOptions {
                    cmd: Some(cmd.to_vec()),
                    user: Some(EXEC_USER),
                    attach_stdin: Some(true),
                    attach_stdout: Some(true),
                    attach_stderr: Some(true),
                    ..Default::default()
                },
            )
            .await
            .map_err(rt_err)?;
        match self.docker.start_exec(&created.id, None).await.map_err(rt_err)? {
            StartExecResults::Attached { mut output, input: mut stdin } => {
                stdin.write_all(input).await?;
                stdin.shutdown().await?;
                while let Some(chunk) = output.next().await {
                    chunk.map_err(rt_err)?;
                }
            }
            StartExecResults::Detached => return Err(KalypsoError::Runtime("exec unexpectedly detached".into())),
        }
        // This exec's own exit code, not whichever exec finished last.
        Ok(self.docker.inspect_exec(&created.id).await.map_err(rt_err)?.exit_code.unwrap_or(-1))
    }

    async fn open_stream(&self, ns: &str, id: &str, cmd: &[&str]) -> Result<ExecStream> {
        let created = self
            .docker
            .create_exec(
                &container_name(ns, id),
                CreateExecOptions {
                    cmd: Some(cmd.to_vec()),
                    user: Some(EXEC_USER),
                    attach_stdin: Some(true),
                    attach_stdout: Some(true),
                    attach_stderr: Some(true),
                    ..Default::default()
                },
            )
            .await
            .map_err(rt_err)?;
        match self.docker.start_exec(&created.id, None).await.map_err(rt_err)? {
            StartExecResults::Attached { output, input } => Ok(ExecStream {
                output: output
                    .filter_map(|chunk| async move {
                        match chunk {
                            Ok(LogOutput::StdOut { message }) => Some(Ok(message.to_vec())),
                            Ok(_) => None, // stderr and console noise aren't part of the stream
                            Err(e) => Some(Err(std::io::Error::other(e.to_string()))),
                        }
                    })
                    .boxed(),
                input,
            }),
            StartExecResults::Detached => Err(KalypsoError::Runtime("exec unexpectedly detached".into())),
        }
    }

    async fn open_tty(&self, ns: &str, id: &str, cmd: &[&str], cwd: &str, rows: u16, cols: u16) -> Result<(ExecStream, String)> {
        let created = self
            .docker
            .create_exec(
                &container_name(ns, id),
                CreateExecOptions {
                    cmd: Some(cmd.to_vec()),
                    user: Some(EXEC_USER),
                    working_dir: Some(cwd),
                    env: Some(vec!["TERM=xterm-256color", "COLORTERM=truecolor", "LANG=C.UTF-8"]),
                    tty: Some(true),
                    attach_stdin: Some(true),
                    attach_stdout: Some(true),
                    attach_stderr: Some(true),
                    ..Default::default()
                },
            )
            .await
            .map_err(rt_err)?;
        let started =
            self.docker.start_exec(&created.id, Some(StartExecOptions { tty: true, ..Default::default() })).await.map_err(rt_err)?;
        let StartExecResults::Attached { output, input } = started else {
            return Err(KalypsoError::Runtime("exec unexpectedly detached".into()));
        };
        // The size can only be set once the process runs.
        self.resize_tty(&created.id, rows, cols).await?;
        let output = output
            .filter_map(|chunk| async move {
                match chunk {
                    // With a TTY everything arrives as one console stream.
                    Ok(LogOutput::Console { message } | LogOutput::StdOut { message } | LogOutput::StdErr { message }) => {
                        Some(Ok(message.to_vec()))
                    }
                    Ok(_) => None,
                    Err(e) => Some(Err(std::io::Error::other(e.to_string()))),
                }
            })
            .boxed();
        Ok((ExecStream { output, input }, created.id))
    }

    async fn open_process(&self, ns: &str, id: &str, cmd: &[&str], cwd: &str, env: &[String]) -> Result<(ExecStream, String)> {
        self.attach(ns, id, cmd, cwd, env, EXEC_USER, true).await
    }

    async fn run_as(&self, ns: &str, id: &str, cmd: &[&str], cwd: &str, env: &[String], user: &str) -> Result<(ExecStream, String)> {
        self.attach(ns, id, cmd, cwd, env, user, false).await
    }

    async fn exit_code(&self, handle: &str) -> Result<Option<i64>> {
        let info = self.docker.inspect_exec(handle).await.map_err(rt_err)?;
        Ok(if info.running == Some(true) { None } else { info.exit_code })
    }

    async fn resize_tty(&self, handle: &str, rows: u16, cols: u16) -> Result<()> {
        self.docker.resize_exec(handle, ResizeExecOptions { height: rows.max(1), width: cols.max(1) }).await.map_err(rt_err)
    }

    async fn address(&self, ns: &str, id: &str) -> Result<Option<String>> {
        let info = self.docker.inspect_container(&container_name(ns, id), None::<InspectContainerOptions>).await.map_err(rt_err)?;
        Ok(info
            .network_settings
            .and_then(|n| n.networks)
            .and_then(|mut nets| nets.remove(&network_name(ns)))
            .and_then(|n| n.ip_address)
            .filter(|ip| !ip.is_empty()))
    }

    fn watch(&self) -> Result<BoxStream<'static, SandboxStatusEvent>> {
        let filters = HashMap::from([
            ("type".to_string(), vec!["container".to_string()]),
            ("label".to_string(), vec!["kalypso.sandbox".to_string()]),
        ]);
        // The request is only sent on first poll, so ask the engine to replay from now:
        // nothing that happens between this call and the first read is lost.
        let since = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs().to_string()).ok();
        Ok(self
            .docker
            .events(Some(EventsOptions::<String> { since, filters, ..Default::default() }))
            .filter_map(|msg| async move {
                let msg = match msg {
                    Ok(m) => m,
                    Err(e) => {
                        tracing::warn!(error = %e, "unreadable container event");
                        return None;
                    }
                };
                let status = status_for_action(msg.action.as_deref()?)?;
                let attrs = msg.actor?.attributes?;
                Some(SandboxStatusEvent {
                    ns: attrs.get("kalypso.ns")?.clone(),
                    id: attrs.get("kalypso.sandbox")?.clone(),
                    status: status.to_string(),
                })
            })
            .boxed())
    }
}

/// Map a container event action to the status KALYPSO shows. `None` for actions that don't change it.
pub fn status_for_action(action: &str) -> Option<&'static str> {
    match action {
        "start" | "unpause" | "restart" => Some("running"),
        "pause" => Some("paused"),
        "die" | "stop" | "kill" => Some("stopped"),
        "destroy" | "remove" => Some("missing"),
        _ => None,
    }
}

pub fn network_name(ns: &str) -> String {
    format!("kalypso-ns-{ns}")
}

/// The namespace's gateway relay (VM engines only).
pub fn relay_name(ns: &str) -> String {
    format!("kalypso-gw-{ns}")
}

/// A sandbox's private network to the relay (VM engines only).
pub fn gateway_network_name(ns: &str, id: &str) -> String {
    format!("kalypso-gw-{ns}-{id}")
}

/// Whether the engine runs containers in a VM, so host sockets can't be shared with them.
/// `KALYPSO_GATEWAY_TRANSPORT=relay` or `=socket` overrides the guess.
async fn runs_in_vm(docker: &Docker) -> bool {
    match std::env::var("KALYPSO_GATEWAY_TRANSPORT").as_deref() {
        Ok("relay") => return true,
        Ok("socket") => return false,
        _ => {}
    }
    if !cfg!(target_os = "linux") {
        return true;
    }
    // Docker Desktop on Linux runs a VM too.
    match docker.info().await {
        Ok(info) => info.operating_system.is_some_and(|os| os.contains("Docker Desktop")),
        Err(_) => false,
    }
}

pub(crate) fn container_name(ns: &str, id: &str) -> String {
    format!("kalypso-{ns}-{id}")
}

fn rt_err(e: bollard::errors::Error) -> KalypsoError {
    KalypsoError::Runtime(e.to_string())
}

fn kind_of(endpoint: &str) -> &'static str {
    if endpoint.contains("podman") {
        "podman"
    } else {
        "docker"
    }
}

/// Where the `podman` command is: on PATH, or where its installers put it. A desktop app that was
/// open while Podman was installed doesn't see the new PATH, so the usual places are checked too.
pub fn podman_bin() -> Option<std::path::PathBuf> {
    let exe = if cfg!(windows) { "podman.exe" } else { "podman" };
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            if dir.join(exe).is_file() {
                return Some(dir.join(exe));
            }
        }
    }
    let known: &[&str] = if cfg!(windows) {
        &[r"C:\Program Files\RedHat\Podman\podman.exe", r"C:\Program Files\Podman\podman.exe"]
    } else if cfg!(target_os = "macos") {
        &["/opt/podman/bin/podman", "/opt/homebrew/bin/podman", "/usr/local/bin/podman"]
    } else {
        &["/usr/bin/podman", "/usr/local/bin/podman"]
    };
    known.iter().map(std::path::PathBuf::from).find(|p| p.is_file())
}

/// The API endpoints of running Podman machines (macOS, Windows, and Linux with a machine),
/// as Podman itself reports them: whatever the machine is called and wherever its socket is.
async fn podman_machine_endpoints() -> Vec<String> {
    let Some(bin) = podman_bin() else { return vec![] };
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(["machine", "inspect"]).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        // No console window flashing up from a GUI app.
        cmd.creation_flags(0x0800_0000);
    }
    let Ok(Ok(out)) = tokio::time::timeout(std::time::Duration::from_secs(5), cmd.output()).await else { return vec![] };
    let Ok(machines) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else { return vec![] };
    let mut found = Vec::new();
    for m in machines.as_array().into_iter().flatten() {
        if m.get("State").and_then(|s| s.as_str()).is_some_and(|s| s != "running") {
            continue;
        }
        let info = m.get("ConnectionInfo");
        let path = |key: &str| {
            info.and_then(|i| i.get(key)).and_then(|k| k.get("Path")).and_then(|p| p.as_str()).filter(|p| !p.is_empty()).map(str::to_string)
        };
        if cfg!(windows) {
            if let Some(pipe) = path("PodmanPipe") {
                found.push(format!("npipe://{pipe}"));
            }
        } else if let Some(sock) = path("PodmanSocket") {
            found.push(format!("unix://{sock}"));
        }
    }
    found
}

/// Where engines listen, most specific first. Missing ones are skipped cheaply.
async fn candidates() -> Vec<(String, &'static str)> {
    let mut out: Vec<(String, &'static str)> = Vec::new();
    if let Ok(host) = std::env::var("DOCKER_HOST") {
        let kind = kind_of(&host);
        out.push((host, kind));
    }
    // Podman machines first: they say exactly where they listen.
    for e in podman_machine_endpoints().await {
        out.push((e, "podman"));
    }
    #[cfg(unix)]
    {
        let mut socks: Vec<PathBuf> = Vec::new();
        if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
            socks.push(PathBuf::from(dir).join("podman/podman.sock"));
        }
        // Podman 5 machines on macOS put their API socket in the per-user temporary folder.
        if let Ok(tmp) = std::env::var("TMPDIR") {
            if let Ok(entries) = std::fs::read_dir(PathBuf::from(tmp).join("podman")) {
                socks.extend(entries.flatten().map(|e| e.path()).filter(|p| p.to_string_lossy().ends_with("-api.sock")));
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            let home = PathBuf::from(home);
            socks.push(home.join(".docker/run/docker.sock")); // Docker Desktop (per-user)
            socks.push(home.join(".orbstack/run/docker.sock"));
            socks.push(home.join(".colima/default/docker.sock"));
            socks.push(home.join(".local/share/containers/podman/machine/podman.sock"));
            socks.push(home.join(".local/share/containers/podman/machine/qemu/podman.sock"));
            socks.push(home.join(".local/share/containers/podman/machine/applehv/podman.sock"));
        }
        socks.push("/var/run/docker.sock".into());
        socks.push("/run/podman/podman.sock".into());
        out.extend(socks.into_iter().filter(|p| p.exists()).map(|p| {
            let s = format!("unix://{}", p.display());
            let kind = kind_of(&s);
            (s, kind)
        }));
    }
    #[cfg(windows)]
    {
        // Docker Desktop (newer and older pipe), then Podman's default machine and its Docker
        // compatibility pipe.
        out.push((r"npipe://\\.\pipe\dockerDesktopLinuxEngine".into(), "docker"));
        out.push((r"npipe://\\.\pipe\docker_engine".into(), "docker"));
        out.push((r"npipe://\\.\pipe\podman-machine-default".into(), "podman"));
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|(e, _)| seen.insert(e.clone()));
    out
}

fn connect(endpoint: &str) -> Option<Docker> {
    let v = bollard::API_DEFAULT_VERSION;
    #[cfg(unix)]
    if let Some(path) = endpoint.strip_prefix("unix://") {
        return Docker::connect_with_unix(path, 120, v).ok();
    }
    #[cfg(windows)]
    if let Some(pipe) = endpoint.strip_prefix("npipe://") {
        return Docker::connect_with_named_pipe(pipe, 120, v).ok();
    }
    if endpoint.starts_with("tcp://") || endpoint.starts_with("http://") {
        return Docker::connect_with_http(endpoint, 120, v).ok();
    }
    None
}

impl OciProvider {
    /// An exec with its output attached, as `user`.
    #[allow(clippy::too_many_arguments)]
    async fn attach(
        &self,
        ns: &str,
        id: &str,
        cmd: &[&str],
        cwd: &str,
        env: &[String],
        user: &str,
        stdin: bool,
    ) -> Result<(ExecStream, String)> {
        let env: Vec<&str> = env.iter().map(String::as_str).collect();
        let created = self
            .docker
            .create_exec(
                &container_name(ns, id),
                CreateExecOptions {
                    cmd: Some(cmd.to_vec()),
                    user: Some(user),
                    working_dir: Some(cwd),
                    env: Some(env),
                    attach_stdin: Some(stdin),
                    attach_stdout: Some(true),
                    attach_stderr: Some(true),
                    ..Default::default()
                },
            )
            .await
            .map_err(rt_err)?;
        let StartExecResults::Attached { output, input } = self.docker.start_exec(&created.id, None).await.map_err(rt_err)? else {
            return Err(KalypsoError::Runtime("exec unexpectedly detached".into()));
        };
        let output = output
            .filter_map(|chunk| async move {
                match chunk {
                    Ok(LogOutput::StdOut { message } | LogOutput::StdErr { message } | LogOutput::Console { message }) => {
                        Some(Ok(message.to_vec()))
                    }
                    Ok(_) => None,
                    Err(e) => Some(Err(std::io::Error::other(e.to_string()))),
                }
            })
            .boxed();
        Ok((ExecStream { output, input }, created.id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_kinds() {
        assert_eq!(kind_of("unix:///run/user/1000/podman/podman.sock"), "podman");
        assert_eq!(kind_of("npipe:////./pipe/docker_engine"), "docker");
        assert!(connect("ftp://nope").is_none());
    }

    #[test]
    fn actions_map_to_statuses() {
        assert_eq!(status_for_action("start"), Some("running"));
        assert_eq!(status_for_action("die"), Some("stopped"));
        assert_eq!(status_for_action("pause"), Some("paused"));
        assert_eq!(status_for_action("destroy"), Some("missing"));
        assert_eq!(status_for_action("exec_create"), None);
    }
}
