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
    let prompt = body.pointer("/messages/0/content").and_then(|c| c.as_str()).unwrap_or_default();
    let is_judge = body["system"].as_str().is_some_and(|s| s.starts_with("You are a security policy judge"));
    let judge_verdict = is_judge.then(|| if prompt.contains("DROP") { "DENY: dropping tables" } else { "ALLOW" });
    *seen.lock().unwrap() = Seen {
        path: path.clone(),
        headers: parts.headers.iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string())).collect(),
        body,
    };
    if let Some(text) = judge_verdict {
        return axum::Json(serde_json::json!({"content": [{"type": "text", "text": text}]})).into_response();
    }
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
    // 1000 × $2 + 500 × $10 + 2000 × $0.10 (per 1M) = 2000 + 5000 + 200 micros.
    assert_eq!(ev.cost_micros, Some(7_200));
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

async fn check(gw: &str, token: &str, call: serde_json::Value) -> PolicyDecision {
    let res = reqwest::Client::new().post(format!("{gw}/_kalypso/policy/check")).bearer_auth(token).json(&call).send().await.unwrap();
    assert_eq!(res.status(), 200);
    res.json().await.unwrap()
}

#[tokio::test]
async fn force_push_to_main_is_blocked_and_logged() {
    let e = env().await;
    crate::policy::seed_defaults(&e.db, "work").unwrap();
    let token = mint(&e.db, "work", None, "agent").unwrap().token;
    let d = check(&e.gw, &token, serde_json::json!({"kind": "bash", "command": "git push --force origin main"})).await;
    assert_eq!(d.decision, "deny");
    // Both git rules forbid this; either may be the one reported.
    assert!(matches!(d.policy.as_deref(), Some("No force-push to main" | "No pushes to main")), "{:?}", d.policy);
    assert!(d.reason.unwrap().starts_with("Blocked by policy"));
    let ok = check(&e.gw, &token, serde_json::json!({"kind": "bash", "command": "git push origin feature"})).await;
    assert_eq!(ok.decision, "allow");

    let log = crate::policy::events(&e.db, "work", 10).unwrap();
    assert_eq!(log.len(), 1, "allowed calls aren't logged");
    assert_eq!(
        (log[0].outcome.as_str(), log[0].source.as_str(), log[0].action.as_str()),
        ("blocked", "agent", "bash: git push --force origin main")
    );
}

#[tokio::test]
async fn text_policies_are_judged_and_fail_closed() {
    let e = env().await;
    let rule = crate::policy::NewPolicy {
        name: "No dropping tables".into(),
        rule: "Never drop database tables.".into(),
        category: "custom".into(),
        enforcement: "block".into(),
        applies_to: None,
        spec: crate::policy::Spec::Text,
        everywhere: None,
    };
    crate::policy::create(&e.db, "work", rule).unwrap();
    let token = mint(&e.db, "work", None, "agent").unwrap().token;

    let d = check(&e.gw, &token, serde_json::json!({"kind": "bash", "command": "psql -c 'DROP TABLE users'"})).await;
    assert_eq!(d.decision, "deny");
    assert!(d.reason.unwrap().contains("dropping tables"));
    {
        let seen = e.seen.lock().unwrap();
        assert_eq!(seen.path, "/v1/messages");
        assert_eq!(header(&seen, "anthropic-version"), Some("2023-06-01"), "the real API rejects calls without it");
        assert_eq!(header(&seen, "x-api-key"), Some("sk-ant-real-provider-key"));
    }
    let ok = check(&e.gw, &token, serde_json::json!({"kind": "bash", "command": "ls"})).await;
    assert_eq!(ok.decision, "allow");

    // Judge unreachable: the call is blocked, not waved through.
    e.vault.set(&e.db, "work", "ANTHROPIC_BASE_URL", "http://127.0.0.1:1", "gateway").unwrap();
    let d = check(&e.gw, &token, serde_json::json!({"kind": "bash", "command": "ls"})).await;
    assert_eq!(d.decision, "deny");
    assert!(d.reason.unwrap().contains("policy judge unavailable"));
}

