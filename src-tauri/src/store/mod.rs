use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;
use serde::Serialize;
use ts_rs::TS;

use crate::error::{KalypsoError, Result};

/// Migrations run in order; `PRAGMA user_version` records how many have been applied.
const MIGRATIONS: &[&str] =
    &[include_str!("migrations/0001_init.sql"), include_str!("migrations/0002_gateway.sql"), include_str!("migrations/0003_budgets.sql")];

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct AuditEntry {
    #[ts(type = "number")]
    pub id: i64,
    pub ns: Option<String>,
    pub actor: String,
    pub action: String,
    pub target: String,
    pub ts: String,
}

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        Self::init(Connection::open(path)?)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        migrate(&conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// Run `f` with exclusive access to the connection.
    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self.conn.lock().expect("database mutex poisoned");
        f(&conn)
    }

    /// A stored setting, or `None` if it was never set.
    pub fn setting(&self, key: &str) -> Result<Option<serde_json::Value>> {
        let raw: Option<String> = self.with(|c| {
            Ok(rusqlite::OptionalExtension::optional(c.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)))?)
        })?;
        raw.map(|s| serde_json::from_str(&s).map_err(|e| KalypsoError::Invalid(format!("setting {key} is corrupt: {e}")))).transpose()
    }

    pub fn set_setting(&self, key: &str, value: &serde_json::Value) -> Result<()> {
        let key_ok = (1..=64).contains(&key.len()) && key.chars().all(|c| c.is_ascii_alphanumeric() || ".-_".contains(c));
        if !key_ok {
            return Err(KalypsoError::Invalid("setting keys use letters, digits, '.', '-' and '_' (max 64)".into()));
        }
        let text = value.to_string();
        if text.len() > 64 * 1024 {
            return Err(KalypsoError::Invalid(format!("setting {key} is larger than 64 KB")));
        }
        self.with(|c| {
            c.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                (key, &text),
            )?;
            Ok(())
        })
    }

    pub fn audit(&self, ns: Option<&str>, actor: &str, action: &str, target: &str) -> Result<()> {
        self.with(|c| {
            c.execute("INSERT INTO audit_log (ns, actor, action, target) VALUES (?1, ?2, ?3, ?4)", (ns, actor, action, target))?;
            Ok(())
        })
    }

    /// Newest first. `ns` limits to one namespace (namespace deletions, which have
    /// no namespace, are always included); `action_prefix` filters like "secret.".
    pub fn audit_list(&self, ns: Option<&str>, action_prefix: Option<&str>, limit: u32) -> Result<Vec<AuditEntry>> {
        self.with(|c| {
            let mut st = c.prepare(
                "SELECT id, ns, actor, action, target, ts FROM audit_log
                 WHERE (?1 IS NULL OR ns = ?1 OR ns IS NULL) AND (?2 IS NULL OR action LIKE ?2 || '%')
                 ORDER BY id DESC LIMIT ?3",
            )?;
            let rows = st.query_map((ns, action_prefix, limit.min(1000)), |r| {
                Ok(AuditEntry { id: r.get(0)?, ns: r.get(1)?, actor: r.get(2)?, action: r.get(3)?, target: r.get(4)?, ts: r.get(5)? })
            })?;
            Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
        })
    }
}

fn migrate(conn: &Connection) -> Result<()> {
    let applied: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(applied as usize) {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64)?;
        tx.commit()?;
        tracing::info!(version = i + 1, "applied migration");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_once_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("k.db");
        Db::open(&path).unwrap();
        let db = Db::open(&path).unwrap();
        let v: i64 = db.with(|c| Ok(c.pragma_query_value(None, "user_version", |r| r.get(0))?)).unwrap();
        assert_eq!(v as usize, MIGRATIONS.len());
    }

    #[test]
    fn audit_list_filters_and_orders() {
        let db = Db::open_in_memory().unwrap();
        db.audit(Some("work"), "user", "secret.set", "A").unwrap();
        db.audit(Some("lab"), "user", "secret.reveal", "B").unwrap();
        db.audit(Some("work"), "user", "sandbox.create", "box").unwrap();
        db.audit(None, "user", "namespace.delete", "old").unwrap();

        let all = db.audit_list(None, None, 50).unwrap();
        assert_eq!(all.iter().map(|e| e.target.as_str()).collect::<Vec<_>>(), ["old", "box", "B", "A"]);
        let work = db.audit_list(Some("work"), None, 50).unwrap();
        assert_eq!(work.iter().map(|e| e.target.as_str()).collect::<Vec<_>>(), ["old", "box", "A"]);
        let secrets = db.audit_list(Some("work"), Some("secret."), 50).unwrap();
        assert_eq!(secrets.len(), 1);
        assert_eq!(db.audit_list(None, None, 2).unwrap().len(), 2);
    }

    #[test]
    fn settings_roundtrip_and_validation() {
        let db = Db::open_in_memory().unwrap();
        assert_eq!(db.setting("appearance").unwrap(), None);
        let v = serde_json::json!({ "theme": "custom", "accent": "#5b2aaa", "size": "large" });
        db.set_setting("appearance", &v).unwrap();
        db.set_setting("appearance", &serde_json::json!({ "theme": "white" })).unwrap();
        assert_eq!(db.setting("appearance").unwrap(), Some(serde_json::json!({ "theme": "white" })));
        assert_eq!(db.set_setting("bad key!", &v).unwrap_err().code(), "invalid");
        assert_eq!(db.set_setting("big", &serde_json::json!("x".repeat(70_000))).unwrap_err().code(), "invalid");
    }

    #[test]
    fn audit_rows_are_written() {
        let db = Db::open_in_memory().unwrap();
        db.audit(Some("work"), "user", "secret.reveal", "s-1").unwrap();
        let n: i64 = db.with(|c| Ok(c.query_row("SELECT count(*) FROM audit_log", [], |r| r.get(0))?)).unwrap();
        assert_eq!(n, 1);
    }
}
