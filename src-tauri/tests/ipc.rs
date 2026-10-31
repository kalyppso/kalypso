//! Drives the real command handlers through Tauri's IPC layer with the exact
//! JSON the frontend sends (src/backend.ts), so argument names and shapes stay in sync.
//!
//! Not built on Windows: tauri-build embeds the Common Controls v6 manifest only
//! into the app binary, so a separate test binary that boots the Tauri runtime
//! exits with STATUS_ENTRYPOINT_NOT_FOUND. The IPC contract is the same on every
//! platform and is covered on Linux and macOS.
#![cfg(not(windows))]

use std::sync::Arc;

use kalypso_lib::gateway::{pricing::Pricing, Gateway};
use kalypso_lib::{ipc::AppState, register, sandbox::Runtime, store::Db, vault::Vault};
use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{Manager, WebviewWindow, WebviewWindowBuilder};

fn app() -> WebviewWindow<tauri::test::MockRuntime> {
    // The real context: tauri.conf.json and capabilities/, so permissions match the app.
    let app = register(mock_builder()).build(tauri::generate_context!()).unwrap();
    let db = Arc::new(Db::open_in_memory().unwrap());
    let vault = Arc::new(Vault::ephemeral());
    let gateway = Gateway::new(db.clone(), vault.clone(), Pricing::builtin());
    app.manage(AppState { db, vault, rt: Runtime::none(), forwards: Default::default(), gateway, terminals: Default::default() });
    WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap()
}

fn call(w: &WebviewWindow<tauri::test::MockRuntime>, cmd: &str, args: Value) -> Result<Value, Value> {
    get_ipc_response(
        w,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            // The origin the app loads from on Linux and macOS; remote origins are ACL-checked.
            url: "tauri://localhost".parse().unwrap(),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|b| b.deserialize::<Value>().unwrap())
}

#[test]
fn namespaces_and_secrets_over_ipc() {
    let w = app();
    let ns = call(&w, "ns_create", json!({ "id": "work", "description": "Client agents" })).unwrap();
    assert_eq!(ns["id"], "work");
    assert_eq!(call(&w, "ns_list", json!({})).unwrap().as_array().unwrap().len(), 1);

    let meta = call(&w, "secret_set", json!({ "ns": "work", "key": "API_KEY", "value": "s3cret", "scope": "agent" })).unwrap();
    assert!(meta.get("value").is_none(), "metadata must not carry the value");
    let id = meta["id"].as_str().unwrap();
    assert_eq!(call(&w, "secret_reveal", json!({ "ns": "work", "id": id })).unwrap(), "s3cret");

    // Errors arrive as { code, message } for the UI.
    let err = call(&w, "secret_list", json!({ "ns": "nope" })).unwrap_err();
    assert_eq!(err["code"], "not_found");
    call(&w, "secret_delete", json!({ "ns": "work", "id": id })).unwrap();
    assert!(call(&w, "secret_list", json!({ "ns": "work" })).unwrap().as_array().unwrap().is_empty());
}

#[test]
fn settings_roundtrip_over_ipc() {
    let w = app();
    assert_eq!(call(&w, "settings_get", json!({ "key": "appearance" })).unwrap(), Value::Null);
    let look = json!({ "theme": "custom", "bg": "#0d1117", "text": "#e6edf3", "accent": "#5b2aaa", "font": "manrope", "size": "large" });
    call(&w, "settings_set", json!({ "key": "appearance", "value": look })).unwrap();
    assert_eq!(call(&w, "settings_get", json!({ "key": "appearance" })).unwrap(), look);
}

#[test]
fn sandbox_create_reports_missing_runtime() {
    let w = app();
    call(&w, "ns_create", json!({ "id": "lab", "description": "" })).unwrap();
    let spec = json!({ "name": "box", "image": "docker.io/library/alpine:3.20", "cpu": 1, "mem_mb": 256, "network": "isolated" });
    let err = call(&w, "sandbox_create", json!({ "ns": "lab", "spec": spec })).unwrap_err();
    assert_eq!(err["code"], "runtime");
    let info = call(&w, "core_info", json!({})).unwrap();
    assert_eq!(info["runtime"], "none");
}
