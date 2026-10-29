import { useState } from "react";
import { Play, Plus, Square } from "lucide-react";
import { uid, useNamespaced, useStore, useToast } from "../store";
import { CodeReveal, Modal, ModalActions, PageHead, PrimaryButton, Status, initials } from "../components/ui";

const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

export function Agents() {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { agents, sandboxes, secrets, policies, integrations } = useNamespaced();
  const [creating, setCreating] = useState(false);

  const label = (ids: string[], list: { id: string; name?: string; key?: string }[]) =>
    ids.map((id) => list.find((x) => x.id === id)).filter(Boolean).map((x) => x!.name ?? x!.key);

  return (
    <>
      <PageHead title="Agents" subtitle="Each agent runs in a sandbox and only gets the secrets, tools and integrations you grant it.">
        <PrimaryButton onClick={() => setCreating(true)} icon={<Plus size={14} />}>New agent</PrimaryButton>
      </PageHead>

      {agents.length === 0 && <div className="empty">No agents in this namespace yet.</div>}

      <div className="grid cards">
        {agents.map((a) => {
          const sb = sandboxes.find((s) => s.id === a.sandboxId);
          const live = a.status === "running" || a.status === "idle";
          const guards = policies.filter((p) => p.enabled && (p.appliesTo === "all" || p.appliesTo.includes(a.id)));
          const linked = integrations.filter((i) => i.agents.includes(a.id));
          return (
            <div key={a.id} className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="row">
                <span className="avatar" style={{ width: 30, height: 30, fontSize: 11 }}>{initials(a.name)}</span>
                <div>
                  <h2>{a.name}</h2>
                  <div className="faint small">{a.role}</div>
                </div>
                <span className="spacer" />
                <Status value={a.status} />
              </div>
              <Meta k="Model" v={<span className="mono">{a.model}</span>} />
              <Meta k="Sandbox" v={sb ? sb.name : <span style={{ color: "var(--err)" }}>none</span>} />
              <Meta k="Skills" v={<Chips items={label(a.skills, state.skills)} />} />
              <Meta k="MCPs" v={<Chips items={label(a.mcps, state.mcps)} />} />
              <Meta k="Secrets" v={<Chips items={label(a.secrets, secrets)} mono />} />
              <Meta k="Linked" v={linked.length ? <div className="chips">{linked.map((b) => <span key={b.id} className="badge">{b.name}{b.brain ? " (brain)" : ""}</span>)}</div> : <span className="faint">None</span>} />
              <div className="row" style={{ marginTop: 2 }}>
                <span className="faint small">{guards.length} policies apply</span>
                <span className="spacer" />
                <button
                  className="btn sm"
                  disabled={!sb}
                  title={sb ? undefined : "Assign a sandbox first"}
                  onClick={() => {
                    dispatch({ type: "agentStatus", id: a.id, status: live ? "stopped" : "running" });
                    toast(live ? `${a.name} stopped` : `${a.name} is running`, live ? "warn" : "ok");
                  }}
                >
                  {live ? <><Square size={12} /> Stop</> : <><Play size={12} /> Start</>}
                </button>
              </div>
              <CodeReveal code={a.config} />
            </div>
          );
        })}
      </div>

      {creating && <NewAgent onClose={() => setCreating(false)} />}
    </>
  );
}

function Meta({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="row" style={{ alignItems: "flex-start", fontSize: 13 }}>
      <span className="faint" style={{ width: 66, flex: "none", fontSize: 12 }}>{k}</span>
      <div style={{ minWidth: 0 }}>{v}</div>
    </div>
  );
}

function Chips({ items, mono }: { items: (string | undefined)[]; mono?: boolean }) {
  if (items.length === 0) return <span className="faint">None</span>;
  return <div className="chips">{items.map((i) => <span key={i} className={`badge ${mono ? "mono" : ""}`}>{i}</span>)}</div>;
}

function NewAgent({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { sandboxes } = useNamespaced();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [model, setModel] = useState(MODELS[1]);
  const [sandboxId, setSandboxId] = useState(sandboxes[0]?.id ?? "");

  const create = () => {
    if (!name.trim()) return;
    const n = name.trim();
    dispatch({
      type: "addAgent",
      agent: {
        id: uid("a"), ns: state.ns, name: n, role: role || "General assistant", model, status: "stopped",
        sandboxId: sandboxId || null, skills: [], mcps: [], secrets: [],
        config: `# ${n}.agent.yaml\nname: ${n}\nmodel: ${model}\nmax_turns: 40\n`,
      },
    });
    toast(`Agent ${n} created`);
    onClose();
  };

  return (
    <Modal title="New agent" subtitle={`Created in ${state.ns}. Namespace policies apply automatically.`} onClose={onClose}>
      <label className="field">Name<input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="scout" /></label>
      <label className="field">Role<input className="input" value={role} onChange={(e) => setRole(e.target.value)} placeholder="What does this agent do?" /></label>
      <div className="field-row">
        <label className="field">Model
          <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
            {MODELS.map((m) => <option key={m}>{m}</option>)}
          </select>
        </label>
        <label className="field">Sandbox
          <select className="select" value={sandboxId} onChange={(e) => setSandboxId(e.target.value)}>
            <option value="">None yet</option>
            {sandboxes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      </div>
      <ModalActions onCancel={onClose} onConfirm={create} confirm="Create agent" />
    </Modal>
  );
}