#[tokio::test]
async fn ask_policies_wait_for_the_user() {
    let e = env().await;
    crate::policy::seed_defaults(&e.db, "work").unwrap();
    let gw = Gateway::new(e.db.clone(), e.vault.clone(), Pricing::builtin());
    let addr = format!("http://{}", gw.listen_tcp(0).await.unwrap());
    let mut asks = gw.approvals.subscribe();
    let token = mint(&e.db, "work", None, "agent").unwrap().token;
    let fetch = serde_json::json!({"kind": "http", "url": "https://pastebin.com/raw/abc"});

    // Denied: the call waits, then gets the user's answer.
    let pending = tokio::spawn({
        let (addr, token, fetch) = (addr.clone(), token.clone(), fetch.clone());
        async move { check(&addr, &token, fetch).await }
    });
    let req = asks.recv().await.unwrap();
    assert_eq!((req.policy.as_str(), req.source.as_str()), ("Ask before new hosts", "agent"));
    assert!(!pending.is_finished(), "the call is held while the user decides");
    gw.approvals.decide("work", &req.id, false, false).unwrap();
    let d = pending.await.unwrap();
    assert_eq!(d.decision, "deny");
    assert!(d.reason.unwrap().contains("Denied by the user"));

    // Approved and remembered: the next call in the same run doesn't ask again.
    let pending = tokio::spawn({
        let (addr, token, fetch) = (addr.clone(), token.clone(), fetch.clone());
        async move { check(&addr, &token, fetch).await }
    });
    let req = asks.recv().await.unwrap();
    gw.approvals.decide("work", &req.id, true, true).unwrap();
    assert_eq!(pending.await.unwrap().decision, "allow");
    assert_eq!(check(&addr, &token, fetch.clone()).await.decision, "allow");
    assert!(asks.try_recv().is_err(), "remembered for the run");

    // A different key (a new run) is asked again.
    let other = mint(&e.db, "work", None, "agent-2").unwrap().token;
    let pending = tokio::spawn({
        let addr = addr.clone();
        async move { check(&addr, &other, fetch).await }
    });
    let req = asks.recv().await.unwrap();
    gw.approvals.decide("work", &req.id, true, false).unwrap();
    assert_eq!(pending.await.unwrap().decision, "allow");

    let outcomes: Vec<String> = crate::policy::events(&e.db, "work", 20).unwrap().into_iter().rev().map(|e| e.outcome).collect();
    assert_eq!(outcomes, ["asked", "denied", "asked", "approved", "asked", "approved"]);
}

