// KALYPSO core. Phase 1 services: SQLite store, namespaces, secrets vault and
// sandboxes on Docker or Podman. See docs/ARCHITECTURE.md and the Roadmap issue.

pub mod error;
pub mod events;
pub mod forward;
pub mod ipc;
pub mod ns;
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
    register(tauri::Builder::default())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            init_logging(&dir.join("logs"));
            let db = store::Db::open(&dir.join("kalypso.db"))?;
            let vault = vault::Vault::load(&dir)?;
            let rt = tauri::async_runtime::block_on(sandbox::Runtime::detect());
            tracing::info!(data = %dir.display(), runtime = %rt.kind, key = ?vault.source, "core ready");

            // First run: start with the two namespaces the prototype shows.
            if ns::list(&db)?.is_empty() {
                for (id, desc) in SEED {
                    tauri::async_runtime::block_on(ns::create(&db, &vault, &rt, id, desc))?;
                }
            }
            // Networks can vanish (engine reset, manual cleanup); make sure every namespace has one.
            if rt.available() {
                for n in ns::list(&db)? {
                    if let Err(e) = tauri::async_runtime::block_on(rt.ensure_network(&n.id)) {
                        tracing::warn!(ns = %n.id, error = %e, "could not ensure namespace network");
                    }
                }
            }
            app.manage(AppState { db, vault, rt, forwards: Default::default() });
            events::spawn_sandbox_watcher(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running KALYPSO");
}
