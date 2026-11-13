//! The Board (#20): tasks handed to agents, moved along as the agents work.
//!
//! A task moves `queued → running → review → done`, or ends `failed`. The [`Board`] does the
//! moving: when an agent has a queued task it starts the agent if needed, hands it the brief
//! as a message once the agent is free, and when the agent answers puts the task in review
//! with what it said. A person approves (done) or requests changes, which queues it again
//! with their notes. One agent works on one task at a time; the rest wait in priority order.
//!
//! Time and cost add up over every attempt. Cost is what the gateway metered for the agent's
//! sandbox while the task ran, the same numbers the Spend page shows.

use std::sync::Arc;

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::supervisor::Supervisor;
use crate::agent::{self, AgentRecord};
use crate::error::{KalypsoError, Result};
use crate::store::Db;
use crate::vault::new_id;

const PRIORITIES: &[&str] = &["low", "normal", "high"];
const MAX_TITLE: usize = 200;
const MAX_DESCRIPTION: usize = 4_000;
const MAX_NOTE: usize = 4_000;
/// What is kept of the agent's answer for the reviewer.
const MAX_RESULT: usize = 8_000;

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct Task {
    pub id: String,
    pub ns: String,
    pub agent_id: String,
    pub title: String,
    /// The brief: what done looks like, links, constraints.
    pub description: String,
    /// "low", "normal" or "high".
    pub priority: String,
    /// "queued", "running", "review", "done" or "failed".
    pub status: String,
    /// Why it is where it is: the agent's closing line, an error, a reviewer's notes.
    pub status_note: String,
    /// What the agent said when it finished.
    pub result: String,
    /// Notes from the last "request changes", sent with the next attempt.
    pub review_note: String,
    pub attempts: u32,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    /// Over every attempt, including the one running now.
    pub seconds: u32,
    pub cost_usd: f64,
    /// The run and transcript line that handed it over; the answer comes after them.
    #[serde(skip)]
    #[ts(skip)]
    run_id: String,
    #[serde(skip)]
    #[ts(skip)]
    input_event: i64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct NewTask {
    pub agent_id: String,
    pub title: String,
    #[serde(default)]
    #[ts(optional)]
    pub description: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub priority: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, TS)]
#[ts(export)]
pub struct TaskPatch {
    #[serde(default)]
    #[ts(optional)]
    pub title: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub description: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub agent_id: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub priority: Option<String>,
}

const SELECT: &str = "SELECT t.id, t.ns, t.agent_id, t.title, t.description, t.priority, t.status, t.status_note, t.result,
       t.review_note, t.attempts, t.created_at, t.started_at, t.finished_at,
       t.spent_secs + CASE WHEN t.status = 'running' AND t.started_at IS NOT NULL
         THEN CAST((julianday('now') - julianday(t.started_at)) * 86400 AS INTEGER) ELSE 0 END,
       t.spent_micros + CASE WHEN t.status = 'running' AND t.started_at IS NOT NULL
         THEN COALESCE((SELECT SUM(u.cost_micros) FROM usage_events u JOIN gateway_keys k ON k.id = u.key_id
                        WHERE k.sandbox_id = a.sandbox_id AND u.ts >= t.started_at), 0) ELSE 0 END,
       t.run_id, t.input_event
  FROM tasks t JOIN agents a ON a.id = t.agent_id";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: r.get(0)?,
        ns: r.get(1)?,
        agent_id: r.get(2)?,
        title: r.get(3)?,
        description: r.get(4)?,
        priority: r.get(5)?,
        status: r.get(6)?,
        status_note: r.get(7)?,
        result: r.get(8)?,
        review_note: r.get(9)?,
        attempts: r.get(10)?,
        created_at: r.get(11)?,
        started_at: r.get(12)?,
        finished_at: r.get(13)?,
        seconds: r.get::<_, i64>(14)?.max(0) as u32,
        cost_usd: r.get::<_, i64>(15)? as f64 / 1_000_000.0,
        run_id: r.get(16)?,
        input_event: r.get(17)?,
    })
}

