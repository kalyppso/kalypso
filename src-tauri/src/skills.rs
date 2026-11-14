//! Skills (#24): a `SKILL.md` (instructions, and when to use them) that agents can pick up.
//!
//! Skills are kept per namespace and go to every agent, chosen agents, or kalypso only. At each
//! start the supervisor passes an agent its skills (`KALYPSO_SKILLS`); the Claude runner writes
//! them where the SDK discovers skills and enables exactly those, and the OpenAI-compatible runner
//! lists them in its instructions with a path to open them. A skill's files are readable by the
//! agent, so they must never hold secrets.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use rusqlite::OptionalExtension;

use crate::agent::AgentRecord;
use crate::error::{KalypsoError, Result};
use crate::store::Db;

const SCOPES: &[&str] = &["all", "chosen", "master"];
/// The largest SKILL.md, and the most an agent is handed in all.
const MAX_SKILL: usize = 100 * 1024;
const MAX_PER_AGENT: usize = 512 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct Skill {
    pub id: String,
    pub ns: String,
    pub name: String,
    /// When to use it, from the SKILL.md front matter or typed in.
    pub description: String,
    /// The SKILL.md.
    pub content: String,
    /// Where it came from: a URL, a file name, or empty.
    pub source: String,
    /// "all", "chosen" or "master".
    pub scope: String,
    pub agents: Vec<String>,
    pub enabled: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct SkillInput {
    #[serde(default)]
    #[ts(optional)]
    pub id: Option<String>,
    /// Absent: taken from the SKILL.md front matter (`name:`).
    #[serde(default)]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub description: Option<String>,
    pub content: String,
    #[serde(default)]
    #[ts(optional)]
    pub source: Option<String>,
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

/// `name:` and `description:` from a SKILL.md's front matter (`---` … `---`), if present.
pub fn front_matter(content: &str) -> (Option<String>, Option<String>) {
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let (mut name, mut description) = (None, None);
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            let v = v.trim().trim_matches('"').trim_matches('\'').to_string();
            match k.trim() {
                "name" if !v.is_empty() => name = Some(v),
                "description" if !v.is_empty() => description = Some(v),
                _ => {}
            }
        }
    }
    (name, description)
}

const COLS: &str = "id, ns, name, description, content, source, scope, enabled, updated_at,
     (SELECT group_concat(agent_id) FROM agent_skills WHERE skill_id = skills.id)";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Skill> {
    Ok(Skill {
        id: r.get(0)?,
        ns: r.get(1)?,
        name: r.get(2)?,
        description: r.get(3)?,
        content: r.get(4)?,
        source: r.get(5)?,
        scope: r.get(6)?,
        enabled: r.get::<_, i64>(7)? != 0,
        updated_at: r.get(8)?,
        agents: r.get::<_, Option<String>>(9)?.map(|s| s.split(',').map(str::to_string).collect()).unwrap_or_default(),
    })
}

pub fn list(db: &Db, ns: &str) -> Result<Vec<Skill>> {
    db.with(|c| {
        let mut st = c.prepare(&format!("SELECT {COLS} FROM skills WHERE ns = ?1 ORDER BY name"))?;
        let rows = st.query_map([ns], row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

pub fn get(db: &Db, ns: &str, id: &str) -> Result<Skill> {
    db.with(|c| Ok(c.query_row(&format!("SELECT {COLS} FROM skills WHERE ns = ?1 AND id = ?2"), [ns, id], row).optional()?))?
        .ok_or_else(|| KalypsoError::NotFound(format!("skill {id}")))
}

/// Skill names are folder names: lowercase letters, digits and dashes.
fn check_name(name: &str) -> Result<()> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(())
    } else {
        Err(KalypsoError::Invalid("name the skill with lowercase letters, digits and dashes, like release-notes".into()))
    }
}

pub fn save(db: &Db, ns: &str, input: SkillInput) -> Result<Skill> {
    let content = input.content.replace("\r\n", "\n");
    if content.trim().is_empty() {
        return Err(KalypsoError::Invalid("paste or upload the skill's SKILL.md".into()));
    }
    if content.len() > MAX_SKILL {
        return Err(KalypsoError::Invalid(format!("a SKILL.md can be up to {} KB", MAX_SKILL / 1024)));
    }
    let (fm_name, fm_desc) = front_matter(&content);
    let name = input.name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).or(fm_name).unwrap_or_default();
    check_name(&name)?;
    let description = input.description.map(|d| d.trim().to_string()).filter(|d| !d.is_empty()).or(fm_desc).unwrap_or_default();
    if description.is_empty() {
        return Err(KalypsoError::Invalid(
            "say when the skill should be used (its description), so agents know when to reach for it".into(),
        ));
    }
    let scope = input.scope.unwrap_or_else(|| "chosen".into());
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
        None => crate::vault::new_id("skill"),
    };
    let written = db.with(|c| {
        c.execute(
            "INSERT INTO skills (id, ns, name, description, content, source, scope, enabled) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description, content = excluded.content,
               source = excluded.source, scope = excluded.scope, enabled = excluded.enabled, updated_at = CURRENT_TIMESTAMP",
            rusqlite::params![id, ns, name, description, content, input.source.unwrap_or_default(), scope, input.enabled.unwrap_or(true)],
        )?;
        c.execute("DELETE FROM agent_skills WHERE skill_id = ?1", [&id])?;
        if scope == "chosen" {
            for a in &agents {
                c.execute("INSERT OR IGNORE INTO agent_skills (skill_id, agent_id) VALUES (?1, ?2)", (&id, a))?;
            }
        }
        Ok(())
    });
    match written {
        Err(KalypsoError::Db(rusqlite::Error::SqliteFailure(e, _))) if e.code == rusqlite::ErrorCode::ConstraintViolation => {
            return Err(KalypsoError::Conflict(format!("skill {name} in {ns}")));
        }
        r => r?,
    }
    db.audit(Some(ns), "user", if input.id.is_some() { "skill.update" } else { "skill.create" }, &name)?;
    get(db, ns, &id)
}

