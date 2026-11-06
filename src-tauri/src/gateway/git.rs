//! Git credentials and the GitHub API for repository-linked agents (#100), on the sandbox
//! socket and relay port only (never the host TCP port).
//!
//! - `POST /_kalypso/git/credential`: the sandbox's git credential helper sends git's request
//!   (`host=github.com`, `path=owner/name.git`). KALYPSO answers only for a repository linked to
//!   an agent in that sandbox, with the agent's account, if the namespace may use it and policy
//!   allows. The token goes to git's memory for that one operation and is never stored.
//! - `/_kalypso/github/*`: `api.github.com`, limited to paths under that repository, with the
//!   same account. Mutating requests are checked against policy and audited.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};

use super::{resolve, token, Gateway};
use crate::agent::{self, AgentRecord};
use crate::policy::ToolCall;

/// The sandbox behind a request, from its gateway key: (key id, namespace, source, sandbox id).
#[allow(clippy::result_large_err)]
fn caller(gw: &Gateway, headers: &HeaderMap) -> Result<(String, String, String, String), Response> {
    let Some(tok) = token(headers) else { return Err((StatusCode::UNAUTHORIZED, "missing KALYPSO gateway key").into_response()) };
    let (key_id, ns, source) = match resolve(&gw.db, tok) {
        Ok(Some(k)) => k,
        Ok(None) => return Err((StatusCode::UNAUTHORIZED, "unknown or revoked KALYPSO gateway key").into_response()),
        Err(e) => return Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response()),
    };
    match super::secrets::sandbox_of(&gw.db, &key_id) {
        Ok(Some(sb)) => Ok((key_id, ns, source, sb)),
        _ => Err((StatusCode::FORBIDDEN, "only sandboxes can ask for git credentials").into_response()),
    }
}

/// Agents in the sandbox linked to a repository through an account the namespace may use.
fn linked(gw: &Gateway, ns: &str, sandbox: &str) -> Vec<(AgentRecord, String, String)> {
    let allowed: Vec<String> = crate::github::for_ns(&gw.db, ns).unwrap_or_default().into_iter().map(|a| a.id).collect();
    agent::in_sandbox(&gw.db, sandbox)
        .unwrap_or_default()
        .into_iter()
        .filter(|a| a.ns == ns)
        .filter_map(|a| {
            let (repo, account) = (a.repo.clone()?, a.repo_account.clone()?);
            allowed.contains(&account).then_some((a, repo, account))
        })
        .collect()
}

pub async fn credential(State(gw): State<Arc<Gateway>>, headers: HeaderMap, body: Bytes) -> Response {
    let (key_id, ns, source, sandbox) = match caller(&gw, &headers) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let input = String::from_utf8_lossy(&body);
    let Some(repo) = crate::repo::credential_repo(&input) else {
        return (StatusCode::FORBIDDEN, "KALYPSO only has credentials for github.com repositories").into_response();
    };
    let Some((agent, _, account)) = linked(&gw, &ns, &sandbox).into_iter().find(|(_, r, _)| r.eq_ignore_ascii_case(&repo)) else {
        let _ = gw.db.audit(Some(&ns), &source, "git.credential_denied", &format!("{repo}: not linked to an agent in this sandbox"));
        return (StatusCode::FORBIDDEN, "this repository isn't linked to an agent in this sandbox").into_response();
    };
    let call = ToolCall {
        kind: "git".into(),
        tool: Some("credential".into()),
        command: Some(format!("git credential for {repo}")),
        url: Some(format!("https://github.com/{repo}")),
        ..Default::default()
    };
    if let Err(d) = super::decide(&gw, &key_id, &ns, &source, &call, None).await {
        let _ = gw.db.audit(
            Some(&ns),
            &source,
            "git.credential_denied",
            &format!("{}: {repo}: {}", agent.name, d.reason.clone().unwrap_or_default()),
        );
        return (StatusCode::FORBIDDEN, d.reason.unwrap_or_else(|| "blocked by policy".into())).into_response();
    }
    let gh = gw.github();
    let tok = match crate::github::token(&gw.db, &gw.vault, &gh, &account).await {
        Ok(t) => t,
        Err(e) => {
            let _ = gw.db.audit(Some(&ns), &source, "git.credential_denied", &format!("{}: {repo}: {e}", agent.name));
            return (StatusCode::FORBIDDEN, e.to_string()).into_response();
        }
    };
    let _ = gw.db.audit(Some(&ns), &source, "git.credential", &format!("{}: {repo}", agent.name));
    // git's credential protocol. Any username works with a token; this one is GitHub's convention.
    let answer =
        zeroize::Zeroizing::new(format!("protocol=https\nhost=github.com\nusername=x-access-token\npassword={}\n\n", tok.as_str()));
    (StatusCode::OK, [("content-type", "text/plain")], answer.to_string()).into_response()
}

pub async fn api(
    State(gw): State<Arc<Gateway>>,
    method: Method,
    Path(path): Path<String>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let json = |status: StatusCode, msg: &str| (status, axum::Json(serde_json::json!({ "message": msg }))).into_response();
    let (key_id, ns, source, sandbox) = match caller(&gw, &headers) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let path = format!("/{}", path.trim_start_matches('/'));
    let Some((agent, _repo, account)) = linked(&gw, &ns, &sandbox).into_iter().find(|(_, r, _)| crate::repo::api_path_allowed(&path, r))
    else {
        let _ = gw.db.audit(Some(&ns), &source, "github.api_denied", &format!("{method} {path}"));
        return json(
            StatusCode::FORBIDDEN,
            "KALYPSO only forwards GitHub API calls under /repos/<a repository linked to an agent in this sandbox>",
        );
    };
    let mutating = !matches!(method, Method::GET | Method::HEAD | Method::OPTIONS);
    if mutating {
        let call = ToolCall {
            kind: "github".into(),
            tool: Some(format!("{method} {path}")),
            command: Some(format!("gh-api {method} {path}")),
            url: Some(format!("https://api.github.com{path}")),
            content: (!body.is_empty()).then(|| String::from_utf8_lossy(&body).chars().take(4000).collect()),
            ..Default::default()
        };
        if let Err(d) = super::decide(&gw, &key_id, &ns, &source, &call, None).await {
            let _ = gw.db.audit(Some(&ns), &source, "github.api_denied", &format!("{}: {method} {path}", agent.name));
            return json(StatusCode::FORBIDDEN, &d.reason.unwrap_or_else(|| "blocked by policy".into()));
        }
    }
    let gh = gw.github();
    let tok = match crate::github::token(&gw.db, &gw.vault, &gh, &account).await {
        Ok(t) => t,
        Err(e) => return json(StatusCode::FORBIDDEN, &e.to_string()),
    };
    let target = match &query {
        Some(q) => format!("{path}?{q}"),
        None => path.clone(),
    };
    let ct = headers.get("content-type").and_then(|v| v.to_str().ok());
    let res = match gh.api_request(method.clone(), &target, &tok, body.to_vec(), ct).await {
        Ok(r) => r,
        Err(e) => return json(StatusCode::BAD_GATEWAY, &e),
    };
    let status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    if mutating {
        let _ = gw.db.audit(Some(&ns), &source, "github.api", &format!("{}: {method} {path} → {}", agent.name, status.as_u16()));
    }
    let ct = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("application/json").to_string();
    let bytes = res.bytes().await.unwrap_or_default();
    (status, [("content-type", ct)], bytes).into_response()
}
