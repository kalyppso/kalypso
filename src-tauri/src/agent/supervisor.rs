//! Runs agents and keeps them healthy.
//!
//! Each started agent gets a task that runs it through its runtime, records the run
//! and its transcript, and watches for the process to end. Then the restart policy
//! decides: `never`, `on-failure` (only after a crash) or `always`, with growing
//! back-off and a limit, after which the agent is marked failed with the reason.
//! Stop, pause and resume are signals to the agent's process inside its sandbox.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use rusqlite::OptionalExtension;
use serde::Serialize;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use ts_rs::TS;

use super::runtime::{self, AgentCtx, AgentRuntime, Event};
use super::{AgentEvent, AgentRecord};
use crate::error::{KalypsoError, Result};
use crate::sandbox::{self, Runtime, SandboxProvider};
use crate::store::Db;
use crate::vault::Vault;

/// Sent to the UI on every status change and transcript line.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct AgentUpdate {
    pub ns: String,
    pub agent_id: String,
    pub status: Option<String>,
    pub reason: Option<String>,
    pub event: Option<AgentEvent>,
}

/// A running (or restarting) agent.
struct Live {
    ns: String,
    sandbox_id: String,
    provider: Arc<dyn SandboxProvider>,
    input: tokio::sync::Mutex<Option<Pin<Box<dyn AsyncWrite + Send>>>>,
    pid_file: Mutex<String>,
    run_id: Mutex<String>,
    turns: AtomicU32,
    /// Set when someone (you, a limit) ends the agent on purpose: no restart.
    stopping: AtomicBool,
    stop_reason: Mutex<String>,
    done: tokio::sync::Notify,
}

pub struct Supervisor {
    db: Arc<Db>,
    vault: Arc<Vault>,
    rt: Runtime,
    live: Mutex<HashMap<String, Arc<Live>>>,
    updates: tokio::sync::broadcast::Sender<AgentUpdate>,
    backoff: Duration,
}

impl Supervisor {
    pub fn new(db: Arc<Db>, vault: Arc<Vault>, rt: Runtime) -> Arc<Self> {
        Self::with_backoff(db, vault, rt, Duration::from_secs(1))
    }

    /// `backoff` is the first restart delay; it doubles each time, up to 30 seconds.
    pub fn with_backoff(db: Arc<Db>, vault: Arc<Vault>, rt: Runtime, backoff: Duration) -> Arc<Self> {
        Arc::new(Self { db, vault, rt, live: Mutex::default(), updates: tokio::sync::broadcast::channel(512).0, backoff })
    }

    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<AgentUpdate> {
        self.updates.subscribe()
    }

    pub fn is_live(&self, agent_id: &str) -> bool {
        self.live.lock().unwrap().contains_key(agent_id)
    }

    fn status(&self, a: &AgentRecord, status: &str, reason: &str) {
        if let Err(e) = super::set_status(&self.db, &a.id, status, reason) {
            tracing::error!(error = %e, agent = %a.name, "could not record agent status");
        }
        let _ = self.updates.send(AgentUpdate {
            ns: a.ns.clone(),
            agent_id: a.id.clone(),
            status: Some(status.into()),
            reason: Some(reason.into()),
            event: None,
        });
    }

    fn event(&self, a: &AgentRecord, run_id: &str, kind: &str, text: &str) {
        match super::add_event(&self.db, run_id, kind, text) {
            Ok(id) => {
                let event = AgentEvent { id, run_id: run_id.into(), ts: String::new(), kind: kind.into(), text: text.into() };
                let _ = self.updates.send(AgentUpdate {
                    ns: a.ns.clone(),
                    agent_id: a.id.clone(),
                    status: None,
                    reason: None,
                    event: Some(event),
                });
            }
            Err(e) => tracing::error!(error = %e, agent = %a.name, "could not record agent output"),
        }
    }

