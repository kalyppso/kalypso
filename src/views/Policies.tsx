import { useState } from "react";
import { Ban, Eye, Hand, Plus, Trash2 } from "lucide-react";
import { uid, useNamespaced, useStore, useToast } from "../store";
import { CodeReveal, Modal, ModalActions, PageHead, PrimaryButton, Status, Toggle } from "../components/ui";
import type { Enforcement, Policy, PolicyCategory } from "../types";

const ENFORCEMENT: { id: Enforcement; label: string; icon: JSX.Element; hint: string }[] = [
  { id: "block", label: "Block", icon: <Ban size={13} />, hint: "Stop the action outright" },
  { id: "approve", label: "Ask me", icon: <Hand size={13} />, hint: "Pause until you approve" },
  { id: "warn", label: "Warn", icon: <Eye size={13} />, hint: "Allow, but flag it" },
];

const CATEGORIES: PolicyCategory[] = ["filesystem", "network", "git", "secrets", "spend", "comms", "deploy", "custom"];

const TEMPLATES: Pick<Policy, "name" | "rule" | "category" | "enforcement">[] = [
  { name: "Never drop databases", rule: "Never run DROP, TRUNCATE or delete-all statements against any database.", category: "deploy", enforcement: "block" },
  { name: "Stay out of personal accounts", rule: "Never open or read my personal email, banking or social media accounts.", category: "network", enforcement: "block" },
  { name: "No purchases", rule: "Never buy, subscribe or enter payment details anywhere.", category: "spend", enforcement: "block" },
  { name: "No browser extensions", rule: "Never install browser extensions or change browser security settings.", category: "custom", enforcement: "approve" },
  { name: "Quiet Fridays", rule: "Don't merge or deploy after 4pm on Fridays.", category: "deploy", enforcement: "approve" },
  { name: "No mass deletes", rule: "Ask before deleting more than 20 files in one go.", category: "filesystem", enforcement: "approve" },
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const specFor = (name: string, rule: string, enforcement: Enforcement) =>
  [`policy: ${slug(name)}`, "on: [any_tool_call, message, model_request]", `match: judge(${JSON.stringify(rule)})`, `action: ${enforcement === "approve" ? "require_approval" : enforcement}`].join("\n");

export function Policies() {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { policies, policyEvents, agents } = useNamespaced();
  const [creating, setCreating] = useState(false);
  const name = (id: string) => state.agents.find((a) => a.id === id)?.name ?? id;
  const active = policies.filter((p) => p.enabled);
  const unusedTemplates = TEMPLATES.filter((t) => !policies.some((p) => p.name === t.name));

  const addTemplate = (t: (typeof TEMPLATES)[number]) => {
    dispatch({ type: "addPolicy", policy: { ...t, id: uid("p"), ns: state.ns, appliesTo: "all", enabled: true, spec: specFor(t.name, t.rule, t.enforcement) } });
    toast(`Added policy: ${t.name}`);
  };

  return (
    <>
      <PageHead title="Policies" subtitle="Rules your agents follow. Each one is checked before a tool call, message or model request runs.">
        <PrimaryButton onClick={() => setCreating(true)} icon={<Plus size={14} />}>New policy</PrimaryButton>
      </PageHead>

      <div className="stats">
        {ENFORCEMENT.map((e) => (
          <div key={e.id} className="stat">
            <div className="stat-label">{e.label}</div>
            <div className="stat-value">{active.filter((p) => p.enforcement === e.id).length}</div>
            <div className="stat-sub">{e.hint}</div>
          </div>
        ))}
        <div className="stat">
          <div className="stat-label">Stopped today</div>
          <div className="stat-value">{policyEvents.filter((e) => e.outcome === "blocked" || e.outcome === "denied").length}</div>
          <div className="stat-sub">{policyEvents.length} events</div>
        </div>
      </div>

      {unusedTemplates.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div className="section-title">Suggested</div>
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            {unusedTemplates.map((t) => (
              <button key={t.name} className="btn sm" onClick={() => addTemplate(t)} title={t.rule}><Plus size={12} /> {t.name}</button>
            ))}
          </div>
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(420px, 1fr))", marginBottom: 24 }}>
        {policies.map((p) => (
          <div key={p.id} className="card" style={{ display: "flex", flexDirection: "column", gap: 12, opacity: p.enabled ? 1 : 0.55 }}>
            <div className="row">
              <Toggle on={p.enabled} onChange={(v) => dispatch({ type: "updatePolicy", id: p.id, patch: { enabled: v } })} label={`Enable ${p.name}`} />
              <h2 style={{ minWidth: 0 }}>{p.name}</h2>
              <span className="spacer" />
              <button className="btn ghost sm icon danger" title="Delete policy" onClick={() => { dispatch({ type: "removePolicy", id: p.id }); toast(`Removed policy: ${p.name}`, "warn"); }}><Trash2 size={13} /></button>
            </div>
            <p className="dim" style={{ margin: 0 }}>{p.rule}</p>
            <div className="row">
              <div className="segmented">
                {ENFORCEMENT.map((e) => (
                  <button key={e.id} className={p.enforcement === e.id ? "active" : ""} onClick={() => dispatch({ type: "updatePolicy", id: p.id, patch: { enforcement: e.id } })}>
                    {e.label}
                  </button>
                ))}
              </div>
              <span className="spacer" />
              <span className="faint small" style={{ textAlign: "right" }}>
                {p.ns === "*" ? "All namespaces" : p.ns}, {p.appliesTo === "all" ? "all agents" : p.appliesTo.map(name).join(", ")}
              </span>
            </div>
            <CodeReveal code={p.spec} label="rule spec" />
          </div>
        ))}
      </div>

      <div className="card flush">
        <div className="card-head" style={{ padding: "16px 16px 0" }}><span className="card-title">Today's log</span></div>
        <table className="table">
          <thead><tr><th>Time</th><th>Agent</th><th>Policy</th><th>Attempted</th><th>Outcome</th></tr></thead>
          <tbody>
            {policyEvents.map((e) => (
              <tr key={e.id}>
                <td className="mono faint">{e.at}</td>
                <td style={{ fontWeight: 500 }}>{name(e.agentId)}</td>
                <td className="dim">{state.policies.find((p) => p.id === e.policyId)?.name ?? e.policyId}</td>
                <td className="mono dim">{e.detail}</td>
                <td><Status value={e.outcome} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {policyEvents.length === 0 && <div className="empty" style={{ margin: 16 }}>No policy was triggered today.</div>}
      </div>

      {creating && <NewPolicy agents={agents.map((a) => ({ id: a.id, name: a.name }))} onClose={() => setCreating(false)} />}
    </>
  );
}

function NewPolicy({ agents, onClose }: { agents: { id: string; name: string }[]; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const [rule, setRule] = useState("Never ");
  const [name, setName] = useState("");
  const [category, setCategory] = useState<PolicyCategory>("custom");
  const [enforcement, setEnforcement] = useState<Enforcement>("block");
  const [global, setGlobal] = useState(false);
  const [targets, setTargets] = useState<string[]>([]);

  const create = () => {
    const r = rule.trim();
    if (r.length < 8) return;
    const n = name.trim() || r.replace(/^never\s+/i, "No ").split(/[.,;]/)[0].slice(0, 48);
    dispatch({
      type: "addPolicy",
      policy: {
        id: uid("p"), ns: global ? "*" : state.ns, name: n, rule: r, category, enforcement,
        appliesTo: targets.length ? targets : "all", enabled: true, spec: specFor(n, r, enforcement),
      },
    });
    toast(`Added policy: ${n}`);
    onClose();
  };

  return (
    <Modal title="New policy" subtitle="Describe what agents must not do." onClose={onClose}>
      <label className="field">Rule
        <textarea className="textarea" autoFocus value={rule} onChange={(e) => setRule(e.target.value)} placeholder="Never push directly to main." />
      </label>
      <label className="field">Short name (optional)<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Generated from the rule" /></label>
      <div className="field-row">
        <label className="field">Category
          <select className="select" value={category} onChange={(e) => setCategory(e.target.value as PolicyCategory)}>
            {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label className="field">Scope
          <select className="select" value={global ? "all" : "ns"} onChange={(e) => setGlobal(e.target.value === "all")}>
            <option value="ns">Only {state.ns}</option>
            <option value="all">Every namespace</option>
          </select>
        </label>
      </div>
      <div className="field">When it trips
        <div className="segmented" style={{ alignSelf: "flex-start" }}>
          {ENFORCEMENT.map((e) => (
            <button key={e.id} className={enforcement === e.id ? "active" : ""} onClick={() => setEnforcement(e.id)}>{e.icon} {e.label}</button>
          ))}
        </div>
      </div>
      <div className="field">Applies to {targets.length === 0 && <span className="faint">(every agent)</span>}
        <div className="chips">
          {agents.map((a) => (
            <button key={a.id} className={`btn sm ${targets.includes(a.id) ? "on" : ""}`} onClick={() => setTargets(targets.includes(a.id) ? targets.filter((t) => t !== a.id) : [...targets, a.id])}>{a.name}</button>
          ))}
        </div>
      </div>
      <ModalActions onCancel={onClose} onConfirm={create} confirm="Add policy" />
    </Modal>
  );
}
