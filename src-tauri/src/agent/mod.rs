//! Agents: what to run, in which sandbox, and how to keep it running.
//!
//! An agent is a declarative record (this module) plus a runtime that knows how to
//! start that kind of agent ([`runtime`]). The [`supervisor`] runs agents, notices
//! when their process ends, restarts them per policy, enforces `max_turns`, and
//! pauses them when the gateway refuses their sandbox for budget. Every start is a
//! run with its own transcript.

pub mod runtime;
pub mod supervisor;

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{KalypsoError, Result};
use crate::store::Db;

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct AgentRecord {
    pub id: String,
    pub ns: String,
    pub name: String,
    pub role: String,
    /// "command" today; "claude-sdk" (#14) and "claude-code" (#15) plug in through the same trait.
    pub runtime: String,
    pub model: String,
    pub sandbox_id: Option<String>,
    /// For the command runtime: the shell command to run in the sandbox.
    pub command: String,
    /// Messages the agent may be sent per run; 0 means no limit.
    pub max_turns: u32,
    /// "never", "on-failure" or "always".
    pub restart: String,
    pub max_restarts: u32,
    /// "stopped", "starting", "running", "paused", "restarting" or "failed".
    pub status: String,
    /// Why it is in that state, in words: "crashed 3 times (exit 137)", "budget: daily cap reached".
    pub status_reason: String,
    pub created_at: String,
    /// The GitHub repository it works on, "owner/name" (#100).
    pub repo: Option<String>,
    /// The GitHub account whose access it uses for that repository.
    pub repo_account: Option<String>,
    /// Its own branch in that repository, `agent/<name>/<task>`, set when first prepared.
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct NewAgent {
    pub name: String,
    #[serde(default)]
    #[ts(optional)]
    pub role: Option<String>,
    pub runtime: String,
    #[serde(default)]
    #[ts(optional)]
    pub model: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub sandbox_id: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub command: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub max_turns: Option<u32>,
    #[serde(default)]
    #[ts(optional)]
    pub restart: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub max_restarts: Option<u32>,
    /// A GitHub repository, "owner/name", and the account to reach it with (#100).
    #[serde(default)]
    #[ts(optional)]
    pub repo: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub repo_account: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, TS)]