#[tokio::test]
async fn secrets_never_leave_and_never_reach_the_log() {
    let e = env().await;
    crate::policy::seed_defaults(&e.db, "work").unwrap();
    let token = mint(&e.db, "work", None, "agent").unwrap().token;
    // env() stores ANTHROPIC_API_KEY = sk-ant-real-provider-key.
    let d = check(&e.gw, &token, serde_json::json!({"kind": "bash", "command": "echo sk-ant-real-provider-key > /work/out.txt"})).await;
    assert_eq!(d.policy.as_deref(), Some("Never reveal secrets"));
    let log = crate::policy::events(&e.db, "work", 5).unwrap();
    assert!(!log[0].action.contains("sk-ant-real"), "{}", log[0].action);
    assert_eq!(
        reqwest::Client::new()
            .post(format!("{}/_kalypso/policy/check", e.gw))
            .bearer_auth("kx_nope")
            .body("{}")
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
}

#[tokio::test]
async fn approval_wait_follows_preferences() {
    let e = env().await;
    let gw = Gateway::new(e.db.clone(), e.vault.clone(), Pricing::builtin());
    assert_eq!(gw.approval_wait(), crate::policy::APPROVAL_TIMEOUT);
    e.db.set_setting("preferences", &serde_json::json!({"approvalTimeoutMin": 2})).unwrap();
    assert_eq!(gw.approval_wait(), std::time::Duration::from_secs(120));
    // Out-of-range or malformed values fall back to the default.
    e.db.set_setting("preferences", &serde_json::json!({"approvalTimeoutMin": 600})).unwrap();
    assert_eq!(gw.approval_wait(), crate::policy::APPROVAL_TIMEOUT);
    e.db.set_setting("preferences", &serde_json::json!({"approvalTimeoutMin": "soon"})).unwrap();
    assert_eq!(gw.approval_wait(), crate::policy::APPROVAL_TIMEOUT);
}

/// The secret gateway (#87) is only on the sandbox socket. On the TCP port, which any
/// local process can reach, the path is just an unknown provider.
#[tokio::test]
async fn the_secret_gateway_is_not_on_the_tcp_port() {
    let e = env().await;
    let token = mint(&e.db, "work", None, "laptop").unwrap().token;
    let body = serde_json::json!({ "name": "STRIPE_KEY", "purpose": "x", "command": ["true"] });
    let res = reqwest::Client::new().post(format!("{}/_kalypso/secrets/run", e.gw)).bearer_auth(token).json(&body).send().await.unwrap();
    assert_eq!(res.status(), 404);
    assert!(res.text().await.unwrap().contains("use /<provider>/<path>"));
}

// ---------- Git credentials and the GitHub API for repository-linked agents (#100) ----------

/// A gateway serving the sandbox routes, a fake GitHub, an account allowed in `work`, a sandbox
/// with an agent linked to acme/platform, and that sandbox's gateway key.
struct GitEnv {
    db: Arc<Db>,
    url: String,
    tcp: String,
    key: String,
    account: String,
    github_seen: Arc<Mutex<Vec<String>>>,
}

async fn git_env() -> GitEnv {
    use axum::routing::{any, get};
    let db = Arc::new(Db::open_in_memory().unwrap());
    db.with(|c| Ok(c.execute_batch("INSERT INTO namespaces (id, name) VALUES ('work','work'), ('lab','lab');")?)).unwrap();
    let vault = Arc::new(Vault::ephemeral());
    vault.create_ns_key(&db, "work").unwrap();

    // Fake GitHub: accepts ghp_acme, records what reaches it.
    let seen: Arc<Mutex<Vec<String>>> = Default::default();
    let s2 = seen.clone();
    let gh_app = axum::Router::new()
        .route(
            "/user",
            get(|h: axum::http::HeaderMap| async move {
                if h.get("authorization").and_then(|v| v.to_str().ok()) != Some("Bearer ghp_acme") {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                axum::Json(serde_json::json!({ "login": "ada" })).into_response()
            }),
        )
        .route("/user/orgs", get(|| async { axum::Json(serde_json::json!([{ "login": "acme" }])) }))
        .fallback(any(move |req: Request| {
            let seen = s2.clone();
            async move {
                let auth = req.headers().get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                let line = format!("{} {} {}", req.method(), req.uri(), auth);
                seen.lock().unwrap().push(line);
                (StatusCode::CREATED, axum::Json(serde_json::json!({ "number": 7, "html_url": "https://github.com/acme/platform/pull/7" })))
                    .into_response()
            }
        }));
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gh_url = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, gh_app).await.unwrap() });
    let gh = crate::github::GitHub::new(&gh_url, &gh_url);

    let t =
        crate::github::TokenSet { access_token: "ghp_acme".into(), refresh_token: None, expires_in: None, refresh_token_expires_in: None };
    let account = crate::github::connect(&db, &vault, &gh, "acme", "token", t, &["work".into()], None).await.unwrap().id;
    db.with(|c| Ok(c.execute("INSERT INTO sandboxes (id, ns, name, runtime, image, cpu, mem_mb, network) VALUES ('sb-1','work','box','docker','img',1,512,'isolated')", [])?)).unwrap();
    let new = crate::agent::NewAgent {
        name: "scout".into(),
        role: Some("Fix the tests".into()),
        runtime: "command".into(),
        model: None,
        sandbox_id: Some("sb-1".into()),
        command: Some("true".into()),
        max_turns: None,
        restart: None,
        max_restarts: None,
        repo: Some("acme/platform".into()),
        repo_account: Some(account.clone()),
    };
    crate::agent::create(&db, "work", new).unwrap();
    crate::policy::seed_defaults(&db, "work").unwrap();
    let key = mint_for_sandbox(&db, "work", "sb-1", "box").unwrap();

    let gw = Gateway::new(db.clone(), vault.clone(), Pricing::builtin());
    gw.set_github(gh);
    let app = gw.sandbox_router();
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    let tcp = format!("http://{}", gw.listen_tcp(0).await.unwrap());
    GitEnv { db, url, tcp, key, account, github_seen: seen }
}

