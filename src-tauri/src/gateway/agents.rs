//! Agent management for the master agent (`agent::master`), on the sandbox socket and relay
//! port only. The caller must be a sandbox that holds its namespace's master agent; it can
//! then list, create, start, message, wait for, stop and delete the namespace's other agents.
//! Everything it does is audited under its own name, and it can never act on itself.
//!
//! - `GET    /_kalypso/agents`                      the other agents
//! - `POST   /_kalypso/agents`                      create one, in its own sandbox
//! - `GET    /_kalypso/agents/{name}?limit=&wait=`  its state and recent transcript; `wait` holds
//!   the answer until its current work ends
//! - `POST   /_kalypso/agents/{name}/start|stop`
//! - `POST   /_kalypso/agents/{name}/message`       send a message (starting it if needed) and,
//!   with `wait`, return what it answered
//! - `DELETE /_kalypso/agents/{name}`

use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{resolve, token, Gateway};
use crate::agent::supervisor::{AgentUpdate, Supervisor};
use crate::agent::{self, master, AgentRecord, NewAgent};
use crate::error::KalypsoError;

/// Longest a request may wait for an agent's answer; the master can ask again.
const MAX_WAIT: u64 = 1800;
const MAX_TEXT: usize = 6000;

fn fail(status: StatusCode, msg: impl std::fmt::Display) -> Response {
    (status, Json(json!({ "error": msg.to_string() }))).into_response()
}

fn error(e: KalypsoError) -> Response {
    let status = match &e {
        KalypsoError::NotFound(_) => StatusCode::NOT_FOUND,
        KalypsoError::Invalid(_) => StatusCode::BAD_REQUEST,
        KalypsoError::Conflict(_) => StatusCode::CONFLICT,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    fail(status, e)
}

/// Who is asking: the master agent behind the request's gateway key, and the supervisor.
#[allow(clippy::result_large_err)]
fn caller(gw: &Gateway, headers: &HeaderMap) -> Result<(AgentRecord, Arc<Supervisor>), Response> {
    let Some(tok) = token(headers) else { return Err(fail(StatusCode::UNAUTHORIZED, "missing KALYPSO gateway key")) };
    let (key_id, ns, _) = match resolve(&gw.db, tok) {
        Ok(Some(k)) => k,
        Ok(None) => return Err(fail(StatusCode::UNAUTHORIZED, "unknown or revoked KALYPSO gateway key")),
        Err(e) => return Err(error(e)),
    };
    let sandbox = match super::secrets::sandbox_of(&gw.db, &key_id) {
        Ok(Some(sb)) => sb,
        _ => return Err(fail(StatusCode::FORBIDDEN, "only the master agent can manage agents")),
    };
    let me = agent::in_sandbox(&gw.db, &sandbox).unwrap_or_default().into_iter().find(|a| a.master && a.ns == ns);
    let Some(me) = me else { return Err(fail(StatusCode::FORBIDDEN, "only the namespace's master agent can manage agents")) };
    let Some(sup) = gw.agents.get().cloned() else { return Err(fail(StatusCode::SERVICE_UNAVAILABLE, "KALYPSO is still starting")) };
    Ok((me, sup))
}

/// The namespace's agent called `name`, never the master itself.
#[allow(clippy::result_large_err)]
fn worker(gw: &Gateway, me: &AgentRecord, name: &str) -> Result<AgentRecord, Response> {
    match agent::list(&gw.db, &me.ns) {
        Ok(all) => all
            .into_iter()
            .find(|a| a.name == name && !a.master)
            .ok_or_else(|| fail(StatusCode::NOT_FOUND, format!("there is no agent called {name}. See them with: kx-agent list"))),
        Err(e) => Err(error(e)),
    }
}

fn clip(s: &str) -> String {
    if s.len() <= MAX_TEXT {
        return s.to_string();
    }
    let mut end = MAX_TEXT;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}… ({} more characters)", &s[..end], s.len() - end)
}

fn view(a: &AgentRecord) -> Value {
    json!({ "name": a.name, "role": a.role, "model": a.model, "runtime": a.runtime, "status": a.status, "reason": a.status_reason, "repo": a.repo })
}

