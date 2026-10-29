import { useEffect, useState } from "react";
import { Copy, Eye, EyeOff, Lock, Plus, Trash2 } from "lucide-react";
import type { GatewayInfo } from "../bindings/GatewayInfo";
import type { GatewayKey } from "../bindings/GatewayKey";
import { uid, useNamespaced, useStore, useToast } from "../store";
import { api, errorMessage, isLive, syncNamespace } from "../backend";
import { Modal, ModalActions, PageHead, PrimaryButton } from "../components/ui";

export function Secrets() {
  const { state, dispatch } = useStore();
  const { secrets, agents } = useNamespaced();
  const toast = useToast();
  // Decrypted values live only in this component, only after the user asks.
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);

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
      <PageHead title="Secrets" subtitle={`Encrypted with the ${state.ns} vault key. Injected into sandboxes at start; never written to agent logs.`}>
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
                  <td className="dim">{s.scope === "namespace" ? "all agents" : s.scope === "gateway" ? "model gateway" : users.map((a) => a.name).join(", ") || "None"}</td>
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
        {secrets.length === 0 && <div className="empty" style={{ margin: 16 }}>No secrets in this namespace.</div>}
      </div>

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
          <button className="btn sm" onClick={() => navigator.clipboard?.writeText(minted).then(() => toast("Copied"))}><Copy size={12} /></button>
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
        <button className="btn" onClick={create}>Create key</button>
      </div>
    </div>
  );
}

function NewSecret({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState<"namespace" | "agent" | "gateway">("namespace");
  const [scopeTouched, setScopeTouched] = useState(false);
  // Model provider keys belong to the gateway unless the user says otherwise.
  const onKey = (v: string) => {
    setKey(v);
    if (!scopeTouched) setScope(/^(ANTHROPIC|OPENAI)_/i.test(v) || /_BASE_URL$/i.test(v) ? "gateway" : "namespace");
  };

  const create = () => {
    const k = key.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    if (!k || !value) return;
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
      <label className="field">Key<input className="input mono" autoFocus value={key} onChange={(e) => onKey(e.target.value)} placeholder="OPENWEATHER_API_KEY" /></label>
      <label className="field">Value<input className="input mono" type="password" value={value} onChange={(e) => setValue(e.target.value)} /></label>
      <label className="field">Scope
        <select className="select" value={scope} onChange={(e) => { setScopeTouched(true); setScope(e.target.value as typeof scope); }}>
          <option value="namespace">Every agent in {state.ns}</option>
          <option value="agent">Only agents you grant it to</option>
          <option value="gateway">Model gateway only (never sent to sandboxes)</option>
        </select>
      </label>
      <ModalActions onCancel={onClose} onConfirm={create} confirm="Save secret" />
    </Modal>
  );
}
