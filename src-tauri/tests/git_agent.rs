//! Repository-linked agents (#100), end to end in a real sandbox from the agent runner image,
//! with the real gateway on its socket: KALYPSO prepares the agent's repository (credential
//! helper, hooks, branch), git gets credentials only through the gateway and only for the linked
//! repository, commits carry the KALYPSO-Agent trailer, pushes to main are refused, and the
//! account's token is nowhere in the sandbox afterwards: not in files, environments or the
//! process list. The sandbox has no network, so the clone is seeded inside it, with a local
//! remote to push to; everything else is what an agent gets.
//!
//!   podman build -t ghcr.io/kalyppso/agent-runner:dev runner/agent-sdk
//!   KALYPSO_TEST_RUNTIME=1 cargo test --test git_agent
#![cfg(target_os = "linux")]

use std::sync::Arc;

use kalypso_lib::agent::{self, NewAgent};
use kalypso_lib::gateway::{pricing::Pricing, Gateway};
use kalypso_lib::github::{self, GitHub, TokenSet};
use kalypso_lib::sandbox::{self, NewSandbox, Runtime};
use kalypso_lib::store::Db;
use kalypso_lib::vault::{new_id, Vault};

/// The account's token. Split in the probes so their own command lines don't contain it.
const TOKEN: &str = "ghp_e2eT0kenNeverInTheSandbox42";

async fn fake_github() -> String {
    use axum::routing::get;
    let app = axum::Router::new()
        .route("/user", get(|| async { axum::Json(serde_json::json!({ "login": "ada" })) }))
        .route("/user/orgs", get(|| async { axum::Json(serde_json::json!([{ "login": "acme" }])) }));
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    url
}

