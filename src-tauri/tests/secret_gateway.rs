//! The secret gateway (#87), end to end, attacked from the agent's side: a real sandbox
//! from the agent runner image (which has `kx-secret`), the real gateway on its socket,
//! and the real policy engine. The "agent" here is a root shell in the sandbox, which is
//! what an agent's tool calls get.
//!
//!   podman build -t ghcr.io/kalyppso/agent-runner:dev runner/agent-sdk
//!   KALYPSO_TEST_RUNTIME=1 cargo test --test secret_gateway
#![cfg(target_os = "linux")]

use std::sync::Arc;
use std::time::Duration;

use kalypso_lib::gateway::{pricing::Pricing, Gateway};
use kalypso_lib::policy::{self, NewPolicy, Spec};
use kalypso_lib::sandbox::{self, NewSandbox, Runtime};
use kalypso_lib::store::Db;
use kalypso_lib::vault::{new_id, Vault};

const VALUE: &str = "sk_test_kx_9f3a7c51e2d4b860";

struct Env {
    db: Arc<Db>,
    rt: Runtime,
    gw: Arc<Gateway>,
    ns: String,
    sb: String,
}

impl Env {
    /// Run a shell command in the sandbox as the agent would: root, no capabilities.
    async fn agent(&self, script: &str) -> (i64, String) {
        sandbox::exec(&self.rt, &self.ns, &self.sb, &["/bin/sh", "-c", script], false).await.unwrap()
    }

    fn grants(&self) -> Vec<kalypso_lib::gateway::SecretGrant> {
        kalypso_lib::gateway::secrets::list(&self.db, &self.ns, 50).unwrap()
    }
}

/// Answer approval prompts: `approve` for each request, in order, then deny the rest.
fn approver(gw: &Arc<Gateway>, answers: Vec<bool>) -> tokio::task::JoinHandle<usize> {
    let mut rx = gw.approvals.subscribe();
    let gw = gw.clone();
    tokio::spawn(async move {
        let mut seen = 0;
        while let Ok(req) = rx.recv().await {
            let yes = answers.get(seen).copied().unwrap_or(false);
            seen += 1;
            let _ = gw.approvals.decide(&req.ns, &req.id, yes, false);
        }
        seen
    })
}

async fn env() -> Option<Env> {
    if std::env::var("KALYPSO_TEST_RUNTIME").is_err() {
        return None;
    }
    let image = std::env::var("KALYPSO_TEST_RUNNER_IMAGE").unwrap_or_else(|_| "ghcr.io/kalyppso/agent-runner:dev".into());
    let rt = Runtime::detect().await;
    let db = Arc::new(Db::open_in_memory().unwrap());
    let vault = Arc::new(Vault::ephemeral());
    let ns = format!("sg{}", &new_id("x")[2..8]);
    db.with(|c| Ok(c.execute("INSERT INTO namespaces (id, name) VALUES (?1, ?1)", [&ns])?)).unwrap();
    vault.create_ns_key(&db, &ns).unwrap();
    vault.set(&db, &ns, "STRIPE_KEY", VALUE, "on-request").unwrap();
    vault.set(&db, &ns, "SHARED_TOKEN", "shared-namespace-value", "namespace").unwrap();
    // A model key, so a model call gets as far as the leak check (it never reaches this host).
    vault.set(&db, &ns, "ANTHROPIC_API_KEY", "sk-ant-model-key", "gateway").unwrap();
    vault.set(&db, &ns, "ANTHROPIC_BASE_URL", "http://127.0.0.1:9", "gateway").unwrap();

    let gw = Gateway::new(db.clone(), vault.clone(), Pricing::builtin());
    gw.set_runtime(rt.clone());
    gw.listen_unix(std::env::temp_dir().join(format!("kx-sg-{}", std::process::id()))).await.unwrap();

    let spec = NewSandbox { name: "secrets".into(), image, cpu: 1.0, mem_mb: 512, network: "isolated".into(), provider: None };
    let sb = sandbox::create(&db, &rt, &ns, spec).await.unwrap().id;
    sandbox::start(&db, &rt, &ns, &sb).await.unwrap();
    sandbox::deliver_secrets(&db, &vault, &rt, &ns, &sb).await.unwrap();
    Some(Env { db, rt, gw, ns, sb })
}

