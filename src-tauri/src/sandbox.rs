use std::collections::HashMap;
use std::path::PathBuf;

use bollard::container::{
    Config, CreateContainerOptions, InspectContainerOptions, RemoveContainerOptions, StartContainerOptions, StopContainerOptions,
};
use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
use bollard::image::CreateImageOptions;
use bollard::models::{HostConfig, Mount, MountTypeEnum};
use bollard::network::CreateNetworkOptions;
use bollard::Docker;
use futures_util::{StreamExt, TryStreamExt};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{KalypsoError, Result};
use crate::store::Db;
use crate::vault::new_id;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SandboxRecord {
    pub id: String,
    pub ns: String,
    pub name: String,
    pub runtime: String,
    pub image: String,
    pub cpu: f64,
    #[ts(type = "number")]
    pub mem_mb: i64,
    pub network: String,
    pub status: String,
    pub container_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct NewSandbox {
    pub name: String,
    pub image: String,
    pub cpu: f64,
    #[ts(type = "number")]
    pub mem_mb: i64,
    pub network: String,
}

/// The container engine. Podman is driven through its Docker-compatible API,
/// so one code path serves both.
pub struct Runtime {
    docker: Option<Docker>,
    pub kind: String,
}

impl Runtime {
    pub async fn detect() -> Self {
        let mut candidates: Vec<(PathBuf, &str)> = Vec::new();
        if let Ok(host) = std::env::var("DOCKER_HOST") {
            if let Some(path) = host.strip_prefix("unix://") {
                candidates.push((path.into(), if path.contains("podman") { "podman" } else { "docker" }));
            }
        }
        candidates.push(("/var/run/docker.sock".into(), "docker"));
        if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
            candidates.push((PathBuf::from(dir).join("podman/podman.sock"), "podman"));
        }
        candidates.push(("/run/podman/podman.sock".into(), "podman"));

        for (path, kind) in candidates {
            if !path.exists() {
                continue;
            }
            let Ok(docker) = Docker::connect_with_unix(&path.to_string_lossy(), 120, bollard::API_DEFAULT_VERSION) else { continue };
            if docker.ping().await.is_ok() {
                tracing::info!(kind, path = %path.display(), "container runtime connected");
                return Self { docker: Some(docker), kind: kind.into() };
            }
        }
        tracing::warn!("no container runtime found; sandboxes are disabled");
        Self { docker: None, kind: "none".into() }
    }

    pub fn none() -> Self {
        Self { docker: None, kind: "none".into() }
    }

    pub fn available(&self) -> bool {
        self.docker.is_some()
    }

    fn docker(&self) -> Result<&Docker> {
        self.docker.as_ref().ok_or_else(|| KalypsoError::Runtime("no Docker or Podman found. Start one and restart KALYPSO.".into()))
    }

    /// The namespace's internal network: sandboxes on it can reach each other but nothing else.
    pub async fn ensure_network(&self, ns: &str) -> Result<()> {
        let docker = self.docker()?;
        let name = network_name(ns);
        if docker.inspect_network::<String>(&name, None).await.is_ok() {
            return Ok(());
        }
        docker
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

    pub async fn remove_network(&self, ns: &str) -> Result<()> {
        match self.docker()?.remove_network(&network_name(ns)).await {
            Ok(()) => Ok(()),
            Err(bollard::errors::Error::DockerResponseServerError { status_code: 404, .. }) => Ok(()),
            Err(e) => Err(rt_err(e)),
        }
    }

    async fn pull(&self, image: &str) -> Result<()> {
        let docker = self.docker()?;
        if docker.inspect_image(image).await.is_ok() {
            return Ok(());
        }
        tracing::info!(image, "pulling image");
        docker
            .create_image(Some(CreateImageOptions { from_image: image, ..Default::default() }), None, None)
            .try_collect::<Vec<_>>()
            .await
            .map_err(rt_err)?;
        Ok(())
    }
}

pub fn network_name(ns: &str) -> String {
    format!("kalypso-ns-{ns}")
}

fn container_name(ns: &str, id: &str) -> String {
    format!("kalypso-{ns}-{id}")
}

fn rt_err(e: bollard::errors::Error) -> KalypsoError {
    KalypsoError::Runtime(e.to_string())
}

pub fn list(db: &Db, ns: &str) -> Result<Vec<SandboxRecord>> {
    db.with(|c| {
        let mut st = c.prepare(
            "SELECT id, ns, name, runtime, image, cpu, mem_mb, network, status, container_id, created_at
             FROM sandboxes WHERE ns = ?1 ORDER BY created_at, name",
        )?;
        let rows = st.query_map([ns], row_to_record)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    })
}

fn row_to_record(r: &rusqlite::Row) -> rusqlite::Result<SandboxRecord> {
    Ok(SandboxRecord {
        id: r.get(0)?,
        ns: r.get(1)?,
        name: r.get(2)?,
        runtime: r.get(3)?,
        image: r.get(4)?,
        cpu: r.get(5)?,
        mem_mb: r.get(6)?,
        network: r.get(7)?,
        status: r.get(8)?,
        container_id: r.get(9)?,
        created_at: r.get(10)?,
    })
}

fn get(db: &Db, ns: &str, id: &str) -> Result<SandboxRecord> {
    let rec = db
        .with(|c| {
            Ok(c.query_row(
                "SELECT id, ns, name, runtime, image, cpu, mem_mb, network, status, container_id, created_at FROM sandboxes WHERE id = ?1",
                [id],
                row_to_record,
            )
            .optional()?)
        })?
        .ok_or_else(|| KalypsoError::NotFound(format!("sandbox {id}")))?;
    if rec.ns != ns {
        return Err(KalypsoError::WrongNamespace(format!("sandbox {id}"), ns.into()));
    }
    Ok(rec)
}

fn set_status(db: &Db, id: &str, status: &str, container_id: Option<&str>) -> Result<()> {
    db.with(|c| {
        c.execute("UPDATE sandboxes SET status = ?2, container_id = COALESCE(?3, container_id) WHERE id = ?1", (id, status, container_id))?;
        Ok(())
    })
}

pub fn validate(spec: &NewSandbox) -> Result<()> {
    let name_ok =
        !spec.name.is_empty() && spec.name.len() <= 40 && spec.name.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_');
    if !name_ok {
        return Err(KalypsoError::Invalid("sandbox names use letters, digits, - and _ (max 40)".into()));
    }
    if spec.image.trim().is_empty() {
        return Err(KalypsoError::Invalid("image is required".into()));
    }
    if !(0.25..=64.0).contains(&spec.cpu) || !(128..=262_144).contains(&spec.mem_mb) {
        return Err(KalypsoError::Invalid("cpu must be 0.25 to 64 and memory 128 MB to 256 GB".into()));
    }
    if !["isolated", "namespace", "internet"].contains(&spec.network.as_str()) {
        return Err(KalypsoError::Invalid(format!("unknown network mode {}", spec.network)));
    }
    Ok(())
}

/// Create a hardened container for the sandbox. It is created stopped.
pub async fn create(db: &Db, rt: &Runtime, ns: &str, spec: NewSandbox) -> Result<SandboxRecord> {
    validate(&spec)?;
    let docker = rt.docker()?;
    let id = new_id("sb");
    db.with(|c| {
        c.execute(
            "INSERT INTO sandboxes (id, ns, name, runtime, image, cpu, mem_mb, network, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'creating')",
            (&id, ns, &spec.name, &rt.kind, &spec.image, spec.cpu, spec.mem_mb, &spec.network),
        )
        .map_err(|e| match e {
            rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation => KalypsoError::Conflict(format!("sandbox {}", spec.name)),
            e => e.into(),
        })?;
        Ok(())
    })?;

    let result: Result<String> = async {
        rt.pull(&spec.image).await?;
        let network_mode = match spec.network.as_str() {
            "isolated" => "none".to_string(),
            "namespace" => {
                rt.ensure_network(ns).await?;
                network_name(ns)
            }
            // TODO(#33): route through the egress proxy with the namespace allow-list.
            _ => "bridge".to_string(),
        };
        let labels = HashMap::from([("kalypso.ns".to_string(), ns.to_string()), ("kalypso.sandbox".to_string(), id.clone())]);
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
        let opts = || Some(CreateContainerOptions { name: container_name(ns, &id), platform: None });
        let created = match docker.create_container(opts(), config(true)).await {
            Ok(r) => r,
            // Rootless engines without cgroup delegation reject resource limits.
            Err(e) if e.to_string().contains("cgroup") => {
                tracing::warn!(error = %e, "resource limits unsupported here; creating without them");
                docker.create_container(opts(), config(false)).await.map_err(rt_err)?
            }
            Err(e) => return Err(rt_err(e)),
        };
        Ok(created.id)
    }
    .await;

    match result {
        Ok(container_id) => {
            set_status(db, &id, "stopped", Some(&container_id))?;
            db.audit(Some(ns), "user", "sandbox.create", &spec.name)?;
            get(db, ns, &id)
        }
        Err(e) => {
            db.with(|c| Ok(c.execute("DELETE FROM sandboxes WHERE id = ?1", [&id])?))?;
            Err(e)
        }
    }
}

pub async fn start(db: &Db, rt: &Runtime, ns: &str, id: &str) -> Result<SandboxRecord> {
    let rec = get(db, ns, id)?;
    let name = container_name(ns, id);
    let docker = rt.docker()?;
    if rec.status == "paused" {
        docker.unpause_container(&name).await.map_err(rt_err)?;
    } else {
        docker.start_container(&name, None::<StartContainerOptions<String>>).await.map_err(rt_err)?;
    }
    refresh(db, rt, ns, id).await
}

pub async fn pause(db: &Db, rt: &Runtime, ns: &str, id: &str) -> Result<SandboxRecord> {
    get(db, ns, id)?;
    rt.docker()?.pause_container(&container_name(ns, id)).await.map_err(rt_err)?;
    refresh(db, rt, ns, id).await
}

pub async fn stop(db: &Db, rt: &Runtime, ns: &str, id: &str) -> Result<SandboxRecord> {
    get(db, ns, id)?;
    rt.docker()?.stop_container(&container_name(ns, id), Some(StopContainerOptions { t: 5 })).await.map_err(rt_err)?;
    refresh(db, rt, ns, id).await
}

pub async fn remove(db: &Db, rt: &Runtime, ns: &str, id: &str) -> Result<()> {
    let rec = get(db, ns, id)?;
    if rt.available() {
        let res = rt
            .docker()?
            .remove_container(&container_name(ns, id), Some(RemoveContainerOptions { force: true, v: true, ..Default::default() }))
            .await;
        match res {
            Ok(()) | Err(bollard::errors::Error::DockerResponseServerError { status_code: 404, .. }) => {}
            Err(e) => return Err(rt_err(e)),
        }
    }
    db.with(|c| Ok(c.execute("DELETE FROM sandboxes WHERE id = ?1", [id])?))?;
    db.audit(Some(ns), "user", "sandbox.delete", &rec.name)
}

/// Run a command inside a running sandbox and collect its output.
/// With `detach`, start it in the background and return immediately.
pub async fn exec(rt: &Runtime, ns: &str, id: &str, cmd: &[&str], detach: bool) -> Result<(i64, String)> {
    let docker = rt.docker()?;
    let created = docker
        .create_exec(
            &container_name(ns, id),
            CreateExecOptions { cmd: Some(cmd.to_vec()), attach_stdout: Some(!detach), attach_stderr: Some(!detach), ..Default::default() },
        )
        .await
        .map_err(rt_err)?;
    let mut out = String::new();
    match docker.start_exec(&created.id, Some(StartExecOptions { detach, ..Default::default() })).await.map_err(rt_err)? {
        StartExecResults::Attached { mut output, .. } => {
            while let Some(chunk) = output.next().await {
                out.push_str(&chunk.map_err(rt_err)?.to_string());
            }
        }
        StartExecResults::Detached => return Ok((0, out)),
    }
    let code = docker.inspect_exec(&created.id).await.map_err(rt_err)?.exit_code.unwrap_or(-1);
    Ok((code, out))
}

/// The sandbox's address on its namespace network, if it is attached to one.
pub async fn namespace_ip(rt: &Runtime, ns: &str, id: &str) -> Result<Option<String>> {
    let info = rt.docker()?.inspect_container(&container_name(ns, id), None::<InspectContainerOptions>).await.map_err(rt_err)?;
    Ok(info
        .network_settings
        .and_then(|n| n.networks)
        .and_then(|mut nets| nets.remove(&network_name(ns)))
        .and_then(|n| n.ip_address)
        .filter(|ip| !ip.is_empty()))
}

/// Read the real state from the engine and store it.
pub async fn refresh(db: &Db, rt: &Runtime, ns: &str, id: &str) -> Result<SandboxRecord> {
    get(db, ns, id)?;
    let info = rt.docker()?.inspect_container(&container_name(ns, id), None::<InspectContainerOptions>).await.map_err(rt_err)?;
    let state = info.state.unwrap_or_default();
    let status = if state.paused == Some(true) {
        "paused"
    } else if state.running == Some(true) {
        "running"
    } else {
        "stopped"
    };
    set_status(db, id, status, None)?;
    get(db, ns, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str) -> NewSandbox {
        NewSandbox { name: name.into(), image: "docker.io/library/alpine:3.20".into(), cpu: 1.0, mem_mb: 256, network: "namespace".into() }
    }

    #[test]
    fn validation_rejects_bad_specs() {
        assert!(validate(&spec("ok-name")).is_ok());
        assert_eq!(validate(&spec("bad name!")).unwrap_err().code(), "invalid");
        assert_eq!(validate(&NewSandbox { cpu: 0.0, ..spec("x") }).unwrap_err().code(), "invalid");
        assert_eq!(validate(&NewSandbox { network: "host".into(), ..spec("x") }).unwrap_err().code(), "invalid");
    }

    #[tokio::test]
    async fn create_without_runtime_fails_cleanly() {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| Ok(c.execute("INSERT INTO namespaces (id, name) VALUES ('work','work')", [])?)).unwrap();
        let err = create(&db, &Runtime::none(), "work", spec("a")).await.unwrap_err();
        assert_eq!(err.code(), "runtime");
        assert!(list(&db, "work").unwrap().is_empty());
    }

    /// Two sandboxes in one namespace can talk; a sandbox in another namespace cannot.
    /// Runs against a real Docker or Podman. Opt in with KALYPSO_TEST_RUNTIME=1.
    #[tokio::test]
    async fn namespaces_cannot_reach_each_other() {
        if std::env::var("KALYPSO_TEST_RUNTIME").is_err() {
            return;
        }
        let rt = Runtime::detect().await;
        let db = Db::open_in_memory().unwrap();
        let (a, b) = (format!("ia{}", &new_id("x")[2..8]), format!("ib{}", &new_id("x")[2..8]));
        for ns in [&a, &b] {
            db.with(|c| Ok(c.execute("INSERT INTO namespaces (id, name) VALUES (?1, ?1)", [ns])?)).unwrap();
        }
        let server = create(&db, &rt, &a, spec("server")).await.unwrap();
        let neighbour = create(&db, &rt, &a, spec("neighbour")).await.unwrap();
        let outsider = create(&db, &rt, &b, spec("outsider")).await.unwrap();
        for (ns, sb) in [(&a, &server), (&a, &neighbour), (&b, &outsider)] {
            start(&db, &rt, ns, &sb.id).await.unwrap();
        }

        // A tiny TCP server in namespace A.
        exec(&rt, &a, &server.id, &["sh", "-c", "while true; do echo hi | nc -l -p 8080; done"], true).await.unwrap();
        let ip = namespace_ip(&rt, &a, &server.id).await.unwrap().expect("server has an address on its namespace network");
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let probe = format!("nc -w 2 {ip} 8080 </dev/null");
        let (same_ns, out) = exec(&rt, &a, &neighbour.id, &["sh", "-c", &probe], false).await.unwrap();
        assert_eq!(same_ns, 0, "same-namespace sandboxes should connect: {out}");
        let (other_ns, _) = exec(&rt, &b, &outsider.id, &["sh", "-c", &probe], false).await.unwrap();
        assert_ne!(other_ns, 0, "a sandbox in another namespace reached {ip}:8080");

        for (ns, sb) in [(&a, &server), (&a, &neighbour), (&b, &outsider)] {
            remove(&db, &rt, ns, &sb.id).await.unwrap();
        }
        rt.remove_network(&a).await.unwrap();
        rt.remove_network(&b).await.unwrap();
    }

    /// Runs against a real Docker or Podman. Opt in with KALYPSO_TEST_RUNTIME=1.
    #[tokio::test]
    async fn lifecycle_against_real_runtime() {
        if std::env::var("KALYPSO_TEST_RUNTIME").is_err() {
            return;
        }
        let rt = Runtime::detect().await;
        assert!(rt.available(), "no runtime reachable");
        let db = Db::open_in_memory().unwrap();
        let ns = format!("t{}", &new_id("x")[2..8]);
        db.with(|c| Ok(c.execute("INSERT INTO namespaces (id, name) VALUES (?1, ?1)", [&ns])?)).unwrap();

        let sb = create(&db, &rt, &ns, spec("box")).await.unwrap();
        assert_eq!(sb.status, "stopped");
        assert_eq!(start(&db, &rt, &ns, &sb.id).await.unwrap().status, "running");

        // Hardening is applied.
        let info = rt.docker().unwrap().inspect_container(&container_name(&ns, &sb.id), None::<InspectContainerOptions>).await.unwrap();
        let hc = info.host_config.unwrap();
        assert_eq!(hc.readonly_rootfs, Some(true));
        assert_eq!(hc.security_opt.unwrap_or_default(), vec!["no-new-privileges".to_string()]);
        // Docker reports the network in NetworkMode, Podman in NetworkSettings; check attachment.
        let nets = info.network_settings.and_then(|n| n.networks).unwrap_or_default();
        assert!(nets.contains_key(&network_name(&ns)), "attached to {:?}", nets.keys());
        let net = rt.docker().unwrap().inspect_network::<String>(&network_name(&ns), None).await.unwrap();
        assert_eq!(net.internal, Some(true), "namespace network must have no route out");

        assert_eq!(pause(&db, &rt, &ns, &sb.id).await.unwrap().status, "paused");
        assert_eq!(start(&db, &rt, &ns, &sb.id).await.unwrap().status, "running");
        assert_eq!(stop(&db, &rt, &ns, &sb.id).await.unwrap().status, "stopped");
        remove(&db, &rt, &ns, &sb.id).await.unwrap();
        rt.remove_network(&ns).await.unwrap();
        assert!(list(&db, &ns).unwrap().is_empty());
    }
}
