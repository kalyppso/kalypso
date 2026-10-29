// KALYPSO core. Phase 1 services: SQLite store, namespaces, secrets vault and
// sandboxes on Docker or Podman. See docs/ARCHITECTURE.md and the Roadmap issue.

pub mod error;
pub mod ipc;
pub mod ns;
pub mod sandbox;
pub mod store;
pub mod vault;

use tauri::Manager;

use crate::ipc::AppState;

const SEED: &[(&str, &str)] = &[("personal", "Side projects and experiments"), ("work", "Client agents, production credentials")];

/// Every IPC command the frontend may call. Shared by the app and the IPC tests.
pub fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        ipc::core_info,
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
    ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "kalypso_lib=info".into()))
        .init();

    register(tauri::Builder::default())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
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
            app.manage(AppState { db, vault, rt });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running KALYPSO");
}
