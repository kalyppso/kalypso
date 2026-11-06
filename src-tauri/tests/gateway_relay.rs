//! Sandboxes on engines that run in a VM (Docker Desktop on Windows and macOS, Podman
//! machine) can't mount the gateway's socket. They reach it through the namespace's relay
//! container over a private network instead. This forces that mode on a Linux engine and
//! runs the real things through it: a Claude Agent SDK agent (scripted model) and the
//! secret gateway, in a sandbox with no other network.
//!
//!   podman build -t ghcr.io/kalyppso/agent-runner:dev runner/agent-sdk
//!   KALYPSO_TEST_RUNTIME=1 cargo test --test gateway_relay
//! (Its own test binary: the transport is chosen once per process.)
#![cfg(target_os = "linux")]

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use kalypso_lib::agent::{self, supervisor::Supervisor, NewAgent};
use kalypso_lib::gateway::{pricing::Pricing, Gateway};
use kalypso_lib::sandbox::{self, NewSandbox, Runtime};
use kalypso_lib::store::Db;
use kalypso_lib::vault::{new_id, Vault};

#[tokio::test]
async fn vm_engines_reach_the_gateway_through_the_relay() {
    if std::env::var("KALYPSO_TEST_RUNTIME").is_err() {
        return;
    }
    // Relay mode, as on Docker Desktop. Rootless Podman can't reach host loopback the way
    // Docker Desktop and Podman machine do, so this test listens on all interfaces.
    std::env::set_var("KALYPSO_GATEWAY_TRANSPORT", "relay");
    std::env::set_var("KALYPSO_SANDBOX_GATEWAY_BIND", "0.0.0.0:0");
    let image = std::env::var("KALYPSO_TEST_RUNNER_IMAGE").unwrap_or_else(|_| "ghcr.io/kalyppso/agent-runner:dev".into());

    let rt = Runtime::detect().await;
    let db = Arc::new(Db::open_in_memory().unwrap());
    let vault = Arc::new(Vault::ephemeral());
    let ns = format!("rl{}", &new_id("x")[2..8]);
    db.with(|c| Ok(c.execute("INSERT INTO namespaces (id, name) VALUES (?1, ?1)", [&ns])?)).unwrap();
    vault.create_ns_key(&db, &ns).unwrap();
    kalypso_lib::policy::seed_defaults(&db, &ns).unwrap();

    let seen = Arc::new(Mutex::new(Vec::new()));
    let url = common::model(seen.clone()).await;
    vault.set(&db, &ns, "ANTHROPIC_API_KEY", "sk-ant-real-key", "gateway").unwrap();
    vault.set(&db, &ns, "ANTHROPIC_BASE_URL", &url, "gateway").unwrap();
    vault.set(&db, &ns, "DEPLOY_TOKEN", "dpl_relay_7e21c9a4", "on-request").unwrap();
    let gw = Gateway::new(db.clone(), vault.clone(), Pricing::builtin());
    gw.set_runtime(rt.clone());
    gw.listen_sandbox_tcp().await.unwrap();
    // No socket in this mode: listen_unix is never called.

    let spec = |name: &str| NewSandbox {
        name: name.into(),
        image: image.clone(),
        cpu: 1.0,
        mem_mb: 1024,
        network: "isolated".into(),
        provider: None,
    };
    let sb = sandbox::create(&db, &rt, &ns, spec("relayed")).await.unwrap();
    let other = sandbox::create(&db, &rt, &ns, spec("neighbour")).await.unwrap();
    sandbox::start(&db, &rt, &ns, &other.id).await.unwrap();
    let run = |id: String, script: String| {
        let rt = rt.clone();
        let ns = ns.clone();
        async move { sandbox::exec(&rt, &ns, &id, &["/bin/sh", "-c", &script], false).await.unwrap() }
    };

    // 1. A Claude Agent SDK agent finishes its task through the relay, policies included.
    let new = NewAgent {
        name: "builder".into(),
        role: None,
        runtime: "claude-sdk".into(),
        model: Some("claude-haiku-5-5".into()),
        sandbox_id: Some(sb.id.clone()),
        command: Some(common::TASK.into()),
        restart: Some("never".into()),
        max_restarts: Some(0),
        repo: None,
        repo_account: None,
        max_turns: Some(10),
    };
    let a = agent::create(&db, &ns, new).unwrap();
    let sup = Supervisor::new(db.clone(), vault.clone(), rt.clone());
    sup.start(&ns, &a.id).await.unwrap();
    let mut log = Vec::new();
    for _ in 0..240 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if let Some(r) = agent::runs(&db, &ns, &a.id, 1).unwrap().first() {
            log = agent::events(&db, &ns, &r.id, 0, 500).unwrap();
            if log.iter().any(|e| e.kind == "result" || e.kind == "error") || r.outcome != "running" {
                break;
            }
        }
    }
    let dump = log.iter().map(|e| format!("{:>7} | {}", e.kind, e.text)).collect::<Vec<_>>().join("\n");
    let has = |kind: &str, needle: &str| log.iter().any(|e| e.kind == kind && e.text.contains(needle));
    assert!(has("result", "Done"), "no result through the relay:\n{dump}\nupstream saw: {:?}", seen.lock().unwrap());
    assert!(has("policy", "No force-push to main"), "{dump}");
    assert!(seen.lock().unwrap().iter().any(|c| c.ends_with("key=sk-ant-real-key")));
    sup.stop(&ns, &a.id, "test over").await.unwrap();

    // 2. What the sandbox has: the relay URL, no socket, no internet, no neighbours.
    let neighbour = other.name.clone();
    let (_, probe) = run(
        sb.id.clone(),
        format!(
            "echo url=$KALYPSO_GATEWAY_URL; test -e /run/kalypso/gateway && echo socket || echo no-socket; \
             curl -s -m 3 -o /dev/null http://example.com && echo internet || echo no-internet; \
             getent hosts kalypso-{ns}-{} >/dev/null && echo sees-{neighbour} || echo alone",
            other.id
        ),
    )
    .await;
    assert!(probe.contains("url=http://gateway.kalypso:8080"), "{probe}");
    assert!(probe.contains("no-socket") && probe.contains("no-internet") && probe.contains("alone"), "{probe}");

    // 3. The secret gateway works through the relay too (approve the request).
    let mut prompts = gw.approvals.subscribe();
    let approver = {
        let gw = gw.clone();
        tokio::spawn(async move {
            if let Ok(req) = prompts.recv().await {
                let _ = gw.approvals.decide(&req.ns, &req.id, true, false);
            }
        })
    };
    let (code, out) = run(sb.id.clone(), "kx-secret run DEPLOY_TOKEN --purpose deploy -- sh -c 'echo tok=$DEPLOY_TOKEN' 2>&1".into()).await;
    approver.abort();
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("tok=‹DEPLOY_TOKEN›") && !out.contains("dpl_relay_7e21c9a4"), "{out}");

    // 4. A relay that disappears comes back on the next start, on every sandbox's network.
    let docker = |args: &[&str]| std::process::Command::new("podman").args(args).output().map(|o| o.status.success()).unwrap_or(false);
    let relay = format!("kalypso-gw-{ns}");
    assert!(docker(&["rm", "-f", &relay]));
    sandbox::stop(&db, &rt, &ns, &sb.id).await.unwrap();
    sandbox::start(&db, &rt, &ns, &sb.id).await.unwrap();
    sandbox::deliver_secrets(&db, &vault, &rt, &ns, &sb.id).await.unwrap();
    let (_, again) = run(
        sb.id.clone(),
        "curl -s -m 5 -H \"Authorization: Bearer $(cat /run/kalypso/secrets/KALYPSO_GATEWAY_KEY)\" -H 'content-type: application/json' \
         -d '{\"kind\":\"bash\",\"command\":\"ls\"}' http://gateway.kalypso:8080/_kalypso/policy/check"
            .into(),
    )
    .await;
    assert!(again.contains("\"decision\":\"allow\""), "{again}");
    let (_, other_ok) = run(other.id.clone(), "curl -s -m 5 -o /dev/null http://gateway.kalypso:8080/ ; echo rc=$?".into()).await;
    // Any HTTP answer (even 404) means the neighbour's network was rejoined; curl exits 6/7/28 on network failures.
    assert!(other_ok.contains("rc=0"), "relay did not rejoin the neighbour's network: {other_ok}");

    // 5. Cleanup removes the sandbox networks and the relay.
    for id in [&sb.id, &other.id] {
        sandbox::remove(&db, &rt, &ns, id).await.unwrap();
        assert!(!docker(&["network", "exists", &format!("kalypso-gw-{ns}-{id}")]), "network left behind");
    }
    rt.remove_network(&ns).await.unwrap();
    assert!(!docker(&["container", "exists", &relay]), "relay left behind");
}