#[ts(export)]
pub struct AgentPatch {
    #[ts(optional)]
    pub role: Option<String>,
    #[ts(optional)]
    pub model: Option<String>,
    /// Some("") detaches the agent from its sandbox.
    #[ts(optional)]
    pub sandbox_id: Option<String>,
    #[ts(optional)]
    pub command: Option<String>,
    #[ts(optional)]
    pub max_turns: Option<u32>,
    #[ts(optional)]
    pub restart: Option<String>,
    #[ts(optional)]
    pub max_restarts: Option<u32>,
    /// Some("") unlinks the repository.
    #[ts(optional)]
    pub repo: Option<String>,
    #[ts(optional)]
    pub repo_account: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct AgentRun {
    pub id: String,
    pub agent_id: String,
    /// 1 for the first start, 2 for the first restart, and so on.
    pub attempt: u32,
    pub started_at: String,
    pub ended_at: Option<String>,
    #[ts(type = "number | null")]
    pub exit_code: Option<i64>,
    /// "running", "exited", "crashed" or "stopped".
    pub outcome: String,
    pub reason: String,
    pub turns: u32,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct AgentEvent {
    #[ts(type = "number")]
    pub id: i64,
    pub run_id: String,
    pub ts: String,
    /// "output" (what the agent printed), "input" (what it was sent) or "status".
    pub kind: String,
    pub text: String,
}

const RUNTIMES: &[&str] = &["command", "claude-sdk", "claude-code"];
const RESTARTS: &[&str] = &["never", "on-failure", "always"];
const COLS: &str =
    "id, ns, name, role, runtime, model, sandbox_id, command, max_turns, restart, max_restarts, status, status_reason, created_at, repo, repo_account, branch";

fn row(r: &rusqlite::Row) -> rusqlite::Result<AgentRecord> {
    Ok(AgentRecord {
        id: r.get(0)?,
        ns: r.get(1)?,
        name: r.get(2)?,
        role: r.get(3)?,
        runtime: r.get(4)?,
        model: r.get(5)?,
        sandbox_id: r.get(6)?,
        command: r.get(7)?,
        max_turns: r.get(8)?,
        restart: r.get(9)?,
        max_restarts: r.get(10)?,
        status: r.get(11)?,
        status_reason: r.get(12)?,
        created_at: r.get(13)?,
        repo: r.get(14)?,
        repo_account: r.get(15)?,
        branch: r.get(16)?,
    })
}

pub fn list(db: &Db, ns: &str) -> Result<Vec<AgentRecord>> {
    db.with(|c| {
        let mut st = c.prepare(&format!("SELECT {COLS} FROM agents WHERE ns = ?1 ORDER BY name"))?;
        let rows = st.query_map([ns], row)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    })
}

pub fn get(db: &Db, ns: &str, id: &str) -> Result<AgentRecord> {
    db.with(|c| Ok(c.query_row(&format!("SELECT {COLS} FROM agents WHERE id = ?1 AND ns = ?2"), (id, ns), row).optional()?))?
        .ok_or_else(|| KalypsoError::NotFound(format!("agent {id} in {ns}")))
}

/// Agents attached to a sandbox, for pausing them together.
pub fn in_sandbox(db: &Db, sandbox_id: &str) -> Result<Vec<AgentRecord>> {
    db.with(|c| {
        let mut st = c.prepare(&format!("SELECT {COLS} FROM agents WHERE sandbox_id = ?1"))?;
        let rows = st.query_map([sandbox_id], row)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    })
}

fn validate_name(name: &str) -> Result<()> {
    let ok = (1..=40).contains(&name.len())
        && name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(KalypsoError::Invalid("agent names use letters, digits, - and _ (up to 40), starting with a letter or digit".into()))
    }
}

fn check(runtime: &str, restart: &str, command: &str, max_restarts: u32, max_turns: u32) -> Result<()> {
    if !RUNTIMES.contains(&runtime) {
        return Err(KalypsoError::Invalid(format!("unknown runtime {runtime}")));
    }
    if !RESTARTS.contains(&restart) {
        return Err(KalypsoError::Invalid(format!("unknown restart policy {restart}")));
    }
    if command.len() > 4000 {
        return Err(KalypsoError::Invalid("the command is longer than 4000 characters".into()));
    }
    if max_restarts > 100 || max_turns > 100_000 {
        return Err(KalypsoError::Invalid("restart and turn limits are too high".into()));
    }
    Ok(())
}

/// A linked repository must be "owner/name", reached with an account the namespace may use.
fn check_repo(db: &Db, ns: &str, repo: Option<&str>, account: Option<&str>) -> Result<()> {
    let Some(repo) = repo else { return Ok(()) };
    let valid = |s: &str| {
        !s.is_empty() && s.len() <= 100 && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) && s != "." && s != ".."
    };
    match repo.split_once('/') {
        Some((owner, name)) if valid(owner) && valid(name) => {}
        _ => return Err(KalypsoError::Invalid(format!("{repo} isn't a GitHub repository; use owner/name"))),
    }
    let Some(account) = account else {
        return Err(KalypsoError::Invalid("pick the GitHub account to reach the repository with".into()));
    };
    if !crate::github::for_ns(db, ns)?.iter().any(|a| a.id == account) {
        return Err(KalypsoError::Invalid(format!("that GitHub account isn't allowed in namespace {ns}")));
    }
    Ok(())
}

fn check_sandbox(db: &Db, ns: &str, sandbox_id: Option<&str>) -> Result<()> {
    if let Some(sb) = sandbox_id {
        crate::sandbox::get(db, ns, sb).map_err(|_| KalypsoError::Invalid(format!("sandbox {sb} isn't in namespace {ns}")))?;
    }
    Ok(())
}

