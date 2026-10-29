import { useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, Play, Plus, Square } from "lucide-react";
import { uid, useNamespaced, useStore, useToast } from "../store";
import { CodeReveal, Field, Modal, ModalActions, PageHead, PrimaryButton, Status, initials, useErrors } from "../components/ui";
import type { Agent } from "../types";
import "../styles/agents.css";

const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

export function Agents() {
  const { state } = useStore();
  const { agents, sandboxes } = useNamespaced();
  const [creating, setCreating] = useState(state.compose);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = agents.find((a) => a.id === openId);

  if (open) return <AgentDetail agent={open} onBack={() => setOpenId(null)} />;

  return (
    <>
      <PageHead title="Agents" subtitle="Each agent runs in a sandbox and only gets the secrets, tools and integrations you grant it.">
        <PrimaryButton onClick={() => setCreating(true)} icon={<Plus size={14} />}>New agent</PrimaryButton>
      </PageHead>

      {agents.length === 0 && <div className="empty">No agents in this namespace yet.</div>}

      <div className="agent-list">
        {agents.map((a) => {
          const sb = sandboxes.find((s) => s.id === a.sandboxId);
          return (
            <button key={a.id} className="agent-row" onClick={() => setOpenId(a.id)}>
              <span className={`agent-avatar ${a.status}`}>{initials(a.name)}</span>
              <span className="agent-main">
                <span className="agent-name">{a.name}</span>
                <span className="faint small clip">{a.role}</span>
              </span>
              <span className="agent-meta mono small dim clip">{a.model}</span>
              <span className="agent-meta small faint clip">{sb ? sb.name : "No sandbox"}</span>
              <span className="agent-meta small faint">{a.skills.length + a.mcps.length} tools</span>
              <Status value={a.status} />
              <ChevronRight size={15} className="agent-chevron" />
            </button>
          );
        })}
      </div>

      {creating && <NewAgent onClose={() => setCreating(false)} />}
    </>
  );
}

function AgentDetail({ agent: a, onBack }: { agent: Agent; onBack: () => void }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { sandboxes, secrets, policies, integrations } = useNamespaced();
  const sb = sandboxes.find((s) => s.id === a.sandboxId);
  const live = a.status === "running" || a.status === "idle";
  const guards = policies.filter((p) => p.enabled && (p.appliesTo === "all" || p.appliesTo.includes(a.id)));
  const linked = integrations.filter((i) => i.agents.includes(a.id));
  const label = (ids: string[], list: { id: string; name?: string; key?: string }[]) =>
    ids.map((id) => list.find((x) => x.id === id)).filter(Boolean).map((x) => x!.name ?? x!.key);

  return (
    <>
      <button className="btn ghost sm agent-back" onClick={onBack}><ArrowLeft size={13} /> Agents</button>
      <div className="agent-head">
        <span className={`agent-avatar lg ${a.status}`}>{initials(a.name)}</span>
        <div style={{ minWidth: 0 }}>
          <div className="row"><h1>{a.name}</h1><Status value={a.status} /></div>
          <p className="dim" style={{ margin: "4px 0 0" }}>{a.role}</p>
        </div>
        <span className="spacer" />
        <button
          className={`btn ${live ? "" : "primary"}`}
          disabled={!sb}
          title={sb ? undefined : "Assign a sandbox first"}
          onClick={() => {
            dispatch({ type: "agentStatus", id: a.id, status: live ? "stopped" : "running" });
            toast(live ? `${a.name} stopped` : `${a.name} is running`, live ? "warn" : "ok");
          }}
        >
          {live ? <><Square size={13} /> Stop</> : <><Play size={13} /> Start</>}
        </button>
      </div>

      <div className="agent-facts">
        <Fact k="Model" v={<span className="mono">{a.model}</span>} />
        <Fact k="Sandbox" v={sb ? sb.name : <span className="faint">None assigned</span>} />
        <Fact k="Policies" v={`${guards.length} apply`} />
        <Fact k="Integrations" v={`${linked.length} linked`} />
      </div>

      <Section title="Skills"><Chips items={label(a.skills, state.skills)} /></Section>
      <Section title="MCP servers"><Chips items={label(a.mcps, state.mcps)} /></Section>
      <Section title="Secrets"><Chips items={label(a.secrets, secrets)} mono /></Section>
      <Section title="Linked integrations">
        <Chips items={linked.map((b) => `${b.name}${b.brain ? " (brain)" : ""}`)} />
      </Section>
      <Section title="Policies">
        <Chips items={guards.map((p) => p.name)} />
      </Section>
      <Section title="Configuration"><CodeReveal code={a.config} /></Section>
    </>
  );
}

function Fact({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="agent-fact">
      <div className="faint small">{k}</div>
      <div className="clip" style={{ marginTop: 4, fontWeight: 500 }}>{v}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="agent-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Chips({ items, mono }: { items: (string | undefined)[]; mono?: boolean }) {
  if (items.length === 0) return <span className="faint">None</span>;
  return <div className="chips">{items.map((i) => <span key={i} className={`badge ${mono ? "mono" : ""}`}>{i}</span>)}</div>;
}

function NewAgent({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { agents, sandboxes } = useNamespaced();
  const { errors, check, clear } = useErrors();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [model, setModel] = useState(MODELS[1]);
  const [sandboxId, setSandboxId] = useState(sandboxes[0]?.id ?? "");

  const create = () => {
    const n = name.trim();
    const ok = check({
      name: !n ? "Give the agent a name."
        : !/^[a-zA-Z0-9-]+$/.test(n) ? "Use letters, digits and dashes only."
        : agents.some((a) => a.name.toLowerCase() === n.toLowerCase()) ? `An agent called ${n} already exists here.`
        : undefined,
    });
    if (!ok) return;
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
      <Field label="Name" error={errors.name}>
        <input className="input" autoFocus value={name} onChange={(e) => { setName(e.target.value); clear("name"); }} onKeyDown={(e) => e.key === "Enter" && create()} placeholder="scout" />
      </Field>
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
