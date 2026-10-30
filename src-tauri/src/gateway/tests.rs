use std::sync::{Arc, Mutex};

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use super::*;

/// What the fake provider saw.
#[derive(Default)]
struct Seen {
    path: String,
    headers: Vec<(String, String)>,
    body: serde_json::Value,
}

type Upstream = Arc<Mutex<Seen>>;

const SSE: &str = "event: message_start\n\
data: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-sonnet-5-5\",\"usage\":{\"input_tokens\":1000,\"cache_read_input_tokens\":2000,\"output_tokens\":1}}}\n\n\
event: message_delta\n\
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":500}}\n\n";

async fn fake(State(seen): State<Upstream>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let bytes = axum::body::to_bytes(body, 1 << 20).await.unwrap();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
    let stream = body["stream"].as_bool().unwrap_or(false);
    let path = parts.uri.path().to_string();
    *seen.lock().unwrap() = Seen {
        path: path.clone(),
        headers: parts.headers.iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string())).collect(),
        body,
    };
    if path.ends_with("/fail") {
        return (StatusCode::TOO_MANY_REQUESTS, axum::Json(serde_json::json!({"type": "error"}))).into_response();
    }
    if path.ends_with("chat/completions") {
        let usage = serde_json::json!({"model": "local-llama", "usage": {"prompt_tokens": 40, "completion_tokens": 2}});
        return axum::Json(usage).into_response();
    }
    if stream {
        return ([("content-type", "text/event-stream")], SSE).into_response();
    }
    axum::Json(serde_json::json!({
        "type": "message", "model": "claude-opus-5-5",
        "usage": {"input_tokens": 1_000_000, "output_tokens": 100_000, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
    }))
    .into_response()
}

struct Env {
    db: Arc<Db>,
    vault: Arc<Vault>,
    gw: String,
    seen: Upstream,
    events: tokio::sync::broadcast::Receiver<UsageEvent>,
}

async fn env() -> Env {
    let db = Arc::new(Db::open_in_memory().unwrap());
    db.with(|c| Ok(c.execute_batch("INSERT INTO namespaces (id, name) VALUES ('work','work'), ('lab','lab');")?)).unwrap();
    let vault = Arc::new(Vault::ephemeral());
    vault.create_ns_key(&db, "work").unwrap();
    vault.create_ns_key(&db, "lab").unwrap();

    let seen: Upstream = Default::default();
    let up = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let up_url = format!("http://{}", up.local_addr().unwrap());
    let app = axum::Router::new().fallback(fake).with_state(seen.clone());
    tokio::spawn(async move { axum::serve(up, app).await.unwrap() });

    vault.set(&db, "work", "ANTHROPIC_API_KEY", "sk-ant-real-provider-key", "gateway").unwrap();
    vault.set(&db, "work", "ANTHROPIC_BASE_URL", &up_url, "gateway").unwrap();
    vault.set(&db, "work", "OLLAMA_BASE_URL", &format!("{up_url}/v1"), "namespace").unwrap();

    let gw = Gateway::new(db.clone(), vault.clone(), Pricing::builtin());
    let events = gw.subscribe();
    let addr = gw.listen_tcp(0).await.unwrap();
    Env { db, vault, gw: format!("http://{addr}"), seen, events }
}

fn header<'a>(seen: &'a Seen, name: &str) -> Option<&'a str> {
    seen.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

