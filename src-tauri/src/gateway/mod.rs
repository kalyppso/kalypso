//! Model gateway: a local proxy every model request goes through.
//!
//! Callers present a KALYPSO virtual key. The gateway swaps it for the
//! namespace's real provider key (a `gateway`-scoped secret, never delivered to
//! sandboxes), streams the response back untouched, reads the token usage out of
//! it, prices it from `pricing.toml` and writes a `usage_events` row.
//!
//! Routes mirror each provider's SDK base URL: `/<provider>/<path>` is sent to
//! `<PROVIDER>_BASE_URL/<path>`. Anthropic and OpenAI have built-in base URLs;
//! any other OpenAI-compatible provider needs `<PROVIDER>_BASE_URL` set.

pub mod pricing;
pub mod usage;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::StreamExt;
use rand::RngCore;
use rusqlite::OptionalExtension;
use serde::Serialize;
use sha2::{Digest, Sha256};
use ts_rs::TS;

use crate::error::{KalypsoError, Result};
use crate::store::Db;
use crate::vault::Vault;
use pricing::Pricing;
use usage::{Format, Meter, Usage};

/// Preferred port on 127.0.0.1; a free one is used if it is taken.
pub const DEFAULT_PORT: u16 = 47821;
/// The host name sandboxes use; the socket decides where it goes, not DNS.
pub const SANDBOX_URL: &str = "http://gateway.kalypso";
/// Where sandboxes find the gateway socket.
pub const SANDBOX_SOCKET_DIR: &str = "/run/kalypso/gateway";
const MAX_REQUEST: usize = 64 << 20;

static SOCKET_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Host folder holding the gateway socket, once the gateway listens on one.
/// Sandbox providers mount it at [`SANDBOX_SOCKET_DIR`].
pub fn socket_dir() -> Option<&'static PathBuf> {
    SOCKET_DIR.get()
}

/// Built-in upstreams; anything else needs `<PROVIDER>_BASE_URL`.
fn default_base(provider: &str) -> Option<&'static str> {
    match provider {
        "anthropic" => Some("https://api.anthropic.com"),
        "openai" => Some("https://api.openai.com/v1"),
        _ => None,
    }
}

/// `open-router` → `OPEN_ROUTER`, the prefix of its secrets.
fn secret_prefix(provider: &str) -> String {
    provider.to_ascii_uppercase().replace('-', "_")
}

// ---------- Virtual keys ----------

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct GatewayKey {
    pub id: String,
    pub ns: String,
    pub sandbox_id: Option<String>,
    pub label: String,
    pub created_at: String,
    pub revoked_at: Option<String>,
}

/// A new key and its secret value, which is shown once and stored only as a hash.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct MintedKey {
    pub key: GatewayKey,
    pub token: String,
}

fn hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

fn new_token() -> String {
    let mut b = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut b);
    format!("kx_{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>())
}

pub fn mint(db: &Db, ns: &str, sandbox_id: Option<&str>, label: &str) -> Result<MintedKey> {
    let label = label.trim();
    if label.is_empty() || label.len() > 64 {
        return Err(KalypsoError::Invalid("key labels are 1 to 64 characters".into()));
    }
    let token = new_token();
    let id = crate::vault::new_id("gk");
    db.with(|c| {
        c.execute(
            "INSERT INTO gateway_keys (id, ns, sandbox_id, label, hash) VALUES (?1, ?2, ?3, ?4, ?5)",
            (&id, ns, sandbox_id, label, hash(&token)),
        )?;
        Ok(())
    })?;
    db.audit(Some(ns), if sandbox_id.is_some() { "kalypso" } else { "user" }, "gateway.key.create", label)?;
    let key = list_keys(db, ns)?.into_iter().find(|k| k.id == id).ok_or_else(|| KalypsoError::NotFound(id))?;
    Ok(MintedKey { key, token })
}

/// A fresh key for a sandbox, revoking the ones it had. Called on every secret delivery.
pub fn mint_for_sandbox(db: &Db, ns: &str, sandbox_id: &str, name: &str) -> Result<String> {
    db.with(|c| {
        c.execute(
            "UPDATE gateway_keys SET revoked_at = CURRENT_TIMESTAMP WHERE ns = ?1 AND sandbox_id = ?2 AND revoked_at IS NULL",
            (ns, sandbox_id),
        )?;
        Ok(())
    })?;
    Ok(mint(db, ns, Some(sandbox_id), name)?.token)
}

