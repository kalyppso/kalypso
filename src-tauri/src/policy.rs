//! Policies: rules checked before an agent's tool call runs.
//!
//! A policy is a plain-language rule shown to people and agents, plus a spec the
//! engine checks deterministically: command regexes, allowed and denied paths,
//! host lists, a scan for secret values, or a cost limit. A policy with only text
//! (`Spec::Text`) is stored and shown but needs the judge (#30) to be enforced.
//!
//! Enforcement: `block` refuses, `warn` lets the call through and logs it,
//! `approve` holds the call until the user approves or denies it (denied after
//! [`APPROVAL_TIMEOUT`]). An approval can be remembered for the rest of the run,
//! where a run is the life of the gateway key making the call.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{KalypsoError, Result};
use crate::store::Db;

/// How long a call waits for the user before it is denied.
pub const APPROVAL_TIMEOUT: Duration = Duration::from_secs(600);

const CATEGORIES: &[&str] = &["filesystem", "network", "git", "secrets", "spend", "comms", "deploy", "custom"];

/// The checkable part of a policy.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum Spec {
    /// Shell commands matching any of these regexes.
    Command { patterns: Vec<String> },
    /// File access outside `allow` (when set) or inside `deny`. Globs; `**` crosses folders.
    Path {
        #[serde(default)]
        allow: Vec<String>,
        #[serde(default)]
        deny: Vec<String>,
    },
    /// Requests to hosts outside `allow` (when set) or in `deny`. `*.example.com` covers subdomains.
    Host {
        #[serde(default)]
        allow: Vec<String>,
        #[serde(default)]
        deny: Vec<String>,
    },
    /// Any of the namespace's secret values appearing in the call.
    Secrets,
    /// A single call estimated to cost more than this, in millionths of a dollar.
    Cost {
        #[ts(type = "number")]
        max: i64,
    },
    /// Plain language only; checked by the judge (#30), not here.
    Text,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct Policy {
    pub id: String,
    /// A namespace, or "*" for every namespace.
    pub ns: String,
    pub name: String,
    pub rule: String,
    pub category: String,
    /// "block", "approve" or "warn".
    pub enforcement: String,
    /// Targets ("sandbox:<id>", "key:<id>"), or null for everything in scope.
    pub applies_to: Option<Vec<String>>,
    pub enabled: bool,
    pub spec: Spec,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct NewPolicy {
    pub name: String,
    pub rule: String,
    pub category: String,
    pub enforcement: String,
    #[serde(default)]
    #[ts(optional)]
    pub applies_to: Option<Vec<String>>,
    pub spec: Spec,
    /// Apply in every namespace instead of just this one.
    #[serde(default)]
    #[ts(optional)]
    pub everywhere: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize, TS)]
#[ts(export)]
pub struct PolicyPatch {
    #[ts(optional)]
    pub name: Option<String>,
    #[ts(optional)]
    pub rule: Option<String>,
    #[ts(optional)]
    pub enforcement: Option<String>,
    #[ts(optional)]
    pub enabled: Option<bool>,
    #[ts(optional)]
    pub spec: Option<Spec>,
}

/// What an agent is about to do. Fields that don't apply are left out.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ToolCall {
    /// "bash", "file_read", "file_write", "http", "mcp", or another tool name.
    pub kind: String,
    #[serde(default)]
    #[ts(optional)]
    pub command: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub path: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub url: Option<String>,
    /// Text the call sends or writes: a file's new content, a request body, a message.
    #[serde(default)]
    #[ts(optional)]
    pub content: Option<String>,
    /// MCP or other tool name.
    #[serde(default)]
    #[ts(optional)]
    pub tool: Option<String>,
    /// Estimated cost in millionths of a dollar.
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub cost: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub policy: Policy,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct PolicyEvent {
    #[ts(type = "number")]
    pub id: i64,
    pub ts: String,
    pub ns: String,
    pub policy_id: String,
    pub policy: String,
    pub source: String,
    pub action: String,
    /// "blocked", "warned", "asked", "approved" or "denied".
    pub outcome: String,
}

