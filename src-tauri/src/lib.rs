// KALYPSO core. Phase 1 services: SQLite store, namespaces, secrets vault and
// sandboxes on Docker or Podman. See docs/ARCHITECTURE.md and the Roadmap issue.

pub mod budget;
pub mod error;
pub mod events;
pub mod forward;
pub mod gateway;
pub mod ipc;
pub mod ns;
pub mod policy;
pub mod sandbox;
pub mod store;
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
        ipc::policy_pending,
        ipc::policy_decide,
        ipc::sandbox_providers,
        ipc::sandbox_list,
        ipc::sandbox_create,
        ipc::sandbox_start,
        ipc::sandbox_pause,
        ipc::sandbox_stop,
        ipc::sandbox_delete,
        ipc::port_forward_open,
        ipc::port_forward_list,
        ipc::port_forward_close,
    ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    register(tauri::Builder::default().plugin(tauri_plugin_notification::init()))
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            init_logging(&dir.join("logs"));
            let db = std::sync::Arc::new(store::Db::open(&dir.join("kalypso.db"))?);
            let vault = std::sync::Arc::new(vault::Vault::load(&dir)?);
            let rt = tauri::async_runtime::block_on(sandbox::Runtime::detect());
            tracing::info!(data = %dir.display(), runtime = %rt.kind, key = ?vault.source, "core ready");

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
                // Sandboxes reach the gateway through this socket (Linux engines can mount it).
                #[cfg(target_os = "linux")]
                if let Err(e) = gw.listen_unix(dir.join("run")).await {
                    tracing::warn!(error = %e, "model gateway socket unavailable; sandboxes cannot reach the gateway");
                }
            });
            events::spawn_usage_events(app.handle().clone(), gw.subscribe());
            events::spawn_budget_alerts(app.handle().clone(), gw.subscribe_alerts());
            events::spawn_policy_events(app.handle().clone(), gw.approvals.subscribe(), gw.subscribe_policy_log());
            app.manage(AppState { db, vault, rt, forwards: Default::default(), gateway: gw });
            events::spawn_sandbox_watcher(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running KALYPSO");
}