#[tokio::test]
async fn an_agent_works_on_its_repo_and_never_holds_the_token() {
    if std::env::var("KALYPSO_TEST_RUNTIME").is_err() {
        return;
    }
    let image = std::env::var("KALYPSO_TEST_RUNNER_IMAGE").unwrap_or_else(|_| "ghcr.io/kalyppso/agent-runner:dev".into());
    let rt = Runtime::detect().await;
    let db = Arc::new(Db::open_in_memory().unwrap());
    let vault = Arc::new(Vault::ephemeral());
    let ns = format!("ga{}", &new_id("x")[2..8]);
    db.with(|c| Ok(c.execute("INSERT INTO namespaces (id, name) VALUES (?1, ?1)", [&ns])?)).unwrap();
    vault.create_ns_key(&db, &ns).unwrap();
    kalypso_lib::policy::seed_defaults(&db, &ns).unwrap();

    let gh_url = fake_github().await;
    let gh = GitHub::new(&gh_url, &gh_url);
    let t = TokenSet { access_token: TOKEN.into(), refresh_token: None, expires_in: None, refresh_token_expires_in: None };
    let account = github::connect(&db, &vault, &gh, "acme", "token", t, std::slice::from_ref(&ns), None).await.unwrap().id;

    let gw = Gateway::new(db.clone(), vault.clone(), Pricing::builtin());
    gw.set_runtime(rt.clone());
    gw.set_github(gh);
    gw.listen_unix(std::env::temp_dir().join(format!("kx-ga-{}", std::process::id()))).await.unwrap();

    let spec = NewSandbox { name: "repo".into(), image, cpu: 1.0, mem_mb: 512, network: "isolated".into(), provider: None };
    let sb = sandbox::create(&db, &rt, &ns, spec).await.unwrap();
    sandbox::start(&db, &rt, &ns, &sb.id).await.unwrap();
    sandbox::deliver_secrets(&db, &vault, &rt, &ns, &sb.id).await.unwrap();
    let new = NewAgent {
        name: "scout".into(),
        role: Some("Fix the flaky tests".into()),
        runtime: "command".into(),
        model: None,
        sandbox_id: Some(sb.id.clone()),
        command: Some("true".into()),
        max_turns: None,
        restart: None,
        max_restarts: None,
        repo: Some("acme/platform".into()),
        repo_account: Some(account),
    };
    let a = agent::create(&db, &ns, new).unwrap();
    let sh = |script: String| {
        let (rt, ns, sb) = (rt.clone(), ns.clone(), sb.id.clone());
        async move { sandbox::exec(&rt, &ns, &sb, &["/bin/sh", "-c", &script], false).await.unwrap() }
    };

    // The agent's clone, seeded in the sandbox, with a local remote standing in for GitHub.
    let (code, out) = sh("set -e; git init -q --bare -b main /tmp/remote.git; git init -q -b main /work/platform; cd /work/platform; \
         git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init; \
         git remote add origin https://github.com/acme/platform.git; git config remote.origin.pushurl /tmp/remote.git; \
         git push -q /tmp/remote.git main; echo seeded"
        .into())
    .await;
    assert_eq!(code, 0, "{out}");

    // 1. KALYPSO prepares it: helpers, hooks, the agent's own branch.
    let provider = rt.provider(&sb.runtime).unwrap();
    let prepared = kalypso_lib::repo::prepare(&db, &provider, &ns, &sb.id, &a, "https://github.com").await.unwrap().unwrap();
    assert_eq!(prepared.dir, "/work/platform");
    assert_eq!(prepared.branch, "agent/scout/fix-the-flaky-tests");
    assert_eq!(agent::get(&db, &ns, &a.id).unwrap().branch.as_deref(), Some("agent/scout/fix-the-flaky-tests"));
    let (_, br) = sh("cd /work/platform && git branch --show-current".into()).await;
    assert_eq!(br.trim(), "agent/scout/fix-the-flaky-tests");

    // 2. git gets credentials through the gateway, for the linked repository only.
    let fill = |path: &str| {
        format!("cd /work/platform && printf 'protocol=https\\nhost=github.com\\npath={path}\\n\\n' | git credential fill 2>&1; echo \"exit=$?\"")
    };
    let (_, linked) = sh(fill("acme/platform.git")).await;
    assert!(linked.contains(&format!("password={TOKEN}")), "the linked repository gets credentials:\n{linked}");
    let (_, other) = sh(fill("acme/billing.git")).await;
    assert!(!other.contains(TOKEN), "another repository gets nothing:\n{other}");

    // 3. Commits carry the trailer.
    let (code, out) =
        sh("cd /work/platform && echo fix > fix.txt && git add fix.txt && git commit -q -m 'Fix the flaky test' && git log -1 --format=%B"
            .into())
        .await;
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("KALYPSO-Agent: scout"), "{out}");

    // 4. Pushing to main is refused; pushing the agent's branch works.
    let (code, out) = sh("cd /work/platform && git push origin HEAD:main 2>&1".into()).await;
    assert_ne!(code, 0, "push to main must fail:\n{out}");
    assert!(out.contains("pushing to main is blocked"), "{out}");
    let (code, out) = sh("cd /work/platform && git push -q -u origin agent/scout/fix-the-flaky-tests 2>&1 && git --git-dir=/tmp/remote.git branch --list 'agent/*'".into()).await;
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("agent/scout/fix-the-flaky-tests"), "{out}");

    // 5. The token is nowhere in the sandbox: files, process environments, command lines.
    // The probe only ever holds the first half of the token, so its own command line can't match;
    // the search for the whole token happens here, on everything it prints.
    let (_, snoop) = sh(format!(
        "A='{}'; grep -rsho \"$A[A-Za-z0-9]*\" /work /tmp /run /etc /root 2>/dev/null; \
         cat /proc/*/environ 2>/dev/null | tr '\\0' '\\n'; cat /proc/*/cmdline 2>/dev/null | tr '\\0' ' '; \
         ps -eo args 2>/dev/null; echo scanned",
        &TOKEN[..10]
    ))
    .await;
    assert!(snoop.contains("scanned"), "{snoop}");
    assert!(!snoop.contains(TOKEN), "the token is in the sandbox:\n{snoop}");

    let log = db.audit_list(Some(&ns), Some("git."), 20).unwrap();
    assert!(log.iter().any(|l| l.action == "git.credential"), "{log:?}");
    assert!(log.iter().any(|l| l.action == "git.credential_denied"), "{log:?}");
    sandbox::remove(&db, &rt, &ns, &sb.id).await.ok();
}
