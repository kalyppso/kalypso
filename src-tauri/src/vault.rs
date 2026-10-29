use std::path::Path;

use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use rand::RngCore;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{KalypsoError, Result};
use crate::store::Db;

const KEYRING_SERVICE: &str = "kalypso";
const KEYRING_USER: &str = "master-key";

/// Secret metadata. Values never leave the vault except through `reveal`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SecretMeta {
    pub id: String,
    pub ns: String,
    pub key: String,
    pub scope: String,
    pub updated_at: String,
}

/// Where the master key lives, reported to the UI so the user knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KeySource {
    Keychain,
    File,
    Memory,
}

pub struct Vault {
    master: Key,
    pub source: KeySource,
}

impl Vault {
    /// Load the master key from the OS keychain, creating it on first run. If no
    /// keychain service is reachable (headless Linux, WSL), fall back to a file
    /// in the app data dir readable only by this user.
    pub fn load(data_dir: &Path) -> Result<Self> {
        match keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).and_then(|e| match e.get_password() {
            Ok(hex) => Ok(hex),
            Err(keyring::Error::NoEntry) => {
                let hex = to_hex(&random_key());
                e.set_password(&hex)?;
                Ok(hex)
            }
            Err(err) => Err(err),
        }) {
            Ok(hex) => Ok(Self { master: key_from_hex(&hex)?, source: KeySource::Keychain }),
            Err(err) => {
                tracing::warn!(%err, "OS keychain unavailable, using a key file");
                Self::load_file(&data_dir.join("master.key"))
            }
        }
    }

    fn load_file(path: &Path) -> Result<Self> {
        let hex = match std::fs::read_to_string(path) {
            Ok(s) => s.trim().to_string(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let hex = to_hex(&random_key());
                write_private(path, &hex)?;
                hex
            }
            Err(e) => return Err(e.into()),
        };
        Ok(Self { master: key_from_hex(&hex)?, source: KeySource::File })
    }

    pub fn ephemeral() -> Self {
        Self { master: Key::clone_from_slice(&random_key()), source: KeySource::Memory }
    }

    /// Create and store a fresh data key for a namespace, wrapped by the master key.
    pub fn create_ns_key(&self, db: &Db, ns: &str) -> Result<()> {
        let (wrapped, nonce) = seal(&self.master, &random_key())?;
        db.with(|c| {
            c.execute("INSERT INTO ns_keys (ns, wrapped, nonce) VALUES (?1, ?2, ?3)", (ns, wrapped, nonce))?;
            Ok(())
        })
    }

    fn ns_key(&self, db: &Db, ns: &str) -> Result<Key> {
        let (wrapped, nonce): (Vec<u8>, Vec<u8>) = db
            .with(|c| {
                Ok(c.query_row("SELECT wrapped, nonce FROM ns_keys WHERE ns = ?1", [ns], |r| Ok((r.get(0)?, r.get(1)?))).optional()?)
            })?
            .ok_or_else(|| KalypsoError::Vault(format!("no data key for namespace {ns}")))?;
        Ok(Key::clone_from_slice(&open(&self.master, &wrapped, &nonce)?))
    }

    /// Create or replace a secret. Keys are upper-snake-case, unique per namespace.
    pub fn set(&self, db: &Db, ns: &str, key: &str, value: &str, scope: &str) -> Result<SecretMeta> {
        if key.is_empty() || !key.chars().all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_') {
            return Err(KalypsoError::Invalid("secret keys use A-Z, 0-9 and _".into()));
        }
        if value.is_empty() {
            return Err(KalypsoError::Invalid("secret value is empty".into()));
        }
        if scope != "namespace" && scope != "agent" {
            return Err(KalypsoError::Invalid(format!("unknown scope {scope}")));
        }
        let (ct, nonce) = seal(&self.ns_key(db, ns)?, value.as_bytes())?;
        let id = new_id("s");
        db.with(|c| {
            c.execute(
                "INSERT INTO secrets (id, ns, key, ciphertext, nonce, scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (ns, key) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce,
                   scope = excluded.scope, updated_at = CURRENT_TIMESTAMP",
                (&id, ns, key, ct, nonce, scope),
            )?;
            Ok(())
        })?;
        db.audit(Some(ns), "user", "secret.set", key)?;
        self.list(db, ns)?.into_iter().find(|s| s.key == key).ok_or_else(|| KalypsoError::NotFound(key.into()))
    }

    pub fn list(&self, db: &Db, ns: &str) -> Result<Vec<SecretMeta>> {
        db.with(|c| {
            let mut st = c.prepare("SELECT id, ns, key, scope, updated_at FROM secrets WHERE ns = ?1 ORDER BY key")?;
            let rows = st.query_map([ns], |r| {
                Ok(SecretMeta { id: r.get(0)?, ns: r.get(1)?, key: r.get(2)?, scope: r.get(3)?, updated_at: r.get(4)? })
            })?;
            Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
        })
    }

    /// Decrypt one secret. Refuses ids from other namespaces and records every reveal.
    pub fn reveal(&self, db: &Db, ns: &str, id: &str) -> Result<String> {
        let (owner, key, ct, nonce): (String, String, Vec<u8>, Vec<u8>) = db
            .with(|c| {
                Ok(c.query_row("SELECT ns, key, ciphertext, nonce FROM secrets WHERE id = ?1", [id], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })
                .optional()?)
            })?
            .ok_or_else(|| KalypsoError::NotFound(format!("secret {id}")))?;
        if owner != ns {
            return Err(KalypsoError::WrongNamespace(format!("secret {id}"), ns.into()));
        }
        let plain = open(&self.ns_key(db, ns)?, &ct, &nonce)?;
        db.audit(Some(ns), "user", "secret.reveal", &key)?;
        String::from_utf8(plain).map_err(|_| KalypsoError::Vault("secret is not valid UTF-8".into()))
    }

    pub fn delete(&self, db: &Db, ns: &str, id: &str) -> Result<()> {
        let n = db.with(|c| Ok(c.execute("DELETE FROM secrets WHERE id = ?1 AND ns = ?2", (id, ns))?))?;
        if n == 0 {
            return Err(KalypsoError::NotFound(format!("secret {id} in {ns}")));
        }
        db.audit(Some(ns), "user", "secret.delete", id)
    }
}

