//! Prompts, chat settings and memory: what an agent is told before it starts work.
//!
//! - **Prompts** are written once per namespace and assigned to any agents. A *persona* says who
//!   the agent is; an *instruction* says how it should work.
//! - **Chat settings** are the master agent's own: extra instructions, how it should reply,
//!   and whether it stops agents when their work is done.
//! - **Memory** is what the master agent knows across chats: notes you add, and ones it saves.
//!
//! [`compose`] puts the parts together for one agent; the runtimes add it to the agent's role.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{KalypsoError, Result};
use crate::store::Db;
use crate::vault::new_id;

const KINDS: &[&str] = &["instruction", "persona"];
const MAX_PROMPT: usize = 20_000;
const MAX_MEMORY: usize = 2_000;
/// The most memories the master is given; the newest win.
const MEMORY_IN_PROMPT: usize = 60;

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct Prompt {
    pub id: String,
    pub ns: String,
    pub name: String,
    /// "instruction" or "persona".
    pub kind: String,
    pub description: String,
    pub content: String,
    /// Agents it is assigned to.
    pub agents: Vec<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct PromptInput {
    /// Set to update an existing prompt; empty to create one.
    #[serde(default)]
    #[ts(optional)]
    pub id: Option<String>,
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub description: String,
    pub content: String,
    #[serde(default)]
    pub agents: Vec<String>,
}

fn assigned(db: &Db, prompt_id: &str) -> Result<Vec<String>> {
    db.with(|c| {
        let mut st = c.prepare("SELECT agent_id FROM agent_prompts WHERE prompt_id = ?1 ORDER BY agent_id")?;
        let rows = st.query_map([prompt_id], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(rows)
    })
}

pub fn list(db: &Db, ns: &str) -> Result<Vec<Prompt>> {
    let rows = db.with(|c| {
        let mut st =
            c.prepare("SELECT id, ns, name, kind, description, content, updated_at FROM prompts WHERE ns = ?1 ORDER BY kind DESC, name")?;
        let rows = st
            .query_map([ns], |r| {
                Ok(Prompt {
                    id: r.get(0)?,
                    ns: r.get(1)?,
                    name: r.get(2)?,
                    kind: r.get(3)?,
                    description: r.get(4)?,
                    content: r.get(5)?,
                    agents: vec![],
                    updated_at: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })?;
    rows.into_iter()
        .map(|mut p| {
            p.agents = assigned(db, &p.id)?;
            Ok(p)
        })
        .collect()
}

fn get(db: &Db, ns: &str, id: &str) -> Result<Prompt> {
    list(db, ns)?.into_iter().find(|p| p.id == id).ok_or_else(|| KalypsoError::NotFound(format!("prompt {id}")))
}

/// Create or update a prompt, and set exactly which agents have it.
pub fn save(db: &Db, ns: &str, input: PromptInput) -> Result<Prompt> {
    let name = input.name.trim().to_string();
    if name.is_empty() || name.len() > 80 {
        return Err(KalypsoError::Invalid("give the prompt a name of up to 80 characters".into()));
    }
    if !KINDS.contains(&input.kind.as_str()) {
        return Err(KalypsoError::Invalid(format!("a prompt is an instruction or a persona, not {}", input.kind)));
    }
    let content = input.content.trim().to_string();
    if content.is_empty() {
        return Err(KalypsoError::Invalid("the prompt is empty".into()));
    }
    if content.len() > MAX_PROMPT {
        return Err(KalypsoError::Invalid(format!("prompts are at most {MAX_PROMPT} characters")));
    }
    let agents = crate::agent::list(db, ns)?;
    for a in &input.agents {
        if !agents.iter().any(|x| &x.id == a) {
            return Err(KalypsoError::NotFound(format!("agent {a} in {ns}")));
        }
    }
    let description = input.description.trim().to_string();
    let id = match input.id.filter(|i| !i.is_empty()) {
        Some(id) => {
            get(db, ns, &id)?;
            id
        }
        None => new_id("pr"),
    };
    let saved = db.with(|c| {
        let tx = c.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO prompts (id, ns, name, kind, description, content) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET name = ?3, kind = ?4, description = ?5, content = ?6, updated_at = CURRENT_TIMESTAMP",
            rusqlite::params![id, ns, name, input.kind, description, content],
        )?;
        tx.execute("DELETE FROM agent_prompts WHERE prompt_id = ?1", [&id])?;
        for a in &input.agents {
            tx.execute("INSERT OR IGNORE INTO agent_prompts (agent_id, prompt_id) VALUES (?1, ?2)", (a, &id))?;
        }
        tx.commit()?;
        Ok(())
    });
    match saved {
        Err(KalypsoError::Db(rusqlite::Error::SqliteFailure(e, _))) if e.code == rusqlite::ErrorCode::ConstraintViolation => {
            return Err(KalypsoError::Conflict(format!("a prompt called {name}")));
        }
        r => r?,
    }
    db.audit(Some(ns), "user", "prompt.save", &name)?;
    get(db, ns, &id)
}

pub fn delete(db: &Db, ns: &str, id: &str) -> Result<()> {
    let p = get(db, ns, id)?;
    db.with(|c| Ok(c.execute("DELETE FROM prompts WHERE id = ?1 AND ns = ?2", (id, ns))?))?;
    db.audit(Some(ns), "user", "prompt.delete", &p.name)
}

// ---------- Chat settings ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(default)]
pub struct ChatSettings {
    /// Extra instructions for the master agent, in your words.
    pub instructions: String,
    /// "balanced", "concise" or "detailed".
    pub style: String,
    /// Stop agents once their work is done.
    pub stop_when_done: bool,
    /// Give the master agent its memory, and let it save new memories.
    pub memory: bool,
}

impl Default for ChatSettings {
    fn default() -> Self {
        Self { instructions: String::new(), style: "balanced".into(), stop_when_done: true, memory: true }
    }
}

fn settings_key(ns: &str) -> String {
    format!("chat.{ns}")
}

pub fn chat_settings(db: &Db, ns: &str) -> Result<ChatSettings> {
    Ok(db.setting(&settings_key(ns))?.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default())
}

pub fn set_chat_settings(db: &Db, ns: &str, s: ChatSettings) -> Result<ChatSettings> {
    if !["balanced", "concise", "detailed"].contains(&s.style.as_str()) {
        return Err(KalypsoError::Invalid(format!("unknown reply style {}", s.style)));
    }
    if s.instructions.len() > MAX_PROMPT {
        return Err(KalypsoError::Invalid(format!("instructions are at most {MAX_PROMPT} characters")));
    }
    let s = ChatSettings { instructions: s.instructions.trim().to_string(), ..s };
    db.set_setting(&settings_key(ns), &serde_json::to_value(&s).map_err(|e| KalypsoError::Invalid(e.to_string()))?)?;
    Ok(s)
}

// ---------- Memory ----------

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct Memory {
    pub id: String,
    pub text: String,
    /// "you", or the agent that saved it.
    pub source: String,
    pub created_at: String,
}

pub fn memories(db: &Db, ns: &str) -> Result<Vec<Memory>> {
    db.with(|c| {
        let mut st = c.prepare("SELECT id, text, source, created_at FROM memories WHERE ns = ?1 ORDER BY created_at DESC, rowid DESC")?;
        let rows = st
            .query_map([ns], |r| Ok(Memory { id: r.get(0)?, text: r.get(1)?, source: r.get(2)?, created_at: r.get(3)? }))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

pub fn remember(db: &Db, ns: &str, text: &str, source: &str) -> Result<Memory> {
    let text = text.trim();
    if text.is_empty() {
        return Err(KalypsoError::Invalid("the memory is empty".into()));
    }
    if text.len() > MAX_MEMORY {
        return Err(KalypsoError::Invalid(format!("a memory is at most {MAX_MEMORY} characters; keep it to one fact")));
    }
    let id = new_id("me");
    db.with(|c| Ok(c.execute("INSERT INTO memories (id, ns, text, source) VALUES (?1, ?2, ?3, ?4)", (&id, ns, text, source))?))?;
    db.audit(Some(ns), source, "memory.add", &text.chars().take(60).collect::<String>())?;
    memories(db, ns)?.into_iter().find(|m| m.id == id).ok_or_else(|| KalypsoError::NotFound(id))
}

pub fn edit_memory(db: &Db, ns: &str, id: &str, text: &str) -> Result<()> {
    let text = text.trim();
    if text.is_empty() || text.len() > MAX_MEMORY {
        return Err(KalypsoError::Invalid(format!("a memory is 1 to {MAX_MEMORY} characters")));
    }
    let n = db.with(|c| Ok(c.execute("UPDATE memories SET text = ?1 WHERE id = ?2 AND ns = ?3", (text, id, ns))?))?;
    if n == 0 {
        return Err(KalypsoError::NotFound(format!("memory {id}")));
    }
    Ok(())
}

pub fn forget(db: &Db, ns: &str, id: &str) -> Result<()> {
    let n = db.with(|c| Ok(c.execute("DELETE FROM memories WHERE id = ?1 AND ns = ?2", (id, ns))?))?;
    if n == 0 {
        return Err(KalypsoError::NotFound(format!("memory {id}")));
    }
    db.audit(Some(ns), "user", "memory.delete", id)
}

// ---------- Putting it together ----------

/// What an agent is told on top of its role: its persona, its instructions, and for the master
/// agent its chat settings and memory. Empty when there is nothing to add.
pub fn compose(db: &Db, agent: &crate::agent::AgentRecord) -> Result<String> {
    let mine: Vec<Prompt> = list(db, &agent.ns)?.into_iter().filter(|p| p.agents.contains(&agent.id)).collect();
    let mut parts: Vec<String> = Vec::new();
    for p in mine.iter().filter(|p| p.kind == "persona") {
        parts.push(format!("Persona ({}):\n{}", p.name, p.content));
    }
    for p in mine.iter().filter(|p| p.kind == "instruction") {
        parts.push(format!("Instructions ({}):\n{}", p.name, p.content));
    }
    if agent.master {
        let s = chat_settings(db, &agent.ns)?;
        if !s.instructions.is_empty() {
            parts.push(format!("The user's instructions for you:\n{}", s.instructions));
        }
        let style = match s.style.as_str() {
            "concise" => Some("Keep replies short: the result and what the user needs to do, nothing more."),
            "detailed" => Some("Give full replies: what each agent did, why, and anything worth checking."),
            _ => None,
        };
        if let Some(style) = style {
            parts.push(style.to_string());
        }
        parts.push(if s.stop_when_done {
            "Stop each agent once its work is done.".to_string()
        } else {
            "Leave agents running when their work is done, unless the user asks you to stop them.".to_string()
        });
        if s.memory {
            let mem = memories(db, &agent.ns)?;
            let notes: Vec<String> = mem.iter().take(MEMORY_IN_PROMPT).map(|m| format!("- {}", m.text)).collect();
            let mut block = String::from(
                "Memory: you can save a lasting fact about the user, their projects or how they like to work with: kx-agent remember \"...\" (one short fact; only what will still matter next time).",
            );
            if !notes.is_empty() {
                block.push_str("\nWhat you remember:\n");
                block.push_str(&notes.join("\n"));
            }
            parts.push(block);
        }
    }
    Ok(parts.join("\n\n"))
}

/// Whether the master agent may save memories now.
pub fn memory_on(db: &Db, ns: &str) -> Result<bool> {
    Ok(chat_settings(db, ns)?.memory)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (Db, crate::agent::AgentRecord, crate::agent::AgentRecord) {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| Ok(c.execute_batch("INSERT INTO namespaces (id, name) VALUES ('work','work');")?)).unwrap();
        let new = |name: &str| crate::agent::NewAgent {
            name: name.into(),
            role: Some("r".into()),
            runtime: "command".into(),
            model: None,
            sandbox_id: None,
            command: Some("true".into()),
            max_turns: None,
            restart: None,
            max_restarts: None,
            repo: None,
            repo_account: None,
        };
        let worker = crate::agent::create(&db, "work", new("scout")).unwrap();
        let master = crate::agent::create(&db, "work", new("kalypso")).unwrap();
        db.with(|c| Ok(c.execute("UPDATE agents SET master = 1 WHERE id = ?1", [&master.id])?)).unwrap();
        let master = crate::agent::get(&db, "work", &master.id).unwrap();
        (db, worker, master)
    }

    #[test]
    fn assigned_prompts_reach_only_their_agents_persona_first() {
        let (db, worker, master) = setup();
        let p = |name: &str, kind: &str, content: &str, agents: Vec<String>| PromptInput {
            id: None,
            name: name.into(),
            kind: kind.into(),
            description: String::new(),
            content: content.into(),
            agents,
        };
        save(&db, "work", p("tests first", "instruction", "Write a failing test before fixing.", vec![worker.id.clone()])).unwrap();
        save(&db, "work", p("reviewer", "persona", "You are a careful senior reviewer.", vec![worker.id.clone()])).unwrap();
        save(&db, "work", p("unused", "instruction", "Never shown.", vec![])).unwrap();
        let text = compose(&db, &worker).unwrap();
        assert!(text.starts_with("Persona (reviewer):"), "{text}");
        assert!(text.contains("Write a failing test"));
        assert!(!text.contains("Never shown"));
        assert!(!compose(&db, &master).unwrap().contains("failing test"));
        // Names are unique, kinds checked, agents must exist.
        assert!(matches!(save(&db, "work", p("reviewer", "persona", "x", vec![])), Err(KalypsoError::Conflict(_))));
        assert!(save(&db, "work", p("x", "mood", "x", vec![])).is_err());
        assert!(save(&db, "work", p("y", "persona", "x", vec!["ag-nope".into()])).is_err());
        // Updating replaces the assignment.
        let mut all = list(&db, "work").unwrap();
        let tf = all.iter_mut().find(|x| x.name == "tests first").unwrap();
        save(
            &db,
            "work",
            PromptInput {
                id: Some(tf.id.clone()),
                name: tf.name.clone(),
                kind: tf.kind.clone(),
                description: String::new(),
                content: tf.content.clone(),
                agents: vec![],
            },
        )
        .unwrap();
        assert!(!compose(&db, &worker).unwrap().contains("failing test"));
    }

    #[test]
    fn the_master_gets_its_settings_and_memory() {
        let (db, worker, master) = setup();
        set_chat_settings(
            &db,
            "work",
            ChatSettings { instructions: "Answer in French.".into(), style: "concise".into(), stop_when_done: false, memory: true },
        )
        .unwrap();
        remember(&db, "work", "The main repo is acme/platform", "you").unwrap();
        remember(&db, "work", "Prefers Podman", "kalypso").unwrap();
        let text = compose(&db, &master).unwrap();
        assert!(text.contains("Answer in French."));
        assert!(text.contains("Keep replies short"));
        assert!(text.contains("Leave agents running"));
        assert!(text.contains("- The main repo is acme/platform") && text.contains("- Prefers Podman"));
        // Workers never see the master's settings or memory.
        assert_eq!(compose(&db, &worker).unwrap(), "");
        // Memory off: none of it is given.
        set_chat_settings(&db, "work", ChatSettings { memory: false, ..chat_settings(&db, "work").unwrap() }).unwrap();
        assert!(!compose(&db, &master).unwrap().contains("acme/platform"));
        assert!(set_chat_settings(&db, "work", ChatSettings { style: "loud".into(), ..Default::default() }).is_err());
        let id = memories(&db, "work").unwrap()[0].id.clone();
        forget(&db, "work", &id).unwrap();
        assert_eq!(memories(&db, "work").unwrap().len(), 1);
    }
}
