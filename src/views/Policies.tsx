import { formatTime, fromDb } from "../prefs";
import { useEffect, useState } from "react";
import { Ban, Eye, Hand, Plus, Trash2 } from "lucide-react";
import { uid, useNamespaced, useStore, useToast } from "../store";
import { CodeReveal, Field, Modal, ModalActions, PageHead, PrimaryButton, Status, Toggle, useErrors } from "../components/ui";
import "../styles/pages.css";
import type { Enforcement, Policy, PolicyCategory } from "../types";
import { api, errorMessage, isLive, onPolicyLog, toPolicy } from "../backend";
import type { Policy as PolicyRecord } from "../bindings/Policy";
import type { PolicyEvent as PolicyEventRecord } from "../bindings/PolicyEvent";
import type { Spec } from "../bindings/Spec";

const ENFORCEMENT: { id: Enforcement; label: string; icon: JSX.Element; hint: string }[] = [
  { id: "block", label: "Block", icon: <Ban size={13} />, hint: "Stop the action outright" },
  { id: "approve", label: "Ask me", icon: <Hand size={13} />, hint: "Pause until you approve" },
  { id: "warn", label: "Warn", icon: <Eye size={13} />, hint: "Allow, but flag it" },
];

const CATEGORIES: PolicyCategory[] = ["filesystem", "network", "git", "secrets", "spend", "comms", "deploy", "custom"];

const TEMPLATES: (Pick<Policy, "name" | "rule" | "category" | "enforcement"> & { check?: Spec })[] = [
  {
    name: "Never drop databases", rule: "Never run DROP, TRUNCATE or delete-all statements against any database.", category: "deploy", enforcement: "block",
    check: { kind: "command", patterns: ["(?i)\\b(drop\\s+(table|database|schema)|truncate\\s+table)\\b", "(?i)\\bdelete\\s+from\\s+\\w+\\s*(;|$)"] },
  },
  { name: "Stay out of personal accounts", rule: "Never open or read my personal email, banking or social media accounts.", category: "network", enforcement: "block" },
  { name: "No purchases", rule: "Never buy, subscribe or enter payment details anywhere.", category: "spend", enforcement: "block" },
  { name: "No browser extensions", rule: "Never install browser extensions or change browser security settings.", category: "custom", enforcement: "approve" },
  { name: "Quiet Fridays", rule: "Don't merge or deploy after 4pm on Fridays.", category: "deploy", enforcement: "approve" },
  { name: "No mass deletes", rule: "Ask before deleting more than 20 files in one go.", category: "filesystem", enforcement: "approve" },
];

/** Policies and their log from the core. Null outside the desktop app. */
function useLivePolicies(ns: string) {
  const toast = useToast();
  const { dispatch } = useStore();
  const [data, setData] = useState<{ policies: PolicyRecord[]; events: PolicyEventRecord[] } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!isLive()) return;
    let gone = false;
    const load = () =>
      Promise.all([api.policyList(ns), api.policyEvents(ns, 200)])
        .then(([policies, events]) => {
          if (gone) return;
          setData({ policies, events });
          // Keep the sidebar and status bar counts in step.
          dispatch({ type: "hydratePolicies", ns, policies: policies.map(toPolicy) });
        })
        .catch((e) => toast(errorMessage(e), "err"));
    load();
    const off = onPolicyLog((changed) => changed === ns && load());
    return () => { gone = true; off.then((f) => f()); };
  }, [ns, tick]);
  return data && { ...data, reload: () => setTick((t) => t + 1) };
}

/** What the engine actually checks, in words. */
function specSummary(s: Spec): string {
  switch (s.kind) {
    case "command": return `Commands matching ${s.patterns.length === 1 ? "a pattern" : `${s.patterns.length} patterns`}`;
    case "path": return [s.allow.length ? `Files outside ${s.allow.join(", ")}` : "", s.deny.length ? `Files in ${s.deny.join(", ")}` : ""].filter(Boolean).join("; ");
    case "host": return [s.allow.length ? `Hosts not in a list of ${s.allow.length}` : "", s.deny.length ? `Hosts ${s.deny.join(", ")}` : ""].filter(Boolean).join("; ");
    case "secrets": return "Any secret value of this namespace";
    case "cost": return `Calls over $${(s.max / 1e6).toFixed(2)}`;
    default: return "Plain language: enforced by the policy judge.";
  }
}


const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const specFor = (name: string, rule: string, enforcement: Enforcement) =>
  [`policy: ${slug(name)}`, "on: [any_tool_call, message, model_request]", `match: judge(${JSON.stringify(rule)})`, `action: ${enforcement === "approve" ? "require_approval" : enforcement}`].join("\n");

