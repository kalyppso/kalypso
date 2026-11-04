//! A Claude Agent SDK agent, end to end: the runner image in a real sandbox with no
//! network, the real gateway on its Unix socket, the real policy engine, and a stand-in
//! for the Anthropic API that scripts the model's turns. Nothing reaches a real model.
//!
//! Needs a container engine and the runner image:
//!   podman build -t ghcr.io/kalyppso/agent-runner:dev runner/agent-sdk
//!   KALYPSO_TEST_RUNTIME=1 cargo test --test agent_sdk
//! (Its own test binary: the gateway's socket folder is set once per process.)
#![cfg(target_os = "linux")]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::response::IntoResponse;
use kalypso_lib::agent::{self, supervisor::Supervisor, NewAgent};
use kalypso_lib::gateway::{pricing::Pricing, Gateway};
use kalypso_lib::sandbox::{self, NewSandbox, Runtime};
use kalypso_lib::store::Db;
use kalypso_lib::vault::{new_id, Vault};
use serde_json::{json, Value};

const TASK: &str = "KX-TASK: write a marker file, then try to force-push.";

/// What the stand-in model says next, from how far the conversation has got.
fn reply(body: &Value) -> Value {
    let msgs = body["messages"].as_array().cloned().unwrap_or_default();
    let ours = msgs.iter().any(|m| m.to_string().contains("KX-TASK"));
    let results = msgs
        .iter()
        .filter(|m| m["role"] == "user")
        .flat_map(|m| m["content"].as_array().cloned().unwrap_or_default())
        .filter(|b| b["type"] == "tool_result")
        .count();
    let tool = |id: &str, command: &str| json!({ "type": "tool_use", "id": id, "name": "Bash", "input": { "command": command, "description": "test step" } });
    let (content, stop) = match (ours, results) {
        // Side calls (titles, summaries): a short answer.
        (false, _) => (vec![json!({ "type": "text", "text": "ok" })], "end_turn"),
        (true, 0) => (vec![tool("toolu_01", "echo kalypso-sdk > /work/done.txt")], "tool_use"),
        (true, 1) => (vec![tool("toolu_02", "git push --force origin main")], "tool_use"),
        (true, _) => (vec![json!({ "type": "text", "text": "Marker written; the force-push was blocked by policy." })], "end_turn"),
    };
    json!({
        "id": format!("msg_{}", new_id("m")), "type": "message", "role": "assistant",
        "model": body["model"], "content": content, "stop_reason": stop, "stop_sequence": null,
        "usage": { "input_tokens": 100, "output_tokens": 20 }
    })
}

/// The same message as the Messages API's server-sent events.
fn sse(msg: &Value) -> String {
    let mut out = String::new();
    let mut ev = |name: &str, data: Value| out.push_str(&format!("event: {name}\ndata: {data}\n\n"));
    let mut start = msg.clone();
    start["content"] = json!([]);
    start["stop_reason"] = Value::Null;
    start["usage"] = json!({ "input_tokens": 100, "output_tokens": 1 });
    ev("message_start", json!({ "type": "message_start", "message": start }));
    for (i, b) in msg["content"].as_array().unwrap().iter().enumerate() {
        if b["type"] == "text" {
            ev(
                "content_block_start",
                json!({ "type": "content_block_start", "index": i, "content_block": { "type": "text", "text": "" } }),
            );
            ev(
                "content_block_delta",
                json!({ "type": "content_block_delta", "index": i, "delta": { "type": "text_delta", "text": b["text"] } }),
            );
        } else {
            let mut head = b.clone();
            head["input"] = json!({});
            ev("content_block_start", json!({ "type": "content_block_start", "index": i, "content_block": head }));
            ev(
                "content_block_delta",
                json!({ "type": "content_block_delta", "index": i, "delta": { "type": "input_json_delta", "partial_json": b["input"].to_string() } }),
            );
        }
        ev("content_block_stop", json!({ "type": "content_block_stop", "index": i }));
    }
    ev(
        "message_delta",
        json!({ "type": "message_delta", "delta": { "stop_reason": msg["stop_reason"], "stop_sequence": null }, "usage": { "output_tokens": 20 } }),
    );
    ev("message_stop", json!({ "type": "message_stop" }));
    out
}

async fn model(seen: Arc<Mutex<Vec<String>>>) -> String {
    let up = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", up.local_addr().unwrap());
    let app = axum::Router::new().fallback(move |uri: axum::http::Uri, h: axum::http::HeaderMap, body: axum::body::Bytes| {
        let seen = seen.clone();
        async move {
            let key = h.get("x-api-key").and_then(|v| v.to_str().ok()).unwrap_or("-").to_string();
            seen.lock().unwrap().push(format!("{} key={key}", uri.path()));
            let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            if uri.path().ends_with("/count_tokens") {
                return axum::Json(json!({ "input_tokens": 100 })).into_response();
            }
            if !uri.path().ends_with("/v1/messages") {
                return axum::Json(json!({})).into_response();
            }
            let msg = reply(&body);
            if body["stream"] == true {
                ([("content-type", "text/event-stream")], sse(&msg)).into_response()
            } else {
                axum::Json(msg).into_response()
            }
        }
    });
    tokio::spawn(async move { axum::serve(up, app).await.unwrap() });
    url
}