pub fn create(db: &Db, ns: &str, new: NewAgent) -> Result<AgentRecord> {
    let name = new.name.trim().to_string();
    validate_name(&name)?;
    let restart = new.restart.unwrap_or_else(|| "on-failure".into());
    let command = new.command.unwrap_or_default().trim().to_string();
    let (max_turns, max_restarts) = (new.max_turns.unwrap_or(0), new.max_restarts.unwrap_or(3));
    check(&new.runtime, &restart, &command, max_restarts, max_turns)?;
    let sandbox_id = new.sandbox_id.filter(|s| !s.is_empty());
    check_sandbox(db, ns, sandbox_id.as_deref())?;
    let repo = new.repo.map(|r| r.trim().trim_end_matches(".git").to_string()).filter(|r| !r.is_empty());
    let repo_account = new.repo_account.filter(|a| !a.is_empty() && repo.is_some());
    check_repo(db, ns, repo.as_deref(), repo_account.as_deref())?;
    let id = crate::vault::new_id("ag");
    let inserted = db.with(|c| {
        Ok(c.execute(
            "INSERT INTO agents (id, ns, name, role, runtime, model, sandbox_id, command, max_turns, restart, max_restarts, repo, repo_account)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            rusqlite::params![
                id,
                ns,
                name,
                new.role.unwrap_or_default().trim(),
                new.runtime,
                new.model.unwrap_or_default().trim(),
                sandbox_id,
                command,
                max_turns,
                restart,
                max_restarts,
                repo,
                repo_account
            ],
        )?)
    });
    match inserted {
        Err(KalypsoError::Db(rusqlite::Error::SqliteFailure(e, _))) if e.code == rusqlite::ErrorCode::ConstraintViolation => {
            return Err(KalypsoError::Conflict(format!("agent {name} in {ns}")));
        }
        r => {
            r?;
        }
    }
    db.audit(Some(ns), "user", "agent.create", &name)?;
    get(db, ns, &id)
}

pub fn update(db: &Db, ns: &str, id: &str, p: AgentPatch) -> Result<AgentRecord> {
    let mut a = get(db, ns, id)?;
    if let Some(v) = p.role {
        a.role = v.trim().to_string();
    }
    if let Some(v) = p.model {
        a.model = v.trim().to_string();
    }
    if let Some(v) = p.sandbox_id {
        a.sandbox_id = Some(v).filter(|s| !s.is_empty());
    }
    if let Some(v) = p.command {
        a.command = v.trim().to_string();
    }
    if let Some(v) = p.max_turns {
        a.max_turns = v;
    }
    if let Some(v) = p.restart {
        a.restart = v;
    }
    if let Some(v) = p.max_restarts {
        a.max_restarts = v;
    }
    if let Some(v) = p.repo {
        let v = v.trim().trim_end_matches(".git").to_string();
        let new = Some(v).filter(|r| !r.is_empty());
        // A different repository means a fresh branch the next time it's prepared.
        if new != a.repo {
            a.branch = None;
        }
        a.repo = new;
        if a.repo.is_none() {
            a.repo_account = None;
        }
    }
    if let Some(v) = p.repo_account {
        a.repo_account = Some(v).filter(|s| !s.is_empty());
    }
    check(&a.runtime, &a.restart, &a.command, a.max_restarts, a.max_turns)?;
    check_sandbox(db, ns, a.sandbox_id.as_deref())?;
    check_repo(db, ns, a.repo.as_deref(), a.repo_account.as_deref())?;
    db.with(|c| {
        c.execute(
            "UPDATE agents SET role = ?2, model = ?3, sandbox_id = ?4, command = ?5, max_turns = ?6, restart = ?7, max_restarts = ?8,
             repo = ?9, repo_account = ?10, branch = ?11 WHERE id = ?1",
            rusqlite::params![
                id,
                a.role,
                a.model,
                a.sandbox_id,
                a.command,
                a.max_turns,
                a.restart,
                a.max_restarts,
                a.repo,
                a.repo_account,
                a.branch
            ],
        )?;
        Ok(())
    })?;
    db.audit(Some(ns), "user", "agent.update", &a.name)?;
    get(db, ns, id)
}