// ---------- Evaluation ----------

/// Resolve `.` and `..` so `/work/../etc/passwd` is judged as `/etc/passwd`.
/// Relative paths are taken from `/work`, the sandbox's working folder.
pub fn normalize_path(p: &str) -> String {
    let full = if p.starts_with('/') { p.to_string() } else { format!("/work/{p}") };
    let mut parts: Vec<&str> = Vec::new();
    for seg in full.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    format!("/{}", parts.join("/"))
}

fn glob(pattern: &str) -> std::result::Result<globset::GlobMatcher, String> {
    globset::GlobBuilder::new(pattern).literal_separator(true).build().map(|g| g.compile_matcher()).map_err(|e| e.to_string())
}

fn host_of(url: &str) -> Option<String> {
    reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(|h| h.trim_end_matches('.').to_ascii_lowercase()))
}

fn host_matches(host: &str, pattern: &str) -> bool {
    let p = pattern.trim().to_ascii_lowercase();
    match p.strip_prefix("*.") {
        Some(base) => host.len() > base.len() && host.ends_with(base) && host[..host.len() - base.len()].ends_with('.'),
        None => host == p,
    }
}

/// Check a spec is well formed: regexes and globs compile, hosts and limits make sense.
pub fn validate_spec(spec: &Spec) -> Result<()> {
    let bad = |m: String| Err(KalypsoError::Invalid(m));
    match spec {
        Spec::Command { patterns } => {
            if patterns.is_empty() {
                return bad("add at least one command pattern".into());
            }
            for p in patterns {
                if let Err(e) = regex::Regex::new(p) {
                    return bad(format!("pattern {p} is not a valid regular expression: {e}"));
                }
            }
        }
        Spec::Path { allow, deny } | Spec::Host { allow, deny } => {
            if allow.is_empty() && deny.is_empty() {
                return bad("list at least one allowed or denied entry".into());
            }
            if matches!(spec, Spec::Path { .. }) {
                for p in allow.iter().chain(deny) {
                    if !p.starts_with('/') {
                        return bad(format!("path {p} must start with /"));
                    }
                    if let Err(e) = glob(p) {
                        return bad(format!("path {p} is not a valid pattern: {e}"));
                    }
                }
            } else {
                for h in allow.iter().chain(deny) {
                    let h = h.trim();
                    let ok = !h.is_empty() && h.trim_start_matches("*.").chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
                    if !ok {
                        return bad(format!("{h} is not a host name (use example.com or *.example.com)"));
                    }
                }
            }
        }
        Spec::Cost { max } if *max <= 0 => return bad("the cost limit must be more than $0".into()),
        _ => {}
    }
    Ok(())
}

/// Why `spec` stops `call`, or `None` if it doesn't apply.
fn check_spec(spec: &Spec, call: &ToolCall, secrets: &[String]) -> Option<String> {
    match spec {
        Spec::Command { patterns } => {
            let cmd = call.command.as_deref()?;
            patterns
                .iter()
                .find(|p| regex::Regex::new(p).is_ok_and(|r| r.is_match(cmd)))
                .map(|_| "the command matches a forbidden pattern".into())
        }
        Spec::Path { allow, deny } => {
            if !matches!(call.kind.as_str(), "file_read" | "file_write" | "file_delete") && call.kind != "bash" {
                return None;
            }
            let path = normalize_path(call.path.as_deref()?);
            let hit = |list: &Vec<String>| list.iter().any(|p| glob(p).is_ok_and(|g| g.is_match(&path)));
            if hit(deny) {
                Some(format!("{path} is a protected path"))
            } else if !allow.is_empty() && !hit(allow) {
                Some(format!("{path} is outside the allowed folders ({})", allow.join(", ")))
            } else {
                None
            }
        }
        Spec::Host { allow, deny } => {
            let host = host_of(call.url.as_deref()?)?;
            if deny.iter().any(|p| host_matches(&host, p)) {
                Some(format!("{host} is on the blocked list"))
            } else if !allow.is_empty() && !allow.iter().any(|p| host_matches(&host, p)) {
                Some(format!("{host} is not on the allowed list"))
            } else {
                None
            }
        }
        Spec::Secrets => {
            let fields = [&call.command, &call.path, &call.url, &call.content];
            let leaked = secrets
                .iter()
                .filter(|s| s.len() >= 6)
                .find(|s| fields.iter().any(|f| f.as_deref().is_some_and(|t| t.contains(s.as_str()))));
            leaked.map(|_| "the call contains a secret value".into())
        }
        Spec::Cost { max } => {
            let cost = call.cost?;
            (cost > *max).then(|| format!("estimated {} is over the {} limit", crate::budget::usd(cost), crate::budget::usd(*max)))
        }
        Spec::Text => None,
    }
}

