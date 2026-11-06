//! Repository-linked agents (#100). When an agent linked to a GitHub repository starts, its
//! sandbox gets the repository cloned into `/work/<name>`, on the agent's own branch
//! (`agent/<agent>/<task>`). Git asks KALYPSO for credentials through the gateway each time it
//! needs them, so the account's token is never written into the sandbox; KALYPSO only answers
//! for the repository linked to an agent in that sandbox. Commits carry the `KALYPSO-Agent`
//! trailer, and pushes to the default branch are refused by a hook (and by policy).

use std::sync::Arc;

use crate::agent::AgentRecord;
use crate::error::{KalypsoError, Result};
use crate::sandbox::provider::SandboxProvider;
use crate::store::Db;

/// Helper commands KALYPSO installs in the sandbox, on the agent's PATH.
pub const BIN: &str = "/work/.kalypso/bin";
const HOOKS: &str = "/work/.kalypso/hooks";
/// The agent's PATH: KALYPSO's helpers first, then the usual places.
pub const AGENT_PATH: &str = "/work/.kalypso/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/// git credential helper: asks KALYPSO, through the gateway, for this repository's credentials.
const CREDENTIAL_HELPER: &str = r#"#!/bin/sh
# KALYPSO git credential helper (#100). It asks KALYPSO for credentials through the gateway,
# with this sandbox's key. The account's token is never stored here; KALYPSO only answers
# for the repository linked to an agent in this sandbox.
[ "$1" = get ] || exit 0
key_file="${KALYPSO_GATEWAY_KEY_FILE:-/run/kalypso/secrets/KALYPSO_GATEWAY_KEY}"
sock="${KALYPSO_GATEWAY_SOCK:-/run/kalypso/gateway/gateway.sock}"
[ -r "$key_file" ] || exit 0
if [ -S "$sock" ]; then
  exec curl -sf --unix-socket "$sock" -H "x-api-key: $(cat "$key_file")" --data-binary @- http://gateway.kalypso/_kalypso/git/credential
elif [ -n "$KALYPSO_GATEWAY_URL" ]; then
  exec curl -sf -H "x-api-key: $(cat "$key_file")" --data-binary @- "$KALYPSO_GATEWAY_URL/_kalypso/git/credential"
fi
"#;

/// gh-api: the GitHub API for this agent's repository, through KALYPSO.
const GH_API: &str = r#"#!/bin/sh
# gh-api METHOD PATH [JSON]: call the GitHub API for this agent's repository through KALYPSO,
# which adds the account's access. Only paths under /repos/<this repository> are allowed.
#   gh-api GET  /repos/OWNER/NAME/pulls
#   gh-api POST /repos/OWNER/NAME/pulls '{"title":"…","head":"BRANCH","base":"main","body":"…"}'
[ $# -ge 2 ] || { echo "usage: gh-api METHOD PATH [JSON]" >&2; exit 2; }
key_file="${KALYPSO_GATEWAY_KEY_FILE:-/run/kalypso/secrets/KALYPSO_GATEWAY_KEY}"
sock="${KALYPSO_GATEWAY_SOCK:-/run/kalypso/gateway/gateway.sock}"
if [ -S "$sock" ]; then set -- "$1" "$2" "$3" --unix-socket "$sock"; base=http://gateway.kalypso; else base="$KALYPSO_GATEWAY_URL"; fi
method=$1; path=$2; body=$3; shift 3
if [ -n "$body" ]; then
  exec curl -sS "$@" -X "$method" -H "x-api-key: $(cat "$key_file")" -H "content-type: application/json" --data-binary "$body" "$base/_kalypso/github$path"
fi
exec curl -sS "$@" -X "$method" -H "x-api-key: $(cat "$key_file")" "$base/_kalypso/github$path"
"#;

/// Refuse pushes to the default branch: agents push their own branch and open a pull request.
const PRE_PUSH: &str = r#"#!/bin/sh
# KALYPSO: agents push their own branch and open a pull request, never the default branch.
default=$(git config kalypso.defaultBranch || echo main)
while read -r local_ref local_sha remote_ref remote_sha; do
  case "$remote_ref" in
    refs/heads/main|refs/heads/master|"refs/heads/$default")
      echo "KALYPSO: pushing to ${remote_ref#refs/heads/} is blocked. Push your own branch and open a pull request." >&2
      exit 1 ;;
  esac
