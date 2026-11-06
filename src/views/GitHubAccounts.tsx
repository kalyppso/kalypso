import { useEffect, useRef, useState } from "react";
import { siGithub } from "simple-icons";
import { Check, Copy, ExternalLink, GitBranch, Loader2, Plus, RefreshCw } from "lucide-react";
import { api, errorMessage, openUrl } from "../backend";
import type { Account } from "../bindings/Account";
import type { DeviceStart } from "../bindings/DeviceStart";
import { useStore, useToast } from "../store";
import { EmptyState, Modal } from "../components/ui";
import { BrandIcon } from "./Auth";

// GitHub accounts (#100), in Settings → Account. Several at once, connected by signing in or by
// pasting a token. Each namespace chooses which accounts it may use. Tokens stay in the core.

export function GitHubAccounts() {
  const toast = useToast();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [connecting, setConnecting] = useState<{ replace?: Account } | null>(null);
  const load = () => api.ghAccounts().then(setAccounts).catch((e) => { setAccounts([]); toast(errorMessage(e), "err"); });
  useEffect(() => { load(); }, []);
  const upsert = (a: Account) => setAccounts((all) => (all ?? []).some((x) => x.id === a.id) ? (all ?? []).map((x) => (x.id === a.id ? a : x)) : [...(all ?? []), a]);

  return (
    <div style={{ marginBottom: 20 }}>
      <div className="row" style={{ alignItems: "baseline" }}>
        <div className="section-title">GitHub accounts</div>
        <span className="spacer" />
        {!!accounts?.length && <button className="btn sm" onClick={() => setConnecting({})}><Plus size={13} /> Connect account</button>}
      </div>
      <div className="card" style={{ padding: "4px 18px" }}>
        {accounts === null && <p className="faint" style={{ padding: "12px 0" }}><Loader2 size={14} className="spin" /> Loading accounts…</p>}
        {accounts?.length === 0 && (
          <EmptyState icon={GitBranch} title="No GitHub accounts yet" action={<button className="btn primary" onClick={() => setConnecting({})}>Connect GitHub</button>}>
            Connect one so agents can clone, push and open pull requests. The token stays in KALYPSO; sandboxes never see it.
          </EmptyState>
        )}
        {accounts?.map((a) => (
          <AccountRow key={a.id} a={a} onChange={upsert} onRemove={() => setAccounts((all) => (all ?? []).filter((x) => x.id !== a.id))} onReconnect={() => setConnecting({ replace: a })} />
        ))}
      </div>
      {connecting && <ConnectGitHub replace={connecting.replace} onClose={() => setConnecting(null)} onDone={(a) => { upsert(a); setConnecting(null); toast(`${a.label} connected`); }} />}
    </div>
  );
}

