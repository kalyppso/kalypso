//! The egress proxy (#33): the only way out of an `internet` sandbox.
//!
//! An `internet` sandbox sits on an internal network with no route out. Its only neighbour is
//! the namespace's egress relay (`egress.kalypso`), which forwards to this proxy inside KALYPSO.
//! The sandbox is given `HTTP_PROXY` and `HTTPS_PROXY` with its own credentials, so the proxy
//! knows which sandbox is asking. Every host is checked against the namespace's policies, the
//! same way an agent's tool calls are: a `host` policy's allow-list lets it through, a blocked
//! host is refused, and "Ask before new hosts" holds the connection until you answer.
//!
//! Programs that ignore the proxy settings simply have no route out: it fails closed.
//!
//! Decisions are remembered per sandbox and host for a few minutes, so a page with fifty
//! requests to one host asks once, and the policy judge isn't called per connection.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::gateway::Gateway;

/// The port the relay listens on inside the namespace's egress network.
pub const RELAY_PORT: u16 = 3128;
/// What sandboxes call the relay.
pub const HOST: &str = "egress.kalypso";
/// Preferred host port for VM engines; a free one is used if it is taken.
const PORT: u16 = 47823;
const MAX_HEAD: usize = 16 * 1024;
const ALLOW_FOR: Duration = Duration::from_secs(10 * 60);
const DENY_FOR: Duration = Duration::from_secs(30);

static SECRET: OnceLock<[u8; 32]> = OnceLock::new();
static TCP_PORT: OnceLock<u16> = OnceLock::new();
static SOCKET_DIR: OnceLock<PathBuf> = OnceLock::new();

/// The host port the proxy listens on, for relays on VM engines.
pub fn tcp_port() -> Option<u16> {
    TCP_PORT.get().copied()
}

/// The folder with the proxy's socket, for relays on local engines. Never mounted into sandboxes.
pub fn socket_dir() -> Option<&'static PathBuf> {
    SOCKET_DIR.get()
}

/// Load (or create, the first time) the secret sandbox credentials are derived from.
pub fn init_secret(db: &crate::store::Db) -> crate::error::Result<()> {
    let hex = match db.setting("egress.secret")?.and_then(|v| v.as_str().map(str::to_string)) {
        Some(h) if h.len() == 64 => h,
        _ => {
            use rand::RngCore;
            let mut b = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut b);
            let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
            db.set_setting("egress.secret", &serde_json::Value::String(h.clone()))?;
            h
        }
    };
    let mut key = [0u8; 32];
    for (i, k) in key.iter_mut().enumerate() {
        *k = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
    }
    let _ = SECRET.set(key);
    Ok(())
}

fn hmac(key: &[u8; 32], msg: &[u8]) -> [u8; 32] {
    let mut k = [0u8; 64];
    k[..32].copy_from_slice(key);
    let pad = |b: u8| k.iter().map(|x| x ^ b).collect::<Vec<u8>>();
    let inner = Sha256::new().chain_update(pad(0x36)).chain_update(msg).finalize();
    Sha256::new().chain_update(pad(0x5c)).chain_update(inner).finalize().into()
}

/// A sandbox's proxy password: derived from its id, so nothing is stored per sandbox.
pub fn token_for(sandbox_id: &str) -> Option<String> {
    let key = SECRET.get()?;
    Some(hmac(key, sandbox_id.as_bytes()).iter().map(|b| format!("{b:02x}")).collect())
}

/// The environment an `internet` sandbox gets, or nothing if the proxy isn't running.
pub fn sandbox_env(sandbox_id: &str) -> Vec<String> {
    let Some(token) = token_for(sandbox_id) else { return vec![] };
    let url = format!("http://{sandbox_id}:{token}@{HOST}:{RELAY_PORT}");
    // The gateway and the runner's own local forwarder stay direct.
    let no_proxy = "localhost,127.0.0.1,::1,gateway.kalypso";
    ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]
        .iter()
        .map(|k| format!("{k}={url}"))
        .chain(["NO_PROXY", "no_proxy"].iter().map(|k| format!("{k}={no_proxy}")))
        .collect()
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The request line and headers of a proxy request.
#[derive(Debug, PartialEq)]
struct Head {
    method: String,
    /// `host:port` for CONNECT, an absolute URL otherwise.
    target: String,
    version: String,
    /// (sandbox id, password) from Proxy-Authorization.
    auth: Option<(String, String)>,
    /// Header lines other than the proxy's own, as sent.
    headers: Vec<String>,
}

