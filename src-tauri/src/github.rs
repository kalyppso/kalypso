//! GitHub accounts (#100). Several accounts at once, connected by signing in (OAuth device
//! flow, no redirect URL needed) or by pasting a token. Tokens are sealed with the master key
//! and never leave the core: sandboxes get git credentials through the gateway instead.
//! Each namespace chooses which accounts it may use.

use std::time::Duration;

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use zeroize::Zeroizing;

use crate::error::{KalypsoError, Result};
use crate::store::Db;
use crate::vault::{new_id, Vault};

/// What the device flow asks for: repositories (to clone, push and open pull requests) and
/// organisation membership (to list organisation repositories).
const SCOPES: &str = "repo read:org";
/// Refresh an expiring token this long before it lapses.
const REFRESH_AHEAD: chrono::Duration = chrono::Duration::minutes(10);

/// The OAuth App used for "Sign in with GitHub". Its client ID is public. A `github.client_id`
/// setting overrides the built-in one (for forks, or before one is built in).
pub const BUILT_IN_CLIENT_ID: Option<&str> = option_env!("KALYPSO_GITHUB_CLIENT_ID");

#[derive(Clone)]
pub struct GitHub {
    http: reqwest::Client,
    /// https://api.github.com
    pub api: String,
    /// https://github.com (device flow and token endpoints)
    pub web: String,
}

impl Default for GitHub {
    fn default() -> Self {
        Self::new("https://api.github.com", "https://github.com")
    }
}

/// A token, as the device flow or a refresh hands it over.
#[derive(Debug, Clone, Deserialize)]
pub struct TokenSet {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Seconds until the access token expires (only for expiring tokens).
    #[serde(default)]
    pub expires_in: Option<i64>,
    #[serde(default)]
    pub refresh_token_expires_in: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct Identity {
    pub login: String,
    pub avatar_url: Option<String>,
    pub scopes: Vec<String>,
    pub orgs: Vec<String>,
}

/// The device flow's first step: what the user types at github.com/login/device.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DeviceStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u32,
    pub interval: u32,
}

/// Where a device sign-in stands.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum DevicePoll {
    /// Not approved yet; ask again after `interval` seconds.
    Pending {
        interval: u32,
    },
    Done {
        account: Box<Account>,
    },
    Denied,
    Expired,
}

/// A repository an account can reach.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct Repo {
    pub account_id: String,
    pub account_label: String,
    pub full_name: String,
    pub private: bool,
    pub default_branch: String,
    pub description: Option<String>,
}

#[derive(Debug)]
pub enum GhError {
    /// GitHub refused the token (revoked, expired or wrong).
    Unauthorized,
    Other(String),
}

impl From<GhError> for KalypsoError {
    fn from(e: GhError) -> Self {
        match e {
            GhError::Unauthorized => KalypsoError::Invalid("GitHub didn't accept this token. Check it, or create a new one.".into()),
            GhError::Other(m) => KalypsoError::Invalid(m),
        }
    }
}

impl GitHub {
    pub fn new(api: &str, web: &str) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent(concat!("KALYPSO/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("http client");
        Self { http, api: api.trim_end_matches('/').into(), web: web.trim_end_matches('/').into() }
    }

    async fn get(&self, token: &str, path: &str) -> std::result::Result<reqwest::Response, GhError> {
        let res = self
            .http
            .get(format!("{}{path}", self.api))
            .header("authorization", format!("Bearer {token}"))
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28")
            .send()
            .await
            .map_err(|e| GhError::Other(format!("couldn't reach GitHub: {}", e.without_url())))?;
        match res.status() {
            StatusCode::UNAUTHORIZED => Err(GhError::Unauthorized),
            s if s.is_success() => Ok(res),
            s => Err(GhError::Other(format!("GitHub answered {s} for {path}"))),
        }
    }

    /// Who a token belongs to, its classic scopes (empty for fine-grained tokens) and organisations.
    pub async fn whoami(&self, token: &str) -> std::result::Result<Identity, GhError> {
        #[derive(Deserialize)]
        struct User {
            login: String,
            avatar_url: Option<String>,
        }
        #[derive(Deserialize)]
        struct Org {
            login: String,
        }
        let res = self.get(token, "/user").await?;
        let scopes = res
            .headers()
            .get("x-oauth-scopes")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect())
            .unwrap_or_default();
        let user: User = res.json().await.map_err(|e| GhError::Other(e.to_string()))?;
        // Fine-grained tokens without organisation access answer 403 here; that just means none.
        let orgs = match self.get(token, "/user/orgs?per_page=100").await {
            Ok(r) => r.json::<Vec<Org>>().await.map(|o| o.into_iter().map(|o| o.login).collect()).unwrap_or_default(),
            Err(GhError::Unauthorized) => return Err(GhError::Unauthorized),
            Err(_) => vec![],
        };
        Ok(Identity { login: user.login, avatar_url: user.avatar_url, scopes, orgs })
    }

