import { useState } from "react";
import { Copy, Eye, EyeOff, Lock, Plus, Trash2 } from "lucide-react";
import { uid, useNamespaced, useStore, useToast } from "../store";
import { api, errorMessage, isLive, syncNamespace } from "../backend";
import { Field, Modal, ModalActions, PageHead, PrimaryButton, useErrors } from "../components/ui";
import "../styles/pages.css";

export function Secrets() {
  const { state, dispatch } = useStore();
  const { secrets, agents } = useNamespaced();
  const toast = useToast();
  // Decrypted values live only in this component, only after the user asks.
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(state.compose);

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
                  <td className="dim">{s.scope === "namespace" ? "all agents" : users.map((a) => a.name).join(", ") || "None"}</td>
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

      {creating && <NewSecret onClose={() => setCreating(false)} />}
    </>
  );
}

function NewSecret({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState<"namespace" | "agent">("namespace");
  const { errors, check, clear } = useErrors();
  const { secrets } = useNamespaced();

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
        <input className="input mono" autoFocus value={key} onChange={(e) => { setKey(e.target.value); clear("key"); }} placeholder="OPENWEATHER_API_KEY" />
      </Field>
      <Field label="Value" error={errors.value}>
        <input className="input mono" type="password" value={value} onChange={(e) => { setValue(e.target.value); clear("value"); }} />
      </Field>
      <label className="field">Scope
        <select className="select" value={scope} onChange={(e) => setScope(e.target.value as "namespace" | "agent")}>
          <option value="namespace">Every agent in {state.ns}</option>
          <option value="agent">Only agents you grant it to</option>
        </select>
      </label>
      <ModalActions onCancel={onClose} onConfirm={create} confirm="Save secret" />
    </Modal>
  );
}