pub async fn list(State(gw): State<Arc<Gateway>>, headers: HeaderMap) -> Response {
    let (me, _) = match caller(&gw, &headers) {
        Ok(c) => c,
        Err(r) => return r,
    };
    match agent::list(&gw.db, &me.ns) {
        Ok(all) => Json(all.iter().filter(|a| !a.master).map(view).collect::<Vec<_>>()).into_response(),
        Err(e) => error(e),
    }
}

#[derive(Deserialize)]
pub struct Create {
    name: String,
    role: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    repo: Option<String>,
    #[serde(default)]
    task: Option<String>,
}

pub async fn create(State(gw): State<Arc<Gateway>>, headers: HeaderMap, Json(req): Json<Create>) -> Response {
    let (me, sup) = match caller(&gw, &headers) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let ns = me.ns.clone();
    let Some(rt) = gw.rt.get() else { return fail(StatusCode::SERVICE_UNAVAILABLE, "no container engine is connected") };
    let existing = match agent::list(&gw.db, &ns) {
        Ok(a) => a,
        Err(e) => return error(e),
    };
    if existing.iter().filter(|a| !a.master).count() >= master::MAX_WORKERS {
        return fail(StatusCode::CONFLICT, format!("this namespace already has {} agents, the most a master agent may manage. Reuse one, or delete one the user no longer needs.", master::MAX_WORKERS));
    }
    let name = req.name.trim().to_string();
    // The same model as the master unless told otherwise, on the runtime that model needs.
    let model = req.model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty()).unwrap_or_else(|| me.model.clone());
    let runtime = if model.contains('/') { "openai-compat" } else { "claude-sdk" };
    let repo = req.repo.map(|r| r.trim().to_string()).filter(|r| !r.is_empty());
    let repo_account = if repo.is_some() {
        match crate::github::for_ns(&gw.db, &ns).unwrap_or_default().into_iter().next() {
            Some(a) => Some(a.id),
            None => return fail(StatusCode::BAD_REQUEST, "this namespace has no GitHub account connected, so agents can't be linked to a repository. Ask the user to connect one in Settings."),
        }
    } else {
        None
    };
    let sandbox_id = match master::sandbox_named(&gw.db, rt, &ns, &name).await {
        Ok(id) => id,
        Err(e) => return error(e),
    };
    let task = req.task.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    let new = NewAgent {
        name: name.clone(),
        role: Some(req.role),
        runtime: runtime.into(),
        model: Some(model),
        sandbox_id: Some(sandbox_id),
        command: task.clone(),
        max_turns: None,
        restart: Some("on-failure".into()),
        max_restarts: None,
        repo,
        repo_account,
    };
    let created = match agent::create(&gw.db, &ns, new) {
        Ok(a) => a,
        Err(e) => return error(e),
    };
    let _ = gw.db.audit(Some(&ns), &me.name, "master.agent.create", &name);
    sup.announce(&ns, &created.id);
    if task.is_some() {
        return match sup.start(&ns, &created.id).await {
            Ok(a) => Json(view(&a)).into_response(),
            Err(e) => fail(StatusCode::BAD_GATEWAY, format!("{name} was created but didn't start: {e}")),
        };
    }
    Json(view(&created)).into_response()
}

/// `limit` and `wait` from the query string.
fn param(query: Option<&str>, key: &str) -> Option<u64> {
    query?.split('&').find_map(|kv| kv.strip_prefix(key)?.strip_prefix('=')?.parse().ok())
}

pub async fn show(State(gw): State<Arc<Gateway>>, headers: HeaderMap, Path(name): Path<String>, RawQuery(q): RawQuery) -> Response {
    let (me, sup) = match caller(&gw, &headers) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let a = match worker(&gw, &me, &name) {
        Ok(a) => a,
        Err(r) => return r,
    };
    if let Some(secs) = param(q.as_deref(), "wait") {
        let rx = sup.subscribe();
        // Already finished or never started: answer from the transcript instead of waiting.
        if a.status != "running" || !busy(&gw, &a) {
            return Json(outcome(&gw, &a, last_reply(&gw, &a), false)).into_response();
        }
        let (texts, timed_out) = until_done(rx, &a.id, secs).await;
        return Json(outcome(&gw, &a, texts, timed_out)).into_response();
    }
    let mut v = view(&a);
    v["log"] = json!(recent(&gw, &a, param(q.as_deref(), "limit").unwrap_or(30).clamp(1, 200) as u32));
    Json(v).into_response()
}