pub fn delete(db: &Db, ns: &str, id: &str) -> Result<()> {
    let s = get(db, ns, id)?;
    db.with(|c| Ok(c.execute("DELETE FROM skills WHERE id = ?1", [id])?))?;
    db.audit(Some(ns), "user", "skill.delete", &s.name)
}

/// Give one agent a skill, or take it away, without touching anyone else's.
pub fn assign(db: &Db, ns: &str, id: &str, agent_id: &str, on: bool) -> Result<Skill> {
    let s = get(db, ns, id)?;
    crate::agent::get(db, ns, agent_id)?;
    if s.scope != "chosen" {
        return Err(KalypsoError::Invalid(format!(
            "{} goes to {}; change who gets it in Toolkit",
            s.name,
            if s.scope == "all" { "every agent" } else { "kalypso only" }
        )));
    }
    db.with(|c| {
        if on {
            c.execute("INSERT OR IGNORE INTO agent_skills (skill_id, agent_id) VALUES (?1, ?2)", (id, agent_id))?;
        } else {
            c.execute("DELETE FROM agent_skills WHERE skill_id = ?1 AND agent_id = ?2", (id, agent_id))?;
        }
        Ok(())
    })?;
    get(db, ns, id)
}

/// The skills an agent gets: enabled, and meant for it.
pub fn for_agent(db: &Db, a: &AgentRecord) -> Result<Vec<Skill>> {
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

/// What the runner receives: `[{"name", "description", "content"}]`, within the per-agent size cap.
pub fn bundle_for(db: &Db, a: &AgentRecord) -> Result<String> {
    let mut total = 0;
    let mut out = Vec::new();
    for s in for_agent(db, a)? {
        total += s.content.len();
        if total > MAX_PER_AGENT {
            tracing::warn!(agent = %a.name, skill = %s.name, "skills past the size cap are left out");
            break;
        }
        out.push(serde_json::json!({ "name": s.name, "description": s.description, "content": s.content }));
    }
    Ok(serde_json::Value::Array(out).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{self, NewAgent};

    const SKILL: &str = "---\nname: release-notes\ndescription: Write release notes from merged pull requests\n---\n\n# Release notes\n\n1. List merged PRs.\n";

    fn db() -> Db {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| Ok(c.execute_batch("INSERT INTO namespaces (id, name) VALUES ('work','work');")?)).unwrap();
        db
    }

    fn agent(db: &Db, name: &str) -> AgentRecord {
        let n = NewAgent {
            name: name.into(),
            role: None,
            runtime: "claude-sdk".into(),
            model: None,
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

    fn input(content: &str) -> SkillInput {
        SkillInput {
            id: None,
            name: None,
            description: None,
            content: content.into(),
            source: None,
            scope: None,
            agents: None,
            enabled: None,
        }
    }

    #[test]
    fn name_and_description_come_from_the_front_matter() {
        assert_eq!(front_matter(SKILL), (Some("release-notes".into()), Some("Write release notes from merged pull requests".into())));
        assert_eq!(front_matter("# no front matter"), (None, None));
        let db = db();
        let s = save(&db, "work", input(SKILL)).unwrap();
        assert_eq!((s.name.as_str(), s.scope.as_str()), ("release-notes", "chosen"));
        assert!(save(&db, "work", input("# Untitled\n")).unwrap_err().to_string().contains("name the skill"));
        let mut no_desc = input("---\nname: x\n---\n");
        no_desc.name = Some("x".into());
        assert!(save(&db, "work", no_desc).unwrap_err().to_string().contains("description"));
        assert_eq!(save(&db, "work", input(SKILL)).unwrap_err().code(), "conflict");
    }

    #[test]
    fn agents_get_the_skills_given_to_them() {
        let db = db();
        let coder = agent(&db, "coder");
        let writer = agent(&db, "writer");
        let s = save(&db, "work", input(SKILL)).unwrap();
        assert!(for_agent(&db, &writer).unwrap().is_empty(), "chosen, and nobody chosen yet");
        assign(&db, "work", &s.id, &writer.id, true).unwrap();
        assert_eq!(for_agent(&db, &writer).unwrap().len(), 1);
        assert!(for_agent(&db, &coder).unwrap().is_empty());
        let bundle: serde_json::Value = serde_json::from_str(&bundle_for(&db, &writer).unwrap()).unwrap();
        assert_eq!(bundle[0]["name"], "release-notes");
        assign(&db, "work", &s.id, &writer.id, false).unwrap();
        assert!(for_agent(&db, &writer).unwrap().is_empty());

        let mut all = input(SKILL);
        all.id = Some(s.id.clone());
        all.scope = Some("all".into());
        save(&db, "work", all).unwrap();
        assert_eq!(for_agent(&db, &coder).unwrap().len(), 1, "every agent");
        assert!(assign(&db, "work", &s.id, &coder.id, false).unwrap_err().to_string().contains("every agent"));
    }
}