done
exit 0
"#;

/// Where repositories are cloned from: github.com. `KALYPSO_GIT_CLONE_BASE` points it elsewhere
/// (a local git server in tests).
pub fn clone_base() -> String {
    std::env::var("KALYPSO_GIT_CLONE_BASE").unwrap_or_else(|_| "https://github.com".into())
}

/// Where the repository is cloned in the sandbox.
pub fn dir(repo: &str) -> String {
    format!("/work/{}", repo.split('/').nth(1).unwrap_or(repo))
}

/// The agent's own branch: `agent/<name>/<task>`, the task taken from its role.
pub fn branch_for(name: &str, role: &str) -> String {
    let words: Vec<String> =
        role.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).take(4).map(|w| w.to_ascii_lowercase()).collect();
    let task = if words.is_empty() { "work".to_string() } else { words.join("-") };
    format!("agent/{}/{task}", name.to_ascii_lowercase())
}

async fn write(p: &Arc<dyn SandboxProvider>, ns: &str, sb: &str, path: &str, body: &str) -> Result<()> {
    let script = "mkdir -p \"$(dirname \"$1\")\" && cat > \"$1\" && chmod 755 \"$1\"";
    let code = p.exec_with_stdin(ns, sb, &["sh", "-c", script, "sh", path], body.as_bytes()).await?;
    if code != 0 {
        return Err(KalypsoError::Runtime(format!("could not write {path} into the sandbox")));
    }
    Ok(())
}

/// Install KALYPSO's git helpers in the sandbox (credential helper, gh-api, hooks).
pub async fn install_helpers(p: &Arc<dyn SandboxProvider>, ns: &str, sb: &str, agent_name: &str) -> Result<()> {
    write(p, ns, sb, &format!("{BIN}/git-credential-kalypso"), CREDENTIAL_HELPER).await?;
    write(p, ns, sb, &format!("{BIN}/gh-api"), GH_API).await?;
    write(p, ns, sb, &format!("{HOOKS}/pre-push"), PRE_PUSH).await?;
    // Agent names are [A-Za-z0-9_-], so they are safe inside the trailer.
    let commit_msg = format!(
        "#!/bin/sh\n# KALYPSO: mark commits made by an agent (#29).\ngit interpret-trailers --in-place --if-exists addIfDifferent --trailer \"KALYPSO-Agent: {agent_name}\" \"$1\"\n"
    );
    write(p, ns, sb, &format!("{HOOKS}/commit-msg"), &commit_msg).await
}

/// Clone the agent's repository (or reuse the clone from an earlier run), point git at
/// KALYPSO for credentials, and check out the agent's branch. Positional arguments:
/// $1 repo, $2 dir, $3 branch, $4 agent name, $5 clone base URL.
const SETUP: &str = r#"set -e
export GIT_TERMINAL_PROMPT=0
helper=/work/.kalypso/bin/git-credential-kalypso
if [ ! -d "$2/.git" ]; then
  git -c credential.helper= -c "credential.helper=$helper" -c credential.useHttpPath=true clone --quiet "$5/$1.git" "$2" 2>&1
fi
cd "$2"
git config --local --replace-all credential.helper ""
git config --local --add credential.helper "$helper"
git config --local credential.useHttpPath true
git config --local user.name "$4 (KALYPSO agent)"
git config --local user.email "$4@agents.kalypso.invalid"
git config --local core.hooksPath /work/.kalypso/hooks
default=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')
git config --local kalypso.defaultBranch "${default:-main}"
if git rev-parse --verify --quiet "refs/heads/$3" >/dev/null; then
  git checkout --quiet "$3"
elif git rev-parse --verify --quiet "refs/remotes/origin/$3" >/dev/null; then
  git checkout --quiet -b "$3" --track "origin/$3"
else
  git checkout --quiet -b "$3"
fi
echo "ready ${default:-main}"
"#;

/// What the agent's process needs to know about its repository.
pub struct Prepared {
    pub dir: String,
    pub branch: String,
    pub default_branch: String,
}

