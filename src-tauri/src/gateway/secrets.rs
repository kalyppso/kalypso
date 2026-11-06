//! The secret gateway (#87): an agent asks for an `on-request` secret to run one command;
//! if a policy or the user approves, KALYPSO runs that command in the sandbox with the
//! secret in its environment, as a user the agent isn't.
//!
//! What keeps the value away from the agent:
//! - It exists only in the environment of the process KALYPSO starts through the engine's
//!   exec API, never in the container's environment, files or the agent's processes.
//! - That process runs as a fresh uid per grant with no capabilities. Reading another
//!   process's `/proc/<pid>/environ` or attaching to it needs the same uid or
//!   `CAP_SYS_PTRACE`, so the agent can't, even as root in the sandbox.
//! - Its output is redacted as it streams back; files left holding the value are removed
//!   after the run; model calls carrying it are refused at the gateway while it is live.
//! - The value is decrypted only to start the command and lives in memory wiped on drop.
//! - The endpoint is only on the Unix socket mounted into sandboxes, not on the TCP port.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use zeroize::Zeroizing;

use super::{resolve, token, Gateway};
use crate::error::{KalypsoError, Result};
use crate::store::Db;

const MAX_TTL: u64 = 3600;
const DEFAULT_TTL: u64 = 900;
/// Per sandbox key: grants running at once, and requests per window.
const MAX_RUNNING: usize = 2;
const MAX_REQUESTS: usize = 10;
const REQUEST_WINDOW: Duration = Duration::from_secs(600);
/// Grant processes get uids from this range, one per grant.
const UID_BASE: u32 = 20_000;
const UID_SPAN: u32 = 40_000;

#[derive(Debug, Deserialize)]
pub struct RunRequest {
    pub name: String,
    pub purpose: String,
    pub command: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub ttl: Option<u64>,
}

/// A grant as the UI lists it. Never carries the value.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct SecretGrant {
    pub id: String,
    pub ns: String,
    pub sandbox_id: String,
    pub secret: String,
    pub command: String,
    pub purpose: String,
    pub source: String,
    pub started_at: String,
    pub expires_at: String,
    pub ended_at: Option<String>,
    pub outcome: String,
    #[ts(type = "number | null")]
    pub exit_code: Option<i64>,
    #[ts(type = "number")]
    pub leaks: i64,
}

struct Live {
    ns: String,
    secret: String,
    value: Zeroizing<String>,
    stop: Arc<tokio::sync::Notify>,
    revoked: Arc<std::sync::atomic::AtomicBool>,
}

/// Grants in flight. The only place a value lives while its command runs.
#[derive(Default)]
pub struct Grants {
    live: Mutex<HashMap<String, Live>>,
    requests: Mutex<HashMap<String, Vec<Instant>>>,
    running: Mutex<HashMap<String, usize>>,
    seq: AtomicU32,
}

impl Grants {
    /// The name of a live grant's secret whose value appears in `bytes`, in `ns`.
    pub fn leak_in(&self, ns: &str, bytes: &[u8]) -> Option<String> {
        let live = self.live.lock().unwrap();
        live.values()
            .filter(|g| g.ns == ns && g.value.len() >= 4)
            .find(|g| find(bytes, g.value.as_bytes()).is_some())
            .map(|g| g.secret.clone())
    }

    /// Stop a running grant now. False if it isn't running.
    pub fn revoke(&self, ns: &str, id: &str) -> bool {
        let live = self.live.lock().unwrap();
        match live.get(id) {
            Some(g) if g.ns == ns => {
                g.revoked.store(true, Ordering::SeqCst);
                // notify_one keeps the signal if the run loop isn't waiting yet (still starting).
                g.stop.notify_one();
                true
            }
            _ => false,
        }
    }

    fn next_uid(&self) -> u32 {
        // Start somewhere different on every launch so uids don't line up across restarts.
        if self.seq.load(Ordering::SeqCst) == 0 {
            let _ = self.seq.compare_exchange(0, rand::random::<u32>() % UID_SPAN + 1, Ordering::SeqCst, Ordering::SeqCst);
        }
        UID_BASE + self.seq.fetch_add(1, Ordering::SeqCst) % UID_SPAN
    }

