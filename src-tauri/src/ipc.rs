//! Tauri commands. Every command that touches namespaced data takes `ns` first;
//! the services check ownership so a buggy view can't cross namespaces.

use serde::Serialize;
use tauri::State;

use crate::error::{KalypsoError, Result};
use crate::ns::{self, Namespace};
use crate::sandbox::{self, NewSandbox, Runtime, SandboxRecord};
use crate::store::{AuditEntry, Db};
use crate::vault::{KeySource, SecretMeta, Vault};

pub struct AppState {
    pub db: Db,
    pub vault: Vault,
    pub rt: Runtime,
}

fn ensure_ns(s: &AppState, ns: &str) -> Result<()> {
    if ns::exists(&s.db, ns)? {
        Ok(())
    } else {
        Err(KalypsoError::NotFound(format!("namespace {ns}")))
    }
}

#[derive(Serialize)]
pub struct CoreInfo {
    version: &'static str,
    runtime: String,
    key_source: KeySource,
}

#[tauri::command]
pub fn core_info(s: State<'_, AppState>) -> CoreInfo {
    CoreInfo { version: env!("CARGO_PKG_VERSION"), runtime: s.rt.kind.clone(), key_source: s.vault.source }
}

// ---------- Audit log ----------

#[tauri::command]
pub fn audit_list(s: State<'_, AppState>, ns: Option<String>, action: Option<String>, limit: Option<u32>) -> Result<Vec<AuditEntry>> {
    s.db.audit_list(ns.as_deref(), action.as_deref(), limit.unwrap_or(200))
}

// ---------- Settings ----------

#[tauri::command]
pub fn settings_get(s: State<'_, AppState>, key: String) -> Result<Option<serde_json::Value>> {
    s.db.setting(&key)
}

#[tauri::command]
pub fn settings_set(s: State<'_, AppState>, key: String, value: serde_json::Value) -> Result<()> {
    s.db.set_setting(&key, &value)
}

// ---------- Namespaces ----------

#[tauri::command]
pub fn ns_list(s: State<'_, AppState>) -> Result<Vec<Namespace>> {
    ns::list(&s.db)
}

#[tauri::command]
pub async fn ns_create(s: State<'_, AppState>, id: String, description: String) -> Result<Namespace> {
    ns::create(&s.db, &s.vault, &s.rt, &id, &description).await
}

#[tauri::command]
pub async fn ns_delete(s: State<'_, AppState>, ns: String) -> Result<()> {
    ns::delete(&s.db, &s.rt, &ns).await
}

// ---------- Secrets ----------

#[tauri::command]
pub fn secret_list(s: State<'_, AppState>, ns: String) -> Result<Vec<SecretMeta>> {
    ensure_ns(&s, &ns)?;
    s.vault.list(&s.db, &ns)
}

#[tauri::command]
pub async fn secret_set(s: State<'_, AppState>, ns: String, key: String, value: String, scope: String) -> Result<SecretMeta> {
    ensure_ns(&s, &ns)?;
    let meta = s.vault.set(&s.db, &ns, &key, &value, &scope)?;
    sandbox::redeliver_running(&s.db, &s.vault, &s.rt, &ns).await;
    Ok(meta)
}

#[tauri::command]
pub fn secret_reveal(s: State<'_, AppState>, ns: String, id: String) -> Result<String> {
    ensure_ns(&s, &ns)?;
    s.vault.reveal(&s.db, &ns, &id)
}

#[tauri::command]
pub async fn secret_delete(s: State<'_, AppState>, ns: String, id: String) -> Result<()> {
    ensure_ns(&s, &ns)?;
    s.vault.delete(&s.db, &ns, &id)?;
    sandbox::redeliver_running(&s.db, &s.vault, &s.rt, &ns).await;
    Ok(())
}

// ---------- Sandboxes ----------

#[tauri::command]
pub fn sandbox_list(s: State<'_, AppState>, ns: String) -> Result<Vec<SandboxRecord>> {
    ensure_ns(&s, &ns)?;
    sandbox::list(&s.db, &ns)
}

#[tauri::command]
pub async fn sandbox_create(s: State<'_, AppState>, ns: String, spec: NewSandbox) -> Result<SandboxRecord> {
    ensure_ns(&s, &ns)?;
    sandbox::create(&s.db, &s.rt, &ns, spec).await
}

#[tauri::command]
pub async fn sandbox_start(s: State<'_, AppState>, ns: String, id: String) -> Result<SandboxRecord> {
    let rec = sandbox::start(&s.db, &s.rt, &ns, &id).await?;
    // The secrets folder is in memory, so it is empty after every (re)start.
    sandbox::deliver_secrets(&s.db, &s.vault, &s.rt, &ns, &id).await?;
    Ok(rec)
}

#[tauri::command]
pub async fn sandbox_pause(s: State<'_, AppState>, ns: String, id: String) -> Result<SandboxRecord> {
    sandbox::pause(&s.db, &s.rt, &ns, &id).await
}

#[tauri::command]
pub async fn sandbox_stop(s: State<'_, AppState>, ns: String, id: String) -> Result<SandboxRecord> {
    sandbox::stop(&s.db, &s.rt, &ns, &id).await
}

#[tauri::command]
pub async fn sandbox_delete(s: State<'_, AppState>, ns: String, id: String) -> Result<()> {
    sandbox::remove(&s.db, &s.rt, &ns, &id).await
}
