import { useEffect, useState } from "react";
import { Copy, Eye, EyeOff, KeyRound, Lock, Plus, Trash2 } from "lucide-react";
import type { GatewayInfo } from "../bindings/GatewayInfo";
import type { GatewayKey } from "../bindings/GatewayKey";
import type { SecretGrant } from "../bindings/SecretGrant";
import { uid, useNamespaced, useStore, useToast, useCompose } from "../store";
import { api, errorMessage, isLive, onPolicyLog, syncNamespace } from "../backend";
import { EmptyState, Field, Modal, ModalActions, PageHead, PrimaryButton, useErrors, Skeleton } from "../components/ui";
import "../styles/pages.css";

export function Secrets() {
  const { state, dispatch } = useStore();
  const { loading, secrets, agents } = useNamespaced();
  const toast = useToast();
  // Decrypted values live only in this component, only after the user asks.
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  useCompose(() => setCreating(true));

  const valueOf = async (id: string) => {
    if (revealed[id] !== undefined) return revealed[id];
    const v = isLive() ? await api.secretReveal(state.ns, id) : secrets.find((s) => s.id === id)?.value ?? "";
    return v;
  };
  const toggle = (id: string) => {
    if (revealed[id] !== undefined) {
      const { [id]: _, ...rest } = revealed;
      return setRevealed(rest);
    }
    valueOf(id).then((v) => setRevealed((r) => ({ ...r, [id]: v }))).catch((e) => toast(errorMessage(e), "err"));
  };
  const copy = (id: string) =>
    valueOf(id).then((v) => navigator.clipboard?.writeText(v)).then(() => toast("Copied")).catch((e) => toast(errorMessage(e), "err"));
  const remove = (id: string, key: string) => {
    if (!confirm(`Delete ${key}?`)) return;
    if (!isLive()) return dispatch({ type: "removeSecret", id });
    api.secretDelete(state.ns, id).then(() => syncNamespace(state.ns, dispatch)).then(() => toast(`Deleted ${key}`, "warn")).catch((e) => toast(errorMessage(e), "err"));
  };

  return (
    <>
      <PageHead title="Vault" subtitle={`Secrets and keys, encrypted with the ${state.ns} vault key. Injected into sandboxes at start; never written to agent logs.`}>
        <PrimaryButton onClick={() => setCreating(true)} icon={<Plus size={14} />}>Add secret</PrimaryButton>
      </PageHead>

      <div className="card flush">
        <table className="table">
          <thead><tr><th>Key</th><th>Value</th><th>Scope</th><th>Used by</th><th>Updated</th><th /></tr></thead>
          <tbody>
            {secrets.map((s) => {
              const users = agents.filter((a) => a.secrets.includes(s.id));
              const shown = revealed[s.id] !== undefined;
              return (
                <tr key={s.id}>
                  <td className="mono"><Lock size={12} style={{ verticalAlign: -1, marginRight: 8, color: "var(--accent-hi)" }} />{s.key}</td>
                  <td className="mono dim" style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {shown ? revealed[s.id] : "•".repeat(16)}
                  </td>
                  <td><span className="badge">{s.scope}</span></td>
                  <td className="dim">{s.scope === "namespace" ? "all agents" : s.scope === "gateway" ? "model gateway" : s.scope === "on-request" ? "approved commands" : users.map((a) => a.name).join(", ") || "None"}</td>
                  <td className="dim">{s.updatedAt}</td>
                  <td>
                    <div className="row" style={{ justifyContent: "flex-end" }}>
                      <button className="btn sm" title={shown ? "Hide" : "Reveal"} onClick={() => toggle(s.id)}>{shown ? <EyeOff size={12} /> : <Eye size={12} />}</button>
                      <button className="btn sm" title="Copy" onClick={() => copy(s.id)}><Copy size={12} /></button>
                      <button className="btn sm danger" title="Delete" onClick={() => remove(s.id, s.key)}><Trash2 size={12} /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {loading && <Skeleton rows={3} />}
        {!loading && secrets.length === 0 && (
          <EmptyState icon={KeyRound} title="No secrets yet" action={<button className="btn primary sm" onClick={() => dispatch({ type: "view", view: "secrets", compose: true })}><Plus size={13} /> Add secret</button>}>
            Encrypted in the vault. Agents get them as files, or on request for one approved command.
          </EmptyState>
        )}
      </div>

      {isLive() && <SecretGrants />}
      {isLive() && <GatewayKeys />}

      {creating && <NewSecret onClose={() => setCreating(false)} />}
    </>
  );
}

/** Keys that let a tool outside KALYPSO call models through the gateway. */
function GatewayKeys() {
  const { state } = useStore();
  const toast = useToast();
  const [info, setInfo] = useState<GatewayInfo | null>(null);
  const [keys, setKeys] = useState<GatewayKey[]>([]);
  const [label, setLabel] = useState("");
  const [minted, setMinted] = useState<string | null>(null);

  const load = () => api.gatewayKeyList(state.ns).then(setKeys).catch((e) => toast(errorMessage(e), "err"));
  useEffect(() => {
    api.gatewayInfo().then(setInfo).catch(() => {});
    setMinted(null);
    load();
  }, [state.ns]);

  const create = () => {
    if (!label.trim()) return;
    api.gatewayKeyCreate(state.ns, label.trim())
      .then((k) => { setMinted(k.token); setLabel(""); return load(); })
      .catch((e) => toast(errorMessage(e), "err"));
  };
  const revoke = (k: GatewayKey) => {
    if (!confirm(`Revoke ${k.label}? Tools using it stop working.`)) return;
    api.gatewayKeyRevoke(state.ns, k.id).then(load).then(() => toast(`Revoked ${k.label}`, "warn")).catch((e) => toast(errorMessage(e), "err"));
  };
  const active = keys.filter((k) => !k.revoked_at && !k.sandbox_id);

  return (
    <div className="card flush" style={{ marginTop: 16 }}>
      <div className="card-head" style={{ padding: "16px 16px 0" }}>
        <span className="card-title">Model gateway</span>
        <span className="spacer" />
        <span className="faint small mono">{info?.url ?? "not running"}</span>
      </div>
      <p className="dim small" style={{ margin: "8px 16px 0" }}>
        Store provider keys with the <span className="mono">gateway</span> scope (ANTHROPIC_API_KEY, OPENAI_API_KEY, or
        &lt;PROVIDER&gt;_API_KEY with &lt;PROVIDER&gt;_BASE_URL). Sandboxes get their own key at start; for other tools, set the
        SDK base URL to <span className="mono">{info?.url ?? "the gateway"}/anthropic</span> (or /openai, /&lt;provider&gt;) and use a key below.
      </p>
      {minted && (
        <div className="row" style={{ margin: "12px 16px 0" }}>
          <span className="mono small" style={{ wordBreak: "break-all" }}>{minted}</span>
          <button className="btn sm" title="Copy" aria-label="Copy" onClick={() => navigator.clipboard?.writeText(minted).then(() => toast("Copied"))}><Copy size={12} /></button>
          <span className="faint small">Shown once.</span>
        </div>
      )}
      {active.length > 0 && <table className="table">
        <thead><tr><th>Key</th><th>Created</th><th /></tr></thead>
        <tbody>
          {active.map((k) => (
            <tr key={k.id}>
              <td style={{ fontWeight: 500 }}>{k.label}</td>
              <td className="dim">{k.created_at.slice(0, 10)}</td>
              <td><div className="row" style={{ justifyContent: "flex-end" }}><button className="btn sm danger" onClick={() => revoke(k)}>Revoke</button></div></td>
            </tr>
          ))}
        </tbody>
      </table>}
      <div className="row" style={{ padding: 16 }}>
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label, e.g. laptop scripts" onKeyDown={(e) => e.key === "Enter" && create()} />
        <button className="btn" onClick={create} disabled={!label.trim()} title={label.trim() ? undefined : "Type a label first"}>Create key</button>
      </div>
    </div>
  );
}

function NewSecret({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState<"namespace" | "agent" | "gateway" | "on-request">("namespace");
  const [scopeTouched, setScopeTouched] = useState(false);
  const { errors, check, clear } = useErrors();
  const { secrets } = useNamespaced();
  // Model provider keys belong to the gateway unless the user says otherwise.
  const onKey = (v: string) => {
    setKey(v);
    clear("key");
    if (!scopeTouched) setScope(/^(ANTHROPIC|OPENAI)_/i.test(v) || /_BASE_URL$/i.test(v) ? "gateway" : "namespace");
  };

  const create = () => {
    const k = key.trim();
    const suggestion = k.toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/^[^A-Z]+/, "");
    const ok = check({
      key: !k ? "Give the secret a key."
        : !/^[A-Z][A-Z0-9_]*$/.test(k) ? `Use capitals, digits and underscores, starting with a letter${suggestion ? `, like ${suggestion}` : ""}.`
        : secrets.some((s) => s.key === k) ? `${k} already exists in ${state.ns}. Delete it first to replace it.`
        : undefined,
      value: value ? undefined : "Paste the value to encrypt.",
    });
    if (!ok) return;
    if (isLive()) {
      api.secretSet(state.ns, k, value, scope)
        .then(() => syncNamespace(state.ns, dispatch))
        .then(() => { toast(`Saved ${k}`); onClose(); })
        .catch((e) => toast(errorMessage(e), "err"));
      return;
    }
    dispatch({ type: "addSecret", secret: { id: uid("s"), ns: state.ns, key: k, value, scope, updatedAt: new Date().toISOString().slice(0, 10) } });
    onClose();
  };

  return (
    <Modal title="Add secret" subtitle="Encrypted at rest. Agents receive it as a file, never in their prompt." onClose={onClose}>
      <Field label="Key" error={errors.key}>
        <input className="input mono" autoFocus value={key} onChange={(e) => onKey(e.target.value)} placeholder="OPENWEATHER_API_KEY" />
      </Field>
      <Field label="Value" error={errors.value}>
        <input className="input mono" type="password" value={value} onChange={(e) => { setValue(e.target.value); clear("value"); }} />
      </Field>
      <label className="field">Scope
        <select className="select" value={scope} onChange={(e) => { setScopeTouched(true); setScope(e.target.value as typeof scope); }}>
          <option value="namespace">Every agent in {state.ns}</option>
          <option value="agent">Only agents you grant it to</option>
          <option value="gateway">Model gateway only (never sent to sandboxes)</option>
          {isLive() && <option value="on-request">On request: only to commands you approve</option>}
        </select>
      </label>
      {scope === "on-request" && (
        <p className="faint small" style={{ margin: 0 }}>
          Never in a sandbox. An agent asks with <span className="mono">kx-secret run {key.trim() || "NAME"} -- command</span>; once a policy or you approve,
          KALYPSO runs that command with the secret in its environment, as a user the agent can't read, and hides the value in what the agent sees.
        </p>
      )}
      <ModalActions onCancel={onClose} onConfirm={create} confirm="Save secret" />
    </Modal>
  );
}

/** Commands that ran, or are running, with an on-request secret (#87). Never shows values. */
function SecretGrants() {
  const { state } = useStore();
  const toast = useToast();
  const [grants, setGrants] = useState<SecretGrant[]>([]);
  const load = () => api.secretGrants(state.ns).then((g) => setGrants(Array.isArray(g) ? g : [])).catch(() => setGrants([]));
  useEffect(() => {
    load();
    const off = onPolicyLog((ns) => ns === state.ns && load());
    // Running grants count down; refresh now and then so "expires" stays honest.
    const t = setInterval(load, 15000);
    return () => { off.then((f) => f()); clearInterval(t); };
  }, [state.ns]);
  if (!grants.length) return null;
  const revoke = (g: SecretGrant) =>
    api.secretGrantRevoke(state.ns, g.id).then(() => { toast(`Stopped the command using ${g.secret}`, "warn"); load(); }).catch((e) => toast(errorMessage(e), "err"));

  return (
    <section className="card" style={{ marginTop: 24 }}>
      <div className="card-head"><span className="card-title">Commands with secrets</span><span className="faint small">Last {grants.length}</span></div>
      <table className="table">
        <thead><tr><th>Secret</th><th>Command</th><th>Asked by</th><th>Started</th><th>Outcome</th><th /></tr></thead>
        <tbody>
          {grants.map((g) => (
            <tr key={g.id}>
              <td className="mono">{g.secret}</td>
              <td className="mono small clip" title={`${g.command}\n\nPurpose: ${g.purpose}`} style={{ maxWidth: 280 }}>{g.command}</td>
              <td className="dim small">{g.source}</td>
              <td className="dim small mono">{g.started_at.slice(11, 16)}</td>
              <td className="small">
                {g.outcome === "running" ? <>running · until {g.expires_at.slice(11, 16)}</> : g.outcome === "exited" ? `exited ${g.exit_code ?? "?"}` : g.outcome}
                {g.leaks > 0 && <span className="badge" title="Files the command left holding the value were removed" style={{ marginLeft: 6 }}>{g.leaks} copy removed</span>}
              </td>
              <td>{g.outcome === "running" && <button className="btn sm" onClick={() => revoke(g)}>Revoke</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