/// Every enabled policy that stops `call`, block first, then approve, then warn.
pub fn evaluate(policies: &[Policy], call: &ToolCall, secrets: &[String]) -> Vec<Hit> {
    let rank = |e: &str| match e {
        "block" => 0,
        "approve" => 1,
        _ => 2,
    };
    let mut hits: Vec<Hit> = policies
        .iter()
        .filter(|p| p.enabled)
        .filter_map(|p| check_spec(&p.spec, call, secrets).map(|reason| Hit { policy: p.clone(), reason }))
        .collect();
    hits.sort_by_key(|h| rank(&h.policy.enforcement));
    hits
}

/// One line describing the call for logs and approval prompts, with secret values hidden.
pub fn describe(call: &ToolCall, secrets: &[String]) -> String {
    let what =
        call.command.clone().or_else(|| call.url.clone()).or_else(|| call.path.clone()).or_else(|| call.tool.clone()).unwrap_or_default();
    let mut line = format!("{}: {}", call.kind, what.replace('\n', " "));
    for s in secrets.iter().filter(|s| s.len() >= 6) {
        line = line.replace(s.as_str(), "••••••");
    }
    if line.chars().count() > 240 {
        line = line.chars().take(239).collect::<String>() + "…";
    }
    line
}

// ---------- Storage ----------

fn row(r: &rusqlite::Row) -> rusqlite::Result<(Policy, String, String)> {
    let applies: Option<String> = r.get(6)?;
    let spec: String = r.get(8)?;
    Ok((
        Policy {
            id: r.get(0)?,
            ns: r.get(1)?,
            name: r.get(2)?,
            rule: r.get(3)?,
            category: r.get(4)?,
            enforcement: r.get(5)?,
            applies_to: None,
            enabled: r.get(7)?,
            spec: Spec::Text,
        },
        applies.unwrap_or_default(),
        spec,
    ))
}

const COLS: &str = "id, ns, name, rule, category, enforcement, applies_to, enabled, spec";

fn finish((mut p, applies, spec): (Policy, String, String)) -> Policy {
    p.applies_to = serde_json::from_str(&applies).ok();
    // An unreadable spec stays enforceable by nobody rather than failing the whole list.
    p.spec = serde_json::from_str(&spec).unwrap_or(Spec::Text);
    p
}

/// Policies that apply in `ns`: its own and the ones for every namespace.
pub fn list(db: &Db, ns: &str) -> Result<Vec<Policy>> {
    db.with(|c| {
        let mut st = c.prepare(&format!("SELECT {COLS} FROM policies WHERE ns = ?1 OR ns = '*' ORDER BY created_at, id"))?;
        let rows = st.query_map([ns], row)?;
        Ok(rows.map(|r| r.map(finish)).collect::<std::result::Result<Vec<_>, _>>()?)
    })
}

fn get(db: &Db, ns: &str, id: &str) -> Result<Policy> {
    list(db, ns)?.into_iter().find(|p| p.id == id).ok_or_else(|| KalypsoError::NotFound(format!("policy {id} in {ns}")))
}