fn parse_head(raw: &str) -> Option<Head> {
    let mut lines = raw.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, target, version) = (first.next()?.to_string(), first.next()?.to_string(), first.next()?.to_string());
    if !version.starts_with("HTTP/1.") {
        return None;
    }
    let mut auth = None;
    let mut headers = Vec::new();
    for line in lines.filter(|l| !l.is_empty()) {
        let (name, value) = line.split_once(':')?;
        match name.trim().to_ascii_lowercase().as_str() {
            "proxy-authorization" => {
                let encoded = value.trim().strip_prefix("Basic ").or(value.trim().strip_prefix("basic "))?;
                let plain = base64::engine::general_purpose::STANDARD.decode(encoded.trim()).ok()?;
                let plain = String::from_utf8(plain).ok()?;
                let (user, pass) = plain.split_once(':')?;
                auth = Some((user.to_string(), pass.to_string()));
            }
            "proxy-connection" => {}
            _ => headers.push(line.to_string()),
        }
    }
    Some(Head { method, target, version, auth, headers })
}

/// Where a request goes: (host, port, and for plain HTTP the path to send).
fn destination(head: &Head) -> Option<(String, u16, Option<String>)> {
    if head.method.eq_ignore_ascii_case("CONNECT") {
        let (host, port) = split_host_port(&head.target, 443)?;
        return Some((host, port, None));
    }
    let rest = head.target.strip_prefix("http://")?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].to_string()),
        None => (rest, "/".to_string()),
    };
    let (host, port) = split_host_port(authority, 80)?;
    Some((host, port, Some(path)))
}

fn split_host_port(s: &str, default: u16) -> Option<(String, u16)> {
    let s = s.rsplit('@').next()?;
    let (host, port) = if let Some(v6) = s.strip_prefix('[') {
        let (h, rest) = v6.split_once(']')?;
        (h.to_string(), rest.strip_prefix(':').map(|p| p.parse().ok()).unwrap_or(Some(default))?)
    } else {
        match s.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), p.parse().ok()?),
            None => (s.to_string(), default),
        }
    };
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    let ok = !host.is_empty() && host.len() <= 253 && host.chars().all(|c| c.is_ascii_alphanumeric() || "-.:_".contains(c));
    ok.then_some((host, port))
}

/// A remembered decision for (sandbox, host): when it was made, and what it was.
type Decisions = HashMap<(String, String), (Instant, Result<(), String>)>;

/// The proxy: listens for relays and checks every connection.
pub struct Egress {
    gw: Arc<Gateway>,
    decisions: Mutex<Decisions>,
}

impl Egress {
    pub fn new(gw: Arc<Gateway>) -> Arc<Self> {
        Arc::new(Self { gw, decisions: Mutex::default() })
    }

