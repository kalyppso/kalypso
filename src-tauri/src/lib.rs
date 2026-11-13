// KALYPSO core. Phase 1 services: SQLite store, namespaces, secrets vault and
// sandboxes on Docker or Podman. See docs/ARCHITECTURE.md and the Roadmap issue.

pub mod agent;
pub mod budget;
pub mod error;
pub mod events;
pub mod forward;
pub mod gateway;
pub mod github;
pub mod ipc;
pub mod ns;
pub mod policy;
pub mod repo;
pub mod sandbox;
pub mod setup;
pub mod store;
pub mod terminal;
pub mod vault;

use tauri::Manager;

use crate::ipc::AppState;

const SEED: &[(&str, &str)] = &[("personal", "Side projects and experiments"), ("work", "Client agents, production credentials")];

/// Log to stderr and to a daily file in `<app data>/logs`, keeping the last week.
fn init_logging(dir: &std::path::Path) {
    use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
    static GUARD: std::sync::OnceLock<tracing_appender::non_blocking::WorkerGuard> = std::sync::OnceLock::new();

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| "kalypso_lib=info".into());
    let file = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("kalypso")
        .filename_suffix("log")
        .max_log_files(7)
        .build(dir);
    let registry = tracing_subscriber::registry().with(filter).with(fmt::layer());
    match file {
        Ok(appender) => {
            let (writer, guard) = tracing_appender::non_blocking(appender);
            let _ = GUARD.set(guard); // flushes the file on exit
            let _ = registry.with(fmt::layer().with_ansi(false).with_writer(writer)).try_init();
        }
        Err(e) => {
            let _ = registry.try_init();
            tracing::warn!(error = %e, "could not open the log file; logging to stderr only");
        }
    }
}