    /// Start an agent in its sandbox, starting the sandbox first if it is stopped.
    pub async fn start(self: &Arc<Self>, ns: &str, id: &str) -> Result<AgentRecord> {
        if self.is_live(id) {
            return Err(KalypsoError::Conflict(format!("agent {id} is already running")));
        }
        let agent = super::get(&self.db, ns, id)?;
        let rt = runtime::for_kind(&agent.runtime)?;
        let sandbox_id =
            agent.sandbox_id.clone().ok_or_else(|| KalypsoError::Invalid(format!("pick a sandbox for {} first", agent.name)))?;
        let sb = sandbox::get(&self.db, ns, &sandbox_id)?;
        if sb.status != "running" {
            sandbox::start(&self.db, &self.rt, ns, &sandbox_id).await?;
            sandbox::deliver_secrets(&self.db, &self.vault, &self.rt, ns, &sandbox_id).await?;
        }
        let live = Arc::new(Live {
            ns: ns.into(),
            sandbox_id: sandbox_id.clone(),
            provider: self.rt.provider(&sb.runtime)?,
            input: tokio::sync::Mutex::new(None),
            pid_file: Mutex::new(String::new()),
            run_id: Mutex::new(String::new()),
            turns: AtomicU32::new(0),
            stopping: AtomicBool::new(false),
            stop_reason: Mutex::new(String::new()),
            done: tokio::sync::Notify::new(),
        });
        {
            let mut map = self.live.lock().unwrap();
            if map.contains_key(id) {
                return Err(KalypsoError::Conflict(format!("agent {} is already running", agent.name)));
            }
            map.insert(id.into(), live.clone());
        }
        self.status(&agent, "starting", "");
        self.db.audit(Some(ns), "user", "agent.start", &agent.name)?;
        let me = self.clone();
        tokio::spawn(async move { me.supervise(agent, rt, live).await });
        super::get(&self.db, ns, id)
    }