    /// Admit a request from `key`, or say why not.
    fn admit(&self, key: &str) -> std::result::Result<(), String> {
        let now = Instant::now();
        let mut reqs = self.requests.lock().unwrap();
        let list = reqs.entry(key.to_string()).or_default();
        list.retain(|t| now.duration_since(*t) < REQUEST_WINDOW);
        if list.len() >= MAX_REQUESTS {
            return Err(format!("too many secret requests: at most {MAX_REQUESTS} every {} minutes", REQUEST_WINDOW.as_secs() / 60));
        }
        if self.running.lock().unwrap().get(key).copied().unwrap_or(0) >= MAX_RUNNING {
            return Err(format!("at most {MAX_RUNNING} commands with secrets can run at once in a sandbox"));
        }
        list.push(now);
        Ok(())
    }

    fn running(&self, key: &str, delta: isize) {
        let mut r = self.running.lock().unwrap();
        let n = r.entry(key.to_string()).or_default();
        *n = (*n as isize + delta).max(0) as usize;
    }
}

/// Replaces a value with `‹NAME›` in a byte stream, even when it is split across chunks.
pub struct Redactor {
    needle: Vec<u8>,
    mark: Vec<u8>,
    buf: Vec<u8>,
}

impl Redactor {
    pub fn new(name: &str, value: &str) -> Self {
        Redactor { needle: value.as_bytes().to_vec(), mark: format!("‹{name}›").into_bytes(), buf: Vec::new() }
    }

    /// Everything that can't be the start of the value; the rest waits for more bytes.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        self.buf.extend_from_slice(chunk);
        let n = self.needle.len();
        if n == 0 {
            return std::mem::take(&mut self.buf);
        }
        let mut out = Vec::with_capacity(self.buf.len());
        let mut i = 0;
        while i + n <= self.buf.len() {
            if self.buf[i..i + n] == self.needle[..] {
                out.extend_from_slice(&self.mark);
                i += n;
            } else {
                out.push(self.buf[i]);
                i += 1;
            }
        }
        self.buf.drain(..i);
        out
    }

    /// The tail: shorter than the value, so it can't contain it.
    pub fn finish(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.buf)
    }
}