#[derive(Deserialize)]
pub struct Message {
    text: String,
    /// Seconds to wait for the answer; 0 returns as soon as the message is delivered.
    #[serde(default)]
    wait: Option<u64>,
}

pub async fn act(
    State(gw): State<Arc<Gateway>>,
    headers: HeaderMap,
    Path((name, action)): Path<(String, String)>,
    body: axum::body::Bytes,
) -> Response {
    let (me, sup) = match caller(&gw, &headers) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let a = match worker(&gw, &me, &name) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let ns = me.ns.clone();
    match action.as_str() {
        "start" => {
            if sup.is_live(&a.id) {
                return Json(view(&a)).into_response();
            }
            let _ = gw.db.audit(Some(&ns), &me.name, "master.agent.start", &name);
            match sup.start(&ns, &a.id).await {
                Ok(a) => Json(view(&a)).into_response(),
                Err(e) => error(e),
            }
        }
        "stop" => {
            let _ = gw.db.audit(Some(&ns), &me.name, "master.agent.stop", &name);
            match sup.stop(&ns, &a.id, &format!("stopped by {}", me.name)).await {
                Ok(a) => Json(view(&a)).into_response(),
                Err(e) => error(e),
            }
        }
        "message" => {
            let msg: Message = match serde_json::from_slice(&body) {
                Ok(m) => m,
                Err(e) => return fail(StatusCode::BAD_REQUEST, format!("expected {{\"text\": \"...\"}}: {e}")),
            };
            let text = msg.text.trim();
            if text.is_empty() {
                return fail(StatusCode::BAD_REQUEST, "the message is empty");
            }
            if a.status == "paused" {
                return fail(StatusCode::CONFLICT, format!("{name} is paused ({}). The user has to resume it.", a.status_reason));
            }
            // Listen before sending, so a fast answer isn't missed.
            let rx = sup.subscribe();
            if !sup.is_live(&a.id) {
                if let Err(e) = sup.start(&ns, &a.id).await {
                    return fail(StatusCode::BAD_GATEWAY, format!("{name} didn't start: {e}"));
                }
            }
            let _ = gw.db.audit(Some(&ns), &me.name, "master.agent.message", &name);
            if let Err(e) = sup.send(&ns, &a.id, text).await {
                return error(e);
            }
            let secs = msg.wait.unwrap_or(0);
            if secs == 0 {
                return Json(json!({ "name": name, "status": "running", "reason": "", "reply": "", "delivered": true })).into_response();
            }
            let (texts, timed_out) = until_done(rx, &a.id, secs).await;
            Json(outcome(&gw, &a, texts, timed_out)).into_response()
        }
        other => fail(StatusCode::NOT_FOUND, format!("unknown action {other}")),
    }
}

pub async fn remove(State(gw): State<Arc<Gateway>>, headers: HeaderMap, Path(name): Path<String>) -> Response {
    let (me, sup) = match caller(&gw, &headers) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let a = match worker(&gw, &me, &name) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let _ = gw.db.audit(Some(&me.ns), &me.name, "master.agent.delete", &name);
    if let Err(e) = sup.stop(&me.ns, &a.id, "deleted").await {
        return error(e);
    }
    match agent::delete(&gw.db, &me.ns, &a.id) {
        Ok(()) => {
            sup.announce(&me.ns, &a.id);
            Json(json!({ "deleted": name })).into_response()
        }
        Err(e) => error(e),
    }
}

/// What ended a stretch of work, from the agent's transcript: ("result" | "error", text).
struct Ended {
    kind: String,
    text: String,
}

/// Collect what the agent says until its work ends (a result, an error, or it stops), or time runs out.
async fn until_done(mut rx: tokio::sync::broadcast::Receiver<AgentUpdate>, agent_id: &str, secs: u64) -> (Reply, bool) {
    let mut reply = Reply::default();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs.min(MAX_WAIT));
    loop {
        let next = tokio::time::timeout_at(deadline, rx.recv()).await;
        let update = match next {
            Err(_) => return (reply, true),
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(_)) => return (reply, false),
            Ok(Ok(u)) => u,
        };
        if update.agent_id != agent_id {
            continue;
        }
        if let Some(ev) = &update.event {
            match ev.kind.as_str() {
                "text" => reply.texts.push(ev.text.clone()),
                "result" | "error" => {
                    reply.ended = Some(Ended { kind: ev.kind.clone(), text: ev.text.clone() });
                    return (reply, false);
                }
                _ => {}
            }
        }
        if matches!(update.status.as_deref(), Some("stopped" | "failed" | "paused")) {
            return (reply, false);
        }
    }
}