function AccountRow({ a, onChange, onRemove, onReconnect }: { a: Account; onChange: (a: Account) => void; onRemove: () => void; onReconnect: () => void }) {
  const { state } = useStore();
  const toast = useToast();
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(a.label);
  const [busy, setBusy] = useState(false);
  const run = (p: Promise<Account>) => { setBusy(true); p.then(onChange).catch((e) => toast(errorMessage(e), "err")).finally(() => setBusy(false)); };
  const toggleNs = (ns: string) => run(api.ghAccountNamespaces(a.id, a.namespaces.includes(ns) ? a.namespaces.filter((n) => n !== ns) : [...a.namespaces, ns]));
  const reconnect = a.status === "reconnect";
  return (
    <div className="gh-account">
      <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
        {a.avatar_url ? <img className="gh-avatar" src={a.avatar_url} alt="" /> : <span className="gh-avatar"><BrandIcon icon={siGithub} size={16} /></span>}
        <div style={{ flex: 1, minWidth: 0 }}>
          {renaming ? (
            <div className="row" style={{ gap: 6 }}>
              <input className="input" autoFocus value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { run(api.ghAccountRename(a.id, label)); setRenaming(false); } if (e.key === "Escape") { setLabel(a.label); setRenaming(false); } }} />
              <button className="btn sm" onClick={() => { run(api.ghAccountRename(a.id, label)); setRenaming(false); }}>Save</button>
            </div>
          ) : (
            <div>{a.label} <span className="faint">· {a.login}</span> <span className="badge">{a.kind === "oauth" ? "Signed in" : "Token"}</span></div>
          )}
          <div className="faint small">
            {a.orgs.length ? `Organisations: ${a.orgs.join(", ")}` : "No organisations"}
            {a.scopes.length ? ` · scopes: ${a.scopes.join(", ")}` : a.kind === "token" ? " · fine-grained token" : ""}
          </div>
          {reconnect && <div className="gh-reconnect small" role="alert">{a.status_reason ?? "GitHub no longer accepts this account's token."}</div>}
        </div>
        <div className="row" style={{ gap: 4 }}>
          {reconnect
            ? <button className="btn primary sm" onClick={onReconnect}>Reconnect</button>
            : <button className="btn ghost sm icon" title="Check now" aria-label="Check now" disabled={busy} onClick={() => run(api.ghAccountCheck(a.id))}>{busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}</button>}
          {!renaming && <button className="btn ghost sm" onClick={() => setRenaming(true)}>Rename</button>}
          <button className="btn ghost sm" onClick={() => {
            if (!confirm(`Disconnect ${a.label}? Agents using it lose access to its repositories.`)) return;
            api.ghAccountRemove(a.id).then(() => { onRemove(); toast(`${a.label} disconnected`, "info"); }).catch((e) => toast(errorMessage(e), "err"));
          }}>Disconnect</button>
        </div>
      </div>
      <div className="gh-ns" role="group" aria-label={`Namespaces that may use ${a.label}`}>
        <span className="faint small">Used in</span>
        {state.namespaces.map((n) => (
          <button key={n.id} className={`chip${a.namespaces.includes(n.id) ? " on" : ""}`} aria-pressed={a.namespaces.includes(n.id)} disabled={busy} onClick={() => toggleNs(n.id)}>
            {a.namespaces.includes(n.id) && <Check size={11} />} {n.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function ConnectGitHub({ replace, onClose, onDone }: { replace?: Account; onClose: () => void; onDone: (a: Account) => void }) {
  const { state } = useStore();
  const toast = useToast();
  const [signIn, setSignIn] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"signin" | "token">("token");
  const [label, setLabel] = useState("");
  const [namespaces, setNamespaces] = useState<string[]>(replace ? replace.namespaces : [state.ns]);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceStart | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { api.ghInfo().then((i) => { setSignIn(i.sign_in); if (i.sign_in) setMode("signin"); }).catch(() => setSignIn(false)); }, []);

  const connectToken = () => {
    if (!token.trim()) { setError("Paste a token first."); return; }
    setBusy(true); setError(null);
    api.ghConnectToken(label, token, namespaces, replace?.id).then(onDone).catch((e) => setError(errorMessage(e))).finally(() => setBusy(false));
  };
  const startSignIn = async () => {
    setBusy(true); setError(null);
    try {
      const d = await api.ghDeviceStart();
      setDevice(d);
      navigator.clipboard?.writeText(d.user_code).catch(() => {});
      openUrl(d.verification_uri);
      let wait = d.interval;
      const deadline = Date.now() + d.expires_in * 1000;
      while (alive.current && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, wait * 1000));
        if (!alive.current) return;
        const p = await api.ghDevicePoll(d.device_code, label, namespaces, replace?.id);
        if (p.state === "done") { onDone(p.account); return; }
        if (p.state === "denied") throw new Error("Sign-in was cancelled on GitHub.");
        if (p.state === "expired") break;
        wait = p.interval;
      }
      if (alive.current) throw new Error("The code expired before it was approved. Start again.");
    } catch (e) {
      if (alive.current) { setError(errorMessage(e)); setDevice(null); }
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <Modal title={replace ? `Reconnect ${replace.label}` : "Connect a GitHub account"} subtitle={replace ? `Sign in again as ${replace.login}, or paste a new token for it.` : "Agents use it to clone, push and open pull requests. The token stays in KALYPSO."} onClose={onClose}>
      <div className="segmented" role="tablist">
        <button role="tab" aria-selected={mode === "signin"} className={mode === "signin" ? "active" : ""} disabled={!signIn} title={signIn ? undefined : "Not set up in this build"} onClick={() => setMode("signin")}>Sign in with GitHub</button>
        <button role="tab" aria-selected={mode === "token"} className={mode === "token" ? "active" : ""} onClick={() => setMode("token")}>Paste a token</button>
      </div>
      {signIn === false && mode === "token" && <p className="faint small" style={{ margin: 0 }}>Sign-in with GitHub isn't set up in this build yet, so connect with a token.</p>}

      {!replace && (
        <>
          <label className="field">Name<input className="input" value={label} maxLength={40} placeholder="For example: work, or personal" onChange={(e) => setLabel(e.target.value)} /></label>
          <div className="field">
            Namespaces that may use it
            <div className="gh-ns" style={{ marginTop: 6 }}>
              {state.namespaces.map((n) => {
                const on = namespaces.includes(n.id);
                return <button key={n.id} type="button" className={`chip${on ? " on" : ""}`} aria-pressed={on} onClick={() => setNamespaces(on ? namespaces.filter((x) => x !== n.id) : [...namespaces, n.id])}>{on && <Check size={11} />} {n.name}</button>;
              })}
            </div>
          </div>
        </>
      )}

      {mode === "token" && (
        <>
          <label className="field">
            Token
            <input className="input mono" type="password" autoComplete="off" spellCheck={false} placeholder="github_pat_… or ghp_…" value={token}
              onChange={(e) => { setToken(e.target.value); setError(null); }} onKeyDown={(e) => e.key === "Enter" && connectToken()} />
          </label>
          <p className="faint small" style={{ margin: 0 }}>
            A fine-grained token with <b>Contents</b> and <b>Pull requests</b> (read and write) on the repositories agents should use, or a classic token with <code>repo</code> and <code>read:org</code>.{" "}
            <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">Create one <ExternalLink size={11} /></a>
          </p>
        </>
      )}

      {mode === "signin" && device && (
        <div className="gh-device">
          <div className="faint small">Enter this code on GitHub. It's copied, and the page is open in your browser.</div>
          <div className="row" style={{ gap: 8 }}>
            <code className="gh-code">{device.user_code}</code>
            <button className="btn ghost sm icon" title="Copy" onClick={() => navigator.clipboard.writeText(device.user_code).then(() => toast("Copied", "info"))}><Copy size={13} /></button>
          </div>
          <button className="btn sm" onClick={() => openUrl(device.verification_uri)}>Open {device.verification_uri.replace(/^https?:\/\//, "")} <ExternalLink size={12} /></button>
          <div className="faint small"><Loader2 size={13} className="spin" /> Waiting for you to approve…</div>
        </div>
      )}

      {error && <div className="setup-problem" role="alert">{error}</div>}

      <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        {mode === "token"
          ? <button className="btn primary" disabled={busy} onClick={connectToken}>{busy && <Loader2 size={13} className="spin" />} {replace ? "Reconnect" : "Connect"}</button>
          : !device && <button className="btn primary" disabled={busy || !signIn} onClick={startSignIn}>{busy && <Loader2 size={13} className="spin" />} Sign in with GitHub</button>}
      </div>
    </Modal>
  );
}