/// Remove an agent and its runs. The caller stops it first.
pub fn delete(db: &Db, ns: &str, id: &str) -> Result<()> {
    let a = get(db, ns, id)?;
    db.with(|c| Ok(c.execute("DELETE FROM agents WHERE id = ?1", [id])?))?;
    db.audit(Some(ns), "user", "agent.delete", &a.name)
}

/// Remember the branch an agent works on in its repository.
pub(crate) fn set_branch(db: &Db, id: &str, branch: &str) -> Result<()> {
    db.with(|c| {
        c.execute("UPDATE agents SET branch = ?2 WHERE id = ?1", (id, branch))?;
        Ok(())
    })
}

pub(crate) fn set_status(db: &Db, id: &str, status: &str, reason: &str) -> Result<()> {
    db.with(|c| {
        c.execute("UPDATE agents SET status = ?2, status_reason = ?3 WHERE id = ?1", (id, status, reason))?;
        Ok(())
    })
}

/// After a restart of KALYPSO nothing is supervised any more; say so instead of claiming it runs.
pub fn reset_after_restart(db: &Db) -> Result<usize> {
    db.with(|c| {
        c.execute(
            "UPDATE agent_runs SET outcome = 'stopped', reason = 'KALYPSO restarted', ended_at = CURRENT_TIMESTAMP WHERE outcome = 'running'",
            [],
        )?;
        Ok(c.execute(
            "UPDATE agents SET status = 'stopped', status_reason = 'KALYPSO restarted' WHERE status NOT IN ('stopped', 'failed')",
            [],
        )?)
    })
}

pub(crate) fn begin_run(db: &Db, ns: &str, agent_id: &str, attempt: u32) -> Result<String> {
    let id = crate::vault::new_id("run");
    db.with(|c| {
        c.execute("INSERT INTO agent_runs (id, agent_id, ns, attempt) VALUES (?1, ?2, ?3, ?4)", (&id, agent_id, ns, attempt))?;
        Ok(())
    })?;
    Ok(id)
}

pub(crate) fn end_run(db: &Db, run_id: &str, exit_code: Option<i64>, outcome: &str, reason: &str, turns: u32) -> Result<()> {
    db.with(|c| {
        c.execute(
            "UPDATE agent_runs SET ended_at = CURRENT_TIMESTAMP, exit_code = ?2, outcome = ?3, reason = ?4, turns = ?5 WHERE id = ?1",
            rusqlite::params![run_id, exit_code, outcome, reason, turns],
        )?;
        Ok(())
    })
}

pub(crate) fn add_event(db: &Db, run_id: &str, kind: &str, text: &str) -> Result<i64> {
    db.with(|c| {
        c.execute("INSERT INTO agent_events (run_id, kind, text) VALUES (?1, ?2, ?3)", (run_id, kind, text))?;
        Ok(c.last_insert_rowid())
    })
}