pub fn list_keys(db: &Db, ns: &str) -> Result<Vec<GatewayKey>> {
    db.with(|c| {
        let mut st = c.prepare(
            "SELECT id, ns, sandbox_id, label, created_at, revoked_at FROM gateway_keys WHERE ns = ?1 ORDER BY created_at DESC, id",
        )?;
        let rows = st.query_map([ns], |r| {
            Ok(GatewayKey {
                id: r.get(0)?,
                ns: r.get(1)?,
                sandbox_id: r.get(2)?,
                label: r.get(3)?,
                created_at: r.get(4)?,
                revoked_at: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    })
}

pub fn revoke_key(db: &Db, ns: &str, id: &str) -> Result<()> {
    let n = db.with(|c| {
        Ok(c.execute("UPDATE gateway_keys SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP) WHERE id = ?1 AND ns = ?2", (id, ns))?)
    })?;
    if n == 0 {
        return Err(KalypsoError::NotFound(format!("gateway key {id} in {ns}")));
    }
    db.audit(Some(ns), "user", "gateway.key.revoke", id)
}

/// Who a token belongs to: (key id, namespace, label).
fn resolve(db: &Db, token: &str) -> Result<Option<(String, String, String)>> {
    db.with(|c| {
        Ok(c.query_row("SELECT id, ns, label FROM gateway_keys WHERE hash = ?1 AND revoked_at IS NULL", [hash(token)], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .optional()?)
    })
}

// ---------- Usage ----------

/// Sent to the UI after every metered request.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct UsageEvent {
    pub ns: String,
    pub source: String,
    pub provider: String,
    pub model: String,
    pub status: u16,
    #[ts(type = "number")]
    pub input_tokens: u64,
    #[ts(type = "number")]
    pub output_tokens: u64,
    #[ts(type = "number")]
    pub cache_write: u64,
    #[ts(type = "number")]
    pub cache_read: u64,
    /// Millionths of a US dollar; `null` when the model has no price.
    #[ts(type = "number | null")]
    pub cost_micros: Option<i64>,
    #[ts(type = "number")]
    pub latency_ms: u64,
}

fn record(db: &Db, key_id: &str, stream: bool, ev: &UsageEvent) -> Result<()> {
    db.with(|c| {
        c.execute(
            "INSERT INTO usage_events (ns, key_id, source, provider, model, status, stream, input_tokens, output_tokens,
               cache_write, cache_read, cost_micros, priced, latency_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            rusqlite::params![
                ev.ns,
                key_id,
                ev.source,
                ev.provider,
                ev.model,
                ev.status,
                stream,
                ev.input_tokens as i64,
                ev.output_tokens as i64,
                ev.cache_write as i64,
                ev.cache_read as i64,
                ev.cost_micros.unwrap_or(0),
                ev.cost_micros.is_some(),
                ev.latency_ms as i64,
            ],
        )?;
        Ok(())
    })
}

#[derive(Debug, Clone, Default, Serialize, TS)]
#[ts(export)]
pub struct UsageTotals {
    #[ts(type = "number")]
    pub requests: i64,
    #[ts(type = "number")]
    pub errors: i64,
    #[ts(type = "number")]
    pub input_tokens: i64,
    #[ts(type = "number")]
    pub output_tokens: i64,
    #[ts(type = "number")]
    pub cache_write: i64,
    #[ts(type = "number")]
    pub cache_read: i64,
    #[ts(type = "number")]
    pub cost_micros: i64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct UsageGroup {
    /// A day (YYYY-MM-DD), a model, or a source, depending on the list.
    pub name: String,
    pub totals: UsageTotals,
}

/// Spend for one source on one day, for stacked charts.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct UsageCell {
    pub day: String,
    pub source: String,
    #[ts(type = "number")]
    pub cost_micros: i64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct UsageSummary {
    pub days: u32,
    pub totals: UsageTotals,
    pub by_day: Vec<UsageGroup>,
    pub by_model: Vec<UsageGroup>,
    pub by_source: Vec<UsageGroup>,
    pub by_day_source: Vec<UsageCell>,
    /// Models that were used but have no price in pricing.toml.
    pub unpriced: Vec<String>,
}

const TOTALS: &str = "count(*), sum(status >= 400), coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0),
    coalesce(sum(cache_write), 0), coalesce(sum(cache_read), 0), coalesce(sum(cost_micros), 0)";

fn totals(r: &rusqlite::Row, at: usize) -> rusqlite::Result<UsageTotals> {
    Ok(UsageTotals {
        requests: r.get(at)?,
        errors: r.get::<_, Option<i64>>(at + 1)?.unwrap_or(0),
        input_tokens: r.get(at + 2)?,
        output_tokens: r.get(at + 3)?,
        cache_write: r.get(at + 4)?,
        cache_read: r.get(at + 5)?,
        cost_micros: r.get(at + 6)?,
    })
}

/// Spend over the last `days` days, for one namespace or (with `None`) all of them.
pub fn summary(db: &Db, ns: Option<&str>, days: u32) -> Result<UsageSummary> {
    let days = days.clamp(1, 366);
    let since = format!("-{} days", days - 1);
    let filter = "(?1 IS NULL OR ns = ?1) AND ts >= date('now', ?2)";
    db.with(|c| {
        let total = c.query_row(&format!("SELECT {TOTALS} FROM usage_events WHERE {filter}"), (ns, &since), |r| totals(r, 0))?;
        let group = |expr: &str, order: &str| -> Result<Vec<UsageGroup>> {
            let sql = format!("SELECT {expr}, {TOTALS} FROM usage_events WHERE {filter} GROUP BY 1 ORDER BY {order}");
            let mut st = c.prepare(&sql)?;
            let rows = st.query_map((ns, &since), |r| Ok(UsageGroup { name: r.get(0)?, totals: totals(r, 1)? }))?;
            Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
        };
        let by_day = group("date(ts)", "1")?;
        let by_model = group("model", "8 DESC, 2 DESC")?;
        let by_source = group("source", "8 DESC, 2 DESC")?;
        let mut st =
            c.prepare(&format!("SELECT date(ts), source, sum(cost_micros) FROM usage_events WHERE {filter} GROUP BY 1, 2 ORDER BY 1, 2"))?;
        let by_day_source = st
            .query_map((ns, &since), |r| Ok(UsageCell { day: r.get(0)?, source: r.get(1)?, cost_micros: r.get(2)? }))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut st = c.prepare(&format!(
            "SELECT DISTINCT model FROM usage_events WHERE {filter} AND priced = 0 AND (input_tokens + output_tokens) > 0 ORDER BY 1"
        ))?;
        let unpriced = st.query_map((ns, &since), |r| r.get(0))?.collect::<std::result::Result<Vec<String>, _>>()?;
        Ok(UsageSummary { days, totals: total, by_day, by_model, by_source, by_day_source, unpriced })
    })
}

// ---------- Server ----------

pub struct Gateway {
    db: Arc<Db>,
    vault: Arc<Vault>,
    pub pricing: Pricing,
    http: reqwest::Client,
    addr: Mutex<Option<SocketAddr>>,
    events: tokio::sync::broadcast::Sender<UsageEvent>,
}

/// Where the gateway listens, for the UI and for local tools.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct GatewayInfo {
    pub url: Option<String>,
    pub sandbox_url: Option<String>,
    pub pricing_path: Option<String>,
}

impl Gateway {
    pub fn new(db: Arc<Db>, vault: Arc<Vault>, pricing: Pricing) -> Arc<Self> {
        let http = reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(15)).build().expect("HTTP client builds");
        Arc::new(Self { db, vault, pricing, http, addr: Mutex::new(None), events: tokio::sync::broadcast::channel(256).0 })
    }

    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<UsageEvent> {
        self.events.subscribe()
    }

    pub fn info(&self) -> GatewayInfo {
        GatewayInfo {
            url: self.addr.lock().unwrap().map(|a| format!("http://{a}")),
            sandbox_url: socket_dir().map(|_| SANDBOX_URL.to_string()),
            pricing_path: self.pricing.path().map(|p| p.display().to_string()),
        }
    }

    pub fn router(self: &Arc<Self>) -> Router {
        Router::new()
            .route("/health", get(|| async { "ok" }))
            .fallback(proxy)
            .layer(DefaultBodyLimit::max(MAX_REQUEST))
            .with_state(self.clone())
    }

    /// Listen on 127.0.0.1, on [`DEFAULT_PORT`] when it is free.
    pub async fn listen_tcp(self: &Arc<Self>, port: u16) -> std::io::Result<SocketAddr> {
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => l,
            Err(e) if port != 0 => {
                tracing::warn!(port, error = %e, "gateway port is taken, using a free one");
                tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?
            }
            Err(e) => return Err(e),
        };
        let addr = listener.local_addr()?;
        *self.addr.lock().unwrap() = Some(addr);
        let app = self.router();
        tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                tracing::error!(error = %e, "gateway stopped");
            }
        });
        tracing::info!(%addr, "model gateway listening");
        Ok(addr)
    }

    /// Also listen on `<dir>/gateway.sock`, the socket sandboxes get mounted.
    #[cfg(unix)]
    pub async fn listen_unix(self: &Arc<Self>, dir: PathBuf) -> std::io::Result<()> {
        use std::os::unix::fs::PermissionsExt;
        // Open to every user: agents run as non-root users inside sandboxes, which
        // rootless engines map to other host uids. The virtual key is the access check,
        // as it is on the TCP port.
        std::fs::create_dir_all(&dir)?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755))?;
        let path = dir.join("gateway.sock");
        let _ = std::fs::remove_file(&path); // left over from the last run
        let listener = tokio::net::UnixListener::bind(&path)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666))?;
        let _ = SOCKET_DIR.set(dir);
        let app = self.router();
        tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                tracing::error!(error = %e, "gateway socket stopped");
            }
        });
        tracing::info!(path = %path.display(), "model gateway socket ready");
        Ok(())
    }
}