async fn credential(e: &GitEnv, key: &str, path: &str) -> (u16, String) {
    let body = format!("protocol=https\nhost=github.com\npath={path}\n");
    let res =
        reqwest::Client::new().post(format!("{}/_kalypso/git/credential", e.url)).header("x-api-key", key).body(body).send().await.unwrap();
    (res.status().as_u16(), res.text().await.unwrap())
}

#[tokio::test]
async fn git_credentials_only_for_the_linked_repository() {
    let e = git_env().await;
    let (code, body) = credential(&e, &e.key, "acme/platform.git").await;
    assert_eq!(code, 200, "{body}");
    assert!(body.contains("username=x-access-token\npassword=ghp_acme\n"), "{body}");

    // Another repository, even of the same account: no.
    assert_eq!(credential(&e, &e.key, "acme/billing.git").await.0, 403);
    // A key that isn't a sandbox's: no.
    let laptop = mint(&e.db, "work", None, "laptop").unwrap().token;
    assert_eq!(credential(&e, &laptop, "acme/platform.git").await.0, 403);
    // Once the namespace may no longer use the account: no.
    crate::github::set_namespaces(&e.db, &e.account, &["lab".into()]).unwrap();
    assert_eq!(credential(&e, &e.key, "acme/platform.git").await.0, 403);

    let log = e.db.audit_list(Some("work"), Some("git."), 10).unwrap();
    assert!(log.iter().any(|l| l.action == "git.credential" && l.target == "scout: acme/platform"));
    assert!(log.iter().filter(|l| l.action == "git.credential_denied").count() >= 2);
}

#[tokio::test]
async fn git_routes_are_not_on_the_tcp_port() {
    let e = git_env().await;
    let res = reqwest::Client::new()
        .post(format!("{}/_kalypso/git/credential", e.tcp))
        .header("x-api-key", &e.key)
        .body("host=github.com\npath=acme/platform.git\n")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
}

#[tokio::test]
async fn the_github_api_is_proxied_for_the_linked_repository_only() {
    let e = git_env().await;
    let c = reqwest::Client::new();
    let pr = serde_json::json!({ "title": "Fix the tests", "head": "agent/scout/fix-the-tests", "base": "main" });
    let res =
        c.post(format!("{}/_kalypso/github/repos/acme/platform/pulls", e.url)).header("x-api-key", &e.key).json(&pr).send().await.unwrap();
    assert_eq!(res.status(), 201);
    assert_eq!(res.json::<serde_json::Value>().await.unwrap()["number"], 7);
    let res = c
        .get(format!("{}/_kalypso/github/repos/acme/platform/pulls?head=acme:agent/scout/fix-the-tests", e.url))
        .header("x-api-key", &e.key)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 201, "the fake answers 201 to everything it forwards");
    for path in ["/user", "/repos/acme/billing/pulls", "/repos/acme/platform-x/pulls", "/orgs/acme/repos"] {
        let res = c.get(format!("{}/_kalypso/github{path}", e.url)).header("x-api-key", &e.key).send().await.unwrap();
        assert_eq!(res.status(), 403, "{path}");
    }
    let seen = e.github_seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 2, "only the two allowed calls reached GitHub: {seen:?}");
    assert!(seen[0].starts_with("POST /repos/acme/platform/pulls Bearer ghp_acme"), "{seen:?}");
    assert!(seen[1].contains("?head=acme:agent/scout/fix-the-tests"), "{seen:?}");
    let log = e.db.audit_list(Some("work"), Some("github."), 10).unwrap();
    assert!(log.iter().any(|l| l.action == "github.api" && l.target.contains("POST /repos/acme/platform/pulls → 201")));
}