impl Drop for Redactor {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.needle.zeroize();
        self.buf.zeroize();
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Quote an argv for display: `npm test -- --grep "billing tests"`.
fn shell_join(argv: &[String]) -> String {
    argv.iter()
        .map(|a| {
            if !a.is_empty() && a.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:@%+,".contains(c)) {
                a.clone()
            } else {
                format!("'{}'", a.replace('\'', "'\\''"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn validate(r: &RunRequest) -> std::result::Result<(), String> {
    let name_ok =
        !r.name.is_empty() && r.name.len() <= 128 && r.name.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    if !name_ok {
        return Err("name the secret in A-Z, 0-9 and _, for example STRIPE_KEY".into());
    }
    if r.purpose.trim().is_empty() || r.purpose.len() > 500 {
        return Err("say what the secret is for (--purpose), in under 500 characters".into());
    }
    if r.command.is_empty() || r.command.len() > 64 || r.command.iter().map(String::len).sum::<usize>() > 8000 || r.command[0].is_empty() {
        return Err("give the command to run after --, at most 64 arguments and 8000 characters".into());
    }
    if r.command.iter().any(|a| a.contains('\0')) {
        return Err("arguments can't contain NUL".into());
    }
    if let Some(cwd) = &r.cwd {
        if !cwd.starts_with('/') || cwd.contains('\0') {
            return Err("cwd must be an absolute path".into());
        }
    }
    if r.ttl.is_some_and(|t| !(10..=MAX_TTL).contains(&t)) {
        return Err(format!("ttl must be between 10 and {MAX_TTL} seconds"));
    }
    Ok(())
}

fn line(v: serde_json::Value) -> std::result::Result<bytes::Bytes, std::io::Error> {
    let mut s = v.to_string();
    s.push('\n');
    Ok(bytes::Bytes::from(s))
}

/// `POST /_kalypso/secrets/run`, on the sandbox socket only. Streams JSON lines:
/// `{"t":"status"}`, `{"t":"out"}` (redacted) and finally `{"t":"end"}` or `{"t":"error"}`.
pub async fn run(State(gw): State<Arc<Gateway>>, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    let err = |status: StatusCode, msg: &str| (status, axum::Json(serde_json::json!({ "t": "error", "text": msg }))).into_response();
    let Some(tok) = token(&headers) else { return err(StatusCode::UNAUTHORIZED, "missing KALYPSO gateway key") };
    let (key_id, ns, source) = match resolve(&gw.db, tok) {
        Ok(Some(k)) => k,
        Ok(None) => return err(StatusCode::UNAUTHORIZED, "unknown or revoked KALYPSO gateway key"),
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    };
    let Ok(Some(sandbox_id)) = sandbox_of(&gw.db, &key_id) else {
        return err(StatusCode::FORBIDDEN, "only sandboxes can request secrets");
    };
    let req: RunRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => return err(StatusCode::BAD_REQUEST, &format!("expected {{name, purpose, command}}: {e}")),
    };
    if let Err(msg) = validate(&req) {
        return err(StatusCode::BAD_REQUEST, &msg);
    }
    if let Err(msg) = gw.grants.admit(&key_id) {
        let _ = gw.db.audit(Some(&ns), &source, "secret.throttle", &req.name);
        return err(StatusCode::TOO_MANY_REQUESTS, &msg);
    }
    // Only on-request secrets. Whether a secret exists in another scope isn't revealed.
    let exists = gw.db.with(|c| {
        Ok(c.query_row("SELECT 1 FROM secrets WHERE ns = ?1 AND key = ?2 AND scope = 'on-request'", (&ns, &req.name), |_| Ok(()))
            .optional()?
            .is_some())
    });
    let command = shell_join(&req.command);
    let target = format!("{} for `{}`", req.name, command);
    let _ = gw.db.audit(Some(&ns), &source, "secret.request", &target);
    if !matches!(exists, Ok(true)) {
        let _ = gw.db.audit(Some(&ns), &source, "secret.deny", &target);
        return err(StatusCode::NOT_FOUND, &format!("there is no on-request secret called {} in this namespace", req.name));
    }

    let (tx, rx) = tokio::sync::mpsc::channel::<std::result::Result<bytes::Bytes, std::io::Error>>(64);
    tokio::spawn(async move {
        gw.grants.running(&key_id, 1);
        let outcome = serve(&gw, &key_id, &ns, &source, &sandbox_id, req, &command, &target, &tx).await;
        gw.grants.running(&key_id, -1);
        if let Err(e) = outcome {
            let _ = tx.send(line(serde_json::json!({ "t": "error", "text": e.to_string() }))).await;
        }
        let _ = gw.policy_log.send(ns);
    });
    let stream = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) });
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/x-ndjson")
        .header("cache-control", "no-store")
        .body(Body::from_stream(stream))
        .unwrap()
}

#[allow(clippy::too_many_arguments)]
async fn serve(
    gw: &Arc<Gateway>,
    key_id: &str,
    ns: &str,
    source: &str,
    sandbox_id: &str,
    req: RunRequest,
    command: &str,
    target: &str,
    tx: &tokio::sync::mpsc::Sender<std::result::Result<bytes::Bytes, std::io::Error>>,
) -> Result<()> {
    let send = |v: serde_json::Value| async move { tx.send(line(v)).await.is_ok() };

    // 1. Decide: policies first; a request no policy matches asks the user.
    let call = crate::policy::ToolCall {
        kind: "secret".into(),
        tool: Some(req.name.clone()),
        command: Some(command.to_string()),
        content: Some(req.purpose.clone()),
        ..Default::default()
    };
    send(serde_json::json!({ "t": "status", "text": format!("Asking for {}…", req.name) })).await;
    let ask = super::DefaultAsk {
        policy_id: format!("secret:{}", req.name),
        name: "Secret request".into(),
        rule: "Commands that need an on-request secret run only after you approve them.".into(),
        reason: format!("{} wants {}", source, req.name),
    };
    if let Err(denied) = super::decide(gw, key_id, ns, source, &call, Some(ask)).await {
        let _ = gw.db.audit(Some(ns), source, "secret.deny", target);
        let reason = denied.reason.unwrap_or_else(|| "denied".into());
        send(serde_json::json!({ "t": "error", "text": reason })).await;
        return Ok(());
    }

    // 2. Grant: a fresh uid, the value in memory, a deadline.
    let rt = gw.runtime().ok_or_else(|| KalypsoError::Runtime("no container engine".into()))?;
    let sb = crate::sandbox::get(&gw.db, ns, sandbox_id)?;
    if sb.status != "running" {
        return Err(KalypsoError::Invalid("the sandbox isn't running".into()));
    }
    let provider = rt.provider(&sb.runtime)?;
    let value = gw.vault.open_on_request(&gw.db, ns, &req.name)?.ok_or_else(|| KalypsoError::NotFound(req.name.clone()))?;
    let ttl = req.ttl.unwrap_or(DEFAULT_TTL);
    let uid = gw.grants.next_uid();
    let id = crate::vault::new_id("gr");
    gw.db.with(|c| {
        c.execute(
            "INSERT INTO secret_grants (id, ns, sandbox_id, secret, command, purpose, source, uid, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now', ?9))",
            (&id, ns, sandbox_id, &req.name, command, &req.purpose, source, uid, format!("+{ttl} seconds")),
        )?;
        Ok(())
    })?;
    let _ = gw.db.audit(Some(ns), source, "secret.grant", target);
    let stop = Arc::new(tokio::sync::Notify::new());
    let revoked = Arc::new(std::sync::atomic::AtomicBool::new(false));
    gw.grants.live.lock().unwrap().insert(
        id.clone(),
        Live {
            ns: ns.into(),
            secret: req.name.clone(),
            value: Zeroizing::new(value.to_string()),
            stop: stop.clone(),
            revoked: revoked.clone(),
        },
    );
    let _ = gw.policy_log.send(ns.to_string());

    // 3. Run, as that uid (group root, so it can use the agent's files), with the secret in its environment only.
    let user = format!("{uid}:0");
    let cwd = req.cwd.clone().unwrap_or_else(|| "/work".into());
    let argv: Vec<&str> = req.command.iter().map(String::as_str).collect();
    let env = vec![format!("{}={}", req.name, value.as_str()), format!("HOME=/tmp/.kx-{uid}")];
    // Let the grant's user work in the folder: group-writable, as the agent's own user (root, no capabilities).
    let _ = crate::sandbox::exec(&rt, ns, sandbox_id, &["chmod", "-R", "g+rwX", &cwd], false).await;
    send(serde_json::json!({ "t": "status", "text": format!("Approved: running with {} for up to {}s.", req.name, ttl) })).await;
    // Revoked while it was being set up: don't start it at all.
    if revoked.load(Ordering::SeqCst) {
        gw.grants.live.lock().unwrap().remove(&id);
        finish(gw, &id, "revoked", None, 0);
        let _ = gw.db.audit(Some(ns), source, "secret.revoke", target);
        send(serde_json::json!({ "t": "end", "outcome": "revoked", "exit": null, "removed": 0 })).await;
        return Ok(());
    }
    let started = provider.run_as(ns, sandbox_id, &argv, &cwd, &env, &user).await;
    drop(env);
    let (stream, handle) = match started {
        Ok(s) => s,
        Err(e) => {
            finish(gw, &id, "failed", None, 0);
            return Err(e);
        }
    };
    let mut output = stream.output;
    drop(stream.input);
    let mut redactor = Redactor::new(&req.name, value.as_str());
    let deadline = tokio::time::sleep(Duration::from_secs(ttl));
    tokio::pin!(deadline);
    let mut why = "exited";
    loop {
        tokio::select! {
            chunk = output.next() => match chunk {
                Some(Ok(bytes)) => {
                    let safe = redactor.push(&bytes);
                    if !safe.is_empty() && !send(serde_json::json!({ "t": "out", "text": String::from_utf8_lossy(&safe) })).await {
                        why = "disconnected";
                        break;
                    }
                }
                _ => break,
            },
            _ = &mut deadline => { why = "expired"; break; }
            _ = stop.notified() => { why = "revoked"; break; }
            _ = tx.closed() => { why = "disconnected"; break; }
        }
    }
    let rest = redactor.finish();
    if !rest.is_empty() {
        send(serde_json::json!({ "t": "out", "text": String::from_utf8_lossy(&rest) })).await;
    }
    if why != "exited" {
        // Only the grant's own uid can signal its processes (capabilities are dropped).
        let _ = provider.run_as(ns, sandbox_id, &["/bin/sh", "-c", "kill -KILL -1"], "/", &[], &user).await;
    }
    let mut code = None;
    for _ in 0..40 {
        match provider.exit_code(&handle).await {
            Ok(Some(c)) => {
                code = Some(c);
                break;
            }
            Ok(None) => tokio::time::sleep(Duration::from_millis(50)).await,
            Err(_) => break,
        }
    }

    // 4. Clean up: files the command left holding the value are removed.
    let removed = sweep(&provider, ns, sandbox_id, &user, &req.name, value.as_str()).await;
    gw.grants.live.lock().unwrap().remove(&id);
    drop(value);
    let outcome = match why {
        "expired" => "expired",
        "revoked" if revoked.load(Ordering::SeqCst) => "revoked",
        "exited" => "exited",
        _ => "stopped",
    };
    finish(gw, &id, outcome, code, removed);
    let action = match outcome {
        "expired" => "secret.expire",
        "revoked" => "secret.revoke",
        _ => "secret.run",
    };
    let _ = gw.db.audit(Some(ns), source, action, target);
    if removed > 0 {
        let _ = gw.db.audit(Some(ns), "gateway", "secret.leak", &format!("{removed} file(s) holding {} removed", req.name));
    }
    send(serde_json::json!({ "t": "end", "outcome": outcome, "exit": code, "removed": removed })).await;
    Ok(())
}

/// Remove files the grant's user left holding the value. Runs as that user, with the
/// value in its own environment, so the agent never sees it here either.
async fn sweep(provider: &Arc<dyn crate::sandbox::SandboxProvider>, ns: &str, id: &str, user: &str, name: &str, value: &str) -> i64 {
    if value.len() < 4 {
        return 0;
    }
    let script =
        r#"grep -rlsF -e "$KX_SCAN" /work /tmp /var/tmp /dev/shm 2>/dev/null | while IFS= read -r f; do rm -f -- "$f" && echo x; done"#;
    let env = vec![format!("KX_SCAN={value}")];
    let Ok((stream, _)) = provider.run_as(ns, id, &["/bin/sh", "-c", script], "/", &env, user).await else { return 0 };
    let out: Vec<u8> = tokio::time::timeout(Duration::from_secs(30), stream.output.filter_map(|c| async move { c.ok() }).concat())
        .await
        .unwrap_or_default();
    let n = out.iter().filter(|b| **b == b'x').count() as i64;
    if n > 0 {
        tracing::warn!(secret = name, files = n, "removed files holding a granted secret");
    }
    n
}

fn finish(gw: &Gateway, id: &str, outcome: &str, code: Option<i64>, leaks: i64) {
    let r = gw.db.with(|c| {
        c.execute(
            "UPDATE secret_grants SET ended_at = CURRENT_TIMESTAMP, outcome = ?2, exit_code = ?3, leaks = ?4 WHERE id = ?1",
            (id, outcome, code, leaks),
        )?;
        Ok(())
    });
    if let Err(e) = r {
        tracing::error!(error = %e, "could not record the end of a secret grant");
    }
}

pub(super) fn sandbox_of(db: &Db, key_id: &str) -> Result<Option<String>> {
    db.with(|c| {
        Ok(c.query_row("SELECT sandbox_id FROM gateway_keys WHERE id = ?1", [key_id], |r| r.get::<_, Option<String>>(0))
            .optional()?
            .flatten())
    })
}

/// Recent grants in a namespace, newest first.
pub fn list(db: &Db, ns: &str, limit: u32) -> Result<Vec<SecretGrant>> {
    db.with(|c| {
        let mut st = c.prepare(
            "SELECT id, ns, sandbox_id, secret, command, purpose, source, started_at, expires_at, ended_at, outcome, exit_code, leaks
             FROM secret_grants WHERE ns = ?1 ORDER BY started_at DESC, rowid DESC LIMIT ?2",
        )?;
        let rows = st.query_map((ns, limit), |r| {
            Ok(SecretGrant {
                id: r.get(0)?,
                ns: r.get(1)?,
                sandbox_id: r.get(2)?,
                secret: r.get(3)?,
                command: r.get(4)?,
                purpose: r.get(5)?,
                source: r.get(6)?,
                started_at: r.get(7)?,
                expires_at: r.get(8)?,
                ended_at: r.get(9)?,
                outcome: r.get(10)?,
                exit_code: r.get(11)?,
                leaks: r.get(12)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    })
}

/// Grants still marked running when KALYPSO quit are closed: their processes died with it
/// or will be killed when the sandbox restarts.
pub fn reset_after_restart(db: &Db) -> Result<()> {
    db.with(|c| {
        c.execute("UPDATE secret_grants SET outcome = 'stopped', ended_at = CURRENT_TIMESTAMP WHERE outcome = 'running'", [])?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn redact(chunks: &[&str], value: &str) -> String {
        let mut r = Redactor::new("KEY", value);
        let mut out = Vec::new();
        for c in chunks {
            out.extend(r.push(c.as_bytes()));
        }
        out.extend(r.finish());
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn values_are_redacted_across_chunk_boundaries() {
        assert_eq!(redact(&["token=sk_live_123 ok"], "sk_live_123"), "token=‹KEY› ok");
        assert_eq!(redact(&["a sk_li", "ve_1", "23 b sk_live_123"], "sk_live_123"), "a ‹KEY› b ‹KEY›");
        assert_eq!(redact(&["sk_live_12", "4 nope"], "sk_live_123"), "sk_live_124 nope");
        assert_eq!(redact(&["tail sk_li"], "sk_live_123"), "tail sk_li");
    }

    #[test]
    fn requests_are_validated() {
        let ok = RunRequest {
            name: "STRIPE_KEY".into(),
            purpose: "tests".into(),
            command: vec!["npm".into(), "test".into()],
            cwd: None,
            ttl: None,
        };
        assert!(validate(&ok).is_ok());
        assert!(validate(&RunRequest { name: "stripe".into(), ..ok_clone(&ok) }).is_err());
        assert!(validate(&RunRequest { purpose: " ".into(), ..ok_clone(&ok) }).is_err());
        assert!(validate(&RunRequest { command: vec![], ..ok_clone(&ok) }).is_err());
        assert!(validate(&RunRequest { ttl: Some(99_999), ..ok_clone(&ok) }).is_err());
        assert!(validate(&RunRequest { cwd: Some("work".into()), ..ok_clone(&ok) }).is_err());
        assert_eq!(shell_join(&["npm".into(), "run".into(), "a b".into(), "it's".into()]), r#"npm run 'a b' 'it'\''s'"#);
    }

    fn ok_clone(r: &RunRequest) -> RunRequest {
        RunRequest { name: r.name.clone(), purpose: r.purpose.clone(), command: r.command.clone(), cwd: r.cwd.clone(), ttl: r.ttl }
    }

    #[test]
    fn rate_limits_hold() {
        let g = Grants::default();
        for _ in 0..MAX_REQUESTS {
            assert!(g.admit("k").is_ok());
        }
        assert!(g.admit("k").is_err());
        assert!(g.admit("other").is_ok());
        g.running("busy", MAX_RUNNING as isize);
        assert!(g.admit("busy").is_err());
        let a = g.next_uid();
        let b = g.next_uid();
        assert!((UID_BASE..UID_BASE + UID_SPAN).contains(&a) && a != b);
    }
}