/// Every IPC command the frontend may call. Shared by the app and the IPC tests.
pub fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        ipc::core_info,
        ipc::gh_info,
        ipc::gh_accounts,
        ipc::gh_connect_token,
        ipc::gh_device_start,
        ipc::gh_device_poll,
        ipc::gh_account_rename,
        ipc::gh_account_namespaces,
        ipc::gh_account_remove,
        ipc::gh_account_check,
        ipc::gh_repos,
        ipc::agent_pull_requests,
        ipc::setup_engine,
        ipc::setup_key_check,
        ipc::app_restart,
        ipc::audit_list,
        ipc::settings_get,
        ipc::settings_set,
        ipc::ns_list,
        ipc::ns_create,
        ipc::ns_delete,
        ipc::secret_list,
        ipc::secret_set,
        ipc::secret_reveal,
        ipc::secret_delete,
        ipc::gateway_info,
        ipc::gateway_key_list,
        ipc::gateway_key_create,
        ipc::gateway_key_revoke,
        ipc::usage_summary,
        ipc::pricing_models,
        ipc::budget_overview,
        ipc::budget_set,
        ipc::budget_rule_create,
        ipc::budget_rule_delete,
        ipc::policy_list,
        ipc::policy_create,
        ipc::policy_update,
        ipc::policy_delete,
        ipc::policy_events,
        ipc::secret_grants,
        ipc::secret_grant_revoke,
        ipc::policy_pending,
        ipc::policy_decide,
        ipc::sandbox_providers,
        ipc::sandbox_list,
        ipc::sandbox_create,
        ipc::sandbox_start,
        ipc::sandbox_pause,
        ipc::sandbox_stop,
        ipc::sandbox_delete,
        ipc::agent_list,
        ipc::agent_create,
        ipc::agent_update,
        ipc::agent_delete,
        ipc::agent_start,
        ipc::agent_stop,
        ipc::agent_pause,
        ipc::agent_resume,
        ipc::agent_send,
        ipc::agent_runs,
        ipc::agent_events,
        ipc::master_get,
        ipc::master_ensure,
        ipc::master_new_chat,
        ipc::term_open,
        ipc::term_write,
        ipc::term_resize,
        ipc::term_close,
        ipc::port_forward_open,
        ipc::port_forward_list,
        ipc::port_forward_close,
    ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    register(
        tauri::Builder::default()
            .plugin(tauri_plugin_notification::init())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_opener::init()),
    )
    .setup(|app| {
        let dir = app.path().app_data_dir()?;
        std::fs::create_dir_all(&dir)?;
        init_logging(&dir.join("logs"));
        // The window starts hidden and the page shows it once its first frame is painted,
        // so it never opens blank. If the page fails to load, show it anyway.
        if let Some(win) = app.get_webview_window("main") {
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                if !win.is_visible().unwrap_or(true) {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            });
        }
        let db = std::sync::Arc::new(store::Db::open(&dir.join("kalypso.db"))?);
        let vault = std::sync::Arc::new(vault::Vault::load(&dir)?);
        let rt = tauri::async_runtime::block_on(sandbox::Runtime::detect());
        tracing::info!(data = %dir.display(), runtime = %rt.kind(), key = ?vault.source, "core ready");

        // First run: start with the two namespaces the prototype shows.
        if ns::list(&db)?.is_empty() {
            for (id, desc) in SEED {
                tauri::async_runtime::block_on(ns::create(&db, &vault, &rt, id, desc))?;
            }
        }
        // Namespaces made before policies existed get the defaults once.
        for n in ns::list(&db)? {
            policy::seed_defaults(&db, &n.id)?;
        }
        // Networks can vanish (engine reset, manual cleanup); make sure every namespace has one.
        if rt.available() {
            for n in ns::list(&db)? {
                if let Err(e) = tauri::async_runtime::block_on(rt.ensure_network(&n.id)) {
                    tracing::warn!(ns = %n.id, error = %e, "could not ensure namespace network");
                }
            }
        }
        let gw = gateway::Gateway::new(db.clone(), vault.clone(), gateway::pricing::Pricing::load(&dir)?);
        tauri::async_runtime::block_on(async {
            if let Err(e) = gw.listen_tcp(gateway::DEFAULT_PORT).await {
                tracing::error!(error = %e, "model gateway could not start");
            }
            // Engines in a VM (Docker Desktop, Podman machine) reach it through a relay to this port.
            if let Err(e) = gw.listen_sandbox_tcp().await {
                tracing::warn!(error = %e, "sandbox gateway port unavailable; sandboxes on VM engines cannot reach the gateway");
            }
            // Sandboxes reach the gateway through this socket (Linux engines can mount it).
            #[cfg(target_os = "linux")]
            if let Err(e) = gw.listen_unix(dir.join("run")).await {
                tracing::warn!(error = %e, "model gateway socket unavailable; sandboxes cannot reach the gateway");
            }
        });
        // Approved secret commands (#87) run in sandboxes through the engine.
        gw.set_runtime(rt.clone());
        events::spawn_usage_events(app.handle().clone(), gw.subscribe());
        events::spawn_budget_alerts(app.handle().clone(), gw.subscribe_alerts());
        events::spawn_policy_events(app.handle().clone(), gw.approvals.subscribe(), gw.subscribe_policy_log());
        // Agents that were running when KALYPSO quit aren't supervised any more.
        gateway::secrets::reset_after_restart(&db)?;
        let reset = agent::reset_after_restart(&db)?;
        if reset > 0 {
            tracing::info!(agents = reset, "marked agents from the last session as stopped");
        }
        let agents = agent::supervisor::Supervisor::new(db.clone(), vault.clone(), rt.clone());
        // The master agent manages the others through the gateway.
        gw.set_agents(agents.clone());
        events::spawn_agent_events(app.handle().clone(), agents.clone(), gw.subscribe_blocks());
        // GitHub accounts (#100): checked as KALYPSO starts, then hourly, so a revoked token
        // shows "Reconnect" and expiring ones are refreshed before they lapse.
        let github = github::GitHub::default();
        {
            let (db, vault, github) = (db.clone(), vault.clone(), github.clone());
            tauri::async_runtime::spawn(async move {
                loop {
                    github::check_all(&db, &vault, &github).await;
                    tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
                }
            });
        }
        app.manage(AppState { db, vault, rt, forwards: Default::default(), gateway: gw, terminals: Default::default(), agents, github });
        events::spawn_sandbox_watcher(app.handle().clone());
        // No engine yet (Podman or Docker not running, or started after KALYPSO): keep looking,
        // and connect as soon as one answers, without a restart.
        events::spawn_engine_watcher(app.handle().clone());
        Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running KALYPSO");
}