/// Queued first, highest priority first, oldest first.
pub fn list(db: &Db, ns: &str) -> Result<Vec<Task>> {
    db.with(|c| {
        let mut st = c.prepare(&format!(
            "{SELECT} WHERE t.ns = ?1
             ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.created_at, t.rowid"
        ))?;
        let rows = st.query_map([ns], row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

pub fn get(db: &Db, ns: &str, id: &str) -> Result<Task> {
    db.with(|c| Ok(c.query_row(&format!("{SELECT} WHERE t.ns = ?1 AND t.id = ?2"), [ns, id], row).optional()?))?
        .ok_or_else(|| KalypsoError::NotFound(format!("task {id}")))
}

fn worker(db: &Db, ns: &str, agent_id: &str) -> Result<AgentRecord> {
    let a = agent::get(db, ns, agent_id)?;
    if a.master {
        return Err(KalypsoError::Invalid(format!("{} works from Ask, not the Board; give the task to one of your agents", a.name)));
    }
    Ok(a)
}

fn check_text(title: &str, description: &str) -> Result<()> {
    if title.trim().is_empty() {
        return Err(KalypsoError::Invalid("give the task a title".into()));
    }
    if title.chars().count() > MAX_TITLE {
        return Err(KalypsoError::Invalid(format!("keep the title under {MAX_TITLE} characters")));
    }
    if description.chars().count() > MAX_DESCRIPTION {
        return Err(KalypsoError::Invalid(format!("keep the description under {MAX_DESCRIPTION} characters")));
    }
    Ok(())
}

fn check_priority(p: &str) -> Result<()> {
    if PRIORITIES.contains(&p) {
        Ok(())
    } else {
        Err(KalypsoError::Invalid(format!("priority must be one of {}", PRIORITIES.join(", "))))
    }
}

pub fn create(db: &Db, ns: &str, new: NewTask) -> Result<Task> {
    worker(db, ns, &new.agent_id)?;
    let description = new.description.unwrap_or_default();
    check_text(&new.title, &description)?;
    let priority = new.priority.unwrap_or_else(|| "normal".into());
    check_priority(&priority)?;
    let id = new_id("task");
    db.with(|c| {
        c.execute(
            "INSERT INTO tasks (id, ns, agent_id, title, description, priority) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            (&id, ns, &new.agent_id, new.title.trim(), description.trim(), &priority),
        )?;
        Ok(())
    })?;
    get(db, ns, &id)
}

pub fn update(db: &Db, ns: &str, id: &str, p: TaskPatch) -> Result<Task> {
    let t = get(db, ns, id)?;
    let title = p.title.unwrap_or(t.title.clone());
    let description = p.description.unwrap_or(t.description.clone());
    check_text(&title, &description)?;
    let priority = p.priority.unwrap_or(t.priority.clone());
    check_priority(&priority)?;
    let agent_id = p.agent_id.unwrap_or(t.agent_id.clone());
    if agent_id != t.agent_id {
        if t.status == "running" {
            return Err(KalypsoError::Invalid("the task is running; move it back to queued before giving it to another agent".into()));
        }
        worker(db, ns, &agent_id)?;
    }
    db.with(|c| {
        c.execute(
            "UPDATE tasks SET title = ?3, description = ?4, priority = ?5, agent_id = ?6 WHERE ns = ?1 AND id = ?2",
            (ns, id, title.trim(), description.trim(), &priority, &agent_id),
        )?;
        Ok(())
    })?;
    get(db, ns, id)
}

pub fn delete(db: &Db, ns: &str, id: &str) -> Result<()> {
    get(db, ns, id)?;
    db.with(|c| Ok(c.execute("DELETE FROM tasks WHERE ns = ?1 AND id = ?2", [ns, id])?))?;
    Ok(())
}

/// Moved by hand on the board. Only the Board starts tasks, so nothing moves into running;
/// moving a running task elsewhere leaves the agent's answer unused.
pub fn move_to(db: &Db, ns: &str, id: &str, status: &str) -> Result<Task> {
    let t = get(db, ns, id)?;
    match status {
        "running" => return Err(KalypsoError::Invalid("tasks start when their agent picks them up; queue it instead".into())),
        "queued" | "review" | "done" | "failed" => {}
        _ => return Err(KalypsoError::Invalid(format!("unknown status {status}"))),
    }
    if t.status == status {
        return Ok(t);
    }
    close_attempt(db, &t)?;
    db.with(|c| {
        c.execute(
            "UPDATE tasks SET status = ?3, status_note = 'moved by you',
               finished_at = CASE WHEN ?3 = 'queued' THEN NULL ELSE COALESCE(finished_at, CURRENT_TIMESTAMP) END
             WHERE ns = ?1 AND id = ?2",
            (ns, id, status),
        )?;
        Ok(())
    })?;
    get(db, ns, id)
}

/// Approve (done), or request changes: back to queued with the notes for the next attempt.
pub fn review(db: &Db, ns: &str, id: &str, approve: bool, note: &str) -> Result<Task> {
    let t = get(db, ns, id)?;
    if t.status != "review" {
        return Err(KalypsoError::Invalid(format!("the task is {}, not in review", t.status)));
    }
    let note = note.trim();
    if note.chars().count() > MAX_NOTE {
        return Err(KalypsoError::Invalid(format!("keep the notes under {MAX_NOTE} characters")));
    }
    if approve {
        db.with(|c| {
            c.execute("UPDATE tasks SET status = 'done', status_note = 'approved' WHERE ns = ?1 AND id = ?2", [ns, id])?;
            Ok(())
        })?;
    } else {
        if note.is_empty() {
            return Err(KalypsoError::Invalid("say what should change, so the agent knows".into()));
        }
        db.with(|c| {
            c.execute(
                "UPDATE tasks SET status = 'queued', status_note = 'changes requested', review_note = ?3, finished_at = NULL
                 WHERE ns = ?1 AND id = ?2",
                (ns, id, note),
            )?;
            Ok(())
        })?;
    }
    get(db, ns, id)
}

/// Tasks that were running when KALYPSO quit lost their agent (agents restart stopped).
pub fn reset_after_restart(db: &Db) -> Result<usize> {
    let running: Vec<Task> = db.with(|c| {
        let mut st = c.prepare(&format!("{SELECT} WHERE t.status = 'running'"))?;
        let rows = st.query_map([], row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })?;
    for t in &running {
        finish(db, t, "failed", "KALYPSO closed while it was running; queue it again to retry", "")?;
    }
    Ok(running.len())
}

/// Add the time and cost of the attempt that is ending to the totals.
fn close_attempt(db: &Db, t: &Task) -> Result<()> {
    if t.status != "running" {
        return Ok(());
    }
    db.with(|c| {
        c.execute(
            "UPDATE tasks SET
               spent_secs = spent_secs + CAST((julianday('now') - julianday(started_at)) * 86400 AS INTEGER),
               spent_micros = spent_micros + COALESCE((SELECT SUM(u.cost_micros) FROM usage_events u
                   JOIN gateway_keys k ON k.id = u.key_id JOIN agents a ON a.sandbox_id = k.sandbox_id
                  WHERE a.id = tasks.agent_id AND u.ts >= tasks.started_at), 0)
             WHERE id = ?1 AND started_at IS NOT NULL",
            [&t.id],
        )?;
        Ok(())
    })
}

fn finish(db: &Db, t: &Task, status: &str, note: &str, result: &str) -> Result<()> {
    close_attempt(db, t)?;
    db.with(|c| {
        c.execute(
            "UPDATE tasks SET status = ?2, status_note = ?3, result = ?4, finished_at = CURRENT_TIMESTAMP WHERE id = ?1",
            (&t.id, status, note, clip(result, MAX_RESULT)),
        )?;
        Ok(())
    })
}

fn clip(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

/// What the agent is told.
fn brief(t: &Task) -> String {
    let mut b = format!("New task from the Board: {}\n", t.title);
    if !t.description.is_empty() {
        b.push_str(&format!("\n{}\n", t.description));
    }
    if !t.review_note.is_empty() {
        b.push_str(&format!("\nYou worked on this before. The reviewer asked for these changes:\n{}\n", t.review_note));
    }
    b.push_str("\nWork on it until it is done. Then reply with a short summary of what you did and anything the reviewer should check.");
    b
}

/// What the Board should do next for one agent.
#[derive(Debug, PartialEq)]
enum Step {
    Nothing,
    /// The agent is stopped and has work waiting.
    Start(Task),
    /// The agent is free: hand it this task.
    Hand(Task),
    /// The running task ended: (task, new status, note, what the agent said).
    Finish(Task, &'static str, String, String),
}

fn next_step(db: &Db, a: &AgentRecord, live: bool) -> Result<Step> {
    let tasks: Vec<Task> = list(db, &a.ns)?.into_iter().filter(|t| t.agent_id == a.id).collect();

    if let Some(t) = tasks.iter().find(|t| t.status == "running") {
        let events =
            if t.run_id.is_empty() { vec![] } else { agent::events(db, &a.ns, &t.run_id, t.input_event, 2000).unwrap_or_default() };
        let said = events.iter().filter(|e| e.kind == "text").map(|e| e.text.as_str()).collect::<Vec<_>>().join("\n\n");
        if let Some(end) = events.iter().find(|e| e.kind == "result" || e.kind == "error") {
            return Ok(if end.kind == "result" {
                Step::Finish(t.clone(), "review", end.text.clone(), said)
            } else {
                Step::Finish(t.clone(), "failed", end.text.clone(), said)
            });
        }
        // The run that had it is over, and nothing answered.
        let current = agent::runs(db, &a.ns, &a.id, 1)?.into_iter().next();
        let run_over = current.as_ref().is_none_or(|r| r.id != t.run_id || r.ended_at.is_some());
        if run_over && matches!(a.status.as_str(), "stopped" | "failed") {
            // A command agent that exits cleanly has done its work.
            let ok = a.status == "stopped" && a.status_reason.contains("exited normally");
            let output = events.iter().filter(|e| e.kind == "output").map(|e| e.text.as_str()).collect::<Vec<_>>().join("\n");
            let note = if a.status_reason.is_empty() { format!("{} stopped", a.name) } else { format!("{}: {}", a.name, a.status_reason) };
            return Ok(Step::Finish(t.clone(), if ok { "review" } else { "failed" }, note, if said.is_empty() { output } else { said }));
        }
        return Ok(Step::Nothing);
    }

    let Some(next) = tasks.into_iter().find(|t| t.status == "queued") else { return Ok(Step::Nothing) };
    Ok(match a.status.as_str() {
        "paused" => Step::Nothing,
        "stopped" | "failed" if !live => Step::Start(next),
        "running" if live && !agent::busy(db, a) => Step::Hand(next),
        _ => Step::Nothing,
    })
}

/// Moves tasks along as agents work, and tells the UI when the board changed.
pub struct Board {
    db: Arc<Db>,
    sup: Arc<Supervisor>,
    changes: tokio::sync::broadcast::Sender<String>,
    lock: tokio::sync::Mutex<()>,
}

impl Board {
    pub fn new(db: Arc<Db>, sup: Arc<Supervisor>) -> Arc<Self> {
        Arc::new(Self { db, sup, changes: tokio::sync::broadcast::channel(64).0, lock: Default::default() })
    }

    /// Namespaces whose board changed.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<String> {
        self.changes.subscribe()
    }

    pub fn changed(&self, ns: &str) {
        let _ = self.changes.send(ns.to_string());
    }

    /// Follow the supervisor: every status change and every answer may move a task.
    pub fn spawn(self: &Arc<Self>) {
        let me = self.clone();
        let mut updates = self.sup.subscribe();
        tauri::async_runtime::spawn(async move {
            loop {
                match updates.recv().await {
                    Ok(u) => {
                        let ends_turn = u.event.as_ref().is_some_and(|e| e.kind == "result" || e.kind == "error");
                        if u.status.is_some() || ends_turn {
                            me.pump(&u.ns, &u.agent_id).await;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => return,
                }
            }
        });
    }

    /// Move one agent's tasks along as far as they can go right now.
    pub async fn pump(&self, ns: &str, agent_id: &str) {
        let _one_at_a_time = self.lock.lock().await;
        // A few steps at most: finish one task, then hand over the next.
        for _ in 0..3 {
            let Ok(a) = agent::get(&self.db, ns, agent_id) else { return };
            let step = match next_step(&self.db, &a, self.sup.is_live(&a.id)) {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!(error = %e, agent = %a.name, "could not check the agent's tasks");
                    return;
                }
            };
            let done = self.apply(&a, step).await;
            if done {
                return;
            }
        }
    }

    /// Returns true when there is nothing more to do now.
    async fn apply(&self, a: &AgentRecord, step: Step) -> bool {
        let ns = a.ns.as_str();
        match step {
            Step::Nothing => true,
            Step::Finish(t, status, note, said) => {
                if let Err(e) = finish(&self.db, &t, status, &note, &said) {
                    tracing::error!(error = %e, task = %t.id, "could not finish task");
                    return true;
                }
                self.changed(ns);
                false
            }
            Step::Start(t) => {
                // Starting is asynchronous: the agent's "running" update brings us back here.
                if let Err(e) = self.sup.start(ns, &a.id).await {
                    let note = format!("{} couldn't start: {e}", a.name);
                    let _ = finish(&self.db, &t, "failed", &note, "");
                    self.changed(ns);
                }
                true
            }
            Step::Hand(t) => {
                match self.sup.send_tracked(ns, &a.id, &brief(&t)).await {
                    Ok((run_id, event)) => {
                        let r = self.db.with(|c| {
                            c.execute(
                                "UPDATE tasks SET status = 'running', status_note = '', run_id = ?2, input_event = ?3,
                                   attempts = attempts + 1, started_at = CURRENT_TIMESTAMP, finished_at = NULL
                                 WHERE id = ?1",
                                (&t.id, &run_id, event),
                            )?;
                            Ok(())
                        });
                        if let Err(e) = r {
                            tracing::error!(error = %e, task = %t.id, "could not mark task running");
                        }
                    }
                    Err(e) => {
                        let _ = finish(&self.db, &t, "failed", &format!("couldn't hand it to {}: {e}", a.name), "");
                    }
                }
                self.changed(ns);
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::NewAgent;

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

    fn worker_agent(db: &Db, name: &str) -> AgentRecord {
        let new = NewAgent {
            name: name.into(),
            role: None,
            runtime: "command".into(),
            model: None,
            sandbox_id: Some("sb-1".into()),
            command: Some("sh agent.sh".into()),
            max_turns: None,
            restart: None,
            max_restarts: None,
            repo: None,
            repo_account: None,
            effort: None,
        };
        agent::create(db, "work", new).unwrap()
    }

    fn task(db: &Db, agent: &str, title: &str, priority: &str) -> Task {
        let new = NewTask {
            agent_id: agent.into(),
            title: title.into(),
            description: Some("Make it so.".into()),
            priority: Some(priority.into()),
        };
        create(db, "work", new).unwrap()
    }

    fn status(db: &Db, a: &AgentRecord, s: &str, reason: &str) -> AgentRecord {
        agent::set_status(db, &a.id, s, reason).unwrap();
        agent::get(db, "work", &a.id).unwrap()
    }

    /// Hand a task over the way the Board does: a run, an input line, the task marked running.
    fn hand(db: &Db, a: &AgentRecord, t: &Task) -> String {
        let run = agent::begin_run(db, "work", &a.id, 1).unwrap();
        let input = agent::add_event(db, &run, "input", &brief(t)).unwrap();
        db.with(|c| {
            c.execute(
                "UPDATE tasks SET status = 'running', run_id = ?2, input_event = ?3, attempts = attempts + 1, started_at = CURRENT_TIMESTAMP WHERE id = ?1",
                (&t.id, &run, input),
            )?;
            Ok(())
        })
        .unwrap();
        run
    }

    #[test]
    fn creating_checks_the_task_and_its_agent() {
        let db = db();
        let a = worker_agent(&db, "coder");
        let t = task(&db, &a.id, "  Fix the flaky login test ", "high");
        assert_eq!((t.title.as_str(), t.status.as_str(), t.priority.as_str()), ("Fix the flaky login test", "queued", "high"));

        let bad = |title: &str, priority: &str| {
            create(&db, "work", NewTask { agent_id: a.id.clone(), title: title.into(), description: None, priority: Some(priority.into()) })
        };
        assert!(bad(" ", "normal").unwrap_err().to_string().contains("title"));
        assert!(bad("ok", "urgent").unwrap_err().to_string().contains("priority"));
        assert!(bad(&"x".repeat(MAX_TITLE + 1), "normal").is_err());

        // The master agent works from Ask.
        let m = worker_agent(&db, "kalypso");
        db.with(|c| Ok(c.execute("UPDATE agents SET master = 1 WHERE id = ?1", [&m.id])?)).unwrap();
        let err =
            create(&db, "work", NewTask { agent_id: m.id.clone(), title: "x".into(), description: None, priority: None }).unwrap_err();
        assert!(err.to_string().contains("Ask"), "{err}");

        // Another namespace can't see it.
        assert!(get(&db, "lab", &t.id).is_err());
    }

    #[test]
    fn queued_work_starts_the_agent_then_goes_to_it_in_priority_order() {
        let db = db();
        let a = worker_agent(&db, "coder");
        let low = task(&db, &a.id, "Tidy the README", "low");
        let high = task(&db, &a.id, "Fix the outage", "high");

        // Stopped: start it. Starting or paused: wait.
        assert_eq!(next_step(&db, &a, false).unwrap(), Step::Start(get(&db, "work", &high.id).unwrap()));
        let starting = status(&db, &a, "starting", "");
        assert_eq!(next_step(&db, &starting, false).unwrap(), Step::Nothing);
        let paused = status(&db, &a, "paused", "by you");
        assert_eq!(next_step(&db, &paused, true).unwrap(), Step::Nothing);

        // Running and free: the high-priority task goes first.
        let running = status(&db, &a, "running", "");
        let Step::Hand(first) = next_step(&db, &running, true).unwrap() else { panic!("expected a hand-over") };
        assert_eq!(first.id, high.id);
        hand(&db, &running, &first);

        // While it works on that, the low one waits.
        assert_eq!(next_step(&db, &running, true).unwrap(), Step::Nothing);
        assert_eq!(get(&db, "work", &low.id).unwrap().status, "queued");
    }

    #[test]
    fn the_answer_moves_the_task_to_review_or_failed() {
        let db = db();
        let a = worker_agent(&db, "coder");
        let a = status(&db, &a, "running", "");
        let t = task(&db, &a.id, "Fix the flaky login test", "normal");
        let run = hand(&db, &a, &t);
        agent::add_event(&db, &run, "text", "It now waits for the redirect. 20 of 20 runs pass.").unwrap();
        assert_eq!(next_step(&db, &a, true).unwrap(), Step::Nothing, "no result yet");
        agent::add_event(&db, &run, "result", "Done · 9 turns").unwrap();

        let Step::Finish(ft, to, note, said) = next_step(&db, &a, true).unwrap() else { panic!("expected a finish") };
        assert_eq!((to, note.as_str()), ("review", "Done · 9 turns"));
        assert!(said.contains("20 of 20"));
        finish(&db, &ft, to, &note, &said).unwrap();
        let reviewed = get(&db, "work", &t.id).unwrap();
        assert_eq!((reviewed.status.as_str(), reviewed.attempts), ("review", 1));
        assert!(reviewed.finished_at.is_some());

        // An error ends it as failed.
        let t2 = task(&db, &a.id, "Upgrade the SDK", "normal");
        let run2 = hand(&db, &a, &t2);
        agent::add_event(&db, &run2, "error", "The model provider refused the key").unwrap();
        let Step::Finish(_, to, note, _) = next_step(&db, &a, true).unwrap() else { panic!("expected a finish") };
        assert_eq!((to, note.as_str()), ("failed", "The model provider refused the key"));
    }

    #[test]
    fn an_agent_that_stops_mid_task_fails_it() {
        let db = db();
        let a = worker_agent(&db, "coder");
        let a = status(&db, &a, "running", "");
        let t = task(&db, &a.id, "Long job", "normal");
        let run = hand(&db, &a, &t);
        agent::end_run(&db, &run, Some(137), "crashed", "exit 137", 1).unwrap();
        let gone = status(&db, &a, "failed", "gave up after 3 restarts");
        let Step::Finish(_, to, note, _) = next_step(&db, &gone, false).unwrap() else { panic!("expected a finish") };
        assert_eq!(to, "failed");
        assert!(note.contains("gave up after 3 restarts"), "{note}");
    }

    #[test]
    fn review_approves_or_sends_back_with_notes() {
        let db = db();
        let a = worker_agent(&db, "coder");
        let t = task(&db, &a.id, "Write the changelog", "normal");
        assert!(review(&db, "work", &t.id, true, "").unwrap_err().to_string().contains("not in review"));

        db.with(|c| Ok(c.execute("UPDATE tasks SET status = 'review' WHERE id = ?1", [&t.id])?)).unwrap();
        assert!(review(&db, "work", &t.id, false, "  ").unwrap_err().to_string().contains("what should change"));
        let back = review(&db, "work", &t.id, false, "Mention the MIT licence").unwrap();
        assert_eq!((back.status.as_str(), back.review_note.as_str()), ("queued", "Mention the MIT licence"));
        assert!(brief(&back).contains("The reviewer asked for these changes:\nMention the MIT licence"));

        db.with(|c| Ok(c.execute("UPDATE tasks SET status = 'review' WHERE id = ?1", [&t.id])?)).unwrap();
        assert_eq!(review(&db, "work", &t.id, true, "").unwrap().status, "done");
    }

    #[test]
    fn moving_by_hand_never_starts_a_task_and_restarts_fail_running_ones() {
        let db = db();
        let a = worker_agent(&db, "coder");
        let t = task(&db, &a.id, "Anything", "normal");
        assert!(move_to(&db, "work", &t.id, "running").is_err());
        assert_eq!(move_to(&db, "work", &t.id, "done").unwrap().status, "done");
        let again = move_to(&db, "work", &t.id, "queued").unwrap();
        assert_eq!((again.status.as_str(), again.finished_at.as_deref()), ("queued", None));

        let a = status(&db, &a, "running", "");
        hand(&db, &a, &again);
        assert_eq!(reset_after_restart(&db).unwrap(), 1);
        let failed = get(&db, "work", &t.id).unwrap();
        assert_eq!(failed.status, "failed");
        assert!(failed.status_note.contains("KALYPSO closed"));

        // Deleting its agent deletes it.
        agent::delete(&db, "work", &a.id).unwrap();
        assert!(list(&db, "work").unwrap().is_empty());
    }
}