export function Policies() {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { policies, policyEvents, agents } = useNamespaced();
  const [creating, setCreating] = useState(state.compose);
  const [expanded, setExpanded] = useState<string | null>(null);
  const name = (id: string) => state.agents.find((a) => a.id === id)?.name ?? id;
  // In the desktop app policies live in the core and are enforced there.
  const live = useLivePolicies(state.ns);
  const rows = live
    ? live.policies.map((p) => ({
        id: p.id, ns: p.ns, name: p.name, rule: p.rule, enforcement: p.enforcement as Enforcement, enabled: p.enabled,
        scope: `${p.ns === "*" ? "All namespaces" : p.ns}, ${p.applies_to ? `${p.applies_to.length} targets` : "everything"}`,
        check: specSummary(p.spec), judge: p.spec.kind === "text", code: JSON.stringify(p.spec, null, 2),
      }))
    : policies.map((p) => ({
        id: p.id, ns: p.ns, name: p.name, rule: p.rule, enforcement: p.enforcement, enabled: p.enabled,
        scope: `${p.ns === "*" ? "All namespaces" : p.ns}, ${p.appliesTo === "all" ? "all agents" : p.appliesTo.map(name).join(", ")}`,
        check: "", judge: false, code: p.spec,
      }));
  const log = live
    ? live.events.map((e) => ({ id: String(e.id), at: formatTime(fromDb(e.ts), state.prefs), who: e.source, policy: e.policy, detail: e.action, outcome: e.outcome }))
    : policyEvents.map((e) => ({
        id: e.id, at: e.at, who: name(e.agentId), policy: state.policies.find((p) => p.id === e.policyId)?.name ?? e.policyId, detail: e.detail, outcome: e.outcome,
      }));
  const today = new Date().toDateString();
  const stopped = live
    ? live.events.filter((e) => (e.outcome === "blocked" || e.outcome === "denied") && new Date(e.ts.replace(" ", "T") + "Z").toDateString() === today).length
    : policyEvents.filter((e) => e.outcome === "blocked" || e.outcome === "denied").length;
  const active = rows.filter((p) => p.enabled);
  const unusedTemplates = TEMPLATES.filter((t) => !rows.some((p) => p.name === t.name));

  const fail = (e: unknown) => toast(errorMessage(e), "err");
  const addTemplate = (t: (typeof TEMPLATES)[number]) => {
    if (live) {
      api.policyCreate(state.ns, { name: t.name, rule: t.rule, category: t.category, enforcement: t.enforcement, spec: t.check ?? { kind: "text" } })
        .then(live.reload).then(() => toast(`Added policy: ${t.name}`)).catch(fail);
      return;
    }
    dispatch({ type: "addPolicy", policy: { ...t, id: uid("p"), ns: state.ns, appliesTo: "all", enabled: true, spec: specFor(t.name, t.rule, t.enforcement) } });
    toast(`Added policy: ${t.name}`);
  };
  const patch = (id: string, change: { enabled?: boolean; enforcement?: Enforcement }) => {
    if (live) return void api.policyUpdate(state.ns, id, change).then(live.reload).catch(fail);
    dispatch({ type: "updatePolicy", id, patch: change });
  };
  const remove = (id: string, label: string) => {
    const done = () => toast(`Removed policy: ${label}`, "warn");
    if (live) return void api.policyDelete(state.ns, id).then(live.reload).then(done).catch(fail);
    dispatch({ type: "removePolicy", id });
    done();
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
          <div className="stat-value">{stopped}</div>
          <div className="stat-sub">{log.length} {live ? "recent decisions" : "events"}</div>
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

      <div className="card flush" style={{ marginBottom: 24 }}>
        {rows.map((p) => {
          const open = expanded === p.id;
          return (
            <div key={p.id} className={`policy-row ${p.enabled ? "" : "off"}`}>
              <div className="policy-main">
                <Toggle on={p.enabled} onChange={(v) => patch(p.id, { enabled: v })} label={`Enable ${p.name}`} />
                <button className="policy-text" onClick={() => setExpanded(open ? null : p.id)} aria-expanded={open}>
                  <span className="policy-name">{p.name}</span>
                  <span className="dim clip">{p.rule}</span>
                </button>
                <span className="faint small policy-scope">{p.judge ? "Needs the judge" : p.scope}</span>
                <div className="segmented">
                  {ENFORCEMENT.map((e) => (
                    <button key={e.id} className={p.enforcement === e.id ? "active" : ""} title={e.hint} onClick={() => patch(p.id, { enforcement: e.id })}>
                      {e.label}
                    </button>
                  ))}
                </div>
                <button className="btn ghost sm icon danger" title="Delete policy" onClick={() => remove(p.id, p.name)}><Trash2 size={13} /></button>
              </div>
              {open && (
                <div className="policy-detail">
                  <p className="dim" style={{ margin: 0 }}>{p.rule}</p>
                  {p.check && <p className="small" style={{ margin: 0 }}><span className="faint">Checks: </span>{p.check}</p>}
                  <CodeReveal code={p.code} label="rule spec" />
                </div>
              )}
            </div>
          );
        })}
        {rows.length === 0 && <div className="empty">No policies yet. Add one or pick a suggestion above.</div>}
      </div>

      <div className="card flush">
        <div className="card-head" style={{ padding: "16px 16px 0" }}><span className="card-title">{live ? "Enforcement log" : "Today's log"}</span></div>
        <table className="table">
          <thead><tr><th>Time</th><th>{live ? "Who" : "Agent"}</th><th>Policy</th><th>Attempted</th><th>Outcome</th></tr></thead>
          <tbody>
            {log.map((e) => (
              <tr key={e.id}>
                <td className="mono faint">{e.at}</td>
                <td style={{ fontWeight: 500 }}>{e.who}</td>
                <td className="dim">{e.policy}</td>
                <td className="mono dim" style={{ maxWidth: 360, overflowWrap: "anywhere" }}>{e.detail}</td>
                <td><Status value={e.outcome} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {log.length === 0 && <div className="empty" style={{ margin: 16 }}>No policy was triggered today.</div>}
      </div>

      {creating && (live
        ? <NewLivePolicy names={rows.map((r) => r.name)} onAdded={live.reload} onClose={() => setCreating(false)} />
        : <NewPolicy agents={agents.map((a) => ({ id: a.id, name: a.name }))} onClose={() => setCreating(false)} />)}
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
  const { errors, check, clear } = useErrors();

  const create = () => {
    const r = rule.trim();
    const n = name.trim() || r.replace(/^never\s+/i, "No ").split(/[.,;]/)[0].slice(0, 48);
    const ns = global ? "*" : state.ns;
    const taken = state.policies.some((p) => (p.ns === ns || p.ns === "*" || ns === "*") && p.name.toLowerCase() === n.toLowerCase());
    const dupe = taken ? `A policy called "${n}" already exists here.` : undefined;
    const ruleError = !r || /^never$/i.test(r) ? "Write the rule." : r.length < 8 ? "Say a bit more, so agents know exactly what is off limits." : undefined;
    // A generated name that clashes is reported on the rule; a typed one on the name field.
    const ok = check({ rule: ruleError ?? (name.trim() ? undefined : dupe), name: name.trim() ? dupe : undefined });
    if (!ok) return;
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
      <Field label="Rule" error={errors.rule}>
        <textarea className="textarea" autoFocus value={rule} onChange={(e) => { setRule(e.target.value); clear("rule"); }} placeholder="Never push directly to main." />
      </Field>
      <Field label="Short name (optional)" error={errors.name}>
        <input className="input" value={name} onChange={(e) => { setName(e.target.value); clear("name"); }} placeholder="Generated from the rule" />
      </Field>
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

type CheckKind = Spec["kind"];
const CHECKS: { id: CheckKind; label: string; hint: string }[] = [
  { id: "command", label: "Commands", hint: "Regular expressions, one per line. A shell command matching any of them trips the policy." },
  { id: "path", label: "Files", hint: "Folders, one per line. ** covers everything below, like /work/**." },
  { id: "host", label: "Hosts", hint: "Host names, one per line. *.example.com covers its subdomains." },
  { id: "secrets", label: "Secret values", hint: "Trips when a call contains any secret value from this namespace." },
  { id: "cost", label: "Cost per call", hint: "Trips when a single call is estimated to cost more than this." },
  { id: "text", label: "Plain language", hint: "Stored and shown to agents. Enforced by the policy judge." },
];

/** The New policy form against the core: the rule in words, plus what the engine checks. */
function NewLivePolicy({ names, onAdded, onClose }: { names: string[]; onAdded: () => void; onClose: () => void }) {
  const { state } = useStore();
  const toast = useToast();
  const [rule, setRule] = useState("Never ");
  const [name, setName] = useState("");
  const [category, setCategory] = useState<PolicyCategory>("custom");
  const [enforcement, setEnforcement] = useState<Enforcement>("block");
  const [everywhere, setEverywhere] = useState(false);
  const [kind, setKind] = useState<CheckKind>("command");
  const [entries, setEntries] = useState("");
  const [mode, setMode] = useState<"allow" | "deny">("deny");
  const [cost, setCost] = useState("1");
  const { errors, check, clear } = useErrors();
  const lines = entries.split("\n").map((l) => l.trim()).filter(Boolean);

  const spec = (): Spec => {
    switch (kind) {
      case "command": return { kind, patterns: lines };
      case "path": case "host": return { kind, allow: mode === "allow" ? lines : [], deny: mode === "deny" ? lines : [] };
      case "cost": return { kind, max: Math.round(+cost * 1e6) };
      case "secrets": return { kind };
      default: return { kind: "text" };
    }
  };

  const create = () => {
    const r = rule.trim();
    const n = name.trim() || r.replace(/^never\s+/i, "No ").split(/[.,;]/)[0].slice(0, 48);
    const ok = check({
      rule: !r || /^never$/i.test(r) ? "Write the rule." : r.length < 8 ? "Say a bit more, so agents know exactly what is off limits." : undefined,
      name: names.some((x) => x.toLowerCase() === n.toLowerCase()) ? `A policy called "${n}" already exists here.` : undefined,
      entries: ["command", "path", "host"].includes(kind) && lines.length === 0 ? "Add at least one line." : undefined,
      cost: kind === "cost" && !(+cost > 0) ? "Enter an amount over $0." : undefined,
    });
    if (!ok) return;
    api.policyCreate(state.ns, { name: n, rule: r, category, enforcement, spec: spec(), everywhere })
      .then(() => { onAdded(); toast(`Added policy: ${n}`); onClose(); })
      .catch((e) => toast(errorMessage(e), "err"));
  };

  const hint = CHECKS.find((c) => c.id === kind)?.hint;
  return (
    <Modal title="New policy" subtitle="Say what agents must not do, then what the engine should check." onClose={onClose}>
      <Field label="Rule" error={errors.rule}>
        <textarea className="textarea" autoFocus value={rule} onChange={(e) => { setRule(e.target.value); clear("rule"); }} placeholder="Never push directly to main." />
      </Field>
      <div className="field-row">
        <Field label="Short name (optional)" error={errors.name}>
          <input className="input" value={name} onChange={(e) => { setName(e.target.value); clear("name"); }} placeholder="Generated from the rule" />
        </Field>
        <label className="field">Category
          <select className="select" value={category} onChange={(e) => setCategory(e.target.value as PolicyCategory)}>
            {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
      </div>
      <label className="field">How it's checked
        <select className="select" value={kind} onChange={(e) => { setKind(e.target.value as CheckKind); clear("entries"); }}>
          {CHECKS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </label>
      {(kind === "path" || kind === "host") && (
        <div className="segmented" style={{ alignSelf: "flex-start" }}>
          <button className={mode === "deny" ? "active" : ""} onClick={() => setMode("deny")}>Trip on these</button>
          <button className={mode === "allow" ? "active" : ""} onClick={() => setMode("allow")}>Trip on anything else</button>
        </div>
      )}
      {["command", "path", "host"].includes(kind) ? (
        <Field label={kind === "command" ? "Patterns" : kind === "path" ? "Folders" : "Hosts"} error={errors.entries} hint={hint}>
          <textarea
            className="textarea mono"
            value={entries}
            onChange={(e) => { setEntries(e.target.value); clear("entries"); }}
            placeholder={kind === "command" ? "\\bgit\\s+push\\b.*--force" : kind === "path" ? "/etc/**\n/root/**" : "pastebin.com\n*.ngrok.io"}
          />
        </Field>
      ) : kind === "cost" ? (
        <Field label="Limit per call (USD)" error={errors.cost} hint={hint}>
          <input className="input mono" type="number" min={0} step={0.5} value={cost} onChange={(e) => { setCost(e.target.value); clear("cost"); }} />
        </Field>
      ) : (
        <span className="faint small">{hint}</span>
      )}
      <div className="field-row">
        <div className="field">When it trips
          <div className="segmented" style={{ alignSelf: "flex-start" }}>
            {ENFORCEMENT.map((e) => (
              <button key={e.id} className={enforcement === e.id ? "active" : ""} onClick={() => setEnforcement(e.id)}>{e.icon} {e.label}</button>
            ))}
          </div>
        </div>
        <label className="field">Scope
          <select className="select" value={everywhere ? "all" : "ns"} onChange={(e) => setEverywhere(e.target.value === "all")}>
            <option value="ns">Only {state.ns}</option>
            <option value="all">Every namespace</option>
          </select>
        </label>
      </div>
      <ModalActions onCancel={onClose} onConfirm={create} confirm="Add policy" />
    </Modal>
  );
}