/// An error in the shape the caller's SDK expects, so it surfaces a readable message.
fn fail(format: Format, status: StatusCode, message: &str) -> Response {
    let body = match format {
        Format::Anthropic => serde_json::json!({
            "type": "error",
            "error": { "type": if status == StatusCode::UNAUTHORIZED { "authentication_error" } else { "invalid_request_error" }, "message": message },
        }),
        Format::OpenAi => serde_json::json!({ "error": { "message": message, "type": "invalid_request_error", "code": status.as_u16() } }),
    };
    (status, axum::Json(body)).into_response()
}

fn token(headers: &HeaderMap) -> Option<&str> {
    if let Some(v) = headers.get("x-api-key").and_then(|v| v.to_str().ok()) {
        return Some(v.trim());
    }
    let auth = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    auth.strip_prefix("Bearer ").or_else(|| auth.strip_prefix("bearer ")).map(str::trim)
}

/// Headers that describe this hop or carry the caller's key; never forwarded.
fn hop_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "host"
            | "connection"
            | "keep-alive"
            | "proxy-connection"
            | "transfer-encoding"
            | "te"
            | "trailer"
            | "upgrade"
            | "content-length"
            | "authorization"
            | "x-api-key"
            | "accept-encoding"
            | "proxy-authorization"
    )
}