#[tokio::test]
async fn an_sdk_agent_completes_a_task_in_its_sandbox_within_policy() {
    if std::env::var("KALYPSO_TEST_RUNTIME").is_err() {
        return;
    }
    let image = std::env::var("KALYPSO_TEST_RUNNER_IMAGE").unwrap_or_else(|_| "ghcr.io/kalyppso/agent-runner:dev".into());
    let rt = Runtime::detect().await;
    let db = Arc::new(Db::open_in_memory().unwrap());
    let vault = Arc::new(Vault::ephemeral());
    let ns = format!("sdk{}", &new_id("x")[2..8]);
    db.with(|c| Ok(c.execute("INSERT INTO namespaces (id, name) VALUES (?1, ?1)", [&ns])?)).unwrap();
    vault.create_ns_key(&db, &ns).unwrap();
    kalypso_lib::policy::seed_defaults(&db, &ns).unwrap(); // includes "No force-push to main"

    let seen = Arc::new(Mutex::new(Vec::new()));
    let url = model(seen.clone()).await;
    vault.set(&db, &ns, "ANTHROPIC_API_KEY", "sk-ant-real-key", "gateway").unwrap();
    vault.set(&db, &ns, "ANTHROPIC_BASE_URL", &url, "gateway").unwrap();
    let gw = Gateway::new(db.clone(), vault.clone(), Pricing::builtin());
    gw.listen_unix(std::env::temp_dir().join(format!("kx-sdk-{}", std::process::id()))).await.unwrap();

    let spec = NewSandbox { name: "sdk".into(), image, cpu: 1.0, mem_mb: 1024, network: "isolated".into(), provider: None };
    let sb = sandbox::create(&db, &rt, &ns, spec).await.unwrap();
    let new = NewAgent {
        name: "builder".into(),
        role: Some("Writes files when asked.".into()),
        runtime: "claude-sdk".into(),
        model: Some("claude-haiku-5-5".into()),
        sandbox_id: Some(sb.id.clone()),
        command: Some(TASK.into()),
        restart: Some("never".into()),
        max_restarts: Some(0),
        max_turns: Some(10),
    };
    let a = agent::create(&db, &ns, new).unwrap();
    let sup = Supervisor::new(db.clone(), vault.clone(), rt.clone());
    sup.start(&ns, &a.id).await.unwrap();

    // Wait for the task's result.
    let mut log = Vec::new();
    for _ in 0..240 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if let Some(run) = agent::runs(&db, &ns, &a.id, 1).unwrap().first() {
            log = agent::events(&db, &ns, &run.id, 0, 500).unwrap();
            if log.iter().any(|e| e.kind == "result" || e.kind == "error") || run.outcome != "running" {
                break;
            }
        }
    }
    let dump = log.iter().map(|e| format!("{:>7} | {}", e.kind, e.text)).collect::<Vec<_>>().join("\n");
    eprintln!("transcript:\n{dump}");
    let has = |kind: &str, needle: &str| log.iter().any(|e| e.kind == kind && e.text.contains(needle));

    assert!(has("result", "Done"), "no successful result:\n{dump}\nupstream saw: {:?}", seen.lock().unwrap());
    assert!(has("tool", "Bash  echo kalypso-sdk"), "{dump}");
    assert!(has("policy", "No force-push to main"), "the force-push was not blocked:\n{dump}");
    assert!(has("text", "force-push was blocked"), "{dump}");

    // The allowed command really ran in the sandbox; the blocked one never did.
    let (code, out) = sandbox::exec(&rt, &ns, &sb.id, &["cat", "/work/done.txt"], false).await.unwrap();
    assert_eq!((code, out.trim()), (0, "kalypso-sdk"));

    // Model calls carried the real key upstream, and only the virtual key inside.
    let calls = seen.lock().unwrap().clone();
    assert!(calls.iter().any(|c| c.starts_with("/v1/messages") && c.ends_with("key=sk-ant-real-key")), "{calls:?}");
    let (_, leak) =
        sandbox::exec(&rt, &ns, &sb.id, &["sh", "-c", "grep -rl sk-ant-real-key /run /tmp /work 2>/dev/null; true"], false).await.unwrap();
    assert_eq!(leak.trim(), "", "provider key found inside the sandbox");

    // The agent waits for more work; a message starts another turn.
    let rec = agent::get(&db, &ns, &a.id).unwrap();
    assert_eq!(rec.status, "running");
    assert!(rec.status_reason.contains("waiting for a message"), "{}", rec.status_reason);

    sup.stop(&ns, &a.id, "test over").await.unwrap();
    sandbox::remove(&db, &rt, &ns, &sb.id).await.unwrap();
    let _ = rt.remove_network(&ns).await;
}