fn check_fields(name: &str, rule: &str, enforcement: &str) -> Result<()> {
    if name.trim().is_empty() || name.len() > 80 {
        return Err(KalypsoError::Invalid("give the policy a name (up to 80 characters)".into()));
    }
    if rule.trim().is_empty() || rule.len() > 2000 {
        return Err(KalypsoError::Invalid("describe the rule in plain language (up to 2000 characters)".into()));
    }
    if !["block", "approve", "warn"].contains(&enforcement) {
        return Err(KalypsoError::Invalid(format!("unknown enforcement {enforcement}")));
    }
    Ok(())
}

pub fn create(db: &Db, ns: &str, new: NewPolicy) -> Result<Policy> {
    check_fields(&new.name, &new.rule, &new.enforcement)?;
    if !CATEGORIES.contains(&new.category.as_str()) {
        return Err(KalypsoError::Invalid(format!("unknown category {}", new.category)));
    }
    validate_spec(&new.spec)?;
    let id = crate::vault::new_id("p");
    let scope = if new.everywhere.unwrap_or(false) { "*" } else { ns };
    let applies = new.applies_to.filter(|a| !a.is_empty()).map(|a| serde_json::to_string(&a).unwrap_or_default());
    let spec = serde_json::to_string(&new.spec).map_err(|e| KalypsoError::Invalid(e.to_string()))?;
    db.with(|c| {
        c.execute(
            "INSERT INTO policies (id, ns, name, rule, category, enforcement, applies_to, spec) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            (&id, scope, new.name.trim(), new.rule.trim(), &new.category, &new.enforcement, applies, spec),
        )?;
        Ok(())
    })?;
    db.audit(Some(ns), "user", "policy.create", new.name.trim())?;
    get(db, ns, &id)
}

pub fn update(db: &Db, ns: &str, id: &str, patch: PolicyPatch) -> Result<Policy> {
    let mut p = get(db, ns, id)?;
    if let Some(v) = patch.name {
        p.name = v.trim().to_string();
    }
    if let Some(v) = patch.rule {
        p.rule = v.trim().to_string();
    }
    if let Some(v) = patch.enforcement {
        p.enforcement = v;
    }
    if let Some(v) = patch.enabled {
        p.enabled = v;
    }
    if let Some(v) = patch.spec {
        validate_spec(&v)?;
        p.spec = v;
    }
    check_fields(&p.name, &p.rule, &p.enforcement)?;
    let spec = serde_json::to_string(&p.spec).map_err(|e| KalypsoError::Invalid(e.to_string()))?;
    db.with(|c| {
        c.execute(
            "UPDATE policies SET name = ?2, rule = ?3, enforcement = ?4, enabled = ?5, spec = ?6 WHERE id = ?1",
            (id, &p.name, &p.rule, &p.enforcement, p.enabled, spec),
        )?;
        Ok(())
    })?;
    db.audit(Some(ns), "user", "policy.update", &p.name)?;
    Ok(p)
}

pub fn delete(db: &Db, ns: &str, id: &str) -> Result<()> {
    let p = get(db, ns, id)?;
    db.with(|c| Ok(c.execute("DELETE FROM policies WHERE id = ?1", [id])?))?;
    db.audit(Some(ns), "user", "policy.delete", &p.name)
}

/// Remove a deleted namespace's own policies (shared "*" ones stay).
pub fn delete_namespace(db: &Db, ns: &str) -> Result<()> {
    db.with(|c| Ok(c.execute("DELETE FROM policies WHERE ns = ?1", [ns])?)).map(|_| ())
}

/// Enabled policies that cover a call made with key `key_id` (and its sandbox, if any).
pub fn applicable(db: &Db, ns: &str, key_id: &str) -> Result<Vec<Policy>> {
    let sandbox: Option<String> =
        db.with(|c| Ok(c.query_row("SELECT sandbox_id FROM gateway_keys WHERE id = ?1", [key_id], |r| r.get(0)).optional()?.flatten()))?;
    let mine = |t: &str| t.strip_prefix("key:") == Some(key_id) || (sandbox.is_some() && t.strip_prefix("sandbox:") == sandbox.as_deref());
    Ok(list(db, ns)?.into_iter().filter(|p| p.enabled && p.applies_to.as_ref().is_none_or(|a| a.iter().any(|t| mine(t)))).collect())
}

