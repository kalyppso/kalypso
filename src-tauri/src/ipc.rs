//! Tauri commands. Every command that touches namespaced data takes `ns` first;
//! the services check ownership so a buggy view can't cross namespaces.

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::budget::{self, Budget, BudgetOverview, BudgetRule, NewBudgetRule};
use crate::error::{KalypsoError, Result};
use crate::forward::{Forwards, PortForward};
use crate::gateway::{self, Gateway, GatewayInfo, GatewayKey, MintedKey, UsageSummary};
use crate::ns::{self, Namespace};
use crate::policy::{self, ApprovalRequest, NewPolicy, Policy, PolicyEvent, PolicyPatch};
use crate::sandbox::{self, NewSandbox, ProviderInfo, Runtime, SandboxRecord};
use crate::store::{AuditEntry, Db};
use crate::terminal::Terminals;
use crate::vault::{KeySource, SecretMeta, Vault};

pub struct AppState {
    pub db: Arc<Db>,
    pub vault: Arc<Vault>,
    pub rt: Runtime,
    pub forwards: Forwards,
    pub gateway: Arc<Gateway>,
    pub terminals: Terminals,
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

// ---------- Model gateway ----------

#[tauri::command]
pub fn gateway_info(s: State<'_, AppState>) -> GatewayInfo {
    s.gateway.info()
}

#[tauri::command]
pub fn gateway_key_list(s: State<'_, AppState>, ns: String) -> Result<Vec<GatewayKey>> {
    ensure_ns(&s, &ns)?;
    gateway::list_keys(&s.db, &ns)
}

/// A key for a tool outside KALYPSO. The token is returned once and never again.
#[tauri::command]
pub fn gateway_key_create(s: State<'_, AppState>, ns: String, label: String) -> Result<MintedKey> {
    ensure_ns(&s, &ns)?;
    gateway::mint(&s.db, &ns, None, &label)
}

#[tauri::command]
pub fn gateway_key_revoke(s: State<'_, AppState>, ns: String, id: String) -> Result<()> {
    ensure_ns(&s, &ns)?;
    gateway::revoke_key(&s.db, &ns, &id)
}

/// Spend over the last `days` days; all namespaces when `ns` is omitted.
#[tauri::command]
pub fn usage_summary(s: State<'_, AppState>, ns: Option<String>, days: Option<u32>) -> Result<UsageSummary> {
    if let Some(ns) = &ns {
        ensure_ns(&s, ns)?;
    }
    gateway::summary(&s.db, ns.as_deref(), days.unwrap_or(30))
}

/// Models with a price in pricing.toml, for picking a downgrade target.
#[tauri::command]
pub fn pricing_models(s: State<'_, AppState>) -> Vec<String> {
    s.gateway.pricing.table().models()
}

// ---------- Budgets ----------

#[tauri::command]
pub fn budget_overview(s: State<'_, AppState>, ns: String) -> Result<BudgetOverview> {
    ensure_ns(&s, &ns)?;
    budget::overview(&s.db, &ns)
}

/// `monthly_limit` in millionths of a dollar (0 for none); `alert_at` as a fraction.
#[tauri::command]
pub fn budget_set(s: State<'_, AppState>, ns: String, monthly_limit: i64, alert_at: f64) -> Result<Budget> {
    ensure_ns(&s, &ns)?;
    budget::set(&s.db, &ns, monthly_limit, alert_at)
}

#[tauri::command]
pub fn budget_rule_create(s: State<'_, AppState>, ns: String, rule: NewBudgetRule) -> Result<BudgetRule> {
    ensure_ns(&s, &ns)?;
    budget::create_rule(&s.db, &ns, rule)
}

#[tauri::command]
pub fn budget_rule_delete(s: State<'_, AppState>, ns: String, id: String) -> Result<()> {
    ensure_ns(&s, &ns)?;
    budget::delete_rule(&s.db, &ns, &id)
}

// ---------- Policies ----------

/// The namespace's policies and the ones that apply everywhere.
#[tauri::command]
pub fn policy_list(s: State<'_, AppState>, ns: String) -> Result<Vec<Policy>> {
    ensure_ns(&s, &ns)?;
    policy::list(&s.db, &ns)
}

#[tauri::command]
pub fn policy_create(s: State<'_, AppState>, ns: String, policy: NewPolicy) -> Result<Policy> {
    ensure_ns(&s, &ns)?;
    policy::create(&s.db, &ns, policy)
}

#[tauri::command]
pub fn policy_update(s: State<'_, AppState>, ns: String, id: String, patch: PolicyPatch) -> Result<Policy> {
    ensure_ns(&s, &ns)?;
    policy::update(&s.db, &ns, &id, patch)
}

#[tauri::command]
pub fn policy_delete(s: State<'_, AppState>, ns: String, id: String) -> Result<()> {
    ensure_ns(&s, &ns)?;
    policy::delete(&s.db, &ns, &id)
}

/// Newest first.
#[tauri::command]
pub fn policy_events(s: State<'_, AppState>, ns: String, limit: Option<u32>) -> Result<Vec<PolicyEvent>> {
    ensure_ns(&s, &ns)?;
    policy::events(&s.db, &ns, limit.unwrap_or(200))
}

/// Calls waiting for the user's decision.
#[tauri::command]
pub fn policy_pending(s: State<'_, AppState>, ns: String) -> Result<Vec<ApprovalRequest>> {
    ensure_ns(&s, &ns)?;
    Ok(s.gateway.approvals.pending(&ns))
}

/// Answer a waiting call. `remember` approves the same policy for the rest of the run.
#[tauri::command]
pub fn policy_decide(s: State<'_, AppState>, ns: String, id: String, approve: bool, remember: Option<bool>) -> Result<()> {
    ensure_ns(&s, &ns)?;
    s.gateway.approvals.decide(&ns, &id, approve, remember.unwrap_or(false))?;
    s.db.audit(Some(&ns), "user", if approve { "policy.approve" } else { "policy.deny" }, &id)
}

// ---------- Sandboxes ----------

/// Sandbox providers available on this machine, default first.
#[tauri::command]
pub fn sandbox_providers(s: State<'_, AppState>) -> Vec<ProviderInfo> {
    s.rt.infos()
}

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
    let rec = sandbox::stop(&s.db, &s.rt, &ns, &id).await?;
    s.forwards.close_sandbox(&id);
    s.terminals.close_sandbox(&ns, &id);
    Ok(rec)
}