#[tokio::test]
async fn approved_commands_get_the_secret_and_the_agent_never_does() {
    let Some(e) = env().await else { return };

    // 1. Approved: the command sees the value, the agent sees it redacted.
    let asked = approver(&e.gw, vec![true]);
    let run = r#"kx-secret run STRIPE_KEY --purpose "billing tests" -- sh -c 'echo "got:$STRIPE_KEY"; echo "$STRIPE_KEY" > /tmp/copy.txt; echo "$STRIPE_KEY" > /work/copy.txt; sleep 4; echo done' 2>&1"#.to_string();
    let agent = {
        let (rt, ns, sb) = (e.rt.clone(), e.ns.clone(), e.sb.clone());
        tokio::spawn(async move { sandbox::exec(&rt, &ns, &sb, &["/bin/sh", "-c", &run], false).await.unwrap() })
    };

    // 2. While it runs, the agent (root in the sandbox) tries everything it can.
    tokio::time::sleep(Duration::from_millis(2500)).await;
    let (_, snoop) = e
        .agent(&format!(
            // The value is split so this probe's own command line doesn't contain it.
            "A='{}'; B='{}'; ps -eo pid,user,args 2>/dev/null || ls /proc; env; cat /proc/*/environ 2>/dev/null | tr '\\0' '\\n'; \
             cat /proc/*/cmdline 2>/dev/null | tr '\\0' ' '; grep -rs \"$A$B\" /proc/*/environ /run /etc 2>/dev/null; echo snooped",
            &VALUE[..8],
            &VALUE[8..]
        ))
        .await;
    eprintln!("what the agent saw:\n{snoop}");
    assert!(snoop.contains("snooped"), "{snoop}");
    assert!(!snoop.contains(VALUE), "the agent could read the secret while the command ran:\n{snoop}");

    // 3. A model call carrying the value is refused at the gateway while the grant is live.
    let (_, model) = e
        .agent(&format!(
            "curl -s --unix-socket /run/kalypso/gateway/gateway.sock -H \"x-api-key: $(cat /run/kalypso/secrets/KALYPSO_GATEWAY_KEY)\" \
             -H 'content-type: application/json' -d '{{\"model\":\"claude-haiku-5-5\",\"max_tokens\":5,\"messages\":[{{\"role\":\"user\",\"content\":\"{VALUE}\"}}]}}' \
             http://gateway.kalypso/anthropic/v1/messages"
        ))
        .await;
    if !model.contains("contains the value of the secret STRIPE_KEY") {
        let (code, out) = agent.await.unwrap();
        panic!("model call not blocked: {model}\nkx-secret exited {code}:\n{out}\ngrants: {:?}", e.grants());
    }

    let (code, out) = agent.await.unwrap();
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("got:‹STRIPE_KEY›") && out.contains("done"), "{out}");
    assert!(!out.contains(VALUE), "the value reached the agent: {out}");
    assert!(out.contains("removed 2 file(s)"), "{out}");
    // The copies it wrote are gone; the agent never sees them.
    let (_, left) = e.agent("cat /tmp/copy.txt /work/copy.txt 2>&1; echo end").await;
    assert!(!left.contains(VALUE), "{left}");
    // One prompt so far, and the approver is still listening.
    assert!(!asked.is_finished());
    let g = &e.grants()[0];
    assert_eq!((g.secret.as_str(), g.outcome.as_str(), g.exit_code, g.leaks), ("STRIPE_KEY", "exited", Some(0), 2));
    assert!(g.command.starts_with("sh -c"), "{}", g.command);

    // 4. Denied by the user: nothing runs.
    let denied = approver(&e.gw, vec![false]);
    let (code, out) = e.agent("kx-secret run STRIPE_KEY --purpose again -- sh -c 'echo ran' 2>&1").await;
    assert_eq!(code, 126, "{out}");
    assert!(out.contains("Denied by the user") && !out.contains("ran\n"), "{out}");
    denied.abort();

    // 5. Only on-request secrets go out this way; others aren't even confirmed to exist.
    for name in ["SHARED_TOKEN", "ANTHROPIC_API_KEY", "NOPE"] {
        let (code, out) = e.agent(&format!("kx-secret run {name} --purpose x -- true 2>&1")).await;
        assert_eq!(code, 126, "{out}");
        assert!(out.contains(&format!("no on-request secret called {name}")), "{out}");
    }

    // 6. The grant expires: the command is killed at its deadline.
    let auto = policy::create(
        &e.db,
        &e.ns,
        NewPolicy {
            name: "CI may use Stripe".into(),
            rule: "Tests may use STRIPE_* without asking.".into(),
            category: "secrets".into(),
            enforcement: "warn".into(),
            applies_to: None,
            spec: Spec::SecretRequest { names: vec!["STRIPE_*".into()] },
            everywhere: None,
        },
    )
    .unwrap();
    let t = std::time::Instant::now();
    let (code, out) = e.agent("kx-secret run STRIPE_KEY --purpose slow --ttl 10s -- sleep 60 2>&1").await;
    assert_eq!(code, 124, "{out}");
    assert!(t.elapsed() < Duration::from_secs(30), "took {:?}", t.elapsed());
    assert_eq!(e.grants()[0].outcome, "expired");

    // 7. Revoked from the UI: stopped at once.
    let agent = {
        let (rt, ns, sb) = (e.rt.clone(), e.ns.clone(), e.sb.clone());
        tokio::spawn(async move {
            sandbox::exec(&rt, &ns, &sb, &["/bin/sh", "-c", "kx-secret run STRIPE_KEY --purpose long -- sleep 60 2>&1"], false)
                .await
                .unwrap()
        })
    };
    let mut id = None;
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(250)).await;
        if let Some(g) = e.grants().into_iter().find(|g| g.outcome == "running") {
            id = Some(g.id);
            break;
        }
    }
    assert!(e.gw.grants.revoke(&e.ns, &id.expect("a running grant")));
    let (code, out) = tokio::time::timeout(Duration::from_secs(15), agent).await.expect("stopped promptly").unwrap();
    assert_eq!(code, 137, "{out}");
    assert_eq!(e.grants()[0].outcome, "revoked");

    // 8. A block policy wins over everything.
    policy::update(&e.db, &e.ns, &auto.id, policy::PolicyPatch { enforcement: Some("block".into()), ..Default::default() }).unwrap();
    let (code, out) = e.agent("kx-secret run STRIPE_KEY --purpose x -- true 2>&1").await;
    assert_eq!(code, 126, "{out}");
    assert!(out.contains("Blocked by policy \"CI may use Stripe\""), "{out}");

    sandbox::remove(&e.db, &e.rt, &e.ns, &e.sb).await.unwrap();
    let _ = e.rt.remove_network(&e.ns).await;
}
