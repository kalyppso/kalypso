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
pub struct Event {
    /// output, text, tool, result, policy, error or status (see `agent_events.kind`).
    pub kind: &'static str,
    pub text: String,
}

impl Event {
    /// A line the agent printed.
    pub fn output(text: impl Into<String>) -> Self {
        Event { kind: "output", text: text.into() }
    }
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
    /// True when the runtime enforces `max_turns` itself (as model turns), so the
    /// supervisor does not count messages against it.
    fn counts_turns(&self) -> bool {
        false
    }
}

/// The runtime for an agent kind.
pub fn for_kind(kind: &str) -> Result<Arc<dyn AgentRuntime>> {
    match kind {
        "command" => Ok(Arc::new(CommandRuntime)),
        "claude-sdk" => Ok(Arc::new(ClaudeSdkRuntime)),
        "openai-compat" => Ok(Arc::new(OpenAiRuntime)),
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
        let (env, cwd) = with_repo(env, ctx.agent);
        let (stream, handle) = ctx.provider.open_process(&ctx.agent.ns, ctx.sandbox_id, &cmd, &cwd, &env).await?;
        Ok(Run { events: lines(stream.output), input: stream.input, handle, pid_file })
    }

    fn encode(&self, message: &str) -> Vec<u8> {
        let mut b = message.replace('\n', " ").into_bytes();
        b.push(b'\n');
        b
    }
}

/// Where the runner lives in the agent runner image (`runner/agent-sdk`).
pub const RUNNER: &str = "/opt/kalypso/runner/runner.mjs";
/// The image with the runner; images built FROM it work too.
pub const RUNNER_IMAGE: &str = "ghcr.io/kalyppso/agent-runner:latest";

/// A Claude Agent SDK agent: the runner in the sandbox drives the SDK, sends model calls
/// through the gateway with the sandbox's virtual key, and asks the policy engine before
/// every tool call. Its stdout is JSON lines, turned into transcript events here.
pub struct ClaudeSdkRuntime;

#[async_trait]
impl AgentRuntime for ClaudeSdkRuntime {
    fn kind(&self) -> &'static str {
        "claude-sdk"
    }

    async fn start(&self, ctx: &AgentCtx<'_>) -> Result<Run> {
        let a = ctx.agent;
        let pid_file = pid_file(&a.id);
        let missing = format!(
            r#"{{"t":"error","text":"The sandbox image has no KALYPSO agent runner. Use {RUNNER_IMAGE}, or an image built FROM it."}}"#
        );
        let wrapper = format!("echo $$ > {pid_file}; [ -f {RUNNER} ] || {{ echo '{missing}'; exit 64; }}; exec node {RUNNER}");
        let cmd = ["/bin/sh", "-c", wrapper.as_str()];
        let env = vec![
            format!("KALYPSO_AGENT={}", a.name),
            format!("KALYPSO_AGENT_ID={}", a.id),
            format!("KALYPSO_MODEL={}", a.model),
            format!("KALYPSO_ROLE={}", a.role),
            format!("KALYPSO_TASK={}", a.command),
            format!("KALYPSO_MAX_TURNS={}", a.max_turns),
        ];
        let (env, cwd) = with_repo(env, a);
        let (stream, handle) = ctx.provider.open_process(&a.ns, ctx.sandbox_id, &cmd, &cwd, &env).await?;
        Ok(Run { events: lines(stream.output).map(sdk_event).boxed(), input: stream.input, handle, pid_file })
    }

    fn encode(&self, message: &str) -> Vec<u8> {
        let mut b = serde_json::json!({ "type": "message", "text": message }).to_string().into_bytes();
        b.push(b'\n');
        b
    }

    fn counts_turns(&self) -> bool {
        true
    }
}

/// The runner for any OpenAI-compatible model, in the same image.
pub const OPENAI_RUNNER: &str = "/opt/kalypso/runner/openai.mjs";

/// An agent on any OpenAI-compatible model (OpenAI, OpenRouter, Ollama, vLLM, LM Studio, …).
/// Its model is "provider/model"; calls go to the gateway's `/<provider>/chat/completions`, so the
/// provider's key and base URL are gateway secrets, never in the sandbox. Same tools, policy
/// checks and transcript as the Claude runner.
pub struct OpenAiRuntime;

