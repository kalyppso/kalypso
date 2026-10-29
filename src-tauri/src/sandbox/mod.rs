//! Sandboxes: KALYPSO's records and rules, independent of the engine.
//! Engine work goes through a [`SandboxProvider`]; see `provider.rs`.

pub mod oci;
pub mod provider;

use std::sync::Arc;

use futures_util::stream::{self, BoxStream};
use futures_util::StreamExt;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[cfg(test)]
pub(crate) use oci::container_name;
pub use oci::network_name;
pub use provider::{ExecStream, ProviderInfo, SandboxProvider};

use crate::error::{KalypsoError, Result};
use crate::store::Db;
use crate::vault::{new_id, Vault};

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SandboxRecord {
    pub id: String,
    pub ns: String,
    pub name: String,
    /// Which provider runs it ("docker", "podman", …).
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
    /// Provider kind; the default provider when omitted.
    #[serde(default)]
    #[ts(optional)]
    pub provider: Option<String>,
}

/// A sandbox changed state in its backend, whoever caused it.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct SandboxStatusEvent {
    pub ns: String,
    pub id: String,
    pub status: String,
}

/// The sandbox providers available on this machine. The first is the default.
pub struct Runtime {
    providers: Vec<Arc<dyn SandboxProvider>>,
    /// Kind of the default provider, or "none".
    pub kind: String,
}

impl Runtime {
    pub async fn detect() -> Self {
        let mut providers: Vec<Arc<dyn SandboxProvider>> = Vec::new();
        if let Some(p) = oci::OciProvider::detect().await {
            providers.push(Arc::new(p));
        }
        if providers.is_empty() {
            tracing::warn!("no sandbox provider found; sandboxes are disabled");
        }
        Self::with(providers)
    }

    pub fn none() -> Self {
        Self::with(Vec::new())
    }

    pub fn with(providers: Vec<Arc<dyn SandboxProvider>>) -> Self {
        let kind = providers.first().map(|p| p.info().kind).unwrap_or_else(|| "none".into());
        Self { providers, kind }
    }

    pub fn available(&self) -> bool {
        !self.providers.is_empty()
    }

    pub fn infos(&self) -> Vec<ProviderInfo> {
        self.providers.iter().map(|p| p.info()).collect()
    }

    fn default_provider(&self) -> Result<Arc<dyn SandboxProvider>> {
        self.providers
            .first()
            .cloned()
            .ok_or_else(|| KalypsoError::Runtime("no Docker or Podman found. Start one and restart KALYPSO.".into()))
    }

    /// The provider that owns sandboxes of this kind.
    pub fn provider(&self, kind: &str) -> Result<Arc<dyn SandboxProvider>> {
        self.providers
            .iter()
            .find(|p| p.handles(kind))
            .cloned()
            .ok_or_else(|| KalypsoError::Runtime(format!("the {kind} provider isn't available on this machine")))
    }

    /// The Docker client, when a Docker/Podman provider is present. Engine-specific test checks only.
    #[cfg(test)]
    pub(crate) fn docker(&self) -> Result<&bollard::Docker> {
        self.providers
            .iter()
            .find_map(|p| p.as_any().downcast_ref::<oci::OciProvider>())
            .map(|o| o.docker())
            .ok_or_else(|| KalypsoError::Runtime("no Docker or Podman found".into()))
    }

    /// Prepare the namespace on every provider (e.g. its internal network).
    pub async fn ensure_network(&self, ns: &str) -> Result<()> {
        if !self.available() {
            return Err(self.default_provider().err().unwrap());
        }
        for p in &self.providers {
            p.prepare_namespace(ns).await?;
        }
        Ok(())
    }

    pub async fn remove_network(&self, ns: &str) -> Result<()> {
        for p in &self.providers {
            p.teardown_namespace(ns).await?;
        }
        Ok(())
    }

    /// Status changes from every provider, merged. Ends when all of them disconnect.
    pub fn watch(&self) -> Result<BoxStream<'static, SandboxStatusEvent>> {
        if !self.available() {
            return Err(self.default_provider().err().unwrap());
        }
        let streams = self.providers.iter().map(|p| p.watch()).collect::<Result<Vec<_>>>()?;
        Ok(stream::select_all(streams).boxed())
    }
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