#[tauri::command]
pub async fn sandbox_delete(s: State<'_, AppState>, ns: String, id: String) -> Result<()> {
    sandbox::remove(&s.db, &s.rt, &ns, &id).await?;
    s.forwards.close_sandbox(&id);
    s.terminals.close_sandbox(&ns, &id);
    Ok(())
}

// ---------- Terminals ----------

/// Open a shell for `pane` in a running sandbox. Output arrives as base64 on
/// `term://data/<pane>`; `term://exit/<pane>` fires when the shell ends.
#[tauri::command]
pub async fn term_open<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    s: State<'_, AppState>,
    ns: String,
    sandbox_id: String,
    pane: String,
    rows: u16,
    cols: u16,
) -> Result<()> {
    use base64::Engine;
    use tauri::Emitter;
    ensure_ns(&s, &ns)?;
    let (data_app, exit_app) = (app.clone(), app);
    let (data_event, exit_event) = (format!("term://data/{pane}"), format!("term://exit/{pane}"));
    s.terminals
        .open(
            &s.db,
            &s.rt,
            &ns,
            &sandbox_id,
            &pane,
            rows,
            cols,
            move |bytes| {
                let _ = data_app.emit(&data_event, base64::engine::general_purpose::STANDARD.encode(bytes));
            },
            move || {
                let _ = exit_app.emit(&exit_event, ());
            },
        )
        .await
}

#[tauri::command]
pub async fn term_write(s: State<'_, AppState>, ns: String, pane: String, data: String) -> Result<()> {
    s.terminals.write(&ns, &pane, data.as_bytes()).await
}

#[tauri::command]
pub async fn term_resize(s: State<'_, AppState>, ns: String, pane: String, rows: u16, cols: u16) -> Result<()> {
    s.terminals.resize(&ns, &pane, rows, cols).await
}

#[tauri::command]
pub async fn term_close(s: State<'_, AppState>, ns: String, pane: String) -> Result<bool> {
    Ok(s.terminals.close(&ns, &pane).await)
}

// ---------- Port forwarding ----------

#[tauri::command]
pub async fn port_forward_open(s: State<'_, AppState>, ns: String, id: String, port: u16) -> Result<PortForward> {
    let rec = sandbox::get(&s.db, &ns, &id)?;
    if rec.status != "running" {
        return Err(KalypsoError::Invalid(format!("start {} before forwarding a port", rec.name)));
    }
    s.forwards.open(s.rt.provider(&rec.runtime)?, &ns, &id, port).await
}

#[tauri::command]
pub fn port_forward_list(s: State<'_, AppState>, ns: String) -> Result<Vec<PortForward>> {
    ensure_ns(&s, &ns)?;
    Ok(s.forwards.list(&ns))
}

#[tauri::command]
pub fn port_forward_close(s: State<'_, AppState>, ns: String, id: String, port: u16) -> Result<bool> {
    sandbox::get(&s.db, &ns, &id)?;
    Ok(s.forwards.close(&id, port))
}
