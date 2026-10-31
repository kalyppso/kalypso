//! Terminal panes: an interactive shell in a sandbox per pane, over the engine's
//! TTY exec (no `docker` CLI needed, and the same on Podman). Output goes to the
//! pane as it arrives; input, resizes and closing come back through IPC.
//!
//! A person typing here isn't subject to agent policies (ARCHITECTURE §4.20); every
//! session opened is audited.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use tokio::io::{AsyncWrite, AsyncWriteExt};

use crate::error::{KalypsoError, Result};
use crate::sandbox::{self, Runtime, SandboxProvider};
use crate::store::Db;

/// bash when the image has it, sh otherwise, as a login shell. The shell's PID is
/// written first (`exec` keeps it), so closing the pane can hang it up: engines don't
/// end an exec'd process when its connection goes away.
fn shell(pane: &str) -> Vec<String> {
    let script = format!("echo $$ > {}; if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi", pid_file(pane));
    vec!["/bin/sh".into(), "-c".into(), script]
}

/// Pane ids are checked to be [A-Za-z0-9_-], so they are safe in a path.
fn pid_file(pane: &str) -> String {
    format!("/tmp/.kalypso-term-{pane}.pid")
}

const CWD: &str = "/work";

struct Session {
    ns: String,
    sandbox_id: String,
    provider: Arc<dyn SandboxProvider>,
    handle: String,
    input: tokio::sync::Mutex<Pin<Box<dyn AsyncWrite + Send>>>,
    reader: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
pub struct Terminals {
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
}

/// Pane ids become event names, so keep them to safe characters.
pub fn valid_pane(pane: &str) -> bool {
    (1..=64).contains(&pane.len()) && pane.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

impl Terminals {
    /// Start a shell for `pane` in a running sandbox, replacing whatever the pane had.
    /// `on_data` gets every chunk the terminal prints; `on_exit` runs once when the shell ends.
    #[allow(clippy::too_many_arguments)]
    pub async fn open(
        &self,
        db: &Db,
        rt: &Runtime,
        ns: &str,
        sandbox_id: &str,
        pane: &str,
        rows: u16,
        cols: u16,
        on_data: impl Fn(Vec<u8>) + Send + 'static,
        on_exit: impl FnOnce() + Send + 'static,
    ) -> Result<()> {
        if !valid_pane(pane) {
            return Err(KalypsoError::Invalid("pane ids use letters, digits, - and _".into()));
        }
        self.close(ns, pane).await;
        let rec = sandbox::get(db, ns, sandbox_id)?;
        if rec.status != "running" {
            return Err(KalypsoError::Invalid(format!("{} is {}. Start it to open a terminal.", rec.name, rec.status)));
        }
        let provider = rt.provider(&rec.runtime)?;
        let cmd = shell(pane);
        let cmd: Vec<&str> = cmd.iter().map(String::as_str).collect();
        let (stream, handle) = provider.open_tty(ns, sandbox_id, &cmd, CWD, rows, cols).await?;
        db.audit(Some(ns), "user", "terminal.open", &rec.name)?;

        let sessions = self.sessions.clone();
        let key = pane.to_string();
        let mut output = stream.output;
        // The reader owns the output; when it ends the pane is told and forgotten,
        // unless a newer session has taken the pane over in the meantime.
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<Arc<Session>>();
        let reader = tokio::spawn(async move {
            let Ok(me) = ready_rx.await else { return };
            while let Some(chunk) = output.next().await {
                match chunk {
                    Ok(bytes) if !bytes.is_empty() => on_data(bytes),
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            let mut map = sessions.lock().unwrap();
            if map.get(&key).is_some_and(|s| Arc::ptr_eq(s, &me)) {
                map.remove(&key);
            }
            drop(map);
            on_exit();
        });
        let session = Arc::new(Session {
            ns: ns.to_string(),
            sandbox_id: sandbox_id.to_string(),
            provider,
            handle,
            input: tokio::sync::Mutex::new(stream.input),
            reader,
        });
        self.sessions.lock().unwrap().insert(pane.to_string(), session.clone());
        let _ = ready_tx.send(session);
        Ok(())
    }

    fn get(&self, ns: &str, pane: &str) -> Result<Arc<Session>> {
        match self.sessions.lock().unwrap().get(pane) {
            Some(s) if s.ns == ns => Ok(s.clone()),
            _ => Err(KalypsoError::NotFound(format!("terminal {pane}"))),
        }
    }

    /// Keystrokes and pasted text, exactly as the terminal produced them.
    pub async fn write(&self, ns: &str, pane: &str, data: &[u8]) -> Result<()> {
        let s = self.get(ns, pane)?;
        let mut input = s.input.lock().await;
        input.write_all(data).await?;
        input.flush().await?;
        Ok(())
    }

    pub async fn resize(&self, ns: &str, pane: &str, rows: u16, cols: u16) -> Result<()> {
        let s = self.get(ns, pane)?;
        s.provider.resize_tty(&s.handle, rows, cols).await
    }

    /// End the pane's shell: hang it up (as closing a terminal window does), then drop
    /// the connection. True if the pane had one.
    pub async fn close(&self, ns: &str, pane: &str) -> bool {
        let session = {
            let mut map = self.sessions.lock().unwrap();
            match map.get(pane) {
                Some(s) if s.ns == ns => map.remove(pane),
                _ => None,
            }
        };
        let Some(s) = session else { return false };
        s.reader.abort();
        let pid = pid_file(pane);
        let hangup = format!("kill -HUP \"$(cat {pid} 2>/dev/null)\" 2>/dev/null; rm -f {pid}");
        if let Err(e) = s.provider.exec(&s.ns, &s.sandbox_id, &["sh", "-c", &hangup], false).await {
            tracing::debug!(error = %e, "could not hang up a terminal (sandbox gone?)");
        }
        true
    }

    /// Close every pane attached to a sandbox that is stopping or going away.
    pub fn close_sandbox(&self, ns: &str, sandbox_id: &str) -> usize {
        let mut map = self.sessions.lock().unwrap();
        let panes: Vec<String> = map.iter().filter(|(_, s)| s.ns == ns && s.sandbox_id == sandbox_id).map(|(k, _)| k.clone()).collect();
        for p in &panes {
            if let Some(s) = map.remove(p) {
                s.reader.abort();
            }
        }
        panes.len()
    }

    pub fn open_panes(&self, ns: &str) -> Vec<String> {
        self.sessions.lock().unwrap().iter().filter(|(_, s)| s.ns == ns).map(|(k, _)| k.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sandbox::{create, remove, start, NewSandbox};
    use crate::vault::new_id;

    #[test]
    fn pane_ids_are_event_safe() {
        assert!(valid_pane("p-1_A"));
        assert!(!valid_pane(""));
        assert!(!valid_pane("a/b"));
        assert!(!valid_pane("a b"));
        assert!(!valid_pane(&"x".repeat(65)));
    }

    #[tokio::test]
    async fn closed_or_unknown_panes_are_not_found() {
        let t = Terminals::default();
        assert_eq!(t.write("work", "p1", b"ls\n").await.unwrap_err().code(), "not_found");
        assert!(!t.close("work", "p1").await);
    }

    /// Wait until everything printed so far contains `needle`.
    async fn until(rx: &mut tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>, seen: &mut String, needle: &str) {
        let wait = async {
            while !seen.contains(needle) {
                let chunk = rx.recv().await.expect("terminal output ended");
                seen.push_str(&String::from_utf8_lossy(&chunk));
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(20), wait)
            .await
            .unwrap_or_else(|_| panic!("never printed {needle:?}; got {seen:?}"));
    }

    #[tokio::test]
    async fn a_pane_runs_commands_and_follows_resizes() {
        if std::env::var("KALYPSO_TEST_RUNTIME").is_err() {
            return;
        }
        let rt = Runtime::detect().await;
        let db = Db::open_in_memory().unwrap();
        let ns = format!("tm{}", &new_id("x")[2..8]);
        db.with(|c| Ok(c.execute("INSERT INTO namespaces (id, name) VALUES (?1, ?1)", [&ns])?)).unwrap();
        let spec = NewSandbox {
            name: "shell".into(),
            image: "docker.io/library/alpine:3.20".into(),
            cpu: 1.0,
            mem_mb: 256,
            network: "isolated".into(),
            provider: None,
        };
        let sb = create(&db, &rt, &ns, spec).await.unwrap();
        let terms = Terminals::default();

        // A stopped sandbox says so instead of hanging.
        let err = terms.open(&db, &rt, &ns, &sb.id, "p1", 24, 80, |_| {}, || {}).await.unwrap_err();
        assert!(err.to_string().contains("Start it"), "{err}");

        start(&db, &rt, &ns, &sb.id).await.unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let (exit_tx, exit_rx) = tokio::sync::oneshot::channel();
        terms
            .open(
                &db,
                &rt,
                &ns,
                &sb.id,
                "p1",
                24,
                80,
                move |b| {
                    let _ = tx.send(b);
                },
                move || {
                    let _ = exit_tx.send(());
                },
            )
            .await
            .unwrap();
        let mut seen = String::new();

        terms.write(&ns, "p1", b"echo $((6*7)) && pwd\n").await.unwrap();
        until(&mut rx, &mut seen, "42").await;
        until(&mut rx, &mut seen, "/work").await;

        terms.resize(&ns, "p1", 33, 101).await.unwrap();
        terms.write(&ns, "p1", b"stty size\n").await.unwrap();
        until(&mut rx, &mut seen, "33 101").await;

        // Typing `exit` ends the shell and tells the pane.
        terms.write(&ns, "p1", b"exit\n").await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(10), exit_rx).await.unwrap().unwrap();
        assert!(terms.open_panes(&ns).is_empty());
        assert_eq!(db.audit_list(Some(&ns), Some("terminal."), 10).unwrap().len(), 1);

        // Closing a pane hangs up its shell instead of leaving it running inside.
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        terms
            .open(
                &db,
                &rt,
                &ns,
                &sb.id,
                "p2",
                24,
                80,
                move |b| {
                    let _ = tx.send(b);
                },
                || {},
            )
            .await
            .unwrap();
        let mut seen = String::new();
        terms.write(&ns, "p2", b"echo ready-$((1+1))\n").await.unwrap();
        until(&mut rx, &mut seen, "ready-2").await;
        let shells = || async {
            let (_, ps) = sandbox::exec(&rt, &ns, &sb.id, &["ps", "-o", "args"], false).await.unwrap();
            ps.lines().filter(|l| l.trim() == "sh -l").count()
        };
        assert_eq!(shells().await, 1);
        assert!(terms.close(&ns, "p2").await);
        let mut gone = false;
        for _ in 0..20 {
            if shells().await == 0 {
                gone = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(gone, "the shell kept running after its pane closed");

        remove(&db, &rt, &ns, &sb.id).await.unwrap();
    }
}
