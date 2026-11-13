//! The master agent: the one you talk to in Chat. It is an ordinary agent in its own sandbox,
//! with one extra ability: it manages the namespace's other agents through KALYPSO (create,
//! start, message, wait, stop, delete) with the `kx-agent` command, served by the gateway
//! (`gateway::agents`). There is at most one per namespace, created the first time you chat.

use super::{AgentRecord, NewAgent};
use crate::error::{KalypsoError, Result};
use crate::sandbox::{self, NewSandbox, Runtime};
use crate::store::Db;

/// The master agent's name, and its sandbox's.
pub const NAME: &str = "kalypso";
/// A coordinator needs judgment more than speed; change it on the agent's page.
pub const MODEL: &str = "claude-sonnet-5-5";
/// How many agents a master may have at once, so a confused plan can't spawn without end.
pub const MAX_WORKERS: usize = 8;

/// `kx-agent`, installed into the master's sandbox at each start so it always matches this
/// version of KALYPSO, whatever the sandbox image carries.
pub const CLI: &str = include_str!("../../../runner/agent-sdk/kx-agent.mjs");
const BIN: &str = "/work/.kalypso/bin";

/// The namespace's master agent, if it has one.
pub fn get(db: &Db, ns: &str) -> Result<Option<AgentRecord>> {
    Ok(super::list(db, ns)?.into_iter().find(|a| a.master))
}

/// The namespace's master agent, created with its sandbox if it doesn't exist yet.
pub async fn ensure(db: &Db, rt: &Runtime, ns: &str) -> Result<AgentRecord> {
    if let Some(m) = get(db, ns)? {
        return Ok(m);
    }
    let sandbox_id = sandbox_named(db, rt, ns, NAME).await?;
    let created = super::create(
        db,
        ns,
        NewAgent {
            name: NAME.into(),
            role: Some("Plans the work, hands it to your agents and reports back".into()),
            runtime: "claude-sdk".into(),
            model: Some(MODEL.into()),
            sandbox_id: Some(sandbox_id),
            command: None,
            max_turns: None,
            restart: Some("on-failure".into()),
            max_restarts: None,
            repo: None,
            repo_account: None,
        },
    );
    let agent = match created {
        Ok(a) => a,
        // Two windows asked at once: the other one made it.
        Err(KalypsoError::Conflict(_)) => {
            return get(db, ns)?.ok_or_else(|| {
                KalypsoError::Conflict(format!(
                    "an agent called {NAME} already exists in {ns}; rename it to let KALYPSO create its master agent"
                ))
            })
        }
        Err(e) => return Err(e),
    };
    db.with(|c| Ok(c.execute("UPDATE agents SET master = 1 WHERE id = ?1", [&agent.id])?))?;
    super::get(db, ns, &agent.id)
}

/// The id of the sandbox called `name`, created from the agent runner image if there is none.
pub async fn sandbox_named(db: &Db, rt: &Runtime, ns: &str, name: &str) -> Result<String> {
    if let Some(sb) = sandbox::list(db, ns)?.into_iter().find(|s| s.name == name) {
        return Ok(sb.id);
    }
    let spec = NewSandbox {
        name: name.into(),
        image: super::runtime::RUNNER_IMAGE.into(),
        cpu: 2.0,
        mem_mb: 2048,
        network: "namespace".into(),
        provider: None,
    };
    Ok(sandbox::create(db, rt, ns, spec).await?.id)
}

/// Start a new conversation with the master agent: stop it and forget its saved session, so
/// its next message starts fresh. Its earlier transcript stays in KALYPSO.
pub async fn new_chat(db: &Db, rt: &Runtime, sup: &super::supervisor::Supervisor, ns: &str) -> Result<Option<AgentRecord>> {
    let Some(m) = get(db, ns)? else { return Ok(None) };
    sup.stop(ns, &m.id, "new chat").await?;
    if let Some(sb) = &m.sandbox_id {
        if sandbox::get(db, ns, sb)?.status == "running" {
            let dir = format!("/work/.kalypso/agents/{}", m.id);
            let files = [format!("{dir}/session"), format!("{dir}/openai-messages.json")];
            let mut cmd = vec!["rm", "-f"];
            cmd.extend(files.iter().map(String::as_str));
            sandbox::exec(rt, ns, sb, &cmd, false).await?;
        }
    }
    Ok(Some(super::get(db, ns, &m.id)?))
}

/// What the master is told about its job, added to its role when it starts.
pub fn instructions(ns: &str) -> String {
    format!(
        r#"You are KALYPSO's master agent for the "{ns}" namespace: the one the user talks to. Your job is to understand what they want, get it done through the namespace's other agents, and report back in plain words.

Each agent runs in its own sandbox with its own files, so agents work in parallel and cannot see your workspace or this conversation. You manage them with the kx-agent command (run it with your shell tool):

  kx-agent list                                   who exists, and what each is doing
  kx-agent create NAME --role "what it does" [--model M] [--repo owner/name] [--task "first task"]
  kx-agent send NAME "message" [--wait SECONDS]   starts it if needed, sends the message, and returns its answer
  kx-agent wait NAME [--timeout SECONDS]          wait for work that is still running
  kx-agent log NAME                               what it said and did most recently
  kx-agent stop NAME | start NAME | delete NAME

How to work:
- Answer simple questions yourself. Use agents for real work: code changes, research, anything long or that benefits from running in parallel.
- Run kx-agent list first and reuse an agent that fits before creating a new one. Give a new agent a short lowercase name and a role that says what it is for.
- An agent only knows what you send it. Write each task so it stands on its own: the goal, where the work is (repository, paths), what done looks like, and what to send back.
- For work in a GitHub repository, pass --repo owner/name when creating the agent; it works on its own branch and can open a pull request.
- To run several agents at once, send each its task with --wait 0, then use kx-agent wait on each.
- Check what comes back before you report it. If an agent failed, was blocked by a policy or ran out of budget, say so and say what you tried.
- Stop agents whose work is finished. Delete an agent only when the user asks.
- You can have up to {max} agents. Tell the user which agents did what, so they can open those conversations."#,
        max = MAX_WORKERS
    )
}

/// Shell that installs `kx-agent` before the master's runner starts, and the variable it reads.
pub fn install(env: &mut Vec<String>) -> String {
    env.push(format!("KX_AGENT_SRC={CLI}"));
    format!("mkdir -p {BIN} && printf '%s' \"$KX_AGENT_SRC\" > {BIN}/kx-agent && chmod 755 {BIN}/kx-agent; unset KX_AGENT_SRC; export PATH={BIN}:$PATH; ")
}