    async fn supervise(self: Arc<Self>, agent: AgentRecord, rt: Arc<dyn AgentRuntime>, live: Arc<Live>) {
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            let ctx = AgentCtx { agent: &agent, sandbox_id: &live.sandbox_id, provider: live.provider.clone() };
            let run = match rt.start(&ctx).await {
                Ok(r) => r,
                Err(e) => {
                    self.status(&agent, "failed", &format!("could not start: {e}"));
                    break;
                }
            };
            let run_id = match super::begin_run(&self.db, &agent.ns, &agent.id, attempt) {
                Ok(r) => r,
                Err(e) => {
                    self.status(&agent, "failed", &format!("could not record the run: {e}"));
                    break;
                }
            };
            *live.run_id.lock().unwrap() = run_id.clone();
            *live.pid_file.lock().unwrap() = run.pid_file.clone();
            *live.input.lock().await = Some(run.input);
            live.turns.store(0, Ordering::SeqCst);
            let note = if attempt == 1 { "started".to_string() } else { format!("restarted (attempt {attempt})") };
            self.event(&agent, &run_id, "status", &note);
            self.status(&agent, "running", if attempt == 1 { "" } else { "restarted after a crash" });

            let mut events = run.events;
            while let Some(Event::Output(line)) = events.next().await {
                self.event(&agent, &run_id, "output", &line);
            }
            *live.input.lock().await = None;

            // The engine may need a moment to report the exit code.
            let mut code = None;
            for _ in 0..40 {
                match live.provider.exit_code(&run.handle).await {
                    Ok(Some(c)) => {
                        code = Some(c);
                        break;
                    }
                    Ok(None) => tokio::time::sleep(Duration::from_millis(50)).await,
                    Err(_) => break,
                }
            }
            let turns = live.turns.load(Ordering::SeqCst);
            let stopping = live.stopping.load(Ordering::SeqCst);
            let exit = code.map(|c| format!("exit {c}")).unwrap_or_else(|| "exit code unknown".into());
            let (outcome, reason) = if stopping {
                ("stopped", live.stop_reason.lock().unwrap().clone())
            } else if code == Some(0) {
                ("exited", "exited normally".to_string())
            } else {
                ("crashed", format!("crashed ({exit})"))
            };
            let _ = super::end_run(&self.db, &run_id, code, outcome, &reason, turns);
            self.event(&agent, &run_id, "status", &reason);

            if stopping {
                self.status(&agent, "stopped", &reason);
                break;
            }
            let restart = match agent.restart.as_str() {
                "always" => true,
                "on-failure" => outcome == "crashed",
                _ => false,
            };
            if !restart {
                if outcome == "crashed" {
                    self.status(&agent, "failed", &reason);
                } else {
                    self.status(&agent, "stopped", &reason);
                }
                break;
            }
            let restarts = attempt - 1;
            if restarts >= agent.max_restarts {
                let why = format!("gave up after {restarts} restart{}; last run {reason}", if restarts == 1 { "" } else { "s" });
                self.status(&agent, "failed", &why);
                break;
            }
            let delay = self.backoff.saturating_mul(1 << restarts.min(5)).min(Duration::from_secs(30));
            self.status(&agent, "restarting", &format!("{reason}; restarting in {:.1}s", delay.as_secs_f32()));
            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                _ = live.done.notified() => {}
            }
            if live.stopping.load(Ordering::SeqCst) {
                let reason = live.stop_reason.lock().unwrap().clone();
                self.status(&agent, "stopped", &reason);
                break;
            }
        }
        self.live.lock().unwrap().remove(&agent.id);
        live.done.notify_waiters();
    }

    async fn signal(&self, live: &Live, sig: &str) -> Result<()> {
        let pid = live.pid_file.lock().unwrap().clone();
        if pid.is_empty() {
            return Ok(());
        }
        let script = format!("kill -{sig} \"$(cat {pid})\"");
        let (code, out) = live.provider.exec(&live.ns, &live.sandbox_id, &["sh", "-c", &script], false).await?;
        if code != 0 {
            return Err(KalypsoError::Runtime(format!("could not send {sig}: {}", out.trim())));
        }
        Ok(())
    }

    fn get_live(&self, id: &str) -> Option<Arc<Live>> {
        self.live.lock().unwrap().get(id).cloned()
    }

    /// End the agent on purpose: TERM, then KILL if it hasn't gone in 5 seconds. No restart.
    pub async fn stop(&self, ns: &str, id: &str, reason: &str) -> Result<AgentRecord> {
        let agent = super::get(&self.db, ns, id)?;
        let Some(live) = self.get_live(id) else {
            if agent.status != "stopped" && agent.status != "failed" {
                self.status(&agent, "stopped", reason);
            }
            return super::get(&self.db, ns, id);
        };
        *live.stop_reason.lock().unwrap() = reason.into();
        live.stopping.store(true, Ordering::SeqCst);
        let finished = live.done.notified();
        tokio::pin!(finished);
        finished.as_mut().enable();
        // A paused process ignores TERM until it is continued.
        let _ = self.signal(&live, "CONT").await;
        if self.signal(&live, "TERM").await.is_ok() && tokio::time::timeout(Duration::from_secs(5), &mut finished).await.is_err() {
            let _ = self.signal(&live, "KILL").await;
            let _ = tokio::time::timeout(Duration::from_secs(5), &mut finished).await;
        }
        live.done.notify_waiters(); // wakes a restart back-off
        self.db.audit(Some(ns), "user", "agent.stop", &agent.name)?;
        super::get(&self.db, ns, id)
    }

    /// Freeze the agent's process where it is.
    pub async fn pause(&self, ns: &str, id: &str, reason: &str) -> Result<AgentRecord> {
        let agent = super::get(&self.db, ns, id)?;
        let live = self
            .get_live(id)
            .filter(|_| agent.status == "running")
            .ok_or_else(|| KalypsoError::Invalid(format!("{} isn't running", agent.name)))?;
        self.signal(&live, "STOP").await?;
        self.status(&agent, "paused", reason);
        let run_id = live.run_id.lock().unwrap().clone();
        self.event(&agent, &run_id, "status", &format!("paused: {reason}"));
        super::get(&self.db, ns, id)
    }

    pub async fn resume(&self, ns: &str, id: &str) -> Result<AgentRecord> {
        let agent = super::get(&self.db, ns, id)?;
        let live = self
            .get_live(id)
            .filter(|_| agent.status == "paused")
            .ok_or_else(|| KalypsoError::Invalid(format!("{} isn't paused", agent.name)))?;
        self.signal(&live, "CONT").await?;
        self.status(&agent, "running", "");
        let run_id = live.run_id.lock().unwrap().clone();
        self.event(&agent, &run_id, "status", "resumed");
        super::get(&self.db, ns, id)
    }

    /// Give the agent a message. Past `max_turns` the run ends instead.
    pub async fn send(&self, ns: &str, id: &str, message: &str) -> Result<()> {
        let agent = super::get(&self.db, ns, id)?;
        let live = self.get_live(id).ok_or_else(|| KalypsoError::Invalid(format!("{} isn't running", agent.name)))?;
        if agent.status == "paused" {
            return Err(KalypsoError::Invalid(format!("{} is paused; resume it first", agent.name)));
        }
        if agent.max_turns > 0 && live.turns.load(Ordering::SeqCst) >= agent.max_turns {
            let reason = format!("reached its limit of {} turns", agent.max_turns);
            self.stop(ns, id, &reason).await?;
            return Err(KalypsoError::Invalid(format!("{} {reason}", agent.name)));
        }
        let rt = runtime::for_kind(&agent.runtime)?;
        {
            let mut input = live.input.lock().await;
            let w = input.as_mut().ok_or_else(|| KalypsoError::Invalid(format!("{} is between runs", agent.name)))?;
            w.write_all(&rt.encode(message)).await?;
            w.flush().await?;
        }
        live.turns.fetch_add(1, Ordering::SeqCst);
        let run_id = live.run_id.lock().unwrap().clone();
        self.event(&agent, &run_id, "input", message);
        Ok(())
    }

    /// The gateway refused a request for budget: pause every running agent in that key's sandbox.
    pub async fn on_budget_block(&self, ns: &str, key_id: &str, reason: &str) {
        let sandbox: Option<String> = self
            .db
            .with(|c| Ok(c.query_row("SELECT sandbox_id FROM gateway_keys WHERE id = ?1", [key_id], |r| r.get(0)).optional()?))
            .ok()
            .flatten()
            .flatten();
        let Some(sandbox) = sandbox else { return };
        for a in super::in_sandbox(&self.db, &sandbox).unwrap_or_default() {
            if a.ns == ns && a.status == "running" && self.is_live(&a.id) {
                if let Err(e) = self.pause(ns, &a.id, &format!("budget: {reason}")).await {
                    tracing::warn!(error = %e, agent = %a.name, "could not pause an agent over budget");
                }
            }
        }
    }

    /// Stop every agent in a sandbox that is stopping or going away.
    pub async fn stop_sandbox(&self, ns: &str, sandbox_id: &str, reason: &str) {
        for a in super::in_sandbox(&self.db, sandbox_id).unwrap_or_default() {
            if a.ns == ns && self.is_live(&a.id) {
                let _ = self.stop(ns, &a.id, reason).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{self, NewAgent};
    use crate::vault::new_id;

    struct Env {
        db: Arc<Db>,
        rt: Runtime,
        sup: Arc<Supervisor>,
        ns: String,
        sb: String,
    }

    async fn env() -> Option<Env> {
        if std::env::var("KALYPSO_TEST_RUNTIME").is_err() {
            return None;
        }
        let rt = Runtime::detect().await;
        let db = Arc::new(Db::open_in_memory().unwrap());
        let vault = Arc::new(Vault::ephemeral());
        let ns = format!("ag{}", &new_id("x")[2..8]);
        db.with(|c| Ok(c.execute("INSERT INTO namespaces (id, name) VALUES (?1, ?1)", [&ns])?)).unwrap();
        vault.create_ns_key(&db, &ns).unwrap();
        let spec = sandbox::NewSandbox {
            name: "agents".into(),
            image: "docker.io/library/alpine:3.20".into(),
            cpu: 1.0,
            mem_mb: 256,
            network: "isolated".into(),
            provider: None,
        };
        let sb = sandbox::create(&db, &rt, &ns, spec).await.unwrap().id;
        let sup = Supervisor::with_backoff(db.clone(), vault, rt.clone(), Duration::from_millis(50));
        Some(Env { db, rt, sup, ns, sb })
    }

    impl Env {
        fn agent(&self, name: &str, command: &str, restart: &str, max_restarts: u32, max_turns: u32) -> AgentRecord {
            let new = NewAgent {
                name: name.into(),
                role: None,
                runtime: "command".into(),
                model: None,
                sandbox_id: Some(self.sb.clone()),
                command: Some(command.into()),
                max_turns: Some(max_turns),
                restart: Some(restart.into()),
                max_restarts: Some(max_restarts),
            };
            agent::create(&self.db, &self.ns, new).unwrap()
        }

        /// Wait until the agent's status (and reason, if given) match.
        async fn until(&self, id: &str, status: &str, reason_has: &str) -> AgentRecord {
            for _ in 0..200 {
                let a = agent::get(&self.db, &self.ns, id).unwrap();
                if a.status == status && a.status_reason.contains(reason_has) {
                    return a;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            let a = agent::get(&self.db, &self.ns, id).unwrap();
            panic!("{} never became {status} ({reason_has}); it is {} ({})", a.name, a.status, a.status_reason);
        }

        /// Wait until the newest run's transcript contains `text`.
        async fn output(&self, id: &str, text: &str) {
            for _ in 0..200 {
                if let Some(run) = agent::runs(&self.db, &self.ns, id, 1).unwrap().first() {
                    if agent::events(&self.db, &self.ns, &run.id, 0, 1000).unwrap().iter().any(|e| e.text.contains(text)) {
                        return;
                    }
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            panic!("never printed {text:?}");
        }

        async fn sh(&self, script: &str) -> String {
            sandbox::exec(&self.rt, &self.ns, &self.sb, &["sh", "-c", script], false).await.unwrap().1
        }

        async fn done(self) {
            sandbox::remove(&self.db, &self.rt, &self.ns, &self.sb).await.unwrap();
        }
    }

    /// The acceptance criterion: a killed agent is noticed and handled per its policy.
    #[tokio::test]
    async fn killed_agents_are_restarted_then_given_up_on() {
        let Some(e) = env().await else { return };
        let a = e.agent("worker", "echo ready; sleep 600", "on-failure", 1, 0);
        // Starting it also starts the stopped sandbox.
        e.sup.start(&e.ns, &a.id).await.unwrap();
        e.until(&a.id, "running", "").await;
        e.output(&a.id, "ready").await;

        let pid = runtime::pid_file(&a.id);
        e.sh(&format!("kill -9 \"$(cat {pid})\"")).await;
        e.until(&a.id, "running", "restarted").await;
        assert_eq!(agent::runs(&e.db, &e.ns, &a.id, 10).unwrap().len(), 2);
        e.output(&a.id, "ready").await;

        e.sh(&format!("kill -9 \"$(cat {pid})\"")).await;
        let failed = e.until(&a.id, "failed", "gave up after 1 restart").await;
        assert!(failed.status_reason.contains("exit 137"), "{}", failed.status_reason);
        let runs = agent::runs(&e.db, &e.ns, &a.id, 10).unwrap();
        assert!(runs.iter().all(|r| r.outcome == "crashed" && r.exit_code == Some(137)), "{runs:?}");
        assert!(!e.sup.is_live(&a.id));
        e.done().await;
    }

    #[tokio::test]
    async fn exits_stops_turns_and_pauses() {
        let Some(e) = env().await else { return };

        // A clean exit isn't a crash: no restart under on-failure.
        let quick = e.agent("quick", "echo done", "on-failure", 3, 0);
        e.sup.start(&e.ns, &quick.id).await.unwrap();
        e.until(&quick.id, "stopped", "exited normally").await;
        assert_eq!(agent::runs(&e.db, &e.ns, &quick.id, 10).unwrap().len(), 1);

        // Messages go to stdin; past max_turns the run ends.
        let chat = e.agent("chat", "while read l; do echo \"got $l\"; done", "always", 3, 2);
        e.sup.start(&e.ns, &chat.id).await.unwrap();
        e.until(&chat.id, "running", "").await;
        e.sup.send(&e.ns, &chat.id, "one").await.unwrap();
        e.output(&chat.id, "got one").await;
        e.sup.send(&e.ns, &chat.id, "two").await.unwrap();
        e.output(&chat.id, "got two").await;
        let err = e.sup.send(&e.ns, &chat.id, "three").await.unwrap_err();
        assert!(err.to_string().contains("limit of 2 turns"), "{err}");
        let stopped = e.until(&chat.id, "stopped", "limit of 2 turns").await;
        assert_eq!(stopped.status, "stopped", "a deliberate stop isn't restarted, even under always");
        let run = &agent::runs(&e.db, &e.ns, &chat.id, 1).unwrap()[0];
        assert_eq!((run.outcome.as_str(), run.turns), ("stopped", 2));

        // Pause freezes the process; resume continues it; stop ends it for good.
        let ticker = e.agent("ticker", "while true; do echo tick; sleep 0.2; done", "always", 3, 0);
        e.sup.start(&e.ns, &ticker.id).await.unwrap();
        e.until(&ticker.id, "running", "").await;
        let pid = runtime::pid_file(&ticker.id);
        e.sup.pause(&e.ns, &ticker.id, "by you").await.unwrap();
        assert!(e.sh(&format!("grep State /proc/$(cat {pid})/status")).await.contains("stopped"));
        e.sup.resume(&e.ns, &ticker.id).await.unwrap();
        assert!(!e.sh(&format!("grep State /proc/$(cat {pid})/status")).await.contains("stopped"));
        e.sup.stop(&e.ns, &ticker.id, "stopped by you").await.unwrap();
        e.until(&ticker.id, "stopped", "stopped by you").await;
        assert!(!e.sup.is_live(&ticker.id));
        e.done().await;
    }

    #[tokio::test]
    async fn a_budget_block_pauses_the_sandboxes_agents() {
        let Some(e) = env().await else { return };
        let a = e.agent("spender", "sleep 600", "never", 0, 0);
        e.sup.start(&e.ns, &a.id).await.unwrap();
        e.until(&a.id, "running", "").await;
        let key = crate::gateway::mint(&e.db, &e.ns, Some(&e.sb), "agents").unwrap().key.id;
        e.sup.on_budget_block(&e.ns, &key, "daily cap reached").await;
        let paused = e.until(&a.id, "paused", "budget: daily cap reached").await;
        assert_eq!(paused.status, "paused");
        e.sup.stop(&e.ns, &a.id, "done").await.unwrap();
        e.done().await;
    }
}