/// Newest first.
pub fn runs(db: &Db, ns: &str, agent_id: &str, limit: u32) -> Result<Vec<AgentRun>> {
    get(db, ns, agent_id)?;
    db.with(|c| {
        let mut st = c.prepare(
            "SELECT id, agent_id, attempt, started_at, ended_at, exit_code, outcome, reason, turns FROM agent_runs
             WHERE agent_id = ?1 ORDER BY started_at DESC, attempt DESC LIMIT ?2",
        )?;
        let rows = st.query_map((agent_id, limit.min(500)), |r| {
            Ok(AgentRun {
                id: r.get(0)?,
                agent_id: r.get(1)?,
                attempt: r.get(2)?,
                started_at: r.get(3)?,
                ended_at: r.get(4)?,
                exit_code: r.get(5)?,
                outcome: r.get(6)?,
                reason: r.get(7)?,
                turns: r.get(8)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    })
}

/// A run's transcript in order, after event `after` (0 for the start).
pub fn events(db: &Db, ns: &str, run_id: &str, after: i64, limit: u32) -> Result<Vec<AgentEvent>> {
    let owner: Option<String> =
        db.with(|c| Ok(c.query_row("SELECT ns FROM agent_runs WHERE id = ?1", [run_id], |r| r.get(0)).optional()?))?;
    if owner.as_deref() != Some(ns) {
        return Err(KalypsoError::NotFound(format!("run {run_id} in {ns}")));
    }
    db.with(|c| {
        let mut st = c.prepare("SELECT id, run_id, ts, kind, text FROM agent_events WHERE run_id = ?1 AND id > ?2 ORDER BY id LIMIT ?3")?;
        let rows = st.query_map((run_id, after, limit.min(5000)), |r| {
            Ok(AgentEvent { id: r.get(0)?, run_id: r.get(1)?, ts: r.get(2)?, kind: r.get(3)?, text: r.get(4)? })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            Ok(c.execute_batch(
                "INSERT INTO namespaces (id, name) VALUES ('work','work'), ('lab','lab');
                 INSERT INTO sandboxes (id, ns, name, runtime, image, cpu, mem_mb, network) VALUES ('sb-1','work','box','docker','alpine',1,512,'isolated');",
            )?)
        })
        .unwrap();
        db
    }

    fn new(name: &str) -> NewAgent {
        NewAgent {
            name: name.into(),
            role: Some("Writes the release notes".into()),
            runtime: "command".into(),
            model: None,
            sandbox_id: Some("sb-1".into()),
            command: Some("python agent.py".into()),
            max_turns: None,
            restart: None,
            max_restarts: None,
            repo: None,
            repo_account: None,
        }
    }

    #[test]
    fn create_update_delete() {
        let db = db();
        let a = create(&db, "work", new("writer")).unwrap();
        assert_eq!((a.status.as_str(), a.restart.as_str(), a.max_restarts), ("stopped", "on-failure", 3));
        assert_eq!(create(&db, "work", new("writer")).unwrap_err().code(), "conflict");
        let a =
            update(&db, "work", &a.id, AgentPatch { restart: Some("always".into()), max_turns: Some(5), ..Default::default() }).unwrap();
        assert_eq!((a.restart.as_str(), a.max_turns), ("always", 5));
        let a = update(&db, "work", &a.id, AgentPatch { sandbox_id: Some(String::new()), ..Default::default() }).unwrap();
        assert_eq!(a.sandbox_id, None);
        assert_eq!(get(&db, "lab", &a.id).unwrap_err().code(), "not_found");
        delete(&db, "work", &a.id).unwrap();
        assert!(list(&db, "work").unwrap().is_empty());
    }

    #[test]
    fn validation() {
        let db = db();
        let bad = |n: NewAgent| create(&db, "work", n).unwrap_err().code();
        assert_eq!(bad(new("has space")), "invalid");
        assert_eq!(bad(new("-dash")), "invalid");
        assert_eq!(bad(NewAgent { runtime: "magic".into(), ..new("a") }), "invalid");
        assert_eq!(bad(NewAgent { restart: Some("sometimes".into()), ..new("b") }), "invalid");
        assert_eq!(create(&db, "lab", new("c")).unwrap_err().code(), "invalid", "another namespace's sandbox");
    }

    #[test]
    fn runs_events_and_restart_reset() {
        let db = db();
        let a = create(&db, "work", new("writer")).unwrap();
        let run = begin_run(&db, "work", &a.id, 1).unwrap();
        set_status(&db, &a.id, "running", "").unwrap();
        add_event(&db, &run, "output", "hello").unwrap();
        let second = add_event(&db, &run, "input", "go").unwrap();
        assert_eq!(events(&db, "work", &run, 0, 10).unwrap().len(), 2);
        assert_eq!(events(&db, "work", &run, second - 1, 10).unwrap()[0].text, "go");
        assert_eq!(events(&db, "lab", &run, 0, 10).unwrap_err().code(), "not_found");

        assert_eq!(reset_after_restart(&db).unwrap(), 1);
        let a = get(&db, "work", &a.id).unwrap();
        assert_eq!((a.status.as_str(), a.status_reason.as_str()), ("stopped", "KALYPSO restarted"));
        assert_eq!(runs(&db, "work", &a.id, 10).unwrap()[0].outcome, "stopped");
    }
}