    /// Repositories the token can reach: its own, ones it collaborates on, and its organisations'.
    pub async fn repos(&self, token: &str) -> std::result::Result<Vec<(String, bool, String, Option<String>)>, GhError> {
        #[derive(Deserialize)]
        struct R {
            full_name: String,
            private: bool,
            default_branch: Option<String>,
            description: Option<String>,
        }
        let mut out = Vec::new();
        for page in 1..=5 {
            let path = format!("/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member&page={page}");
            let batch: Vec<R> = self.get(token, &path).await?.json().await.map_err(|e| GhError::Other(e.to_string()))?;
            let n = batch.len();
            out.extend(
                batch.into_iter().map(|r| (r.full_name, r.private, r.default_branch.unwrap_or_else(|| "main".into()), r.description)),
            );
            if n < 100 {
                break;
            }
        }
        Ok(out)
    }

    /// One GitHub API request on behalf of a sandbox (the gateway's `/_kalypso/github/…`).
    pub async fn api_request(
        &self,
        method: reqwest::Method,
        path_and_query: &str,
        token: &str,
        body: Vec<u8>,
        content_type: Option<&str>,
    ) -> std::result::Result<reqwest::Response, String> {
        let mut req = self
            .http
            .request(method, format!("{}{path_and_query}", self.api))
            .header("authorization", format!("Bearer {token}"))
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28");
        if let Some(ct) = content_type {
            req = req.header("content-type", ct);
        }
        if !body.is_empty() {
            req = req.body(body);
        }
        req.send().await.map_err(|e| format!("couldn't reach GitHub: {}", e.without_url()))
    }

    pub async fn device_start(&self, client_id: &str) -> Result<DeviceStart> {
        let res = self
            .http
            .post(format!("{}/login/device/code", self.web))
            .header("accept", "application/json")
            .form(&[("client_id", client_id), ("scope", SCOPES)])
            .send()
            .await
            .map_err(|e| KalypsoError::Invalid(format!("couldn't reach GitHub: {}", e.without_url())))?;
        if !res.status().is_success() {
            return Err(KalypsoError::Invalid(format!(
                "GitHub refused to start sign-in ({}). Is device flow enabled for the OAuth App?",
                res.status()
            )));
        }
        let body: serde_json::Value = res.json().await.map_err(|e| KalypsoError::Invalid(e.to_string()))?;
        if let Some(err) = body.get("error").and_then(|e| e.as_str()) {
            return Err(KalypsoError::Invalid(format!(
                "GitHub refused to start sign-in: {err}. Is device flow enabled for the OAuth App?"
            )));
        }
        serde_json::from_value(body).map_err(|e| KalypsoError::Invalid(e.to_string()))
    }

    /// One poll of the device flow: a token once the user has approved, or why not yet.
    pub async fn device_poll(&self, client_id: &str, device_code: &str) -> Result<std::result::Result<TokenSet, &'static str>> {
        self.token_request(&[
            ("client_id", client_id),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .await
    }

    pub async fn refresh(&self, client_id: &str, refresh_token: &str) -> Result<std::result::Result<TokenSet, &'static str>> {
        self.token_request(&[("client_id", client_id), ("refresh_token", refresh_token), ("grant_type", "refresh_token")]).await
    }