/// The master agent's endpoints answer only the sandbox holding the namespace's master agent,
/// list the other agents (never itself), and refuse to act on itself.
#[tokio::test]
async fn only_the_master_agent_manages_agents() {
    let db = Arc::new(Db::open_in_memory().unwrap());
    db.with(|c| Ok(c.execute_batch("INSERT INTO namespaces (id, name) VALUES ('work','work');")?)).unwrap();
    let vault = Arc::new(Vault::ephemeral());
    vault.create_ns_key(&db, "work").unwrap();
    db.with(|c| {
        Ok(c.execute_batch(
            "INSERT INTO sandboxes (id, ns, name, runtime, image, cpu, mem_mb, network) VALUES
               ('sb-m','work','kalypso','docker','img',1,512,'isolated'), ('sb-w','work','scout','docker','img',1,512,'isolated');",
        )?)
    })
    .unwrap();
    let agent = |name: &str, sb: &str| crate::agent::NewAgent {
        name: name.into(),
        role: Some(format!("{name} role")),
        runtime: "command".into(),
        model: None,
        sandbox_id: Some(sb.into()),
        command: Some("true".into()),
        max_turns: None,
        restart: None,
        max_restarts: None,
        repo: None,
        repo_account: None,
    };
    let master = crate::agent::create(&db, "work", agent("kalypso", "sb-m")).unwrap();
    db.with(|c| Ok(c.execute("UPDATE agents SET master = 1 WHERE id = ?1", [&master.id])?)).unwrap();
    crate::agent::create(&db, "work", agent("scout", "sb-w")).unwrap();
    let master_key = mint_for_sandbox(&db, "work", "sb-m", "kalypso").unwrap();
    let worker_key = mint_for_sandbox(&db, "work", "sb-w", "scout").unwrap();

    let gw = Gateway::new(db.clone(), vault.clone(), Pricing::builtin());
    let rt = crate::sandbox::Runtime::with(vec![]);
    gw.set_agents(crate::agent::supervisor::Supervisor::new(db.clone(), vault.clone(), rt));
    let app = gw.sandbox_router();
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/_kalypso/agents", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    let tcp = format!("http://{}/_kalypso/agents", gw.listen_tcp(0).await.unwrap());
    let http = reqwest::Client::new();

    // A worker's sandbox can't manage agents, and neither can a request without a key.
    let r = http.get(&url).bearer_auth(&worker_key).send().await.unwrap();
    assert_eq!(r.status(), 403);
    assert_eq!(http.get(&url).send().await.unwrap().status(), 401);
    // The host TCP port doesn't serve these routes at all.
    assert_ne!(http.get(&tcp).bearer_auth(&master_key).send().await.unwrap().status(), 200);

    // The master sees the others, not itself.
    let list: Vec<serde_json::Value> = http.get(&url).bearer_auth(&master_key).send().await.unwrap().json().await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["name"], "scout");
    assert_eq!(list[0]["status"], "stopped");

    // It can read another agent, but not act on itself or on agents that don't exist.
    let r = http.get(format!("{url}/scout?limit=5")).bearer_auth(&master_key).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let r = http.post(format!("{url}/kalypso/stop")).bearer_auth(&master_key).json(&serde_json::json!({})).send().await.unwrap();
    assert_eq!(r.status(), 404);
    let r = http.delete(format!("{url}/ghost")).bearer_auth(&master_key).send().await.unwrap();
    assert_eq!(r.status(), 404);
    // An empty message is refused before anything starts.
    let r =
        http.post(format!("{url}/scout/message")).bearer_auth(&master_key).json(&serde_json::json!({ "text": "  " })).send().await.unwrap();
    assert_eq!(r.status(), 400);
    assert!(
        crate::agent::get(&db, "work", &crate::agent::list(&db, "work").unwrap().iter().find(|a| a.name == "scout").unwrap().id)
            .unwrap()
            .status
            == "stopped"
    );

    // Every action is audited under the master's name.
    let r = http.post(format!("{url}/scout/stop")).bearer_auth(&master_key).json(&serde_json::json!({})).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let audit = db.audit_list(Some("work"), Some("master.agent"), 10).unwrap();
    assert!(audit.iter().any(|a| a.actor == "kalypso" && a.action == "master.agent.stop" && a.target == "scout"));
}