fn seal(key: &Key, plain: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
    let cipher = XChaCha20Poly1305::new(key);
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ct = cipher.encrypt(&nonce, plain).map_err(|_| KalypsoError::Vault("encryption failed".into()))?;
    Ok((ct, nonce.to_vec()))
}

fn open(key: &Key, ct: &[u8], nonce: &[u8]) -> Result<Vec<u8>> {
    if nonce.len() != 24 {
        return Err(KalypsoError::Vault("corrupt nonce".into()));
    }
    XChaCha20Poly1305::new(key)
        .decrypt(XNonce::from_slice(nonce), ct)
        .map_err(|_| KalypsoError::Vault("decryption failed (wrong key or tampered data)".into()))
}

fn random_key() -> [u8; 32] {
    let mut k = [0u8; 32];
    OsRng.fill_bytes(&mut k);
    k
}

pub fn new_id(prefix: &str) -> String {
    let mut b = [0u8; 6];
    OsRng.fill_bytes(&mut b);
    format!("{prefix}-{}", to_hex(&b))
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn key_from_hex(hex: &str) -> Result<Key> {
    if hex.len() != 64 {
        return Err(KalypsoError::Vault("master key has the wrong length".into()));
    }
    let bytes = (0..32)
        .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16))
        .collect::<std::result::Result<Vec<u8>, _>>()
        .map_err(|_| KalypsoError::Vault("master key is not hex".into()))?;
    Ok(Key::clone_from_slice(&bytes))
}

fn write_private(path: &Path, contents: &str) -> Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(contents.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (Db, Vault) {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            c.execute_batch("INSERT INTO namespaces (id, name) VALUES ('work','work'), ('lab','lab');")?;
            Ok(())
        })
        .unwrap();
        let v = Vault::ephemeral();
        v.create_ns_key(&db, "work").unwrap();
        v.create_ns_key(&db, "lab").unwrap();
        (db, v)
    }

    #[test]
    fn set_list_reveal_roundtrip() {
        let (db, v) = setup();
        let m = v.set(&db, "work", "GITHUB_TOKEN", "ghp_example", "namespace").unwrap();
        assert_eq!(v.list(&db, "work").unwrap().len(), 1);
        assert_eq!(v.reveal(&db, "work", &m.id).unwrap(), "ghp_example");
    }

    #[test]
    fn plaintext_never_hits_the_database() {
        let (db, v) = setup();
        v.set(&db, "work", "API_KEY", "super-secret-value", "agent").unwrap();
        let blob: Vec<u8> = db.with(|c| Ok(c.query_row("SELECT ciphertext FROM secrets", [], |r| r.get(0))?)).unwrap();
        assert!(!blob.windows(18).any(|w| w == b"super-secret-value"));
    }

    #[test]
    fn other_namespaces_cannot_reveal() {
        let (db, v) = setup();
        let m = v.set(&db, "work", "API_KEY", "x", "agent").unwrap();
        assert_eq!(v.reveal(&db, "lab", &m.id).unwrap_err().code(), "wrong_namespace");
    }

    #[test]
    fn another_master_key_cannot_decrypt() {
        let (db, v) = setup();
        let m = v.set(&db, "work", "API_KEY", "x", "agent").unwrap();
        assert_eq!(Vault::ephemeral().reveal(&db, "work", &m.id).unwrap_err().code(), "vault");
    }

    #[test]
    fn reveals_are_audited_and_keys_validated() {
        let (db, v) = setup();
        let m = v.set(&db, "work", "API_KEY", "x", "agent").unwrap();
        v.reveal(&db, "work", &m.id).unwrap();
        let n: i64 =
            db.with(|c| Ok(c.query_row("SELECT count(*) FROM audit_log WHERE action = 'secret.reveal'", [], |r| r.get(0))?)).unwrap();
        assert_eq!(n, 1);
        assert_eq!(v.set(&db, "work", "lower-case", "x", "agent").unwrap_err().code(), "invalid");
    }

    #[test]
    fn key_file_fallback_is_stable_and_private() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("master.key");
        let a = Vault::load_file(&path).unwrap();
        let b = Vault::load_file(&path).unwrap();
        assert_eq!(a.master, b.master);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }
}
