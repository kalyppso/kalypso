//! How a kind of agent is started, spoken to and stopped. The supervisor only talks
//! to this trait, so the Claude Agent SDK (#14) and Claude Code (#15) adapters plug in
//! next to the command runtime without the supervisor changing.

use std::pin::Pin;
use std::sync::Arc;

use async_trait::async_trait;
use futures_util::stream::BoxStream;
use futures_util::StreamExt;
use tokio::io::AsyncWrite;

use super::AgentRecord;
use crate::error::{KalypsoError, Result};
use crate::sandbox::SandboxProvider;

/// Where an agent runs.
pub struct AgentCtx<'a> {
    pub agent: &'a AgentRecord,
    pub sandbox_id: &'a str,
    pub provider: Arc<dyn SandboxProvider>,
}

/// Something an agent produced, already split into readable pieces.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// A line the agent printed.
    Output(String),
}

/// A started agent process.
pub struct Run {
    pub events: BoxStream<'static, Event>,
    pub input: Pin<Box<dyn AsyncWrite + Send>>,
    /// Provider handle, for the exit code once the process ends.
    pub handle: String,
    /// File inside the sandbox holding the process id, for signals.
    pub pid_file: String,
}

#[async_trait]
pub trait AgentRuntime: Send + Sync + 'static {
    fn kind(&self) -> &'static str;
    async fn start(&self, ctx: &AgentCtx<'_>) -> Result<Run>;
    /// Bytes to write to the agent's stdin to deliver one message.
    fn encode(&self, message: &str) -> Vec<u8>;
}

/// The runtime for an agent kind.
pub fn for_kind(kind: &str) -> Result<Arc<dyn AgentRuntime>> {
    match kind {
        "command" => Ok(Arc::new(CommandRuntime)),
        "claude-sdk" => Err(KalypsoError::Invalid("Claude Agent SDK agents arrive with #14".into())),
        "claude-code" => Err(KalypsoError::Invalid("Claude Code agents arrive with #15".into())),
        other => Err(KalypsoError::Invalid(format!("unknown runtime {other}"))),
    }
}

/// Agent ids are KALYPSO ids ([a-z0-9-]), so they are safe in a path.
pub fn pid_file(agent_id: &str) -> String {
    format!("/tmp/.kalypso-agent-{agent_id}.pid")
}

/// Any program run in the sandbox: a CLI agent, a script, a bot. Messages are lines on
/// stdin; everything it prints on stdout and stderr is the transcript.
pub struct CommandRuntime;

#[async_trait]
impl AgentRuntime for CommandRuntime {
    fn kind(&self) -> &'static str {
        "command"
    }

    async fn start(&self, ctx: &AgentCtx<'_>) -> Result<Run> {
        let command = ctx.agent.command.trim();
        if command.is_empty() {
            return Err(KalypsoError::Invalid(format!("{} has no command to run", ctx.agent.name)));
        }
        let pid_file = pid_file(&ctx.agent.id);
        // Record the PID, then become the command (exec keeps the PID). The command is
        // passed as an argument, so it needs no quoting.
        let wrapper = format!("echo $$ > {pid_file}; exec sh -c \"$1\"");
        let cmd = ["/bin/sh", "-c", wrapper.as_str(), "kalypso-agent", command];
        let env = vec![
            format!("KALYPSO_AGENT={}", ctx.agent.name),
            format!("KALYPSO_AGENT_ID={}", ctx.agent.id),
            format!("KALYPSO_MODEL={}", ctx.agent.model),
            "PYTHONUNBUFFERED=1".to_string(),
        ];
        let (stream, handle) = ctx.provider.open_process(&ctx.agent.ns, ctx.sandbox_id, &cmd, "/work", &env).await?;
        Ok(Run { events: lines(stream.output), input: stream.input, handle, pid_file })
    }

    fn encode(&self, message: &str) -> Vec<u8> {
        let mut b = message.replace('\n', " ").into_bytes();
        b.push(b'\n');
        b
    }
}

/// Split a byte stream into lines (UTF-8, lossy), keeping a partial last line until it ends.
fn lines(output: BoxStream<'static, std::io::Result<Vec<u8>>>) -> BoxStream<'static, Event> {
    const MAX_LINE: usize = 16 * 1024;
    futures_util::stream::unfold((output, Vec::<u8>::new(), false), |(mut out, mut buf, mut done)| async move {
        loop {
            if let Some(i) = buf.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = buf.drain(..=i).collect();
                let text = String::from_utf8_lossy(&line[..line.len() - 1]).trim_end_matches('\r').to_string();
                return Some((Event::Output(text), (out, buf, done)));
            }
            if buf.len() >= MAX_LINE {
                let text = String::from_utf8_lossy(&buf).into_owned();
                buf.clear();
                return Some((Event::Output(text), (out, buf, done)));
            }
            if done {
                if buf.is_empty() {
                    return None;
                }
                let text = String::from_utf8_lossy(&buf).trim_end_matches('\r').to_string();
                buf.clear();
                return Some((Event::Output(text), (out, buf, done)));
            }
            match out.next().await {
                Some(Ok(chunk)) => buf.extend_from_slice(&chunk),
                Some(Err(_)) | None => done = true,
            }
        }
    })
    .boxed()
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn collect(chunks: Vec<&'static str>) -> Vec<String> {
        let s = futures_util::stream::iter(chunks.into_iter().map(|c| Ok(c.as_bytes().to_vec()))).boxed();
        lines(s).map(|Event::Output(t)| t).collect().await
    }

    #[tokio::test]
    async fn output_is_split_into_lines() {
        assert_eq!(collect(vec!["hel", "lo\nwor", "ld\r\n", "tail"]).await, ["hello", "world", "tail"]);
        assert_eq!(collect(vec!["a\n\nb\n"]).await, ["a", "", "b"]);
        assert!(collect(vec![]).await.is_empty());
    }

    #[test]
    fn messages_are_one_line() {
        assert_eq!(CommandRuntime.encode("hi\nthere"), b"hi there\n");
        assert!(for_kind("claude-sdk").is_err());
        assert_eq!(for_kind("command").unwrap().kind(), "command");
    }
}