#[derive(Default)]
struct Reply {
    texts: Vec<String>,
    ended: Option<Ended>,
}

fn latest_events(gw: &Gateway, a: &AgentRecord) -> Vec<agent::AgentEvent> {
    let Ok(runs) = agent::runs(&gw.db, &a.ns, &a.id, 1) else { return vec![] };
    let Some(run) = runs.first() else { return vec![] };
    agent::events(&gw.db, &a.ns, &run.id, 0, 2000).unwrap_or_default()
}

/// Whether the agent is in the middle of something: its last message hasn't been answered with a result yet.
fn busy(gw: &Gateway, a: &AgentRecord) -> bool {
    let events = latest_events(gw, a);
    let last_input = events.iter().rposition(|e| e.kind == "input");
    let last_end = events.iter().rposition(|e| e.kind == "result" || e.kind == "error");
    match (last_input, last_end) {
        (Some(i), Some(e)) => i > e,
        (Some(_), None) => true,
        // No message yet: busy only if it was started with a task and hasn't reported.
        (None, None) => !a.command.is_empty() && !events.is_empty(),
        (None, Some(_)) => false,
    }
}

/// What the agent said since its last message (or since it started), and how that ended.
fn last_reply(gw: &Gateway, a: &AgentRecord) -> Reply {
    let events = latest_events(gw, a);
    let from = events.iter().rposition(|e| e.kind == "input").map(|i| i + 1).unwrap_or(0);
    let mut reply = Reply::default();
    for e in &events[from..] {
        match e.kind.as_str() {
            "text" => reply.texts.push(e.text.clone()),
            "result" | "error" => reply.ended = Some(Ended { kind: e.kind.clone(), text: e.text.clone() }),
            _ => {}
        }
    }
    reply
}

fn outcome(gw: &Gateway, a: &AgentRecord, reply: Reply, timed_out: bool) -> Value {
    let now = agent::get(&gw.db, &a.ns, &a.id).unwrap_or_else(|_| a.clone());
    let mut v = json!({ "name": now.name, "status": now.status, "reason": now.status_reason, "reply": clip(&reply.texts.join("\n\n")), "timed_out": timed_out });
    if let Some(end) = reply.ended {
        v[end.kind.as_str()] = json!(end.text);
    }
    v
}

fn recent(gw: &Gateway, a: &AgentRecord, limit: u32) -> Vec<Value> {
    let events = latest_events(gw, a);
    let skip = events.len().saturating_sub(limit as usize);
    events[skip..].iter().map(|e| json!({ "kind": e.kind, "text": clip(&e.text) })).collect()
}

/// `GET /_kalypso/memory`: what the master agent remembers.
pub async fn memories(State(gw): State<Arc<Gateway>>, headers: HeaderMap) -> Response {
    let (me, _) = match caller(&gw, &headers) {
        Ok(c) => c,
        Err(r) => return r,
    };
    match crate::prompts::memories(&gw.db, &me.ns) {
        Ok(m) => Json(m.into_iter().map(|m| json!({ "text": m.text, "source": m.source, "at": m.created_at })).collect::<Vec<_>>())
            .into_response(),
        Err(e) => error(e),
    }
}

#[derive(Deserialize)]
pub struct Remember {
    text: String,
}

/// `POST /_kalypso/memory`: the master agent saves a lasting fact, if memory is on.
pub async fn remember(State(gw): State<Arc<Gateway>>, headers: HeaderMap, Json(req): Json<Remember>) -> Response {
    let (me, _) = match caller(&gw, &headers) {
        Ok(c) => c,
        Err(r) => return r,
    };
    match crate::prompts::memory_on(&gw.db, &me.ns) {
        Ok(false) => return fail(StatusCode::FORBIDDEN, "the user has turned memory off; don't save anything"),
        Err(e) => return error(e),
        Ok(true) => {}
    }
    match crate::prompts::remember(&gw.db, &me.ns, &req.text, &me.name) {
        Ok(m) => Json(json!({ "saved": m.text })).into_response(),
        Err(e) => error(e),
    }
}