struct Call {
    gw: Arc<Gateway>,
    key_id: String,
    ns: String,
    source: String,
    provider: String,
    model: String,
    stream: bool,
    started: Instant,
}

impl Call {
    fn finish(&self, status: u16, usage: Option<Usage>, model: Option<String>) {
        let u = usage.unwrap_or_default();
        let model = model.unwrap_or_else(|| self.model.clone());
        let cost = if usage.is_some() { self.gw.pricing.table().cost_micros(&model, &u) } else { Some(0) };
        let ev = UsageEvent {
            ns: self.ns.clone(),
            source: self.source.clone(),
            provider: self.provider.clone(),
            model,
            status,
            input_tokens: u.input,
            output_tokens: u.output,
            cache_write: u.cache_write_5m + u.cache_write_1h,
            cache_read: u.cache_read,
            cost_micros: cost,
            latency_ms: self.started.elapsed().as_millis() as u64,
        };
        if let Err(e) = record(&self.gw.db, &self.key_id, self.stream, &ev) {
            tracing::error!(error = %e, "could not record model usage");
        }
        let _ = self.gw.events.send(ev);
    }
}

/// Records the call when the response body is finished or abandoned.
struct Metered {
    call: Call,
    status: u16,
    meter: Option<Meter>,
}

impl Drop for Metered {
    fn drop(&mut self) {
        let (usage, model) = self.meter.take().map(Meter::finish).unwrap_or((None, None));
        self.call.finish(self.status, usage, model);
    }
}

