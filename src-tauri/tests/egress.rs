//! The egress proxy (#33) end to end: an `internet` sandbox reaches an allowed host through
//! it, is refused one outside the namespace's allow-list, and has no route out without it.
//!
//!   KALYPSO_TEST_RUNTIME=1 cargo test --test egress
//! (Needs Podman or Docker, and internet access on this machine.)
#![cfg(target_os = "linux")]

use std::sync::Arc;

use kalypso_lib::egress::{self, Egress};
use kalypso_lib::gateway::{pricing::Pricing, Gateway};
use kalypso_lib::policy::{self, NewPolicy, Spec};
use kalypso_lib::sandbox::{self, NewSandbox, Runtime};
use kalypso_lib::store::Db;
use kalypso_lib::vault::{new_id, Vault};

#[tokio::test]
async fn internet_sandboxes_go_out_only_through_the_proxy() {
    if std::env::var("KALYPSO_TEST_RUNTIME").is_err() {
        return;
    }
    let rt = Runtime::detect().await;
    let db = Arc::new(Db::open_in_memory().unwrap());
    let vault = Arc::new(Vault::ephemeral());
    let ns = format!("eg{}", &new_id("x")[2..8]);
    db.with(|c| Ok(c.execute("INSERT INTO namespaces (id, name) VALUES (?1, ?1)", [&ns])?)).unwrap();
    vault.create_ns_key(&db, &ns).unwrap();
    // The namespace's allow-list: example.com only, everything else refused.
    policy::create(
        &db,
        &ns,
        NewPolicy {
            name: "Only example.com".into(),
            rule: "Reach example.com and nothing else.".into(),
            category: "network".into(),
            enforcement: "block".into(),
            applies_to: None,
            spec: Spec::Host { allow: vec!["example.com".into()], deny: vec![] },
            everywhere: None,
        },
    )
    .unwrap();

    let gw = Gateway::new(db.clone(), vault.clone(), Pricing::builtin());
    egress::init_secret(&db).unwrap();
    let proxy = Egress::new(gw.clone());
    let dir = tempfile::tempdir().unwrap();
    proxy.listen_unix(dir.path().join("egress")).await.unwrap();
    proxy.listen_tcp().await.unwrap();

    let spec = NewSandbox {
        name: "web".into(),
        image: "docker.io/curlimages/curl:8.10.1".into(),
        cpu: 1.0,
        mem_mb: 256,
        network: "internet".into(),
        provider: None,
    };
    let sb = sandbox::create(&db, &rt, &ns, spec).await.unwrap();
    sandbox::start(&db, &rt, &ns, &sb.id).await.unwrap();
    let sh = |script: &str| {
        let (rt, ns, id, script) = (rt.clone(), ns.clone(), sb.id.clone(), script.to_string());
        async move { sandbox::exec(&rt, &ns, &id, &["/bin/sh", "-c", &script], false).await.unwrap() }
    };

    // Allowed: through the proxy, over HTTPS (CONNECT) and plain HTTP.
    let (_, out) = sh("curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://example.com/").await;
    assert_eq!(out.trim(), "200", "allowed host over https: {out}");
    let (_, out) = sh("curl -sS -o /dev/null -w '%{http_code}' --max-time 20 http://example.com/").await;
    assert!(out.trim().starts_with('2') || out.trim().starts_with('3'), "allowed host over http: {out}");

    // Not on the list: the proxy refuses it and says why.
    let (code, out) =
        sh("curl -sS -o /dev/null --max-time 20 https://example.org/ 2>&1; echo; curl -s --max-time 20 http://example.org/").await;
    assert!(code != 0 || out.contains("Blocked by KALYPSO"), "{out}");
    assert!(out.contains("403") || out.contains("Blocked by KALYPSO"), "{out}");
    assert!(out.contains("not on the allowed list"), "the reason reaches the sandbox: {out}");

    // Around the proxy: no route out at all.
    let (code, out) = sh("curl -sS --noproxy '*' --max-time 8 https://example.com/ 2>&1").await;
    assert_ne!(code, 0, "a sandbox must not reach the internet without the proxy: {out}");

    // Someone else's credentials don't work.
    let (_, out) =
        sh("curl -s -o /dev/null -w '%{http_code}' --max-time 10 -x http://sb-other:wrong@egress.kalypso:3128 http://example.com/").await;
    assert_eq!(out.trim(), "407", "{out}");

    sandbox::remove(&db, &rt, &ns, &sb.id).await.unwrap();
    rt.remove_network(&ns).await.unwrap();
}