    /// Local engines: a socket in its own folder, mounted only into egress relays.
    #[cfg(unix)]
    pub async fn listen_unix(self: &Arc<Self>, dir: PathBuf) -> std::io::Result<()> {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(&dir)?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755))?;
        let path = dir.join("egress.sock");
        let _ = std::fs::remove_file(&path);
        let listener = tokio::net::UnixListener::bind(&path)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666))?;
        let _ = SOCKET_DIR.set(dir);
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((s, _)) => {
                        let me = me.clone();
                        tokio::spawn(async move { me.serve(s).await });
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "egress proxy socket accept failed");
                        tokio::time::sleep(Duration::from_millis(200)).await;
                    }
                }
            }
        });
        tracing::info!(path = %path.display(), "egress proxy socket ready");
        Ok(())
    }

    /// VM engines: a port on this machine's loopback, which their relays reach.
    pub async fn listen_tcp(self: &Arc<Self>) -> std::io::Result<u16> {
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", PORT)).await {
            Ok(l) => l,
            Err(_) => tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?,
        };
        let port = listener.local_addr()?.port();
        let _ = TCP_PORT.set(port);
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((s, _)) => {
                        let me = me.clone();
                        tokio::spawn(async move { me.serve(s).await });
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "egress proxy accept failed");
                        tokio::time::sleep(Duration::from_millis(200)).await;
                    }
                }
            }
        });
        tracing::info!(port, "egress proxy port ready");
        Ok(port)
    }

    async fn serve<S: AsyncRead + AsyncWrite + Unpin>(&self, mut client: S) {
        // The head, up to the blank line; anything after it is the start of the body.
        let mut buf = Vec::with_capacity(2048);
        let mut chunk = [0u8; 2048];
        let end = loop {
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break i;
            }
            if buf.len() > MAX_HEAD {
                return reply(&mut client, 431, "Request headers too large", "").await;
            }
            match tokio::time::timeout(Duration::from_secs(30), client.read(&mut chunk)).await {
                Ok(Ok(0)) | Err(_) | Ok(Err(_)) => return,
                Ok(Ok(n)) => buf.extend_from_slice(&chunk[..n]),
            }
        };
        let rest = buf.split_off(end + 4);
        let Some(head) = std::str::from_utf8(&buf[..end]).ok().and_then(parse_head) else {
            return reply(&mut client, 400, "Bad Request", "KALYPSO's egress proxy couldn't read this request.").await;
        };
        let Some((sandbox_id, password)) = head.auth.clone() else {
            return reply_auth(&mut client).await;
        };
        if token_for(&sandbox_id).is_none_or(|t| !same(&t, &password)) {
            return reply_auth(&mut client).await;
        }
        let Some((host, port, path)) = destination(&head) else {
            return reply(&mut client, 400, "Bad Request", "Only http:// requests and CONNECT tunnels go through KALYPSO's egress proxy.")
                .await;
        };
        if let Err(reason) = self.check(&sandbox_id, &host, port).await {
            return reply(&mut client, 403, "Forbidden", &format!("Blocked by KALYPSO: {reason}")).await;
        }
        let upstream = match tokio::time::timeout(Duration::from_secs(15), tokio::net::TcpStream::connect((host.as_str(), port))).await {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => return reply(&mut client, 502, "Bad Gateway", &format!("Couldn't reach {host}:{port}: {e}")).await,
            Err(_) => return reply(&mut client, 504, "Gateway Timeout", &format!("{host}:{port} didn't answer")).await,
        };
        let mut upstream = upstream;
        match path {
            None => {
                if client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await.is_err() {
                    return;
                }
            }
            Some(path) => {
                // Plain HTTP: send the request on in origin form, without the proxy's headers.
                let mut out = format!("{} {} {}\r\n", head.method, path, head.version);
                for h in &head.headers {
                    out.push_str(h);
                    out.push_str("\r\n");
                }
                out.push_str("\r\n");
                if upstream.write_all(out.as_bytes()).await.is_err() {
                    return;
                }
            }
        }
        if !rest.is_empty() && upstream.write_all(&rest).await.is_err() {
            return;
        }
        let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
    }

    /// Whether this sandbox may reach this host now, by the namespace's policies.
    async fn check(&self, sandbox_id: &str, host: &str, port: u16) -> Result<(), String> {
        let key = (sandbox_id.to_string(), host.to_string());
        if let Some((at, decision)) = self.decisions.lock().unwrap().get(&key) {
            let ttl = if decision.is_ok() { ALLOW_FOR } else { DENY_FOR };
            if at.elapsed() < ttl {
                return decision.clone();
            }
        }
        let decision = self.decide(sandbox_id, host, port).await;
        self.decisions.lock().unwrap().insert(key, (Instant::now(), decision.clone()));
        decision
    }

    async fn decide(&self, sandbox_id: &str, host: &str, port: u16) -> Result<(), String> {
        let db = &self.gw.db;
        let found = db.with(|c| {
            Ok(rusqlite::OptionalExtension::optional(c.query_row(
                "SELECT ns, name, network FROM sandboxes WHERE id = ?1",
                [sandbox_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)),
            ))?)
        });
        let (ns, name, network) = match found {
            Ok(Some(s)) => s,
            Ok(None) => return Err("this sandbox no longer exists".into()),
            Err(e) => return Err(format!("KALYPSO could not check this connection: {e}")),
        };
        if network != "internet" {
            return Err(format!("{name} has no internet access (its network is {network})"));
        }
        // Policies can be scoped to a sandbox through its gateway key.
        let key_id: String = db
            .with(|c| {
                Ok(rusqlite::OptionalExtension::optional(c.query_row(
                    "SELECT id FROM gateway_keys WHERE sandbox_id = ?1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
                    [sandbox_id],
                    |r| r.get(0),
                ))?)
            })
            .ok()
            .flatten()
            .unwrap_or_default();
        let scheme = if port == 80 { "http" } else { "https" };
        let call = crate::policy::ToolCall {
            kind: "network".into(),
            url: Some(if port == 80 || port == 443 { format!("{scheme}://{host}") } else { format!("{scheme}://{host}:{port}") }),
            ..Default::default()
        };
        let source = format!("sandbox {name}");
        let decision = crate::gateway::decide(&self.gw, &key_id, &ns, &source, &call, None).await;
        let _ = db.audit(Some(&ns), &source, if decision.is_ok() { "egress.allow" } else { "egress.deny" }, &format!("{host}:{port}"));
        decision.map(|_| ()).map_err(|d| d.reason.unwrap_or_else(|| format!("{host} isn't allowed")))
    }
}

