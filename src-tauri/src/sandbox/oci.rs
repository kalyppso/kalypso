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
use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
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

pub struct OciProvider {
    docker: Docker,
    kind: &'static str,
}

impl OciProvider {
    /// Find a reachable engine: `DOCKER_HOST` first, then the usual places Docker,
    /// Podman, OrbStack and Colima put their sockets (named pipes on Windows).
    pub async fn detect() -> Option<Self> {
        for (endpoint, kind) in candidates() {
            let Some(docker) = connect(&endpoint) else { continue };
            if docker.ping().await.is_ok() {
                tracing::info!(kind, endpoint, "container runtime connected");
                return Some(Self { docker, kind });
            }
        }
        None
    }

    pub fn docker(&self) -> &Docker {
        &self.docker
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
        match self.docker.remove_network(&network_name(ns)).await {
            Ok(()) => Ok(()),
            Err(bollard::errors::Error::DockerResponseServerError { status_code: 404, .. }) => Ok(()),
            Err(e) => Err(rt_err(e)),
        }
    }

    async fn create(&self, ns: &str, id: &str, spec: &NewSandbox) -> Result<String> {
        self.pull(&spec.image).await?;
        let network_mode = match spec.network.as_str() {
            "isolated" => "none".to_string(),
            "namespace" => {
                self.prepare_namespace(ns).await?;
                network_name(ns)
            }
            // TODO(#33): route through the egress proxy with the namespace allow-list.
            _ => "bridge".to_string(),
        };
        let labels = HashMap::from([("kalypso.ns".to_string(), ns.to_string()), ("kalypso.sandbox".to_string(), id.to_string())]);
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
            // Anonymous volume: removed together with the container.
            mounts: Some(vec![Mount { target: Some("/work".into()), typ: Some(MountTypeEnum::VOLUME), ..Default::default() }]),
            ..Default::default()
        };
        let config = |limits: bool| Config {
            image: Some(spec.image.clone()),
            cmd: Some(vec!["sleep".to_string(), "infinity".to_string()]),
            working_dir: Some("/work".into()),
            labels: Some(labels.clone()),
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
        Ok(created.id)
    }

    async fn start(&self, ns: &str, id: &str) -> Result<()> {
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
            Ok(()) | Err(bollard::errors::Error::DockerResponseServerError { status_code: 404, .. }) => Ok(()),
            Err(e) => Err(rt_err(e)),
        }
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

/// Where engines listen, most specific first. Missing ones are skipped cheaply.
fn candidates() -> Vec<(String, &'static str)> {
    let mut out: Vec<(String, &'static str)> = Vec::new();
    if let Ok(host) = std::env::var("DOCKER_HOST") {
        let kind = kind_of(&host);
        out.push((host, kind));
    }
    #[cfg(unix)]
    {
        let mut socks: Vec<PathBuf> = Vec::new();
        if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
            socks.push(PathBuf::from(dir).join("podman/podman.sock"));
        }
        if let Ok(home) = std::env::var("HOME") {
            let home = PathBuf::from(home);
            socks.push(home.join(".docker/run/docker.sock")); // Docker Desktop (per-user)
            socks.push(home.join(".orbstack/run/docker.sock"));
            socks.push(home.join(".colima/default/docker.sock"));
            socks.push(home.join(".local/share/containers/podman/machine/podman.sock"));
            // Podman machine (macOS)
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
        out.push((r"npipe:////./pipe/docker_engine".into(), "docker"));
        out.push((r"npipe:////./pipe/podman-machine-default".into(), "podman"));
    }
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
