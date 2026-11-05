//! A Claude Agent SDK agent, end to end: the runner image in a real sandbox with no
//! network, the real gateway on its Unix socket, the real policy engine, and a stand-in
//! for the Anthropic API that scripts the model's turns. Nothing reaches a real model.
//!
//! Needs a container engine and the runner image:
//!   podman build -t ghcr.io/kalyppso/agent-runner:dev runner/agent-sdk
//!   KALYPSO_TEST_RUNTIME=1 cargo test --test agent_sdk
//! (Its own test binary: the gateway's socket folder is set once per process.)
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
async fn an_sdk_agent_completes_a_task_in_its_sandbox_within_policy() {
    if std::env::var("KALYPSO_TEST_RUNTIME").is_err() {
        return;
    }
    let image = std::env::var("KALYPSO_TEST_RUNNER_IMAGE").unwrap_or_else(|_| "ghcr.io/kalyppso/agent-runner:dev".into());
    let rt = Runtime::detect().await;
    let db = Arc::new(Db::open_in_memory().unwrap());
    let vault = Arc::new(Vault::ephemeral());
    let ns = format!("sdk{}", &new_id("x")[2..8]);
    db.with(|c| Ok(c.execute("INSERT INTO namespaces (id, name) VALUES (?1, ?1)", [&ns])?)).unwrap();
    vault.create_ns_key(&db, &ns).unwrap();
    kalypso_lib::policy::seed_defaults(&db, &ns).unwrap(); // includes "No force-push to main"

    let seen = Arc::new(Mutex::new(Vec::new()));
    let url = common::model(seen.clone()).await;
    vault.set(&db, &ns, "ANTHROPIC_API_KEY", "sk-ant-real-key", "gateway").unwrap();
    vault.set(&db, &ns, "ANTHROPIC_BASE_URL", &url, "gateway").unwrap();
    let gw = Gateway::new(db.clone(), vault.clone(), Pricing::builtin());
    gw.listen_unix(std::env::temp_dir().join(format!("kx-sdk-{}", std::process::id()))).await.unwrap();

    let spec = NewSandbox { name: "sdk".into(), image, cpu: 1.0, mem_mb: 1024, network: "isolated".into(), provider: None };
    let sb = sandbox::create(&db, &rt, &ns, spec).await.unwrap();
    let new = NewAgent {
        name: "builder".into(),
        role: Some("Writes files when asked.".into()),
        runtime: "claude-sdk".into(),
        model: Some("claude-haiku-5-5".into()),
        sandbox_id: Some(sb.id.clone()),
        command: Some(common::TASK.into()),
        restart: Some("never".into()),
        max_restarts: Some(0),
        max_turns: Some(10),
    };
    let a = agent::create(&db, &ns, new).unwrap();
    let sup = Supervisor::new(db.clone(), vault.clone(), rt.clone());
    sup.start(&ns, &a.id).await.unwrap();

    // Wait for the task's result.
    let mut log = Vec::new();
    for _ in 0..240 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if let Some(run) = agent::runs(&db, &ns, &a.id, 1).unwrap().first() {
            log = agent::events(&db, &ns, &run.id, 0, 500).unwrap();
            if log.iter().any(|e| e.kind == "result" || e.kind == "error") || run.outcome != "running" {
                break;
            }
        }
    }
    let dump = log.iter().map(|e| format!("{:>7} | {}", e.kind, e.text)).collect::<Vec<_>>().join("\n");
    eprintln!("transcript:\n{dump}");
    let has = |kind: &str, needle: &str| log.iter().any(|e| e.kind == kind && e.text.contains(needle));

    assert!(has("result", "Done"), "no successful result:\n{dump}\nupstream saw: {:?}", seen.lock().unwrap());
    assert!(has("tool", "Bash  echo kalypso-sdk"), "{dump}");
    assert!(has("policy", "No force-push to main"), "the force-push was not blocked:\n{dump}");
    assert!(has("text", "force-push was blocked"), "{dump}");

    // The allowed command really ran in the sandbox; the blocked one never did.
    let (code, out) = sandbox::exec(&rt, &ns, &sb.id, &["cat", "/work/done.txt"], false).await.unwrap();
    assert_eq!((code, out.trim()), (0, "kalypso-sdk"));

    // Model calls carried the real key upstream, and only the virtual key inside.
    let calls = seen.lock().unwrap().clone();
    assert!(calls.iter().any(|c| c.starts_with("/v1/messages") && c.ends_with("key=sk-ant-real-key")), "{calls:?}");
    let (_, leak) =
        sandbox::exec(&rt, &ns, &sb.id, &["sh", "-c", "grep -rl sk-ant-real-key /run /tmp /work 2>/dev/null; true"], false).await.unwrap();
    assert_eq!(leak.trim(), "", "provider key found inside the sandbox");

    // The agent waits for more work; a message starts another turn.
    let rec = agent::get(&db, &ns, &a.id).unwrap();
    assert_eq!(rec.status, "running");
    assert!(rec.status_reason.contains("waiting for a message"), "{}", rec.status_reason);

    sup.stop(&ns, &a.id, "test over").await.unwrap();
    sandbox::remove(&db, &rt, &ns, &sb.id).await.unwrap();
    let _ = rt.remove_network(&ns).await;
}
