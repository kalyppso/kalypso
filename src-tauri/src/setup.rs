//! First-run setup (#94): the checks the setup wizard runs, each with an answer a new
//! user can act on.

use std::time::Duration;

use serde::Serialize;
use ts_rs::TS;

use crate::error::Result;
use crate::sandbox::Runtime;
use crate::store::Db;
use crate::vault::Vault;

/// The container engine: the one KALYPSO is connected to, and the one it could connect to now.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct EngineStatus {
    /// What the core started with: "docker", "podman" or "none".
    pub connected: String,
    /// An engine reachable right now, if any. When this is set but `connected` is "none",
    /// the engine was started after KALYPSO and a restart connects it.
    pub found: Option<String>,
    /// "linux", "macos" or "windows", to tailor the install advice.
    pub os: String,
    /// Whether the `podman` / `docker` commands are installed, to tell "not installed"
    /// apart from "installed but not running".
    pub podman_cli: bool,
    pub docker_cli: bool,
}

pub async fn engine_status(current: &Runtime) -> EngineStatus {
    let found = if current.available() {
        Some(current.kind.clone())
    } else {
        let rt = Runtime::detect().await;
        rt.available().then_some(rt.kind)
    };
    EngineStatus {
        connected: current.kind.clone(),
        found,
        os: std::env::consts::OS.to_string(),
        podman_cli: on_path("podman"),
        docker_cli: on_path("docker"),
    }
}

fn on_path(bin: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else { return false };
    std::env::split_paths(&path).any(|dir| dir.join(bin).is_file() || dir.join(format!("{bin}.exe")).is_file())
}

/// Whether a model key works, and what to do if it doesn't.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct KeyCheck {
    pub ok: bool,
    pub message: String,
}

/// Try the namespace's ANTHROPIC_API_KEY against the models list: free, and enough to
/// tell a good key from a bad one. Honours ANTHROPIC_BASE_URL, like the gateway does.
pub async fn check_anthropic_key(db: &Db, vault: &Vault, ns: &str) -> Result<KeyCheck> {
    let Some(key) = vault.lookup(db, ns, "ANTHROPIC_API_KEY")? else {
        return Ok(KeyCheck { ok: false, message: "There's no ANTHROPIC_API_KEY in this namespace yet.".into() });
    };
    let base = vault.lookup(db, ns, "ANTHROPIC_BASE_URL")?.unwrap_or_else(|| "https://api.anthropic.com".into());
    let url = format!("{}/v1/models?limit=1", base.trim_end_matches('/'));
    let http = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().map_err(|e| crate::error::KalypsoError::Runtime(e.to_string()))?;
    let res = http.get(&url).header("x-api-key", key).header("anthropic-version", "2023-06-01").send().await;
    Ok(match res {
        Err(e) if e.is_timeout() => KeyCheck { ok: false, message: format!("{} didn't answer within 15 seconds. Check your connection, then try again.", host(&base)) },
        Err(_) => KeyCheck { ok: false, message: format!("Couldn't reach {}. Check your internet connection or proxy, then try again.", host(&base)) },
        Ok(r) => match r.status().as_u16() {
            200..=299 => KeyCheck { ok: true, message: "The key works.".into() },
            // Rate-limited means the key itself was accepted.
            429 => KeyCheck { ok: true, message: "The key works. Anthropic is rate-limiting it right now, so the first calls may wait.".into() },
            401 => KeyCheck { ok: false, message: "Anthropic didn't accept this key. Check you copied all of it, then save it again.".into() },
            403 => KeyCheck { ok: false, message: "This key isn't allowed to use the API. Check its permissions and billing in the Anthropic Console.".into() },
            s => KeyCheck { ok: false, message: format!("{} answered with an error ({s}). Try again in a moment.", host(&base)) },
        },
    })
}

fn host(base: &str) -> String {
    base.split("://").nth(1).unwrap_or(base).split('/').next().unwrap_or(base).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{http::StatusCode, routing::get, Router};

    /// A stand-in for api.anthropic.com that answers every request with `status`.
    async fn upstream(status: StatusCode) -> String {
        let app = Router::new().route("/v1/models", get(move || async move { (status, "{}") }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    fn env() -> ((), Db, Vault) {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| Ok(c.execute_batch("INSERT INTO namespaces (id, name) VALUES ('work','work');")?)).unwrap();
        let vault = Vault::ephemeral();
        vault.create_ns_key(&db, "work").unwrap();
        ((), db, vault)
    }

    #[tokio::test]
    async fn no_key_says_so() {
        let (_d, db, vault) = env();
        let c = check_anthropic_key(&db, &vault, "work").await.unwrap();
        assert!(!c.ok);
        assert!(c.message.contains("no ANTHROPIC_API_KEY"));
    }

    #[tokio::test]
    async fn good_and_bad_keys() {
        let (_d, db, vault) = env();
        vault.set(&db, "work", "ANTHROPIC_API_KEY", "sk-ant-test", "gateway").unwrap();
        for (status, ok, says) in [
            (StatusCode::OK, true, "works"),
            (StatusCode::TOO_MANY_REQUESTS, true, "rate-limiting"),
            (StatusCode::UNAUTHORIZED, false, "didn't accept"),
            (StatusCode::FORBIDDEN, false, "permissions"),
            (StatusCode::BAD_GATEWAY, false, "(502)"),
        ] {
            let base = upstream(status).await;
            vault.set(&db, "work", "ANTHROPIC_BASE_URL", &base, "gateway").unwrap();
            let c = check_anthropic_key(&db, &vault, "work").await.unwrap();
            assert_eq!(c.ok, ok, "{status}");
            assert!(c.message.contains(says), "{status}: {}", c.message);
        }
    }

    #[tokio::test]
    async fn unreachable_host_is_explained() {
        let (_d, db, vault) = env();
        vault.set(&db, "work", "ANTHROPIC_API_KEY", "sk-ant-test", "gateway").unwrap();
        // Nothing listens on port 9 (discard) on loopback.
        vault.set(&db, "work", "ANTHROPIC_BASE_URL", "http://127.0.0.1:9", "gateway").unwrap();
        let c = check_anthropic_key(&db, &vault, "work").await.unwrap();
        assert!(!c.ok);
        assert!(c.message.contains("Couldn't reach 127.0.0.1:9"), "{}", c.message);
    }

    #[test]
    fn host_of_a_base_url() {
        assert_eq!(host("https://api.anthropic.com"), "api.anthropic.com");
        assert_eq!(host("http://127.0.0.1:8080/v1"), "127.0.0.1:8080");
    }
}