async fn reply<S: AsyncWrite + Unpin>(client: &mut S, code: u16, status: &str, body: &str) {
    let msg = format!(
        "HTTP/1.1 {code} {status}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = client.write_all(msg.as_bytes()).await;
    let _ = client.shutdown().await;
}

async fn reply_auth<S: AsyncWrite + Unpin>(client: &mut S) {
    let body = "KALYPSO's egress proxy needs this sandbox's own credentials (HTTPS_PROXY as KALYPSO set it).";
    let msg = format!(
        "HTTP/1.1 407 Proxy Authentication Required\r\nproxy-authenticate: Basic realm=\"KALYPSO\"\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = client.write_all(msg.as_bytes()).await;
    let _ = client.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_connect_and_plain_http() {
        let auth = base64::engine::general_purpose::STANDARD.encode("sb-1:secret");
        let head = parse_head(&format!(
            "CONNECT api.github.com:443 HTTP/1.1\r\nHost: api.github.com:443\r\nProxy-Authorization: Basic {auth}\r\n"
        ))
        .unwrap();
        assert_eq!(head.auth, Some(("sb-1".into(), "secret".into())));
        assert_eq!(destination(&head), Some(("api.github.com".into(), 443, None)));
        assert!(head.headers.iter().all(|h| !h.to_lowercase().starts_with("proxy-")), "proxy headers are never passed on");

        let get = parse_head("GET http://Example.com/a?b=1 HTTP/1.1\r\nHost: example.com\r\nProxy-Connection: keep-alive\r\n").unwrap();
        assert_eq!(destination(&get), Some(("example.com".into(), 80, Some("/a?b=1".into()))));
        assert_eq!(get.headers, ["Host: example.com"]);
        let port = parse_head("GET http://localhost:8080 HTTP/1.1\r\n").unwrap();
        assert_eq!(destination(&port), Some(("localhost".into(), 8080, Some("/".into()))));

        assert!(parse_head("GET / SPDY/3\r\n").is_none());
        assert_eq!(destination(&parse_head("GET ftp://x/ HTTP/1.1\r\n").unwrap()), None);
        assert!(parse_head("CONNECT bad host:443 HTTP/1.1\r\n").is_none(), "a space in the host breaks the request line");
        assert_eq!(destination(&parse_head("CONNECT bad!host:443 HTTP/1.1\r\n").unwrap()), None);
    }

    #[test]
    fn credentials_are_per_sandbox() {
        let key = [7u8; 32];
        let a = hmac(&key, b"sb-1");
        assert_eq!(a, hmac(&key, b"sb-1"));
        assert_ne!(a, hmac(&key, b"sb-2"));
        assert_ne!(a, hmac(&[8u8; 32], b"sb-1"));
        assert!(same("abc", "abc") && !same("abc", "abd") && !same("abc", "ab"));
    }
}