    async fn token_request(&self, form: &[(&str, &str)]) -> Result<std::result::Result<TokenSet, &'static str>> {
        let res = self
            .http
            .post(format!("{}/login/oauth/access_token", self.web))
            .header("accept", "application/json")
            .form(form)
            .send()
            .await
            .map_err(|e| KalypsoError::Invalid(format!("couldn't reach GitHub: {}", e.without_url())))?;
        let body: serde_json::Value = res.json().await.map_err(|e| KalypsoError::Invalid(e.to_string()))?;
        if let Some(err) = body.get("error").and_then(|e| e.as_str()) {
            return Ok(Err(match err {
                "authorization_pending" => "pending",
                "slow_down" => "slow_down",
                "expired_token" => "expired",
                "access_denied" => "denied",
                "bad_refresh_token" => "bad_refresh",
                _ => "error",
            }));
        }
        Ok(Ok(serde_json::from_value(body).map_err(|e| KalypsoError::Invalid(e.to_string()))?))
    }
}

/// A pull request opened from an agent's branch.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PullRequest {
    #[ts(type = "number")]
    pub number: u64,
    pub title: String,
    /// "open" or "closed".
    pub state: String,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub merged_at: Option<String>,
    pub html_url: String,
    pub updated_at: String,
}

impl GitHub {
    /// Pull requests whose head is `branch` in `repo` (the agent's own, #100).
    pub async fn pull_requests(&self, token: &str, repo: &str, branch: &str) -> std::result::Result<Vec<PullRequest>, GhError> {
        let owner = repo.split('/').next().unwrap_or(repo);
        let path = format!("/repos/{repo}/pulls?state=all&per_page=20&head={owner}:{branch}");
        self.get(token, &path).await?.json().await.map_err(|e| GhError::Other(e.to_string()))
    }
}

/// The OAuth App client ID, if sign-in is set up: the setting first, then the built-in one.
pub fn client_id(db: &Db) -> Option<String> {
    db.setting("github.client_id")
        .ok()
        .flatten()
        .and_then(|v| v.as_str().map(str::to_string))
        .filter(|s| !s.trim().is_empty())
        .or_else(|| BUILT_IN_CLIENT_ID.map(str::to_string))
}

// ---------- Accounts ----------

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct Account {
    pub id: String,
    pub label: String,
    pub login: String,
    pub avatar_url: Option<String>,
    /// "oauth" (signed in) or "token" (pasted).
    pub kind: String,
    pub scopes: Vec<String>,
    pub orgs: Vec<String>,
    /// "ok", or "reconnect" when GitHub no longer accepts the token.
    pub status: String,
    pub status_reason: Option<String>,
    pub expires_at: Option<String>,
    pub checked_at: Option<String>,
    pub created_at: String,
    /// Namespaces allowed to use this account.
    pub namespaces: Vec<String>,
}

const COLS: &str = "id, label, login, avatar_url, kind, scopes, orgs, status, status_reason, expires_at, checked_at, created_at";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Account> {
    let scopes: String = r.get(5)?;
    let orgs: String = r.get(6)?;
    Ok(Account {
        id: r.get(0)?,
        label: r.get(1)?,
        login: r.get(2)?,
        avatar_url: r.get(3)?,
        kind: r.get(4)?,
        scopes: scopes.split(',').filter(|s| !s.is_empty()).map(str::to_string).collect(),
        orgs: serde_json::from_str(&orgs).unwrap_or_default(),
        status: r.get(7)?,
        status_reason: r.get(8)?,
        expires_at: r.get(9)?,
        checked_at: r.get(10)?,
        created_at: r.get(11)?,
        namespaces: vec![],
    })
}