/// The sandbox record, checked to belong to `ns`.
pub fn get(db: &Db, ns: &str, id: &str) -> Result<SandboxRecord> {
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

/// Create a sandbox with the requested (or default) provider. It is created stopped.
pub async fn create(db: &Db, rt: &Runtime, ns: &str, spec: NewSandbox) -> Result<SandboxRecord> {
    validate(&spec)?;
    let provider = match &spec.provider {
        Some(kind) => rt.provider(kind)?,
        None => rt.default_provider()?,
    };
    let info = provider.info();
    if !info.network_modes.contains(&spec.network) {
        return Err(KalypsoError::Invalid(format!("{} sandboxes don't support the {} network mode", info.label, spec.network)));
    }
    let id = new_id("sb");
    db.with(|c| {
        c.execute(
            "INSERT INTO sandboxes (id, ns, name, runtime, image, cpu, mem_mb, network, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'creating')",
            (&id, ns, &spec.name, &info.kind, &spec.image, spec.cpu, spec.mem_mb, &spec.network),
        )
        .map_err(|e| match e {
            rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation => KalypsoError::Conflict(format!("sandbox {}", spec.name)),
            e => e.into(),
        })?;
        Ok(())
    })?;

    match provider.create(ns, &id, &spec).await {
        Ok(handle) => {
            set_status(db, &id, "stopped", Some(&handle))?;
            db.audit(Some(ns), "user", "sandbox.create", &spec.name)?;
            get(db, ns, &id)
        }
        Err(e) => {
            db.with(|c| Ok(c.execute("DELETE FROM sandboxes WHERE id = ?1", [&id])?))?;
            Err(e)
        }
    }
}

/// The provider that runs this sandbox.
fn provider_for(rt: &Runtime, rec: &SandboxRecord) -> Result<Arc<dyn SandboxProvider>> {
    rt.provider(&rec.runtime)
}

pub async fn start(db: &Db, rt: &Runtime, ns: &str, id: &str) -> Result<SandboxRecord> {
    let rec = get(db, ns, id)?;
    let p = provider_for(rt, &rec)?;
    if rec.status == "paused" {
        p.resume(ns, id).await?;
    } else {
        p.start(ns, id).await?;
    }
    refresh(db, rt, ns, id).await
}

pub async fn pause(db: &Db, rt: &Runtime, ns: &str, id: &str) -> Result<SandboxRecord> {
    let rec = get(db, ns, id)?;
    provider_for(rt, &rec)?.pause(ns, id).await?;
    refresh(db, rt, ns, id).await
}

pub async fn stop(db: &Db, rt: &Runtime, ns: &str, id: &str) -> Result<SandboxRecord> {
    let rec = get(db, ns, id)?;
    provider_for(rt, &rec)?.stop(ns, id).await?;
    refresh(db, rt, ns, id).await
}

pub async fn remove(db: &Db, rt: &Runtime, ns: &str, id: &str) -> Result<()> {
    let rec = get(db, ns, id)?;
    // If the provider is gone (engine uninstalled), still let the record be deleted.
    if let Ok(p) = provider_for(rt, &rec) {
        p.remove(ns, id).await?;
    }
    db.with(|c| Ok(c.execute("DELETE FROM sandboxes WHERE id = ?1", [id])?))?;
    db.audit(Some(ns), "user", "sandbox.delete", &rec.name)
}

/// Read the real state from the provider and store it.
pub async fn refresh(db: &Db, rt: &Runtime, ns: &str, id: &str) -> Result<SandboxRecord> {
    let rec = get(db, ns, id)?;
    let status = provider_for(rt, &rec)?.status(ns, id).await?;
    set_status(db, id, status, None)?;
    get(db, ns, id)
}

/// Run a command in a sandbox of the default provider and collect its output.
/// Code that has the record uses its provider directly.
pub async fn exec(rt: &Runtime, ns: &str, id: &str, cmd: &[&str], detach: bool) -> Result<(i64, String)> {
    rt.default_provider()?.exec(ns, id, cmd, detach).await
}

pub const SECRETS_DIR: &str = "/run/kalypso/secrets";

/// Write the namespace's secrets into the sandbox's in-memory secrets folder,
/// replacing whatever was there. Returns how many were delivered.
pub async fn deliver_secrets(db: &Db, vault: &Vault, rt: &Runtime, ns: &str, id: &str) -> Result<usize> {
    let rec = get(db, ns, id)?;
    let p = provider_for(rt, &rec)?;
    let mut secrets = vault.for_delivery(db, ns)?;
    // Model keys stay with the gateway; the sandbox gets a key that only works through it.
    secrets.push(("KALYPSO_GATEWAY_KEY".to_string(), crate::gateway::mint_for_sandbox(db, ns, id, &rec.name)?));
    let (code, out) = p.exec(ns, id, &["sh", "-c", &format!("rm -f {SECRETS_DIR}/*")], false).await?;
    if code != 0 {
        return Err(KalypsoError::Runtime(format!("could not clear secrets in {}: {out}", rec.name)));
    }
    for (key, value) in &secrets {
        // Keys are validated as [A-Z0-9_], so they are safe as file names.
        let script = format!("umask 077 && cat > {SECRETS_DIR}/$1");
        let code = p.exec_with_stdin(ns, id, &["sh", "-c", &script, "sh", key], value.as_bytes()).await?;
        if code != 0 {
            return Err(KalypsoError::Runtime(format!("could not write secret {key} into {}", rec.name)));
        }
    }
    let keys = secrets.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(",");
    db.audit(Some(ns), "kalypso", "secret.deliver", &format!("{}: {keys}", rec.name))?;
    Ok(secrets.len())
}

/// Bring every running sandbox in the namespace up to date after a secret changes.
pub async fn redeliver_running(db: &Db, vault: &Vault, rt: &Runtime, ns: &str) {
    let Ok(all) = list(db, ns) else { return };
    for sb in all.into_iter().filter(|s| s.status == "running") {
        if let Err(e) = deliver_secrets(db, vault, rt, ns, &sb.id).await {
            tracing::warn!(sandbox = %sb.name, error = %e, "could not refresh secrets");
        }
    }
}

/// The sandbox's address on its namespace network, if it is attached to one.
pub async fn namespace_ip(rt: &Runtime, ns: &str, id: &str) -> Result<Option<String>> {
    rt.default_provider()?.address(ns, id).await
}

/// Record a status reported by a provider. Unknown ids (already deleted here) are ignored.
pub fn apply_event(db: &Db, ev: &SandboxStatusEvent) -> Result<bool> {
    let n = db.with(|c| {
        Ok(c.execute("UPDATE sandboxes SET status = ?3 WHERE id = ?1 AND ns = ?2 AND status != ?3", (&ev.id, &ev.ns, &ev.status))?)
    })?;
    Ok(n > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bollard::container::{InspectContainerOptions, StartContainerOptions};

    fn spec(name: &str) -> NewSandbox {
        NewSandbox {
            name: name.into(),
            image: "docker.io/library/alpine:3.20".into(),
            cpu: 1.0,
            mem_mb: 256,
            network: "namespace".into(),
            provider: None,
        }
    }

    /// A provider that keeps sandboxes in memory: proves a new backend plugs in
    /// through the trait alone, with no changes to records, IPC or namespaces.
    #[derive(Default)]
    struct FakeProvider {
        boxes: std::sync::Mutex<std::collections::HashMap<String, &'static str>>,
    }

    #[async_trait::async_trait]
    impl SandboxProvider for FakeProvider {
        fn info(&self) -> ProviderInfo {
            ProviderInfo {
                kind: "fake".into(),
                label: "Fake".into(),
                isolation: "microvm".into(),
                network_modes: vec!["isolated".into()],
                resource_limits: false,
                remote: false,
            }
        }
        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
        async fn prepare_namespace(&self, _: &str) -> Result<()> {
            Ok(())
        }
        async fn teardown_namespace(&self, _: &str) -> Result<()> {
            Ok(())
        }
        async fn create(&self, _: &str, id: &str, _: &NewSandbox) -> Result<String> {
            self.boxes.lock().unwrap().insert(id.into(), "stopped");
            Ok(format!("fake-{id}"))
        }
        async fn start(&self, _: &str, id: &str) -> Result<()> {
            self.boxes.lock().unwrap().insert(id.into(), "running");
            Ok(())
        }
        async fn resume(&self, ns: &str, id: &str) -> Result<()> {
            self.start(ns, id).await
        }
        async fn pause(&self, _: &str, id: &str) -> Result<()> {
            self.boxes.lock().unwrap().insert(id.into(), "paused");
            Ok(())
        }
        async fn stop(&self, _: &str, id: &str) -> Result<()> {
            self.boxes.lock().unwrap().insert(id.into(), "stopped");
            Ok(())
        }
        async fn remove(&self, _: &str, id: &str) -> Result<()> {
            self.boxes.lock().unwrap().remove(id);
            Ok(())
        }
        async fn status(&self, _: &str, id: &str) -> Result<&'static str> {
            self.boxes.lock().unwrap().get(id).copied().ok_or_else(|| KalypsoError::NotFound(id.into()))
        }
        async fn exec(&self, _: &str, _: &str, _: &[&str], _: bool) -> Result<(i64, String)> {
            Ok((0, String::new()))
        }
        async fn exec_with_stdin(&self, _: &str, _: &str, _: &[&str], _: &[u8]) -> Result<i64> {
            Ok(0)
        }
        async fn open_stream(&self, _: &str, _: &str, _: &[&str]) -> Result<ExecStream> {
            Err(KalypsoError::Runtime("no streams in the fake".into()))
        }
        async fn address(&self, _: &str, _: &str) -> Result<Option<String>> {
            Ok(None)
        }
        fn watch(&self) -> Result<BoxStream<'static, SandboxStatusEvent>> {
            Ok(stream::empty().boxed())
        }
    }

    #[tokio::test]
    async fn a_second_provider_plugs_in_through_the_trait() {
        let fake = Arc::new(FakeProvider::default());
        let rt = Runtime::with(vec![fake.clone()]);
        assert_eq!(rt.kind, "fake");
        assert_eq!(rt.infos()[0].isolation, "microvm");
        let db = Db::open_in_memory().unwrap();
        db.with(|c| Ok(c.execute("INSERT INTO namespaces (id, name) VALUES ('lab','lab')", [])?)).unwrap();

        // The provider's capabilities are enforced: no namespace network here.
        let err = create(&db, &rt, "lab", spec("vm")).await.unwrap_err();
        assert_eq!(err.code(), "invalid");

        let isolated = NewSandbox { network: "isolated".into(), ..spec("vm") };
        let sb = create(&db, &rt, "lab", isolated).await.unwrap();
        assert_eq!((sb.runtime.as_str(), sb.container_id.as_deref()), ("fake", Some(format!("fake-{}", sb.id).as_str())));
        assert_eq!(start(&db, &rt, "lab", &sb.id).await.unwrap().status, "running");
        assert_eq!(pause(&db, &rt, "lab", &sb.id).await.unwrap().status, "paused");
        assert_eq!(start(&db, &rt, "lab", &sb.id).await.unwrap().status, "running");
        assert_eq!(stop(&db, &rt, "lab", &sb.id).await.unwrap().status, "stopped");
        remove(&db, &rt, "lab", &sb.id).await.unwrap();
        assert!(list(&db, "lab").unwrap().is_empty());
        assert!(fake.boxes.lock().unwrap().is_empty());

        // Asking for a provider that isn't installed is a clear error.
        let other = NewSandbox { provider: Some("e2b".into()), ..spec("x") };
        assert_eq!(create(&db, &rt, "lab", other).await.unwrap_err().code(), "runtime");
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

    /// Namespace secrets arrive as private files; agent-scoped ones don't; values never
    /// show up in the container's configuration.
    #[tokio::test]
    async fn secrets_are_delivered_as_files() {
        if std::env::var("KALYPSO_TEST_RUNTIME").is_err() {
            return;
        }
        let rt = Runtime::detect().await;
        let db = Db::open_in_memory().unwrap();
        let vault = Vault::ephemeral();
        let ns = format!("sd{}", &new_id("x")[2..8]);
        db.with(|c| Ok(c.execute("INSERT INTO namespaces (id, name) VALUES (?1, ?1)", [&ns])?)).unwrap();
        vault.create_ns_key(&db, &ns).unwrap();
        let token = vault.set(&db, &ns, "API_TOKEN", "tok-123 with spaces\nand a newline", "namespace").unwrap();
        vault.set(&db, &ns, "AGENT_ONLY", "not-for-everyone", "agent").unwrap();
        vault.set(&db, &ns, "ANTHROPIC_API_KEY", "sk-ant-model-key", "gateway").unwrap();

        let sb = create(&db, &rt, &ns, spec("vaulted")).await.unwrap();
        start(&db, &rt, &ns, &sb.id).await.unwrap();
        // API_TOKEN plus the sandbox's own gateway key.
        assert_eq!(deliver_secrets(&db, &vault, &rt, &ns, &sb.id).await.unwrap(), 2);
        let (_, gk) = exec(&rt, &ns, &sb.id, &["cat", &format!("{SECRETS_DIR}/KALYPSO_GATEWAY_KEY")], false).await.unwrap();
        assert!(gk.starts_with("kx_"));
        let (_, listing) = exec(&rt, &ns, &sb.id, &["sh", "-c", &format!("cat {SECRETS_DIR}/*")], false).await.unwrap();
        assert!(!listing.contains("sk-ant-model-key"), "model keys must stay with the gateway");

        let (_, body) = exec(&rt, &ns, &sb.id, &["cat", &format!("{SECRETS_DIR}/API_TOKEN")], false).await.unwrap();
        assert_eq!(body, "tok-123 with spaces\nand a newline");
        let (_, mode) = exec(&rt, &ns, &sb.id, &["stat", "-c", "%a", &format!("{SECRETS_DIR}/API_TOKEN")], false).await.unwrap();
        assert_eq!(mode.trim(), "600");
        let (missing, _) = exec(&rt, &ns, &sb.id, &["test", "-e", &format!("{SECRETS_DIR}/AGENT_ONLY")], false).await.unwrap();
        assert_ne!(missing, 0, "agent-scoped secrets must not reach every sandbox");

        let inspect = rt.docker().unwrap().inspect_container(&container_name(&ns, &sb.id), None::<InspectContainerOptions>).await.unwrap();
        assert!(!serde_json::to_string(&inspect).unwrap().contains("tok-123"), "secret leaked into container config");

        // Deleting the secret and redelivering removes the file.
        vault.delete(&db, &ns, &token.id).unwrap();
        redeliver_running(&db, &vault, &rt, &ns).await;
        let (gone, _) = exec(&rt, &ns, &sb.id, &["test", "-e", &format!("{SECRETS_DIR}/API_TOKEN")], false).await.unwrap();
        assert_ne!(gone, 0);
        remove(&db, &rt, &ns, &sb.id).await.unwrap();
        rt.remove_network(&ns).await.unwrap();
    }

    /// A sandbox with no network at all reaches a model only through the gateway socket,
    /// and the provider key never enters it.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn sandbox_reaches_the_model_gateway_through_its_socket() {
        use crate::gateway::{pricing::Pricing, summary, Gateway};
        use std::sync::Arc;
        if std::env::var("KALYPSO_TEST_RUNTIME").is_err() {
            return;
        }
        let rt = Runtime::detect().await;
        let db = Arc::new(Db::open_in_memory().unwrap());
        let vault = Arc::new(Vault::ephemeral());
        let ns = format!("gw{}", &new_id("x")[2..8]);
        db.with(|c| Ok(c.execute("INSERT INTO namespaces (id, name) VALUES (?1, ?1)", [&ns])?)).unwrap();
        vault.create_ns_key(&db, &ns).unwrap();

        // A stand-in for the provider that echoes the key it was given.
        let up = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let up_url = format!("http://{}", up.local_addr().unwrap());
        let app = axum::Router::new().fallback(|h: axum::http::HeaderMap| async move {
            let key = h.get("x-api-key").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            axum::Json(serde_json::json!({"model": "claude-opus-5-5", "saw_key": key, "usage": {"input_tokens": 10, "output_tokens": 5}}))
        });
        tokio::spawn(async move { axum::serve(up, app).await.unwrap() });
        vault.set(&db, &ns, "ANTHROPIC_API_KEY", "sk-ant-model-key", "gateway").unwrap();
        vault.set(&db, &ns, "ANTHROPIC_BASE_URL", &up_url, "gateway").unwrap();

        let gw = Gateway::new(db.clone(), vault.clone(), Pricing::builtin());
        // Never removed while tests run: other sandboxes created meanwhile mount it too.
        gw.listen_unix(std::env::temp_dir().join(format!("kalypso-gw-test-{}", std::process::id()))).await.unwrap();

        let mut s = spec("modelcaller");
        s.image = "docker.io/curlimages/curl:8.10.1".into();
        s.network = "isolated".into();
        let sb = create(&db, &rt, &ns, s).await.unwrap();
        start(&db, &rt, &ns, &sb.id).await.unwrap();
        deliver_secrets(&db, &vault, &rt, &ns, &sb.id).await.unwrap();

        let script = format!(
            "curl -sS --unix-socket {}/gateway.sock -H \"x-api-key: $(cat {SECRETS_DIR}/KALYPSO_GATEWAY_KEY)\" \
             -H 'content-type: application/json' -d '{{\"model\":\"claude-opus-5-5\"}}' {}/anthropic/v1/messages",
            crate::gateway::SANDBOX_SOCKET_DIR,
            crate::gateway::SANDBOX_URL,
        );
        let (code, body) = exec(&rt, &ns, &sb.id, &["sh", "-c", &script], false).await.unwrap();
        assert_eq!(code, 0, "{body}");
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["saw_key"], "sk-ant-model-key");
        let (_, everywhere) = exec(&rt, &ns, &sb.id, &["sh", "-c", "grep -rl sk-ant-model-key /run /tmp /work 2>/dev/null; true"], false).await.unwrap();
        assert_eq!(everywhere.trim(), "", "provider key found inside the sandbox");

        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(summary(&db, Some(&ns), 1).unwrap().totals.requests, 1);
        remove(&db, &rt, &ns, &sb.id).await.unwrap();
    }

    /// A port inside a sandbox on an internal network is reachable on 127.0.0.1 through a forward.
    #[tokio::test]
    async fn port_forward_reaches_a_server_inside() {
        if std::env::var("KALYPSO_TEST_RUNTIME").is_err() {
            return;
        }
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let rt = Runtime::detect().await;
        let db = Db::open_in_memory().unwrap();
        let ns = format!("pf{}", &new_id("x")[2..8]);
        db.with(|c| Ok(c.execute("INSERT INTO namespaces (id, name) VALUES (?1, ?1)", [&ns])?)).unwrap();
        let sb = create(&db, &rt, &ns, spec("web")).await.unwrap();
        start(&db, &rt, &ns, &sb.id).await.unwrap();
        let server = "while true; do printf 'HTTP/1.0 200 OK\\r\\n\\r\\nhello from the sandbox' | nc -l -p 8080; done";
        exec(&rt, &ns, &sb.id, &["sh", "-c", server], true).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let fwd = crate::forward::Forwards::default();
        let f = fwd.open(rt.provider(&sb.runtime).unwrap(), &ns, &sb.id, 8080).await.unwrap();
        assert_eq!(fwd.open(rt.provider(&sb.runtime).unwrap(), &ns, &sb.id, 8080).await.unwrap(), f);

        let mut conn = tokio::net::TcpStream::connect(("127.0.0.1", f.host_port)).await.unwrap();
        conn.write_all(b"GET / HTTP/1.0\r\n\r\n").await.unwrap();
        let mut got = Vec::new();
        let read = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let mut buf = [0u8; 1024];
            while !String::from_utf8_lossy(&got).contains("hello") {
                let n = conn.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                got.extend_from_slice(&buf[..n]);
            }
        })
        .await;
        assert!(read.is_ok(), "timed out; got {:?}", String::from_utf8_lossy(&got));
        assert!(String::from_utf8_lossy(&got).contains("hello from the sandbox"));

        fwd.close_sandbox(&sb.id);
        assert!(fwd.list(&ns).is_empty());
        remove(&db, &rt, &ns, &sb.id).await.unwrap();
        rt.remove_network(&ns).await.unwrap();
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

    /// Changes made outside KALYPSO (here: straight through the engine API) arrive as events.
    #[tokio::test]
    async fn engine_events_reach_the_watcher() {
        if std::env::var("KALYPSO_TEST_RUNTIME").is_err() {
            return;
        }
        let rt = Runtime::detect().await;
        let db = Db::open_in_memory().unwrap();
        let ns = format!("ev{}", &new_id("x")[2..8]);
        db.with(|c| Ok(c.execute("INSERT INTO namespaces (id, name) VALUES (?1, ?1)", [&ns])?)).unwrap();
        let sb = create(&db, &rt, &ns, spec("watched")).await.unwrap();

        let mut events = Box::pin(rt.watch().unwrap());
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        rt.docker().unwrap().start_container(&container_name(&ns, &sb.id), None::<StartContainerOptions<String>>).await.unwrap();

        let got = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let ev = events.next().await.expect("event stream ended");
                if ev.id == sb.id && ev.status == "running" {
                    return ev;
                }
            }
        })
        .await
        .expect("no start event within 10s");
        assert_eq!(got.ns, ns);
        assert!(apply_event(&db, &got).unwrap());
        assert_eq!(list(&db, &ns).unwrap()[0].status, "running");

        remove(&db, &rt, &ns, &sb.id).await.unwrap();
        rt.remove_network(&ns).await.unwrap();
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