async fn proxy(State(gw): State<Arc<Gateway>>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let path = parts.uri.path().trim_start_matches('/');
    let (provider, rest) = path.split_once('/').unwrap_or((path, ""));
    let format = if provider == "anthropic" { Format::Anthropic } else { Format::OpenAi };
    let provider_ok =
        (1..=32).contains(&provider.len()) && provider.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !provider_ok {
        return fail(format, StatusCode::NOT_FOUND, "use /<provider>/<path>, for example /anthropic/v1/messages");
    }

    let Some(tok) = token(&parts.headers) else {
        return fail(format, StatusCode::UNAUTHORIZED, "missing KALYPSO gateway key (x-api-key or Authorization: Bearer)");
    };
    let (key_id, ns, source) = match resolve(&gw.db, tok) {
        Ok(Some(k)) => k,
        Ok(None) => return fail(format, StatusCode::UNAUTHORIZED, "unknown or revoked KALYPSO gateway key"),
        Err(e) => return fail(format, StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    };

    let prefix = secret_prefix(provider);
    let lookup = |key: String| gw.vault.lookup(&gw.db, &ns, &key);
    let base = match lookup(format!("{prefix}_BASE_URL")) {
        Ok(Some(b)) => b,
        Ok(None) => match default_base(provider) {
            Some(b) => b.to_string(),
            None => {
                let msg = format!("no {prefix}_BASE_URL secret in namespace {ns}");
                return fail(format, StatusCode::BAD_REQUEST, &msg);
            }
        },
        Err(e) => return fail(format, StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    };
    if !(base.starts_with("https://") || base.starts_with("http://")) {
        return fail(format, StatusCode::BAD_REQUEST, &format!("{prefix}_BASE_URL must start with http:// or https://"));
    }
    let api_key = match lookup(format!("{prefix}_API_KEY")) {
        Ok(k) => k,
        Err(e) => return fail(format, StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    };
    if api_key.is_none() && default_base(provider).is_some() {
        let msg = format!("no {prefix}_API_KEY secret in namespace {ns}; add it with the gateway scope");
        return fail(format, StatusCode::UNAUTHORIZED, &msg);
    }

    let mut bytes = match axum::body::to_bytes(body, MAX_REQUEST).await {
        Ok(b) => b,
        Err(_) => return fail(format, StatusCode::PAYLOAD_TOO_LARGE, "request body is larger than 64 MB"),
    };
    let mut model = String::from("unknown");
    let mut stream = false;
    if let Ok(mut json) = serde_json::from_slice::<serde_json::Value>(&bytes) {
        if let Some(m) = json.get("model").and_then(|m| m.as_str()) {
            model = m.to_string();
        }
        stream = json.get("stream").and_then(|s| s.as_bool()).unwrap_or(false);
        // Chat Completions streams only report usage when asked to.
        if stream && format == Format::OpenAi && rest.ends_with("chat/completions") {
            json["stream_options"]["include_usage"] = serde_json::Value::Bool(true);
            bytes = serde_json::to_vec(&json).unwrap_or_default().into();
        }
    }

    let mut url = format!("{}/{}", base.trim_end_matches('/'), rest);
    if let Some(q) = parts.uri.query() {
        url.push('?');
        url.push_str(q);
    }
    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in &parts.headers {
        if !hop_header(name) {
            headers.append(name.clone(), value.clone());
        }
    }
    if let Some(k) = &api_key {
        let (name, value) = match format {
            Format::Anthropic => (HeaderName::from_static("x-api-key"), HeaderValue::from_str(k)),
            Format::OpenAi => (header::AUTHORIZATION, HeaderValue::from_str(&format!("Bearer {k}"))),
        };
        match value {
            Ok(v) => {
                headers.insert(name, v);
            }
            Err(_) => return fail(format, StatusCode::BAD_REQUEST, &format!("{prefix}_API_KEY is not a valid header value")),
        }
    }

    let call = Call { gw: gw.clone(), key_id, ns, source, provider: provider.to_string(), model, stream, started: Instant::now() };
    let upstream = match gw.http.request(parts.method.clone(), &url).headers(headers).body(bytes).send().await {
        Ok(r) => r,
        Err(e) => {
            call.finish(502, None, None);
            let msg = format!("could not reach {provider}: {e}");
            return fail(format, StatusCode::BAD_GATEWAY, &msg);
        }
    };

    let status = upstream.status();
    let sse =
        upstream.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|ct| ct.starts_with("text/event-stream"));
    let mut builder = Response::builder().status(status);
    for (name, value) in upstream.headers() {
        if !hop_header(name) {
            builder = builder.header(name, value);
        }
    }
    let mut metered = Metered { call, status: status.as_u16(), meter: Some(Meter::new(format, sse)) };
    let body = upstream.bytes_stream().map(move |chunk| {
        if let (Ok(b), Some(m)) = (&chunk, metered.meter.as_mut()) {
            m.feed(b);
        }
        chunk
    });
    builder.body(Body::from_stream(body)).unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
}

#[cfg(test)]
mod tests;