#[tokio::test]
async fn swaps_the_virtual_key_and_meters_json() {
    let mut e = env().await;
    let token = mint(&e.db, "work", None, "laptop").unwrap().token;
    let res = reqwest::Client::new()
        .post(format!("{}/anthropic/v1/messages?beta=true", e.gw))
        .header("x-api-key", &token)
        .header("anthropic-version", "2023-06-01")
        .json(&serde_json::json!({"model": "claude-opus-5-5", "max_tokens": 16, "messages": []}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["usage"]["input_tokens"], 1_000_000);

    let ev = e.events.recv().await.unwrap();
    {
        let seen = e.seen.lock().unwrap();
        assert_eq!(seen.path, "/v1/messages");
        assert_eq!(header(&seen, "x-api-key"), Some("sk-ant-real-provider-key"));
        assert_eq!(header(&seen, "anthropic-version"), Some("2023-06-01"));
        assert!(seen.headers.iter().all(|(_, v)| !v.contains(&token)), "virtual key leaked upstream");
    }
    // 1M input × $4 + 100k output × $20 = $6.
    assert_eq!((ev.ns.as_str(), ev.source.as_str(), ev.cost_micros), ("work", "laptop", Some(6_000_000)));

    let s = summary(&e.db, Some("work"), 30).unwrap();
    assert_eq!((s.totals.requests, s.totals.cost_micros, s.totals.input_tokens), (1, 6_000_000, 1_000_000));
    assert_eq!(s.by_model[0].name, "claude-opus-5-5");
    assert_eq!(s.by_day.len(), 1);
    assert_eq!((s.by_day_source[0].source.as_str(), s.by_day_source[0].cost_micros), ("laptop", 6_000_000));
    assert_eq!(summary(&e.db, Some("lab"), 30).unwrap().totals.requests, 0);
    let _ = &e.vault;
}

#[tokio::test]
async fn meters_streams() {
    let mut e = env().await;
    let token = mint(&e.db, "work", None, "agent").unwrap().token;
    let res = reqwest::Client::new()
        .post(format!("{}/anthropic/v1/messages", e.gw))
        .bearer_auth(&token)
        .json(&serde_json::json!({"model": "claude-sonnet-5-5", "stream": true}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.headers()["content-type"], "text/event-stream");
    assert_eq!(res.text().await.unwrap(), SSE, "stream must pass through unchanged");

    let ev = e.events.recv().await.unwrap();
    assert_eq!((ev.input_tokens, ev.output_tokens, ev.cache_read), (1000, 500, 2000));
    // 1000 × $2 + 500 × $10 + 2000 × $0.20 (per 1M) = 2000 + 5000 + 400 micros.
    assert_eq!(ev.cost_micros, Some(7_400));
    assert!(e.db.with(|c| Ok(c.query_row("SELECT stream FROM usage_events", [], |r| r.get::<_, bool>(0))?)).unwrap());
}

#[tokio::test]
async fn openai_compatible_providers_and_usage_injection() {
    let mut e = env().await;
    let token = mint(&e.db, "work", None, "bench").unwrap().token;
    let res = reqwest::Client::new()
        .post(format!("{}/ollama/chat/completions", e.gw))
        .bearer_auth(&token)
        .json(&serde_json::json!({"model": "local-llama", "stream": true, "messages": []}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let ev = e.events.recv().await.unwrap();
    {
        let seen = e.seen.lock().unwrap();
        assert_eq!(seen.path, "/v1/chat/completions");
        assert_eq!(seen.body["stream_options"]["include_usage"], true);
        // No OLLAMA_API_KEY: the caller's key is dropped and none is added.
        assert_eq!(header(&seen, "authorization"), None);
    }
    assert_eq!((ev.provider.as_str(), ev.model.as_str(), ev.input_tokens), ("ollama", "local-llama", 40));
    assert_eq!(ev.cost_micros, None, "unlisted models are counted but unpriced");
    assert_eq!(summary(&e.db, None, 7).unwrap().unpriced, vec!["local-llama".to_string()]);
}

#[tokio::test]
async fn rejects_bad_keys_and_missing_provider_config() {
    let e = env().await;
    let client = reqwest::Client::new();
    let post = |path: &str, key: &str| client.post(format!("{}{path}", e.gw)).header("x-api-key", key).body("{}").send();

    let res = post("/anthropic/v1/messages", "kx_nope").await.unwrap();
    assert_eq!(res.status(), 401);
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["error"]["type"], "authentication_error");

    let lab = mint(&e.db, "lab", None, "lab key").unwrap();
    let res = post("/anthropic/v1/messages", &lab.token).await.unwrap();
    assert_eq!(res.status(), 401, "lab has no ANTHROPIC_API_KEY");
    assert!(res.text().await.unwrap().contains("ANTHROPIC_API_KEY"));
    assert_eq!(post("/groq/chat/completions", &lab.token).await.unwrap().status(), 400);

    revoke_key(&e.db, "lab", &lab.key.id).unwrap();
    assert_eq!(post("/openai/models", &lab.token).await.unwrap().status(), 401);
    assert_eq!(revoke_key(&e.db, "work", &lab.key.id).unwrap_err().code(), "not_found");
}

#[tokio::test]
async fn upstream_errors_are_passed_through_and_counted() {
    let mut e = env().await;
    let token = mint(&e.db, "work", None, "x").unwrap().token;
    let res = reqwest::Client::new()
        .post(format!("{}/anthropic/v1/fail", e.gw))
        .header("x-api-key", &token)
        .json(&serde_json::json!({"model": "claude-opus-5-5"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 429);
    let ev = e.events.recv().await.unwrap();
    assert_eq!((ev.status, ev.cost_micros), (429, Some(0)));
    assert_eq!(summary(&e.db, Some("work"), 1).unwrap().totals.errors, 1);
}

#[test]
fn sandbox_keys_rotate() {
    let db = Db::open_in_memory().unwrap();
    db.with(|c| {
        Ok(c.execute_batch(
            "INSERT INTO namespaces (id, name) VALUES ('work','work');
             INSERT INTO sandboxes (id, ns, name, runtime, image, cpu, mem_mb, network) VALUES ('sb-1','work','box','docker','alpine',1,512,'isolated');",
        )?)
    })
    .unwrap();
    let a = mint_for_sandbox(&db, "work", "sb-1", "box").unwrap();
    let b = mint_for_sandbox(&db, "work", "sb-1", "box").unwrap();
    assert_ne!(a, b);
    assert!(resolve(&db, &a).unwrap().is_none());
    assert_eq!(resolve(&db, &b).unwrap().unwrap().1, "work");
    assert_eq!(list_keys(&db, "work").unwrap().iter().filter(|k| k.revoked_at.is_none()).count(), 1);
    // Deleting the sandbox removes its keys.
    db.with(|c| Ok(c.execute("DELETE FROM sandboxes WHERE id = 'sb-1'", [])?)).unwrap();
    assert!(list_keys(&db, "work").unwrap().is_empty());
}

#[tokio::test]
async fn budgets_pause_and_downgrade_before_forwarding() {
    let mut e = env().await;
    let minted = mint(&e.db, "work", None, "laptop").unwrap();
    let post = |model: &str| {
        reqwest::Client::new()
            .post(format!("{}/anthropic/v1/messages", e.gw))
            .header("x-api-key", &minted.token)
            .json(&serde_json::json!({"model": model, "max_tokens": 16}))
            .send()
    };

    // Over $1 for the day switches this key to Haiku; the first call costs $6.
    let mut rule = crate::budget::NewBudgetRule {
        target: format!("key:{}", minted.key.id),
        period: "day".into(),
        cap: 1_000_000,
        action: "downgrade".into(),
        downgrade_to: Some("claude-haiku-5-5".into()),
    };
    crate::budget::create_rule(&e.db, "work", rule.clone()).unwrap();
    assert_eq!(post("claude-opus-5-5").await.unwrap().status(), 200);
    e.events.recv().await.unwrap();
    assert_eq!(post("claude-opus-5-5").await.unwrap().status(), 200);
    e.events.recv().await.unwrap();
    assert_eq!(e.seen.lock().unwrap().body["model"], "claude-haiku-5-5", "the second request is downgraded");

    // A $10 monthly cap that pauses: the next request never reaches the provider.
    rule.period = "month".into();
    rule.cap = 10_000_000;
    rule.action = "pause".into();
    rule.downgrade_to = None;
    crate::budget::create_rule(&e.db, "work", rule).unwrap();
    e.seen.lock().unwrap().path.clear();
    let res = post("claude-opus-5-5").await.unwrap();
    assert_eq!(res.status(), 402);
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["error"]["type"], "budget_exceeded");
    assert!(body["error"]["message"].as_str().unwrap().contains("monthly cap"), "{body}");
    assert_eq!(e.seen.lock().unwrap().path, "", "a paused request must not be forwarded");
    let ev = e.events.recv().await.unwrap();
    assert_eq!((ev.status, ev.cost_micros), (402, Some(0)));
}

#[tokio::test]
async fn budget_alerts_reach_subscribers_once() {
    let e = env().await;
    let gw = Gateway::new(e.db.clone(), e.vault.clone(), Pricing::builtin());
    let mut alerts = gw.subscribe_alerts();
    let addr = gw.listen_tcp(0).await.unwrap();
    let token = mint(&e.db, "work", None, "laptop").unwrap().token;
    crate::budget::set(&e.db, "work", 1_000_000, 0.5).unwrap();
    for _ in 0..3 {
        reqwest::Client::new()
            .post(format!("http://{addr}/anthropic/v1/messages"))
            .header("x-api-key", &token)
            .json(&serde_json::json!({"model": "claude-opus-5-5"}))
            .send()
            .await
            .unwrap();
    }
    // The first call ($6) jumps straight past the $1 limit: one "paused" alert, no heads-up, no repeats.
    let first = alerts.recv().await.unwrap();
    assert!(first.message.contains("monthly limit") && first.message.contains("paused"), "{}", first.message);
    assert!(tokio::time::timeout(std::time::Duration::from_millis(200), alerts.recv()).await.is_err(), "no repeats");
}
