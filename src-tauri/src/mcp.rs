//! MCP servers (#25): tools for agents, per namespace.
//!
//! A server is either a command the agent's runner starts inside its sandbox (stdio), or a URL
//! it calls (http or sse; reached through the namespace network or, for `internet` sandboxes,
//! the egress proxy). Each one goes to every agent, to chosen agents, or to kalypso only, and
//! can be switched off. Every tool call it serves is checked against the namespace's rules like
//! any other (`kind: "mcp"`).
//!
//! Environment variables and headers can take their value from one of the agent's delivered
//! secrets (`{"secret": "NAME"}`): the runner reads it from the sandbox when it starts, so the
//! value never passes through this table or the agent's prompt.

use std::collections::BTreeMap;

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ts_rs::TS;

use crate::agent::AgentRecord;
use crate::error::{KalypsoError, Result};
use crate::store::Db;

const TRANSPORTS: &[&str] = &["stdio", "http", "sse"];
const SCOPES: &[&str] = &["all", "chosen", "master"];

/// An environment variable or header: a fixed value, or one of the agent's secrets by name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(untagged)]
#[ts(export)]
pub enum McpValue {
    Secret { secret: String },
    Text(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct McpServer {
    pub id: String,
    pub ns: String,
    pub name: String,
    /// "stdio", "http" or "sse".
    pub transport: String,
    pub command: String,
    pub args: Vec<String>,
    pub url: String,
    /// Environment (stdio) or headers (http, sse).
    pub env: BTreeMap<String, McpValue>,
    /// "all", "chosen" or "master".
    pub scope: String,
    /// The agents it goes to when the scope is "chosen".
    pub agents: Vec<String>,
    pub enabled: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct McpInput {
    /// Set to change an existing server; absent to add one.
    #[serde(default)]
    #[ts(optional)]
    pub id: Option<String>,
    pub name: String,
    pub transport: String,
    #[serde(default)]
    #[ts(optional)]
    pub command: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    #[ts(optional)]
    pub url: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub env: Option<BTreeMap<String, McpValue>>,
    #[serde(default)]
    #[ts(optional)]
    pub scope: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub agents: Option<Vec<String>>,
    #[serde(default)]
    #[ts(optional)]
    pub enabled: Option<bool>,
}

const COLS: &str = "id, ns, name, transport, command, args, url, env, scope, enabled, created_at,
     (SELECT group_concat(agent_id) FROM mcp_agents WHERE server_id = mcp_servers.id)";

fn row(r: &rusqlite::Row) -> rusqlite::Result<McpServer> {
    let args: String = r.get(5)?;
    let env: String = r.get(7)?;
    Ok(McpServer {
        id: r.get(0)?,
        ns: r.get(1)?,
        name: r.get(2)?,
        transport: r.get(3)?,
        command: r.get(4)?,
        args: serde_json::from_str(&args).unwrap_or_default(),
        url: r.get(6)?,
        env: serde_json::from_str(&env).unwrap_or_default(),
        scope: r.get(8)?,
        enabled: r.get::<_, i64>(9)? != 0,
        created_at: r.get(10)?,
        agents: r.get::<_, Option<String>>(11)?.map(|s| s.split(',').map(str::to_string).collect()).unwrap_or_default(),
    })
}

pub fn list(db: &Db, ns: &str) -> Result<Vec<McpServer>> {
    db.with(|c| {
        let mut st = c.prepare(&format!("SELECT {COLS} FROM mcp_servers WHERE ns = ?1 ORDER BY name"))?;
        let rows = st.query_map([ns], row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

pub fn get(db: &Db, ns: &str, id: &str) -> Result<McpServer> {
    db.with(|c| Ok(c.query_row(&format!("SELECT {COLS} FROM mcp_servers WHERE ns = ?1 AND id = ?2"), [ns, id], row).optional()?))?
        .ok_or_else(|| KalypsoError::NotFound(format!("MCP server {id}")))
}

/// Names become the tools' prefix (`mcp__<name>__tool`): short, lowercase, no spaces.
fn check_name(name: &str) -> Result<()> {
    let ok = !name.is_empty()
        && name.len() <= 40
        && name.chars().next().is_some_and(|c| c.is_ascii_lowercase())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(KalypsoError::Invalid(
            "name the server with lowercase letters, digits, - and _, starting with a letter, for example github".into(),
        ))
    }
}

/// Add a server, or change one.
pub fn save(db: &Db, ns: &str, input: McpInput) -> Result<McpServer> {
    let name = input.name.trim().to_string();
    check_name(&name)?;
    if !TRANSPORTS.contains(&input.transport.as_str()) {
        return Err(KalypsoError::Invalid("the transport is stdio (a command), http or sse (a URL)".into()));
    }
    let command = input.command.unwrap_or_default().trim().to_string();
    let args: Vec<String> = input.args.unwrap_or_default().into_iter().map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).collect();
    let url = input.url.unwrap_or_default().trim().to_string();
    if input.transport == "stdio" {
        if command.is_empty() {
            return Err(KalypsoError::Invalid("say which command starts the server, for example npx".into()));
        }
    } else if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(KalypsoError::Invalid("the server's URL must start with http:// or https://".into()));
    }
    let env = input.env.unwrap_or_default();
    for (k, v) in &env {
        let key_ok = !k.is_empty() && k.len() <= 100 && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        if !key_ok {
            return Err(KalypsoError::Invalid(format!("{k:?} isn't a valid variable or header name")));
        }
        if let McpValue::Secret { secret } = v {
            if secret.is_empty() || !secret.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_') {
                return Err(KalypsoError::Invalid(format!("{secret:?} isn't a secret name")));
            }
        }
    }
    let scope = input.scope.unwrap_or_else(|| "all".into());
    if !SCOPES.contains(&scope.as_str()) {
        return Err(KalypsoError::Invalid("who gets it: all agents, chosen agents, or kalypso only".into()));
    }
    let agents = input.agents.unwrap_or_default();
    let ns_agents: Vec<String> = crate::agent::list(db, ns)?.into_iter().map(|a| a.id).collect();
    if let Some(bad) = agents.iter().find(|a| !ns_agents.contains(a)) {
        return Err(KalypsoError::Invalid(format!("agent {bad} isn't in {ns}")));
    }
    let id = match &input.id {
        Some(id) => get(db, ns, id)?.id,
        None => crate::vault::new_id("mcp"),
    };
    let args_json = serde_json::to_string(&args).unwrap_or_else(|_| "[]".into());
    let env_json = serde_json::to_string(&env).unwrap_or_else(|_| "{}".into());
    let enabled = input.enabled.unwrap_or(true);
    let written = db.with(|c| {
        c.execute(
            "INSERT INTO mcp_servers (id, ns, name, transport, command, args, url, env, scope, enabled)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name, transport = excluded.transport, command = excluded.command,
               args = excluded.args, url = excluded.url, env = excluded.env, scope = excluded.scope, enabled = excluded.enabled",
            rusqlite::params![id, ns, name, input.transport, command, args_json, url, env_json, scope, enabled],
        )?;
        c.execute("DELETE FROM mcp_agents WHERE server_id = ?1", [&id])?;
        if scope == "chosen" {
            for a in &agents {
                c.execute("INSERT OR IGNORE INTO mcp_agents (server_id, agent_id) VALUES (?1, ?2)", (&id, a))?;
            }
        }
        Ok(())
    });
    match written {
        Err(KalypsoError::Db(rusqlite::Error::SqliteFailure(e, _))) if e.code == rusqlite::ErrorCode::ConstraintViolation => {
            return Err(KalypsoError::Conflict(format!("MCP server {name} in {ns}")));
        }
        r => r?,
    }
    db.audit(Some(ns), "user", if input.id.is_some() { "mcp.update" } else { "mcp.create" }, &name)?;
    get(db, ns, &id)
}

pub fn delete(db: &Db, ns: &str, id: &str) -> Result<()> {
    let s = get(db, ns, id)?;
    db.with(|c| Ok(c.execute("DELETE FROM mcp_servers WHERE id = ?1", [id])?))?;
    db.audit(Some(ns), "user", "mcp.delete", &s.name)
}

/// The servers an agent gets: enabled, and meant for it.
pub fn for_agent(db: &Db, a: &AgentRecord) -> Result<Vec<McpServer>> {
    Ok(list(db, &a.ns)?
        .into_iter()
        .filter(|s| s.enabled)
        .filter(|s| match s.scope.as_str() {
            "all" => true,
            "master" => a.master,
            _ => s.agents.contains(&a.id),
        })
        .collect())
}

/// The agent's MCP config, as the runner hands it to the SDK (`mcpServers`). Secret references
/// stay references (`{"secret": "NAME"}`); the runner resolves them inside the sandbox.
pub fn config_for(db: &Db, a: &AgentRecord) -> Result<Value> {
    let mut out = serde_json::Map::new();
    for s in for_agent(db, a)? {
        let vars: serde_json::Map<String, Value> =
            s.env.iter().map(|(k, v)| (k.clone(), serde_json::to_value(v).unwrap_or(Value::Null))).collect();
        let entry = if s.transport == "stdio" {
            json!({ "type": "stdio", "command": s.command, "args": s.args, "env": vars })
        } else {
            json!({ "type": s.transport, "url": s.url, "headers": vars })
        };
        out.insert(s.name, entry);
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{self, NewAgent};

    fn db() -> Db {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| Ok(c.execute_batch("INSERT INTO namespaces (id, name) VALUES ('work','work'), ('lab','lab');")?)).unwrap();
        db
    }

    fn new_agent(db: &Db, name: &str) -> AgentRecord {
        let n = NewAgent {
            name: name.into(),
            role: None,
            runtime: "claude-sdk".into(),
            model: Some("claude-sonnet-5-5".into()),
            sandbox_id: None,
            command: None,
            max_turns: None,
            restart: None,
            max_restarts: None,
            repo: None,
            repo_account: None,
            effort: None,
        };
        agent::create(db, "work", n).unwrap()
    }

    fn input(name: &str) -> McpInput {
        McpInput {
            id: None,
            name: name.into(),
            transport: "stdio".into(),
            command: Some("npx".into()),
            args: Some(vec!["-y".into(), "@modelcontextprotocol/server-github".into()]),
            url: None,
            env: Some(BTreeMap::from([
                ("GITHUB_PERSONAL_ACCESS_TOKEN".into(), McpValue::Secret { secret: "GITHUB_TOKEN".into() }),
                ("LOG_LEVEL".into(), McpValue::Text("warn".into())),
            ])),
            scope: None,
            agents: None,
            enabled: None,
        }
    }

    #[test]
    fn servers_are_checked_and_saved() {
        let db = db();
        let s = save(&db, "work", input("github")).unwrap();
        assert_eq!((s.transport.as_str(), s.scope.as_str(), s.enabled), ("stdio", "all", true));
        assert_eq!(s.env["GITHUB_PERSONAL_ACCESS_TOKEN"], McpValue::Secret { secret: "GITHUB_TOKEN".into() });

        let bad = |f: &dyn Fn(&mut McpInput)| {
            let mut i = input("other");
            f(&mut i);
            save(&db, "work", i).unwrap_err().to_string()
        };
        assert!(bad(&|i| i.name = "GitHub Tools".into()).contains("lowercase"));
        assert!(bad(&|i| i.command = None).contains("command"));
        assert!(bad(&|i| {
            i.transport = "http".into();
            i.url = Some("ftp://x".into())
        })
        .contains("http://"));
        assert!(bad(&|i| i.env = Some(BTreeMap::from([("X".into(), McpValue::Secret { secret: "lower".into() })]))).contains("secret name"));
        assert_eq!(save(&db, "work", input("github")).unwrap_err().code(), "conflict");
        assert!(list(&db, "lab").unwrap().is_empty(), "namespaces don't share servers");
    }

    #[test]
    fn each_agent_gets_the_servers_meant_for_it() {
        let db = db();
        let coder = new_agent(&db, "coder");
        let writer = new_agent(&db, "writer");
        let master = new_agent(&db, "kalypso");
        db.with(|c| Ok(c.execute("UPDATE agents SET master = 1 WHERE id = ?1", [&master.id])?)).unwrap();
        let master = agent::get(&db, "work", &master.id).unwrap();

        save(&db, "work", input("github")).unwrap();
        let mut docs = input("docs");
        docs.transport = "http".into();
        docs.url = Some("https://docs.example.com/mcp".into());
        docs.scope = Some("chosen".into());
        docs.agents = Some(vec![writer.id.clone()]);
        save(&db, "work", docs).unwrap();
        let mut admin = input("admin");
        admin.scope = Some("master".into());
        let admin = save(&db, "work", admin).unwrap();

        let names = |a: &AgentRecord| for_agent(&db, a).unwrap().into_iter().map(|s| s.name).collect::<Vec<_>>();
        assert_eq!(names(&coder), ["github"]);
        assert_eq!(names(&writer), ["docs", "github"]);
        assert_eq!(names(&master), ["admin", "github"]);

        // The acceptance criterion: switching a server off takes it away from every agent.
        let mut off = input("admin");
        off.id = Some(admin.id.clone());
        off.scope = Some("master".into());
        off.enabled = Some(false);
        save(&db, "work", off).unwrap();
        assert_eq!(names(&master), ["github"]);

        let cfg = config_for(&db, &writer).unwrap();
        assert_eq!(cfg["docs"]["type"], "http");
        assert_eq!(cfg["docs"]["url"], "https://docs.example.com/mcp");
        assert_eq!(cfg["github"]["command"], "npx");
        assert_eq!(cfg["github"]["env"]["GITHUB_PERSONAL_ACCESS_TOKEN"], json!({ "secret": "GITHUB_TOKEN" }), "references, never values");
    }
}