pub fn log(db: &Db, ns: &str, policy: &Policy, source: &str, action: &str, outcome: &str) -> Result<()> {
    db.with(|c| {
        c.execute(
            "INSERT INTO policy_events (ns, policy_id, policy, source, action, outcome) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            (ns, &policy.id, &policy.name, source, action, outcome),
        )?;
        Ok(())
    })
}

pub fn events(db: &Db, ns: &str, limit: u32) -> Result<Vec<PolicyEvent>> {
    db.with(|c| {
        let mut st = c.prepare(
            "SELECT id, ts, ns, policy_id, policy, source, action, outcome FROM policy_events WHERE ns = ?1 ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = st.query_map((ns, limit.min(1000)), |r| {
            Ok(PolicyEvent {
                id: r.get(0)?,
                ts: r.get(1)?,
                ns: r.get(2)?,
                policy_id: r.get(3)?,
                policy: r.get(4)?,
                source: r.get(5)?,
                action: r.get(6)?,
                outcome: r.get(7)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    })
}

pub fn granted(db: &Db, key_id: &str, policy_id: &str) -> Result<bool> {
    db.with(|c| {
        Ok(c.query_row("SELECT 1 FROM policy_grants WHERE key_id = ?1 AND policy_id = ?2", (key_id, policy_id), |_| Ok(()))
            .optional()?
            .is_some())
    })
}

pub fn grant(db: &Db, key_id: &str, policy_id: &str) -> Result<()> {
    db.with(|c| {
        c.execute("INSERT OR IGNORE INTO policy_grants (key_id, policy_id) VALUES (?1, ?2)", (key_id, policy_id))?;
        Ok(())
    })
}

// ---------- Defaults ----------

/// Hosts agents commonly need; anything else asks first.
const KNOWN_HOSTS: &[&str] = &[
    "api.anthropic.com",
    "api.openai.com",
    "github.com",
    "*.github.com",
    "*.githubusercontent.com",
    "pypi.org",
    "files.pythonhosted.org",
    "registry.npmjs.org",
];

/// `git push` with a force flag or a `+` refspec, aimed at main or master, in either order.
pub const FORCE_PUSH: &[&str] = &[
    r"\bgit\s+push\b[^;&|]*\s(-f|--force|--force-with-lease)\b[^;&|]*\b(main|master)\b",
    r"\bgit\s+push\b[^;&|]*\b(main|master)\b[^;&|]*\s(-f|--force|--force-with-lease)\b",
    r"\bgit\s+push\b[^;&|]*\s\+(\S+:)?(main|master)\b",
];

pub fn defaults() -> Vec<NewPolicy> {
    let new = |name: &str, rule: &str, category: &str, enforcement: &str, spec: Spec| NewPolicy {
        name: name.into(),
        rule: rule.into(),
        category: category.into(),
        enforcement: enforcement.into(),
        applies_to: None,
        spec,
        everywhere: None,
    };
    vec![
        new(
            "Never reveal secrets",
            "Never print, log, commit or send secret values anywhere, including to other agents.",
            "secrets",
            "block",
            Spec::Secrets,
        ),
        new(
            "Stay inside the workspace",
            "Never read or write files outside /work and /tmp inside the sandbox.",
            "filesystem",
            "block",
            Spec::Path { allow: vec!["/work/**".into(), "/tmp/**".into()], deny: vec![] },
        ),
        new(
            "No force-push to main",
            "Never force-push to main or master.",
            "git",
            "block",
            Spec::Command { patterns: FORCE_PUSH.iter().map(|s| s.to_string()).collect() },
        ),
        new(
            "Ask before new hosts",
            "Ask before contacting a host that is not on the list.",
            "network",
            "approve",
            Spec::Host { allow: KNOWN_HOSTS.iter().map(|s| s.to_string()).collect(), deny: vec![] },
        ),
    ]
}

/// Give `ns` the default policies, once. Deleting them later is respected.
pub fn seed_defaults(db: &Db, ns: &str) -> Result<()> {
    let key = format!("policy.seeded.{ns}");
    if db.setting(&key)?.is_some() {
        return Ok(());
    }
    for p in defaults() {
        create(db, ns, p)?;
    }
    db.set_setting(&key, &serde_json::Value::Bool(true))
}

// ---------- Approvals ----------

/// A call waiting for the user.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct ApprovalRequest {
    pub id: String,
    pub ns: String,
    pub policy_id: String,
    pub policy: String,
    pub rule: String,
    pub reason: String,
    pub source: String,
    pub action: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    Approved { remember: bool },
    Denied,
    TimedOut,
}

/// Calls waiting for a decision. Held in memory: a restart denies them all.
pub struct Approvals {
    pending: Mutex<HashMap<String, (ApprovalRequest, tokio::sync::oneshot::Sender<Answer>)>>,
    events: tokio::sync::broadcast::Sender<ApprovalRequest>,
}

impl Default for Approvals {
    fn default() -> Self {
        Self { pending: Mutex::default(), events: tokio::sync::broadcast::channel(64).0 }
    }
}

impl Approvals {
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<ApprovalRequest> {
        self.events.subscribe()
    }

    /// Wait for the user to answer `req`, or for `timeout`.
    pub async fn ask(&self, req: ApprovalRequest, timeout: Duration) -> Answer {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let id = req.id.clone();
        self.pending.lock().unwrap().insert(id.clone(), (req.clone(), tx));
        let _ = self.events.send(req);
        let answer = match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(a)) => a,
            // Dropped (shutdown) counts as no answer.
            Ok(Err(_)) | Err(_) => Answer::TimedOut,
        };
        self.pending.lock().unwrap().remove(&id);
        answer
    }

    pub fn pending(&self, ns: &str) -> Vec<ApprovalRequest> {
        self.pending.lock().unwrap().values().filter(|(r, _)| r.ns == ns).map(|(r, _)| r.clone()).collect()
    }

    pub fn decide(&self, ns: &str, id: &str, approve: bool, remember: bool) -> Result<()> {
        let mut pending = self.pending.lock().unwrap();
        match pending.get(id) {
            Some((r, _)) if r.ns == ns => {}
            _ => return Err(KalypsoError::NotFound(format!("approval {id} (already answered or expired)"))),
        }
        let (_, tx) = pending.remove(id).expect("checked above");
        let _ = tx.send(if approve { Answer::Approved { remember } } else { Answer::Denied });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            Ok(c.execute_batch(
                "INSERT INTO namespaces (id, name) VALUES ('work','work'), ('lab','lab');
                 INSERT INTO sandboxes (id, ns, name, runtime, image, cpu, mem_mb, network) VALUES ('sb-1','work','box','docker','alpine',1,512,'isolated');
                 INSERT INTO gateway_keys (id, ns, sandbox_id, label, hash) VALUES ('k-box','work','sb-1','box',x'01');
                 INSERT INTO gateway_keys (id, ns, label, hash) VALUES ('k-cli','work','laptop',x'02');",
            )?)
        })
        .unwrap();
        db
    }

    fn bash(cmd: &str) -> ToolCall {
        ToolCall { kind: "bash".into(), command: Some(cmd.into()), ..Default::default() }
    }

    fn names(hits: &[Hit]) -> Vec<&str> {
        hits.iter().map(|h| h.policy.name.as_str()).collect()
    }

    #[test]
    fn force_push_to_main_is_caught_in_every_spelling() {
        let db = db();
        seed_defaults(&db, "work").unwrap();
        let ps = applicable(&db, "work", "k-box").unwrap();
        for cmd in [
            "git push --force origin main",
            "git push -f origin master",
            "git push origin main --force",
            "git push --force-with-lease origin main",
            "cd repo && git push origin +main",
            "git push origin +feature:main",
        ] {
            assert_eq!(names(&evaluate(&ps, &bash(cmd), &[])), ["No force-push to main"], "{cmd}");
        }
        for cmd in ["git push origin main", "git push -f origin feature", "git push --force origin maintenance", "echo main --force"] {
            assert!(evaluate(&ps, &bash(cmd), &[]).is_empty(), "{cmd}");
        }
    }

    #[test]
    fn paths_are_normalized_before_checking() {
        let db = db();
        seed_defaults(&db, "work").unwrap();
        let ps = applicable(&db, "work", "k-box").unwrap();
        let file = |p: &str| ToolCall { kind: "file_read".into(), path: Some(p.into()), ..Default::default() };
        assert!(evaluate(&ps, &file("/work/src/main.rs"), &[]).is_empty());
        assert!(evaluate(&ps, &file("notes/todo.md"), &[]).is_empty(), "relative to /work");
        assert!(evaluate(&ps, &file("/tmp/x"), &[]).is_empty());
        let hit = evaluate(&ps, &file("/work/../etc/shadow"), &[]);
        assert_eq!(names(&hit), ["Stay inside the workspace"]);
        assert!(hit[0].reason.starts_with("/etc/shadow is outside"));
        assert!(!evaluate(&ps, &file("../../root/.ssh/id_rsa"), &[]).is_empty());
        assert_eq!(normalize_path("/work/a/./b/../c"), "/work/a/c");
    }

    #[test]
    fn hosts_secrets_and_cost() {
        let db = db();
        seed_defaults(&db, "work").unwrap();
        create(
            &db,
            "work",
            NewPolicy {
                name: "Pricey calls".into(),
                rule: "Warn me about calls over $1.".into(),
                category: "spend".into(),
                enforcement: "warn".into(),
                applies_to: None,
                spec: Spec::Cost { max: 1_000_000 },
                everywhere: None,
            },
        )
        .unwrap();
        let ps = applicable(&db, "work", "k-cli").unwrap();
        let http = |u: &str| ToolCall { kind: "http".into(), url: Some(u.into()), ..Default::default() };
        assert!(evaluate(&ps, &http("https://api.github.com/repos"), &[]).is_empty(), "*.github.com");
        assert!(evaluate(&ps, &http("https://github.com.evil.io/x"), &[]).len() == 1, "suffix tricks don't match");
        assert_eq!(evaluate(&ps, &http("https://pastebin.com/raw/x"), &[])[0].policy.enforcement, "approve");

        let secret = "sk-live-0123456789".to_string();
        let leak = ToolCall {
            kind: "http".into(),
            url: Some("https://api.github.com/x".into()),
            content: Some(format!("token={secret}")),
            ..Default::default()
        };
        let hits = evaluate(&ps, &leak, std::slice::from_ref(&secret));
        assert_eq!(names(&hits), ["Never reveal secrets"]);
        assert!(!describe(&bash(&format!("echo {secret}")), &[secret]).contains("sk-live"), "logs hide secret values");

        let pricey = ToolCall { kind: "mcp".into(), tool: Some("render".into()), cost: Some(2_500_000), ..Default::default() };
        assert_eq!(names(&evaluate(&ps, &pricey, &[])), ["Pricey calls"]);
    }

    #[test]
    fn ordering_targets_and_disabled_policies() {
        let db = db();
        seed_defaults(&db, "work").unwrap();
        let both = ToolCall {
            kind: "bash".into(),
            command: Some("git push -f origin main".into()),
            path: Some("/etc/hosts".into()),
            ..Default::default()
        };
        let ps = applicable(&db, "work", "k-box").unwrap();
        let hits = evaluate(&ps, &both, &[]);
        assert_eq!(hits.len(), 2);
        let fs = list(&db, "work").unwrap().into_iter().find(|p| p.name == "Stay inside the workspace").unwrap();
        update(&db, "work", &fs.id, PolicyPatch { enabled: Some(false), ..Default::default() }).unwrap();
        assert_eq!(evaluate(&applicable(&db, "work", "k-box").unwrap(), &both, &[]).len(), 1);

        // A policy aimed at one sandbox leaves other keys alone.
        let only_box = NewPolicy {
            name: "No curl in box".into(),
            rule: "box never runs curl.".into(),
            category: "network".into(),
            enforcement: "block".into(),
            applies_to: Some(vec!["sandbox:sb-1".into()]),
            spec: Spec::Command { patterns: vec![r"\bcurl\b".into()] },
            everywhere: None,
        };
        create(&db, "work", only_box).unwrap();
        assert_eq!(evaluate(&applicable(&db, "work", "k-box").unwrap(), &bash("curl x"), &[]).len(), 1);
        assert!(evaluate(&applicable(&db, "work", "k-cli").unwrap(), &bash("curl x"), &[]).is_empty());
        assert!(applicable(&db, "lab", "k-box").unwrap().is_empty(), "lab has no policies yet");
    }

    #[test]
    fn defaults_seed_once_and_validation() {
        let db = db();
        seed_defaults(&db, "work").unwrap();
        let first = list(&db, "work").unwrap();
        assert_eq!(first.len(), 4);
        delete(&db, "work", &first[0].id).unwrap();
        seed_defaults(&db, "work").unwrap();
        assert_eq!(list(&db, "work").unwrap().len(), 3, "deleted defaults stay deleted");

        let bad = |spec: Spec| validate_spec(&spec).unwrap_err().code();
        assert_eq!(bad(Spec::Command { patterns: vec!["(".into()] }), "invalid");
        assert_eq!(bad(Spec::Command { patterns: vec![] }), "invalid");
        assert_eq!(bad(Spec::Path { allow: vec!["work/**".into()], deny: vec![] }), "invalid");
        assert_eq!(bad(Spec::Host { allow: vec!["https://x.com".into()], deny: vec![] }), "invalid");
        assert_eq!(bad(Spec::Cost { max: 0 }), "invalid");
        assert_eq!(delete(&db, "lab", &first[1].id).unwrap_err().code(), "not_found");

        // Shared policies show up in every namespace.
        let mut shared = defaults().remove(0);
        shared.everywhere = Some(true);
        create(&db, "work", shared).unwrap();
        assert_eq!(list(&db, "lab").unwrap().len(), 1);
        delete_namespace(&db, "work").unwrap();
        assert_eq!(list(&db, "work").unwrap().len(), 1, "only the shared one is left");
    }

    #[tokio::test]
    async fn approvals_wait_for_an_answer() {
        let a = std::sync::Arc::new(Approvals::default());
        let mut seen = a.subscribe();
        let req = |id: &str| ApprovalRequest {
            id: id.into(),
            ns: "work".into(),
            policy_id: "p".into(),
            policy: "Ask".into(),
            rule: "r".into(),
            reason: "x".into(),
            source: "box".into(),
            action: "http: https://x".into(),
        };
        let waiter = tokio::spawn({
            let a = a.clone();
            async move { a.ask(req("one"), Duration::from_secs(5)).await }
        });
        let shown = seen.recv().await.unwrap();
        assert_eq!(a.pending("work").len(), 1);
        assert!(a.pending("lab").is_empty());
        assert_eq!(a.decide("lab", &shown.id, true, false).unwrap_err().code(), "not_found", "other namespaces can't answer");
        a.decide("work", &shown.id, true, true).unwrap();
        assert_eq!(waiter.await.unwrap(), Answer::Approved { remember: true });
        assert!(a.pending("work").is_empty());
        assert_eq!(a.decide("work", "one", false, false).unwrap_err().code(), "not_found", "answered once");

        assert_eq!(a.ask(req("two"), Duration::from_millis(30)).await, Answer::TimedOut);
        assert!(a.pending("work").is_empty());
    }
}
