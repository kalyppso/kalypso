//! Pushes changes from the core to the UI as Tauri events, so views update
//! without polling. Event names are part of the IPC contract.

use std::time::Duration;

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, Manager};

use crate::ipc::AppState;
use crate::sandbox::SandboxStatusEvent;

pub const SANDBOX_STATUS: &str = "sandbox://status";
pub const USAGE: &str = "usage://event";
pub const BUDGET_ALERT: &str = "budget://alert";
pub const POLICY_APPROVAL: &str = "policy://approval";
pub const POLICY_LOG: &str = "policy://log";
pub const AGENT_UPDATE: &str = "agent://update";

/// Follow the container engine's event stream for the life of the app,
/// reconnecting with backoff if the engine restarts.
/// Emitted when a container engine connects after KALYPSO started.
pub const ENGINE: &str = "core://engine";

/// While no container engine is connected, look for one every few seconds. When one answers,
/// prepare every namespace's network, start watching sandbox events and tell the UI.
pub fn spawn_engine_watcher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let state = app.state::<AppState>();
            if state.rt.available() {
                return;
            }
            if state.rt.reconnect().await {
                let kind = state.rt.kind();
                tracing::info!(runtime = %kind, "container engine connected");
                for n in crate::ns::list(&state.db).unwrap_or_default() {
                    if let Err(e) = state.rt.ensure_network(&n.id).await {
                        tracing::warn!(ns = %n.id, error = %e, "could not prepare namespace network");
                    }
                }
                spawn_sandbox_watcher(app.clone());
                let _ = app.emit(ENGINE, &kind);
                return;
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
}

pub fn spawn_sandbox_watcher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut backoff = Duration::from_secs(1);
        loop {
            let stream = match app.state::<AppState>().rt.watch() {
                Ok(s) => s,
                Err(_) => return, // No runtime: nothing to watch.
            };
            tracing::info!("watching sandbox events");
            let mut stream = Box::pin(stream);
            while let Some(ev) = stream.next().await {
                backoff = Duration::from_secs(1);
                forward(&app, ev);
            }
            tracing::warn!(retry_in = ?backoff, "sandbox event stream ended");
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(30));
        }
    });
}

fn forward(app: &AppHandle, ev: SandboxStatusEvent) {
    match crate::sandbox::apply_event(&app.state::<AppState>().db, &ev) {
        Ok(true) => {
            if let Err(e) = app.emit(SANDBOX_STATUS, &ev) {
                tracing::warn!(error = %e, "could not emit sandbox status");
            }
        }
        Ok(false) => {} // Already known, or a sandbox this database no longer has.
        Err(e) => tracing::warn!(error = %e, "could not record sandbox status"),
    }
}

/// Tell the UI about every metered model request, so spend updates live.
pub fn spawn_usage_events(app: AppHandle, mut rx: tokio::sync::broadcast::Receiver<crate::gateway::UsageEvent>) {
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    let _ = app.emit(USAGE, &ev);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return,
            }
        }
    });
}

/// Budget alerts become desktop notifications, and an event so open views refresh.
pub fn spawn_budget_alerts(app: AppHandle, mut rx: tokio::sync::broadcast::Receiver<crate::gateway::BudgetAlert>) {
    use tauri_plugin_notification::NotificationExt;
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(alert) => {
                    tracing::info!(ns = %alert.ns, message = %alert.message, "budget alert");
                    if wants(&app, "notifyBudget") {
                        if let Err(e) =
                            app.notification().builder().title(format!("KALYPSO budget, {}", alert.ns)).body(&alert.message).show()
                        {
                            tracing::warn!(error = %e, "could not show a desktop notification");
                        }
                    }
                    let _ = app.emit(BUDGET_ALERT, &alert);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return,
            }
        }
    });
}

/// A call waiting for approval becomes a desktop notification and an in-app prompt;
/// every logged decision tells open views to refresh.
pub fn spawn_policy_events(
    app: AppHandle,
    mut approvals: tokio::sync::broadcast::Receiver<crate::policy::ApprovalRequest>,
    mut log: tokio::sync::broadcast::Receiver<String>,
) {
    use tauri_plugin_notification::NotificationExt;
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match approvals.recv().await {
                Ok(req) => {
                    let body = format!("{} wants to run {}. Open KALYPSO to approve or deny.", req.source, req.action);
                    if wants(&handle, "notifyApprovals") {
                        if let Err(e) = handle.notification().builder().title(format!("Approval needed: {}", req.policy)).body(body).show()
                        {
                            tracing::warn!(error = %e, "could not show a desktop notification");
                        }
                    }
                    let _ = handle.emit(POLICY_APPROVAL, &req);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return,
            }
        }
    });
    tauri::async_runtime::spawn(async move {
        loop {
            match log.recv().await {
                Ok(ns) => {
                    let _ = app.emit(POLICY_LOG, &ns);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return,
            }
        }
    });
}

/// A desktop-notification switch from the user's preferences (Settings → Preferences). On unless turned off.
fn wants(app: &AppHandle, key: &str) -> bool {
    let prefs = app.state::<AppState>().db.setting("preferences").ok().flatten();
    prefs.as_ref().and_then(|p| p.get(key)).and_then(|v| v.as_bool()).unwrap_or(true)
}

/// Agent status changes and transcript lines go to the UI; budget blocks from the
/// gateway pause the agents in the blocked sandbox.
pub fn spawn_agent_events(
    app: AppHandle,
    agents: std::sync::Arc<crate::agent::supervisor::Supervisor>,
    mut blocks: tokio::sync::broadcast::Receiver<crate::gateway::BudgetBlocked>,
) {
    let mut updates = agents.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match updates.recv().await {
                Ok(u) => {
                    let _ = app.emit(AGENT_UPDATE, &u);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return,
            }
        }
    });
    tauri::async_runtime::spawn(async move {
        loop {
            match blocks.recv().await {
                Ok(b) => agents.on_budget_block(&b.ns, &b.key_id, &b.reason).await,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return,
            }
        }
    });
}
