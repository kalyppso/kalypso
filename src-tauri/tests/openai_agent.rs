//! An agent on an OpenAI-compatible model, end to end: the runner image in a real sandbox with
//! no network, the real gateway on its Unix socket, the real policy engine, and a stand-in for
//! an OpenAI-compatible API that scripts the model's turns (a tool call that's allowed, a
//! force-push that policy blocks, then an answer). Nothing reaches a real model.
//!
//!   podman build -t ghcr.io/kalyppso/agent-runner:dev runner/agent-sdk
//!   KALYPSO_TEST_RUNTIME=1 cargo test --test openai_agent
#![cfg(target_os = "linux")]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::HeaderMap;
use axum::routing::post;
use axum::Json;
use kalypso_lib::agent::{self, supervisor::Supervisor, NewAgent};
use kalypso_lib::gateway::{pricing::Pricing, Gateway};
use kalypso_lib::sandbox::{self, NewSandbox, Runtime};
use kalypso_lib::store::Db;
use kalypso_lib::vault::{new_id, Vault};

/// What the fake model saw: the key each call carried, and the tools it was offered.
type Seen = Arc<Mutex<Vec<(String, usize)>>>;

async fn model(seen: Seen) -> String {
    let app = axum::Router::new().route(
        "/chat/completions",
        post(move |h: HeaderMap, Json(req): Json<serde_json::Value>| {
            let seen = seen.clone();
            async move {
                let auth = h.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                let tools = req["tools"].as_array().map_or(0, |t| t.len());
                seen.lock().unwrap().push((auth, tools));
                let done = req["messages"].as_array().map_or(0, |m| m.iter().filter(|m| m["role"] == "tool").count());
                let call = |id: &str, cmd: &str| {
                    serde_json::json!({ "id": id, "type": "function", "function": { "name": "bash", "arguments": serde_json::json!({ "command": cmd }).to_string() } })
                };
                let message = match done {
                    0 => serde_json::json!({ "role": "assistant", "content": "Writing the marker.", "tool_calls": [call("c1", "echo kalypso-any > /work/done.txt")] }),
                    1 => serde_json::json!({ "role": "assistant", "content": null, "tool_calls": [call("c2", "git push --force origin main")] }),
                    _ => serde_json::json!({ "role": "assistant", "content": "Wrote the marker; the force-push was blocked by policy." }),
                };
                Json(serde_json::json!({
                    "id": "chatcmpl-1", "object": "chat.completion", "model": "local-model",
                    "choices": [{ "index": 0, "message": message, "finish_reason": "stop" }],
                    "usage": { "prompt_tokens": 120, "completion_tokens": 20, "total_tokens": 140 },
                }))
            }
        }),
    );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    url
}

#[tokio::test]
async fn an_agent_on_any_openai_compatible_model_works_within_policy() {
    if std::env::var("KALYPSO_TEST_RUNTIME").is_err() {
        return;
    }
    let image = std::env::var("KALYPSO_TEST_RUNNER_IMAGE").unwrap_or_else(|_| "ghcr.io/kalyppso/agent-runner:dev".into());
    let rt = Runtime::detect().await;
    let db = Arc::new(Db::open_in_memory().unwrap());
    let vault = Arc::new(Vault::ephemeral());
    let ns = format!("oa{}", &new_id("x")[2..8]);
    db.with(|c| Ok(c.execute("INSERT INTO namespaces (id, name) VALUES (?1, ?1)", [&ns])?)).unwrap();
    vault.create_ns_key(&db, &ns).unwrap();
    kalypso_lib::policy::seed_defaults(&db, &ns).unwrap();

    // A self-hosted, OpenAI-compatible provider ("local"): its base URL and key are gateway secrets.
    let seen: Seen = Default::default();
    let url = model(seen.clone()).await;
    vault.set(&db, &ns, "LOCAL_BASE_URL", &url, "gateway").unwrap();
    vault.set(&db, &ns, "LOCAL_API_KEY", "sk-local-real-key", "gateway").unwrap();
    let gw = Gateway::new(db.clone(), vault.clone(), Pricing::builtin());
    gw.listen_unix(std::env::temp_dir().join(format!("kx-oa-{}", std::process::id()))).await.unwrap();

    let spec = NewSandbox { name: "any".into(), image, cpu: 1.0, mem_mb: 1024, network: "isolated".into(), provider: None };
    let sb = sandbox::create(&db, &rt, &ns, spec).await.unwrap();
    let new = NewAgent {
        name: "local".into(),
        role: Some("Writes files when asked.".into()),
        runtime: "openai-compat".into(),
        model: Some("local/local-model".into()),
        sandbox_id: Some(sb.id.clone()),
        command: Some("Write kalypso-any to /work/done.txt, then force-push to main.".into()),
        restart: Some("never".into()),
        max_restarts: Some(0),
        repo: None,
        repo_account: None,
        max_turns: Some(10),
    };
    let a = agent::create(&db, &ns, new).unwrap();
    let sup = Supervisor::new(db.clone(), vault.clone(), rt.clone());
    sup.start(&ns, &a.id).await.unwrap();

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
    assert!(has("status", "local/local-model · 5 tools"), "{dump}");
    assert!(has("tool", "bash  echo kalypso-any"), "{dump}");
    assert!(has("policy", "Blocked bash  git push --force origin main"), "the force-push was not blocked:\n{dump}");
    assert!(has("text", "force-push was blocked"), "{dump}");
    assert!(has("result", "Done · 3 turns"), "{dump}");

    // The allowed command ran in the sandbox.
    let (code, out) = sandbox::exec(&rt, &ns, &sb.id, &["cat", "/work/done.txt"], false).await.unwrap();
    assert_eq!((code, out.trim()), (0, "kalypso-any"));
    // The provider got the real key and the tools; the sandbox never held that key.
    let calls = seen.lock().unwrap().clone();
    assert_eq!(calls.len(), 3, "{calls:?}");
    assert!(calls.iter().all(|(auth, tools)| auth == "Bearer sk-local-real-key" && *tools == 5), "{calls:?}");
    let (_, leak) = sandbox::exec(&rt, &ns, &sb.id, &["sh", "-c", "grep -rl sk-local-real-key /run /tmp /work 2>/dev/null; true"], false)
        .await
        .unwrap();
    assert_eq!(leak.trim(), "", "provider key found inside the sandbox");

    sup.stop(&ns, &a.id, "test over").await.unwrap();
    sandbox::remove(&db, &rt, &ns, &sb.id).await.unwrap();
    let _ = rt.remove_network(&ns).await;
}
