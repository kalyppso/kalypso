use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{KalypsoError, Result};
use crate::sandbox::{self, Runtime};
use crate::store::Db;
use crate::vault::Vault;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Namespace {
    pub id: String,
    pub name: String,
    pub description: String,
    pub color: String,
    pub created_at: String,
}

pub fn list(db: &Db) -> Result<Vec<Namespace>> {
    db.with(|c| {
        let mut st = c.prepare("SELECT id, name, description, color, created_at FROM namespaces ORDER BY created_at, id")?;
        let rows = st.query_map([], |r| {
            Ok(Namespace { id: r.get(0)?, name: r.get(1)?, description: r.get(2)?, color: r.get(3)?, created_at: r.get(4)? })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    })
}

pub fn exists(db: &Db, id: &str) -> Result<bool> {
    db.with(|c| Ok(c.query_row("SELECT 1 FROM namespaces WHERE id = ?1", [id], |_| Ok(())).optional()?.is_some()))
}

/// Ids double as Docker network and directory names, so keep them boring.
pub fn validate_id(id: &str) -> Result<()> {
    let ok = (1..=32).contains(&id.len())
        && id.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(())
    } else {
        Err(KalypsoError::Invalid("namespace names use a-z, 0-9 and -, up to 32 characters".into()))
    }
}

/// Create a namespace and everything that isolates it: a data key and, when a
/// container runtime is present, an internal network.
pub async fn create(db: &Db, vault: &Vault, rt: &Runtime, id: &str, description: &str) -> Result<Namespace> {
    validate_id(id)?;
    if exists(db, id)? {
        return Err(KalypsoError::Conflict(format!("namespace {id}")));
    }
    db.with(|c| Ok(c.execute("INSERT INTO namespaces (id, name, description) VALUES (?1, ?1, ?2)", (id, description))?))?;
    vault.create_ns_key(db, id)?;
    crate::policy::seed_defaults(db, id)?;
    if rt.available() {
        if let Err(e) = rt.ensure_network(id).await {
            tracing::warn!(ns = id, error = %e, "could not create namespace network; it will be retried on first sandbox");
        }
    }
    db.audit(Some(id), "user", "namespace.create", id)?;
    list(db)?.into_iter().find(|n| n.id == id).ok_or_else(|| KalypsoError::NotFound(id.into()))
}

/// Remove a namespace's containers, network, keys and rows.
pub async fn delete(db: &Db, rt: &Runtime, id: &str) -> Result<()> {
    if !exists(db, id)? {
        return Err(KalypsoError::NotFound(format!("namespace {id}")));
    }
    for sb in sandbox::list(db, id)? {
        sandbox::remove(db, rt, id, &sb.id).await?;
    }
    if rt.available() {
        rt.remove_network(id).await?;
    }
    db.with(|c| Ok(c.execute("DELETE FROM namespaces WHERE id = ?1", [id])?))?;
    crate::policy::delete_namespace(db, id)?;
    db.audit(None, "user", "namespace.delete", id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn create_list_delete_without_runtime() {
        let db = Db::open_in_memory().unwrap();
        let vault = Vault::ephemeral();
        let rt = Runtime::none();
        create(&db, &vault, &rt, "work", "Client agents").await.unwrap();
        assert_eq!(create(&db, &vault, &rt, "work", "").await.unwrap_err().code(), "conflict");
        vault.set(&db, "work", "TOKEN", "x", "namespace").unwrap();
        assert_eq!(list(&db).unwrap().len(), 1);

        delete(&db, &rt, "work").await.unwrap();
        assert!(list(&db).unwrap().is_empty());
        // Keys and secrets go with the namespace.
        let left: i64 = db
            .with(|c| Ok(c.query_row("SELECT (SELECT count(*) FROM ns_keys) + (SELECT count(*) FROM secrets)", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn ids_are_validated() {
        for ok in ["work", "client-acme", "lab2"] {
            assert!(validate_id(ok).is_ok(), "{ok}");
        }
        for bad in ["", "Work", "-x", "a b", "x".repeat(33).as_str()] {
            assert!(validate_id(bad).is_err(), "{bad}");
        }
    }
}