/// Prepare an agent's repository in its sandbox, if it has one. `clone_base` is
/// `https://github.com` except in tests.
pub async fn prepare(
    db: &Db,
    p: &Arc<dyn SandboxProvider>,
    ns: &str,
    sb: &str,
    agent: &AgentRecord,
    clone_base: &str,
) -> Result<Option<Prepared>> {
    let Some(repo) = agent.repo.as_deref() else { return Ok(None) };
    let branch = match agent.branch.clone() {
        Some(b) => b,
        None => {
            let b = branch_for(&agent.name, &agent.role);
            crate::agent::set_branch(db, &agent.id, &b)?;
            b
        }
    };
    install_helpers(p, ns, sb, &agent.name).await?;
    let d = dir(repo);
    let (code, out) = p.exec(ns, sb, &["sh", "-c", SETUP, "sh", repo, &d, &branch, &agent.name, clone_base], false).await?;
    if code != 0 {
        let why = out.lines().rfind(|l| !l.trim().is_empty()).unwrap_or("git failed").trim().to_string();
        let hint = if why.contains("Authentication failed") || why.contains("could not read Username") || why.contains("403") {
            " Check that the GitHub account can reach it (Settings → Account)."
        } else {
            ""
        };
        return Err(KalypsoError::Runtime(format!("couldn't prepare {repo}: {why}.{hint}")));
    }
    let default_branch = out.lines().find_map(|l| l.strip_prefix("ready ")).unwrap_or("main").trim().to_string();
    db.audit(Some(ns), "kalypso", "repo.prepare", &format!("{}: {repo} on {branch}", agent.name))?;
    Ok(Some(Prepared { dir: d, branch, default_branch }))
}

// ---------- What the gateway answers ----------

/// The repository a git credential request is about: "owner/name" from `path=owner/name.git`
/// (credential.useHttpPath is on), for github.com only.
pub fn credential_repo(input: &str) -> Option<String> {
    let mut host = None;
    let mut path = None;
    for line in input.lines() {
        if let Some(v) = line.strip_prefix("host=") {
            host = Some(v.trim().to_ascii_lowercase());
        }
        if let Some(v) = line.strip_prefix("path=") {
            path = Some(v.trim().trim_start_matches('/').trim_end_matches('/').trim_end_matches(".git").to_string());
        }
    }
    if host.as_deref() != Some("github.com") {
        return None;
    }
    path.filter(|p| p.split('/').count() == 2)
}

/// Whether a GitHub API path is about `repo`: `/repos/<repo>` or below it.
pub fn api_path_allowed(path: &str, repo: &str) -> bool {
    let p = path.split('?').next().unwrap_or(path).to_ascii_lowercase();
    let base = format!("/repos/{}", repo.to_ascii_lowercase());
    !p.contains("..") && (p == base || p.starts_with(&format!("{base}/")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branches_and_dirs() {
        assert_eq!(branch_for("Scout", "Fix the flaky billing tests!"), "agent/scout/fix-the-flaky-billing");
        assert_eq!(branch_for("coder", ""), "agent/coder/work");
        assert_eq!(dir("acme/platform"), "/work/platform");
    }

    #[test]
    fn credential_requests() {
        assert_eq!(credential_repo("protocol=https\nhost=github.com\npath=acme/platform.git\n").as_deref(), Some("acme/platform"));
        assert_eq!(credential_repo("protocol=https\nhost=GitHub.com\npath=/acme/platform\n").as_deref(), Some("acme/platform"));
        assert_eq!(credential_repo("protocol=https\nhost=gitlab.com\npath=acme/platform.git\n"), None, "github.com only");
        assert_eq!(credential_repo("protocol=https\nhost=github.com\n"), None, "needs a path");
        assert_eq!(credential_repo("protocol=https\nhost=github.com\npath=acme/platform/extra.git\n"), None);
    }

    #[test]
    fn api_paths() {
        assert!(api_path_allowed("/repos/acme/platform/pulls", "acme/platform"));
        assert!(api_path_allowed("/repos/Acme/Platform/pulls?state=all", "acme/platform"));
        assert!(api_path_allowed("/repos/acme/platform", "acme/platform"));
        assert!(!api_path_allowed("/repos/acme/platform-other/pulls", "acme/platform"));
        assert!(!api_path_allowed("/repos/acme/other", "acme/platform"));
        assert!(!api_path_allowed("/user", "acme/platform"));
        assert!(!api_path_allowed("/repos/acme/platform/../other/pulls", "acme/platform"));
    }
}