#[async_trait]
impl AgentRuntime for OpenAiRuntime {
    fn kind(&self) -> &'static str {
        "openai-compat"
    }

    async fn start(&self, ctx: &AgentCtx<'_>) -> Result<Run> {
        let a = ctx.agent;
        let Some((provider, model)) = a.model.split_once('/') else {
            return Err(KalypsoError::Invalid(format!("{} needs a model as provider/model, for example ollama/llama3.1", a.name)));
        };
        let pid_file = pid_file(&a.id);
        let missing = format!(
            r#"{{"t":"error","text":"The sandbox image has no KALYPSO agent runner for other models. Use {RUNNER_IMAGE} (or an image built FROM it), and pull it again if it is older."}}"#
        );
        let wrapper =
            format!("echo $$ > {pid_file}; [ -f {OPENAI_RUNNER} ] || {{ echo '{missing}'; exit 64; }}; exec node {OPENAI_RUNNER}");
        let cmd = ["/bin/sh", "-c", wrapper.as_str()];
        let env = vec![
            format!("KALYPSO_AGENT={}", a.name),
            format!("KALYPSO_AGENT_ID={}", a.id),
            format!("KALYPSO_PROVIDER={provider}"),
            format!("KALYPSO_MODEL={model}"),
            format!("KALYPSO_ROLE={}", a.role),
            format!("KALYPSO_TASK={}", a.command),
            format!("KALYPSO_MAX_TURNS={}", a.max_turns),
        ];
        let (env, cwd) = with_repo(env, a);
        let (stream, handle) = ctx.provider.open_process(&a.ns, ctx.sandbox_id, &cmd, &cwd, &env).await?;
        Ok(Run { events: lines(stream.output).map(sdk_event).boxed(), input: stream.input, handle, pid_file })
    }

    fn encode(&self, message: &str) -> Vec<u8> {
        let mut b = serde_json::json!({ "type": "message", "text": message }).to_string().into_bytes();
        b.push(b'\n');
        b
    }

    fn counts_turns(&self) -> bool {
        true
    }
}

/// One runner line to a transcript event. Anything that is not a runner event (a stack
/// trace, a stray print) is kept as plain output.
fn sdk_event(e: Event) -> Event {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&e.text) else { return e };
    let text = v.get("text").and_then(|t| t.as_str()).unwrap_or_default().to_string();
    let kind = match v.get("t").and_then(|t| t.as_str()) {
        Some("text") => "text",
        Some("tool") => "tool",
        Some("output") => "output",
        Some("result") => "result",
        Some("policy") => "policy",
        Some("error") => "error",
        Some("ready") => "status",
        _ => return e,
    };
    Event { kind, text }
}

/// Split a byte stream into lines (UTF-8, lossy), keeping a partial last line until it ends.
fn lines(output: BoxStream<'static, std::io::Result<Vec<u8>>>) -> BoxStream<'static, Event> {
    const MAX_LINE: usize = 16 * 1024;
    futures_util::stream::unfold((output, Vec::<u8>::new(), false), |(mut out, mut buf, mut done)| async move {
        loop {
            if let Some(i) = buf.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = buf.drain(..=i).collect();
                let text = String::from_utf8_lossy(&line[..line.len() - 1]).trim_end_matches('\r').to_string();
                return Some((Event::output(text), (out, buf, done)));
            }
            if buf.len() >= MAX_LINE {
                let text = String::from_utf8_lossy(&buf).into_owned();
                buf.clear();
                return Some((Event::output(text), (out, buf, done)));
            }
            if done {
                if buf.is_empty() {
                    return None;
                }
                let text = String::from_utf8_lossy(&buf).trim_end_matches('\r').to_string();
                buf.clear();
                return Some((Event::output(text), (out, buf, done)));
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
        lines(s).map(|e| e.text).collect().await
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
        assert_eq!(for_kind("claude-sdk").unwrap().kind(), "claude-sdk");
        assert!(for_kind("claude-code").is_err());
        assert_eq!(for_kind("command").unwrap().kind(), "command");
    }
}

#[cfg(test)]
mod sdk_tests {
    use super::*;

    #[test]
    fn runner_lines_become_typed_events() {
        let ev = |l: &str| sdk_event(Event::output(l));
        assert_eq!(ev(r#"{"t":"tool","text":"Bash  ls"}"#), Event { kind: "tool", text: "Bash  ls".into() });
        assert_eq!(ev(r#"{"t":"ready","text":"claude-haiku-5-5"}"#).kind, "status");
        assert_eq!(ev("plain words"), Event::output("plain words"));
        assert_eq!(ev(r#"{"t":"nope"}"#).kind, "output");
        assert_eq!(ClaudeSdkRuntime.encode("hi\nthere"), b"{\"text\":\"hi\\nthere\",\"type\":\"message\"}\n".to_vec());
        assert!(ClaudeSdkRuntime.counts_turns() && !CommandRuntime.counts_turns());
    }
}

/// An agent linked to a repository (#100) works inside it: it starts there, knows which
/// repository and branch it's on, has KALYPSO's git helpers on its PATH, and git never stops
/// to ask for a password. Without a repository it starts in /work.
fn with_repo(mut env: Vec<String>, a: &AgentRecord) -> (Vec<String>, String) {
    let Some(repo) = a.repo.as_deref() else { return (env, "/work".into()) };
    let dir = crate::repo::dir(repo);
    env.push(format!("KALYPSO_REPO={repo}"));
    env.push(format!("KALYPSO_REPO_DIR={dir}"));
    if let Some(b) = &a.branch {
        env.push(format!("KALYPSO_BRANCH={b}"));
    }
    env.push(format!("PATH={}", crate::repo::AGENT_PATH));
    env.push("GIT_TERMINAL_PROMPT=0".into());
    (env, dir)
}