fn with_namespaces(db: &Db, mut a: Account) -> Result<Account> {
    a.namespaces = db.with(|c| {
        let mut st = c.prepare("SELECT ns FROM ns_github_accounts WHERE account_id = ?1 ORDER BY ns")?;
        let v = st.query_map([&a.id], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(v)
    })?;
    Ok(a)
}

pub fn list(db: &Db) -> Result<Vec<Account>> {
    let all = db.with(|c| {
        let mut st = c.prepare(&format!("SELECT {COLS} FROM github_accounts ORDER BY created_at, label"))?;
        let v = st.query_map([], row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(v)
    })?;
    all.into_iter().map(|a| with_namespaces(db, a)).collect()
}

pub fn get(db: &Db, id: &str) -> Result<Account> {
    let a = db.with(|c| {
        c.query_row(&format!("SELECT {COLS} FROM github_accounts WHERE id = ?1"), [id], row)
            .map_err(|_| KalypsoError::NotFound(format!("GitHub account {id}")))
    })?;
    with_namespaces(db, a)
}

/// Accounts a namespace may use.
pub fn for_ns(db: &Db, ns: &str) -> Result<Vec<Account>> {
    Ok(list(db)?.into_iter().filter(|a| a.namespaces.iter().any(|n| n == ns)).collect())
}

fn expiry(secs: Option<i64>) -> Option<String> {
    secs.filter(|s| *s > 0).map(|s| (chrono::Utc::now() + chrono::Duration::seconds(s)).to_rfc3339())
}

/// Connect an account from a token: check it with GitHub, then store it. With `replace`, the
/// token goes to that existing account instead (Reconnect), which must be the same login.
#[allow(clippy::too_many_arguments)]
pub async fn connect(
    db: &Db,
    vault: &Vault,
    gh: &GitHub,
    label: &str,
    kind: &str,
    tokens: TokenSet,
    namespaces: &[String],
    replace: Option<&str>,
) -> Result<Account> {
    let who = gh.whoami(&tokens.access_token).await?;
    let (tok, tok_n) = vault.seal_user(&tokens.access_token)?;
    let refresh = tokens.refresh_token.as_deref().map(|r| vault.seal_user(r)).transpose()?;
    let (ref_ct, ref_n) = refresh.map(|(a, b)| (Some(a), Some(b))).unwrap_or((None, None));
    let orgs = serde_json::to_string(&who.orgs).unwrap_or_else(|_| "[]".into());
    let now = chrono::Utc::now().to_rfc3339();
    let id = match replace {
        Some(id) => {
            let old = get(db, id)?;
            if !old.login.eq_ignore_ascii_case(&who.login) {
                return Err(KalypsoError::Invalid(format!(
                    "That token belongs to {}, not {}. Connect it as a new account instead.",
                    who.login, old.login
                )));
            }
            db.with(|c| {
                c.execute(
                    "UPDATE github_accounts SET kind=?2, token=?3, token_nonce=?4, refresh=?5, refresh_nonce=?6, expires_at=?7, refresh_expires_at=?8,
                     scopes=?9, orgs=?10, avatar_url=?11, status='ok', status_reason=NULL, checked_at=?12 WHERE id=?1",
                    rusqlite::params![id, kind, tok, tok_n, ref_ct, ref_n, expiry(tokens.expires_in), expiry(tokens.refresh_token_expires_in), who.scopes.join(","), orgs, who.avatar_url, now],
                )?;
                Ok(())
            })?;
            db.audit(None, "user", "github.reconnect", &who.login)?;
            id.to_string()
        }
        None => {
            let id = new_id("gha");
            let label = if label.trim().is_empty() { who.login.clone() } else { label.trim().to_string() };
            db.with(|c| {
                c.execute(
                    "INSERT INTO github_accounts (id, label, login, avatar_url, kind, token, token_nonce, refresh, refresh_nonce, expires_at, refresh_expires_at, scopes, orgs, checked_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                    rusqlite::params![id, label, who.login, who.avatar_url, kind, tok, tok_n, ref_ct, ref_n, expiry(tokens.expires_in), expiry(tokens.refresh_token_expires_in), who.scopes.join(","), orgs, now],
                )?;
                Ok(())
            })?;
            db.audit(None, "user", "github.connect", &who.login)?;
            set_namespaces(db, &id, namespaces)?;
            id
        }
    };
    get(db, &id)
}

pub fn rename(db: &Db, id: &str, label: &str) -> Result<Account> {
    let label = label.trim();
    if label.is_empty() || label.len() > 40 {
        return Err(KalypsoError::Invalid("Give the account a name of 1 to 40 characters.".into()));
    }
    db.with(|c| Ok(c.execute("UPDATE github_accounts SET label = ?2 WHERE id = ?1", [id, label])?))?;
    get(db, id)
}

pub fn set_namespaces(db: &Db, id: &str, namespaces: &[String]) -> Result<()> {
    db.with(|c| {
        c.execute("DELETE FROM ns_github_accounts WHERE account_id = ?1", [id])?;
        for ns in namespaces {
            c.execute("INSERT OR IGNORE INTO ns_github_accounts (ns, account_id) SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM namespaces WHERE id = ?1)", [ns, id])?;
        }
        Ok(())
    })?;
    db.audit(None, "user", "github.namespaces", &format!("{id}: {}", namespaces.join(", ")))
}

pub fn remove(db: &Db, id: &str) -> Result<()> {
    let a = get(db, id)?;
    db.with(|c| Ok(c.execute("DELETE FROM github_accounts WHERE id = ?1", [id])?))?;
    db.audit(None, "user", "github.disconnect", &a.login)
}

fn mark_reconnect(db: &Db, id: &str, reason: &str) -> Result<()> {
    db.with(|c| {
        Ok(c.execute(
            "UPDATE github_accounts SET status='reconnect', status_reason=?2, checked_at=?3 WHERE id=?1",
            [id, reason, &chrono::Utc::now().to_rfc3339()],
        )?)
    })?;
    Ok(())
}

/// The account's current token, refreshed first when it's about to expire. Only the core ever
/// holds it; the plaintext is wiped when dropped.
pub async fn token(db: &Db, vault: &Vault, gh: &GitHub, id: &str) -> Result<Zeroizing<String>> {
    type Sealed = (Vec<u8>, Vec<u8>, Option<Vec<u8>>, Option<Vec<u8>>, Option<String>, String);
    let (ct, n, rct, rn, expires, status): Sealed = db.with(|c| {
        c.query_row("SELECT token, token_nonce, refresh, refresh_nonce, expires_at, status FROM github_accounts WHERE id=?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
        })
        .map_err(|_| KalypsoError::NotFound(format!("GitHub account {id}")))
    })?;
    if status == "reconnect" {
        return Err(KalypsoError::Invalid("This GitHub account needs reconnecting (Settings → Accounts).".into()));
    }
    let due = expires
        .as_deref()
        .and_then(|e| chrono::DateTime::parse_from_rfc3339(e).ok())
        .is_some_and(|e| e.with_timezone(&chrono::Utc) - REFRESH_AHEAD <= chrono::Utc::now());
    if !due {
        return vault.open_user(&ct, &n);
    }
    // Expiring soon: trade the refresh token for a new pair.
    let (Some(rct), Some(rn), Some(cid)) = (rct, rn, client_id(db)) else {
        mark_reconnect(db, id, "The token expired and can't be refreshed.")?;
        return Err(KalypsoError::Invalid("This GitHub account's token expired. Reconnect it in Settings → Accounts.".into()));
    };
    let refresh = vault.open_user(&rct, &rn)?;
    match gh.refresh(&cid, &refresh).await? {
        Ok(t) => {
            let (tok, tok_n) = vault.seal_user(&t.access_token)?;
            let (ref_ct, ref_n) = match t.refresh_token.as_deref() {
                Some(r) => {
                    let (a, b) = vault.seal_user(r)?;
                    (Some(a), Some(b))
                }
                None => (None, None),
            };
            db.with(|c| {
                c.execute(
                    "UPDATE github_accounts SET token=?2, token_nonce=?3, refresh=?4, refresh_nonce=?5, expires_at=?6, refresh_expires_at=?7 WHERE id=?1",
                    rusqlite::params![id, tok, tok_n, ref_ct, ref_n, expiry(t.expires_in), expiry(t.refresh_token_expires_in)],
                )?;
                Ok(())
            })?;
            db.audit(None, "core", "github.refresh", id)?;
            Ok(Zeroizing::new(t.access_token))
        }
        Err(_) => {
            mark_reconnect(db, id, "GitHub didn't renew the token.")?;
            Err(KalypsoError::Invalid("GitHub didn't renew this account's token. Reconnect it in Settings → Accounts.".into()))
        }
    }
}

/// Check an account with GitHub: refresh its token if needed and update who it is. A refused
/// token marks the account "reconnect" rather than failing silently later.
pub async fn check(db: &Db, vault: &Vault, gh: &GitHub, id: &str) -> Result<Account> {
    let now = chrono::Utc::now().to_rfc3339();
    let tok = match token(db, vault, gh, id).await {
        Ok(t) => t,
        Err(_) => return get(db, id),
    };
    match gh.whoami(&tok).await {
        Ok(who) => {
            let orgs = serde_json::to_string(&who.orgs).unwrap_or_else(|_| "[]".into());
            db.with(|c| {
                c.execute(
                    "UPDATE github_accounts SET login=?2, avatar_url=?3, scopes=?4, orgs=?5, status='ok', status_reason=NULL, checked_at=?6 WHERE id=?1",
                    rusqlite::params![id, who.login, who.avatar_url, who.scopes.join(","), orgs, now],
                )?;
                Ok(())
            })?;
        }
        Err(GhError::Unauthorized) => {
            mark_reconnect(db, id, "GitHub no longer accepts this token. It was revoked or expired.")?;
            db.audit(None, "core", "github.revoked", id)?;
        }
        // Offline or GitHub unwell: keep the account as it was.
        Err(GhError::Other(_)) => {}
    }
    get(db, id)
}

/// Check every account, as KALYPSO starts.
pub async fn check_all(db: &Db, vault: &Vault, gh: &GitHub) {
    let Ok(all) = list(db) else { return };
    for a in all {
        if let Err(e) = check(db, vault, gh, &a.id).await {
            tracing::warn!(account = %a.login, error = %e, "could not check GitHub account");
        }
    }
}

/// Repositories a namespace can reach, across every account it may use, filtered by `query`.
pub async fn repos(db: &Db, vault: &Vault, gh: &GitHub, ns: &str, query: &str) -> Result<Vec<Repo>> {
    let q = query.trim().to_lowercase();
    let mut out = Vec::new();
    for a in for_ns(db, ns)?.into_iter().filter(|a| a.status == "ok") {
        let tok = token(db, vault, gh, &a.id).await?;
        let list = match gh.repos(&tok).await {
            Ok(l) => l,
            Err(GhError::Unauthorized) => {
                mark_reconnect(db, &a.id, "GitHub no longer accepts this token. It was revoked or expired.")?;
                continue;
            }
            Err(GhError::Other(m)) => return Err(KalypsoError::Invalid(m)),
        };
        out.extend(
            list.into_iter()
                .filter(|(name, _, _, desc)| {
                    q.is_empty() || name.to_lowercase().contains(&q) || desc.as_deref().is_some_and(|d| d.to_lowercase().contains(&q))
                })
                .map(|(full_name, private, default_branch, description)| Repo {
                    account_id: a.id.clone(),
                    account_label: a.label.clone(),
                    full_name,
                    private,
                    default_branch,
                    description,
                }),
        );
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::{Form, State};
    use axum::http::{HeaderMap, StatusCode as S};
    use axum::response::IntoResponse;
    use axum::routing::{get as aget, post};
    use axum::{Json, Router};
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    /// A stand-in for GitHub: tokens it accepts, and a device flow that approves on the second poll.
    #[derive(Default)]
    struct Fake {
        good: Vec<String>,
        polls: u32,
        refreshed: u32,
    }
    type F = Arc<Mutex<Fake>>;

    fn bearer(h: &HeaderMap) -> String {
        h.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("").trim_start_matches("Bearer ").to_string()
    }

    async fn user(State(f): State<F>, h: HeaderMap) -> axum::response::Response {
        let t = bearer(&h);
        if !f.lock().unwrap().good.contains(&t) {
            return S::UNAUTHORIZED.into_response();
        }
        let login = if t.starts_with("work") { "ada-work" } else { "ada" };
        ([("x-oauth-scopes", "repo, read:org")], Json(serde_json::json!({ "login": login, "avatar_url": null }))).into_response()
    }
    async fn orgs(State(f): State<F>, h: HeaderMap) -> axum::response::Response {
        if !f.lock().unwrap().good.contains(&bearer(&h)) {
            return S::UNAUTHORIZED.into_response();
        }
        Json(serde_json::json!([{ "login": "acme" }])).into_response()
    }
    async fn user_repos(State(f): State<F>, h: HeaderMap) -> axum::response::Response {
        let t = bearer(&h);
        if !f.lock().unwrap().good.contains(&t) {
            return S::UNAUTHORIZED.into_response();
        }
        let who = if t.starts_with("work") { "ada-work" } else { "ada" };
        Json(serde_json::json!([
            { "full_name": format!("{who}/notes"), "private": true, "default_branch": "main", "description": "my notes" },
            { "full_name": "acme/platform", "private": true, "default_branch": "main", "description": "the platform" },
        ]))
        .into_response()
    }
    async fn device_code() -> Json<serde_json::Value> {
        Json(
            serde_json::json!({ "device_code": "dev-1", "user_code": "ABCD-1234", "verification_uri": "https://github.com/login/device", "expires_in": 900, "interval": 5 }),
        )
    }
    async fn access_token(State(f): State<F>, Form(form): Form<HashMap<String, String>>) -> Json<serde_json::Value> {
        let mut f = f.lock().unwrap();
        if form.get("grant_type").map(String::as_str) == Some("refresh_token") {
            f.refreshed += 1;
            f.good.push("gho_refreshed".into());
            return Json(serde_json::json!({ "access_token": "gho_refreshed", "refresh_token": "ghr_2", "expires_in": 28800 }));
        }
        f.polls += 1;
        if f.polls < 2 {
            return Json(serde_json::json!({ "error": "authorization_pending" }));
        }
        f.good.push("gho_signed_in".into());
        Json(
            serde_json::json!({ "access_token": "gho_signed_in", "refresh_token": "ghr_1", "expires_in": 28800, "refresh_token_expires_in": 15552000 }),
        )
    }

    async fn fake() -> (GitHub, F) {
        let f: F = Arc::new(Mutex::new(Fake { good: vec!["ghp_personal".into(), "work_pat".into()], ..Default::default() }));
        let app = Router::new()
            .route("/user", aget(user))
            .route("/user/orgs", aget(orgs))
            .route("/user/repos", aget(user_repos))
            .route("/login/device/code", post(device_code))
            .route("/login/oauth/access_token", post(access_token))
            .with_state(f.clone());
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", l.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        (GitHub::new(&url, &url), f)
    }

    fn env() -> (Db, Vault) {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| Ok(c.execute_batch("INSERT INTO namespaces (id, name) VALUES ('work','work'), ('personal','personal');")?)).unwrap();
        db.set_setting("github.client_id", &serde_json::json!("Iv1.test")).unwrap();
        (db, Vault::ephemeral())
    }

    fn pat(t: &str) -> TokenSet {
        TokenSet { access_token: t.into(), refresh_token: None, expires_in: None, refresh_token_expires_in: None }
    }

    #[tokio::test]
    async fn two_accounts_sign_in_and_token_with_org_repos() {
        let (gh, _f) = fake().await;
        let (db, vault) = env();
        // One by token...
        let a = connect(&db, &vault, &gh, "personal", "token", pat("ghp_personal"), &["personal".into()], None).await.unwrap();
        assert_eq!(a.login, "ada");
        assert_eq!(a.orgs, vec!["acme"]);
        assert_eq!(a.scopes, vec!["repo", "read:org"]);
        // ...one by signing in.
        let cid = client_id(&db).unwrap();
        let start = gh.device_start(&cid).await.unwrap();
        assert_eq!(start.user_code, "ABCD-1234");
        assert_eq!(gh.device_poll(&cid, &start.device_code).await.unwrap().unwrap_err(), "pending");
        let t = gh.device_poll(&cid, &start.device_code).await.unwrap().unwrap();
        let b = connect(&db, &vault, &gh, "", "oauth", t, &["work".into()], None).await.unwrap();
        assert_eq!(b.label, "ada", "label defaults to the login");
        assert!(b.expires_at.is_some());

        // Each namespace sees only its own accounts' repos, including organisation repos.
        let work = repos(&db, &vault, &gh, "work", "").await.unwrap();
        assert!(work.iter().all(|r| r.account_id == b.id));
        assert!(work.iter().any(|r| r.full_name == "acme/platform"));
        let found = repos(&db, &vault, &gh, "personal", "notes").await.unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].full_name, "ada/notes");

        // Tokens are sealed at rest, never stored in the clear.
        let raw: Vec<u8> = db.with(|c| Ok(c.query_row("SELECT token FROM github_accounts WHERE id=?1", [&a.id], |r| r.get(0))?)).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("ghp_personal"));
    }

    #[tokio::test]
    async fn a_revoked_token_asks_to_reconnect_and_reconnect_fixes_it() {
        let (gh, f) = fake().await;
        let (db, vault) = env();
        let a = connect(&db, &vault, &gh, "mine", "token", pat("ghp_personal"), &[], None).await.unwrap();
        f.lock().unwrap().good.retain(|t| t != "ghp_personal");
        let checked = check(&db, &vault, &gh, &a.id).await.unwrap();
        assert_eq!(checked.status, "reconnect");
        assert!(token(&db, &vault, &gh, &a.id).await.is_err());

        // A token for someone else can't reconnect this account.
        assert!(connect(&db, &vault, &gh, "", "token", pat("work_pat"), &[], Some(&a.id)).await.is_err());
        f.lock().unwrap().good.push("ghp_new".into());
        let back = connect(&db, &vault, &gh, "", "token", pat("ghp_new"), &[], Some(&a.id)).await.unwrap();
        assert_eq!(back.status, "ok");
        assert_eq!(back.label, "mine", "reconnecting keeps the name");
        assert_eq!(&*token(&db, &vault, &gh, &a.id).await.unwrap(), "ghp_new");
    }

    #[tokio::test]
    async fn an_expiring_token_is_refreshed_before_use() {
        let (gh, f) = fake().await;
        let (db, vault) = env();
        let t = TokenSet {
            access_token: "ghp_personal".into(),
            refresh_token: Some("ghr_1".into()),
            expires_in: Some(60),
            refresh_token_expires_in: None,
        };
        let a = connect(&db, &vault, &gh, "", "oauth", t, &[], None).await.unwrap();
        // Expires within the refresh window, so the next use refreshes it.
        assert_eq!(&*token(&db, &vault, &gh, &a.id).await.unwrap(), "gho_refreshed");
        assert_eq!(f.lock().unwrap().refreshed, 1);
        assert_eq!(&*token(&db, &vault, &gh, &a.id).await.unwrap(), "gho_refreshed");
        assert_eq!(f.lock().unwrap().refreshed, 1, "a fresh token isn't refreshed again");
    }

    #[tokio::test]
    async fn rename_namespaces_and_disconnect() {
        let (gh, _f) = fake().await;
        let (db, vault) = env();
        let a = connect(&db, &vault, &gh, "", "token", pat("ghp_personal"), &["work".into(), "nope".into()], None).await.unwrap();
        assert_eq!(a.namespaces, vec!["work"], "unknown namespaces are ignored");
        assert_eq!(rename(&db, &a.id, " personal ").unwrap().label, "personal");
        assert!(rename(&db, &a.id, "").is_err());
        set_namespaces(&db, &a.id, &["personal".into()]).unwrap();
        assert!(for_ns(&db, "work").unwrap().is_empty());
        remove(&db, &a.id).unwrap();
        assert!(list(&db).unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_bad_token_is_refused_on_connect() {
        let (gh, _f) = fake().await;
        let (db, vault) = env();
        let e = connect(&db, &vault, &gh, "", "token", pat("nope"), &[], None).await.unwrap_err();
        assert!(e.to_string().contains("didn't accept"));
        assert!(list(&db).unwrap().is_empty());
    }
}
