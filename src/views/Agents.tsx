import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Bot, ChevronRight, Pause, Pencil, Play, Plus, Square, Trash2 } from "lucide-react";
import { api, errorMessage, isLive, syncNamespace, toAgent } from "../backend";
import { uid, useNamespaced, useStore, useToast, useCompose, useFocus } from "../store";
import { Composer, Conversation, useAgentConversation, useAgentGate } from "../components/Conversation";
import { CodeReveal, EmptyState, Field, AgentFace, Modal, ModalActions, PageHead, PrimaryButton, Status, useErrors, Skeleton } from "../components/ui";
import type { Agent } from "../types";
import { RepoPicker, type RepoChoice } from "../components/RepoPicker";
import { providerModels, useModelChoices, useProviders } from "../components/Providers";
import { Pecten } from "../components/Pecten";
import { Logo } from "../components/Logo";
import type { AgentPatch } from "../bindings/AgentPatch";
import { openSettings } from "./Settings";
import type { PullRequest } from "../bindings/PullRequest";
import "../styles/agents.css";

const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

export function Agents() {
  const { dispatch } = useStore();
  const { loading, agents, sandboxes } = useNamespaced();
  const [creating, setCreating] = useState(false);
  useCompose(() => setCreating(true));
  const [openId, setOpenId] = useState<string | null>(null);
  useFocus(setOpenId);
  const open = agents.find((a) => a.id === openId);

  const form = creating && (isLive() ? <NewLiveAgent onClose={() => setCreating(false)} /> : <NewAgent onClose={() => setCreating(false)} />);
  // "New agent" from the palette also works while an agent is open.
  if (open) return <>{isLive() ? <LiveAgentDetail agent={open} onBack={() => setOpenId(null)} /> : <AgentDetail agent={open} onBack={() => setOpenId(null)} />}{form}</>;

  return (
    <>
      <PageHead title="Crew" subtitle="Your agents. Each one runs in a sandbox and only gets the secrets, tools and integrations you grant it.">
        <PrimaryButton onClick={() => setCreating(true)} icon={<Plus size={14} />}>New agent</PrimaryButton>
      </PageHead>

      {loading && <Skeleton rows={3} />}
      {!loading && agents.length === 0 && (
        <EmptyState icon={Bot} title="No agents yet" action={<button className="btn primary sm" onClick={() => dispatch({ type: "view", view: "agents", compose: true })}><Plus size={13} /> New agent</button>}>
          An agent works in a sandbox with only the secrets, tools and integrations you grant it.
        </EmptyState>
      )}

      <div className="agent-list">
        {agents.map((a) => {
          const sb = sandboxes.find((s) => s.id === a.sandboxId);
          return (
            <button key={a.id} className="agent-row" onClick={() => setOpenId(a.id)}>
              <AgentMark agent={a} size={24} active={a.status === "running"} />
              <span className="agent-main">
                <span className="agent-name">{a.name}</span>
                <span className="faint small clip">{a.role}</span>
              </span>
              <span className="agent-meta mono small dim clip">{a.runtime ? a.runtime : a.model}</span>
              <span className="agent-meta small faint clip">{sb ? sb.name : "No sandbox"}</span>
              <span className="agent-meta small faint clip" title={a.statusReason}>{a.runtime ? a.statusReason || "" : `${a.skills.length + a.mcps.length} tools`}</span>
              <Status value={a.status} />
              <ChevronRight size={15} className="agent-chevron" />
            </button>
          );
        })}
      </div>

      {form}
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
  const convo = useAgentConversation(state.ns, a);
  const [editing, setEditing] = useState(false);

  return (
    <AgentPage
      agent={a}
      onBack={onBack}
      working={live}
      actions={
        <>
          <button className="btn" onClick={() => setEditing(true)}><Pencil size={13} /> Edit</button>
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
        </>
      }
      conversation={
        <>
          <Conversation events={convo.events} working={false} who={{ name: a.name, mark: a.master ? <Logo size={26} fine /> : <Pecten size={26} /> }} empty={<>No runs yet. Start {a.name} and what it does shows up here.</>} />
          <Composer onSend={convo.send} placeholder={`Message ${a.name}`} />
        </>
      }
      side={
        <>
          <Facts items={[["Model", <span className="mono">{a.model}</span>], ["Sandbox", sb ? sb.name : <span className="faint">None assigned</span>], ["Policies", `${guards.length} apply`], ["Integrations", `${linked.length} linked`]]} />
          <Section title="Skills"><Chips items={label(a.skills, state.skills)} /></Section>
          <Section title="MCP servers"><Chips items={label(a.mcps, state.mcps)} /></Section>
          <Section title="Secrets"><Chips items={label(a.secrets, secrets)} mono /></Section>
          <Section title="Linked integrations"><Chips items={linked.map((b) => `${b.name}${b.brain ? " (brain)" : ""}`)} /></Section>
          <Section title="Policies"><Chips items={guards.map((p) => p.name)} /></Section>
          <Section title="Configuration"><CodeReveal code={a.config} /></Section>
          {editing && <EditSampleAgent agent={a} onClose={() => setEditing(false)} />}
        </>
      }
    />
  );
}

/** The crew wear the pecten shell; kalypso, the master, wears her own mark. */
export function AgentMark({ agent: a, size, active, pulse }: { agent: Agent; size: number; active?: boolean; pulse?: number }) {
  if (a.master) return <span className={`agent-avatar ${size > 30 ? "lg" : ""} ${a.status} mark`}><AgentFace agent={a} size={size} /></span>;
  return <span className="agent-mark"><Pecten size={size * 1.25} active={active} pulse={pulse} /></span>;
}

/**
 * An agent's page: who it is and what you can do on top; its conversation filling the rest,
 * with the message box pinned at the bottom like any chat; its settings in a column beside it.
 */
function AgentPage({ agent: a, onBack, actions, reason, conversation, side, working, pulse }: {
  agent: Agent; onBack: () => void; actions: ReactNode; reason?: ReactNode; conversation: ReactNode; side: ReactNode; working?: boolean; pulse?: number;
}) {
  return (
    <div className="agent-page">
      <header className="agent-top">
        <button className="btn ghost sm icon" onClick={onBack} title="All agents" aria-label="All agents"><ArrowLeft size={14} /></button>
        <AgentMark agent={a} size={34} active={working} pulse={pulse} />
        <div style={{ minWidth: 0 }}>
          <div className="row"><h1 className="clip">{a.name}</h1><Status value={a.status} /></div>
          <p className="dim clip" style={{ margin: "2px 0 0" }}>{a.role || "No role yet"}</p>
          {reason}
        </div>
        <span className="spacer" />
        <div className="row" style={{ gap: 8 }}>{actions}</div>
      </header>
      <div className="agent-split">
        <section className="agent-convo" aria-label={`Conversation with ${a.name}`}>{conversation}</section>
        <aside className="agent-side" aria-label={`${a.name}'s settings`}>{side}</aside>
      </div>
    </div>
  );
}

function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="agent-facts-list">
      {items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="clip">{v}</dd></div>)}
    </dl>
  );
}

/** Browser preview: edit the sample agent's basics. */
function EditSampleAgent({ agent: a, onClose }: { agent: Agent; onClose: () => void }) {
  const { dispatch } = useStore();
  const toast = useToast();
  const { sandboxes } = useNamespaced();
  const [name, setName] = useState(a.name);
  const [role, setRole] = useState(a.role);
  const [model, setModel] = useState(a.model);
  const [sandboxId, setSandboxId] = useState(a.sandboxId ?? "");
  const save = () => {
    dispatch({ type: "updateAgent", id: a.id, patch: { name: name.trim() || a.name, role, model, sandboxId: sandboxId || null } });
    toast(`${name.trim() || a.name} saved`);
    onClose();
  };
  return (
    <Modal title={`Edit ${a.name}`} onClose={onClose}>
      <div className="field-row">
        <label className="field">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field">Sandbox
          <select className="select" value={sandboxId} onChange={(e) => setSandboxId(e.target.value)}>
            <option value="">None</option>
            {sandboxes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      </div>
      <label className="field">Role<input className="input" value={role} onChange={(e) => setRole(e.target.value)} /></label>
      <label className="field">Model
        <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
          {!MODELS.includes(model) && <option>{model}</option>}
          {MODELS.map((m) => <option key={m}>{m}</option>)}
        </select>
      </label>
      <ModalActions onCancel={onClose} onConfirm={save} confirm="Save" />
    </Modal>
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

/** An agent run by the core's supervisor: real controls, run history and a live transcript. */
function LiveAgentDetail({ agent: a, onBack }: { agent: Agent; onBack: () => void }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { sandboxes } = useNamespaced();
  const sb = sandboxes.find((s) => s.id === a.sandboxId);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const convo = useAgentConversation(state.ns, a);
  const gate = useAgentGate(a, () => syncNamespace(state.ns, dispatch));

  // Each reply that arrives fans its shell open.
  const replies = convo.events.filter((e) => e.kind === "text" || e.kind === "result" || e.kind === "error").length;
  const [received, setReceived] = useState(0);
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (convo.loading) return;
    if (seen.current !== null && replies > seen.current) setReceived((n) => n + 1);
    seen.current = replies;
  }, [replies, convo.loading]);

  const act = (what: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    fn().then(() => syncNamespace(state.ns, dispatch)).then(() => toast(what)).catch((e) => toast(errorMessage(e), "err")).finally(() => setBusy(false));
  };
  const remove = () => {
    if (!confirm(`Delete ${a.name} and its run history?`)) return;
    api.agentDelete(state.ns, a.id).then(() => syncNamespace(state.ns, dispatch)).then(() => { toast(`Deleted ${a.name}`, "warn"); onBack(); }).catch((e) => toast(errorMessage(e), "err"));
  };

  const active = ["running", "starting", "restarting", "paused"].includes(a.status);
  const bad = a.status === "failed";
  const runner = a.runtime === "claude-sdk" || a.runtime === "openai-compat";

  return (
    <AgentPage
      agent={a}
      onBack={onBack}
      working={gate.working}
      pulse={received}
      reason={a.statusReason ? <p className={`agent-reason clip ${bad ? "bad" : ""}`}>{a.statusReason}</p> : undefined}
      actions={
        <>
          <button className="btn" onClick={() => setEditing(true)}><Pencil size={13} /> Edit</button>
          {a.status === "running" && <button className="btn" disabled={busy} onClick={() => act(`${a.name} paused`, () => api.agentPause(state.ns, a.id))}><Pause size={13} /> Pause</button>}
          {a.status === "paused" && <button className="btn" disabled={busy} onClick={() => act(`${a.name} resumed`, () => api.agentResume(state.ns, a.id))}><Play size={13} /> Resume</button>}
          {active ? (
            <button className="btn" disabled={busy} onClick={() => act(`${a.name} stopped`, () => api.agentStop(state.ns, a.id))}><Square size={13} /> Stop</button>
          ) : (
            <button className="btn primary" disabled={busy || !sb} title={sb ? undefined : "Assign a sandbox first"} onClick={() => act(`${a.name} started`, () => api.agentStart(state.ns, a.id))}><Play size={13} /> Start</button>
          )}
          <button className="btn ghost icon danger" title="Delete agent" onClick={remove}><Trash2 size={14} /></button>
        </>
      }
      conversation={
        <>
          <Conversation
            who={{ name: a.name, mark: a.master ? <Logo size={26} fine /> : <Pecten size={26} active={gate.working} pulse={received} /> }}
            events={convo.events}
            runs={convo.runs}
            loading={convo.loading}
            working={gate.working}
            onShowEarlier={convo.hasEarlier ? convo.showEarlier : undefined}
            empty={<div className="chat-crew-empty">{!a.master && <Pecten size={88} active={gate.working} pulse={received} />}<span>No runs yet. Start {a.name}, or send it a message, and what it does shows up here.</span></div>}
          />
          <Composer onSend={convo.send} placeholder={`Message ${a.name}`} blocked={gate.blocked} />
        </>
      }
      side={
        <>
          <Facts
            items={[
              ["Model", <span className="mono" title={a.model}>{a.model || a.runtime}</span>],
              ["Runtime", a.runtime === "claude-sdk" ? "Claude Agent SDK" : a.runtime === "openai-compat" ? "Any model (OpenAI-compatible)" : a.runtime ?? ""],
              ...(runner ? [["Effort", a.effort ? a.effort : "Model default"] as [string, ReactNode]] : []),
              ["Sandbox", sb ? sb.name : <span className="faint">None assigned</span>],
              ["If it stops", a.restart === "never" ? "Leave it stopped" : a.restart === "always" ? `Restart, up to ${a.maxRestarts}x` : `Restart after crashes, up to ${a.maxRestarts}x`],
              [runner ? "Turns per task" : "Turns per run", a.maxTurns ? a.maxTurns : "No limit"],
            ]}
          />
          <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => setEditing(true)}><Pencil size={12} /> Edit settings</button>
          <RepoSection agent={a} />
          <Section title={runner ? "First task" : "Command"}>
            {runner ? <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{a.command || <span className="faint">None. Send it a message to give it work.</span>}</p> : <code className="mono small">{a.command || "None set"}</code>}
          </Section>
          {editing && <EditAgent agent={a} onClose={() => setEditing(false)} />}
        </>
      }
    />
  );
}

/** Change anything about an agent after it is made: name, role, model, effort, sandbox, task and limits. */
function EditAgent({ agent: a, onClose }: { agent: Agent; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { sandboxes } = useNamespaced();
  const { errors, check, clear } = useErrors();
  const runner = a.runtime === "claude-sdk" || a.runtime === "openai-compat";
  const [name, setName] = useState(a.name);
  const [role, setRole] = useState(a.role ?? "");
  const [model, setModel] = useState(a.model ?? "");
  const [effort, setEffort] = useState(a.effort ?? "");
  const [sandboxId, setSandboxId] = useState(a.sandboxId ?? "");
  const [command, setCommand] = useState(a.command ?? "");
  const [restart, setRestart] = useState(a.restart ?? "on-failure");
  const [maxRestarts, setMaxRestarts] = useState(String(a.maxRestarts ?? 3));
  const [maxTurns, setMaxTurns] = useState(String(a.maxTurns ?? 0));
  const [saving, setSaving] = useState(false);

  // Models from every connected provider, grouped; the current one stays listed even if its provider isn't.
  const { connected } = useProviders();
  const choices = useModelChoices(connected);
  const known = choices.some((c) => c.models.some((m) => m.id === model));

  const save = async () => {
    const n = name.trim();
    const ok = check({
      name: !n ? "Give the agent a name." : !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(n) ? "Use letters, digits, - and _, starting with a letter or digit." : undefined,
      command: runner || command.trim() ? undefined : "Say what to run, for example: python agent.py",
    });
    if (!ok) return;
    const patch: AgentPatch = {};
    if (n !== a.name) patch.name = n;
    if (role.trim() !== (a.role ?? "")) patch.role = role.trim();
    if (runner && model && model !== a.model) patch.model = model;
    if (runner && effort !== (a.effort ?? "")) patch.effort = effort;
    if (sandboxId !== (a.sandboxId ?? "")) patch.sandbox_id = sandboxId;
    if (command.trim() !== (a.command ?? "")) patch.command = command.trim();
    if (restart !== a.restart) patch.restart = restart;
    if ((+maxRestarts || 0) !== a.maxRestarts) patch.max_restarts = Math.max(0, +maxRestarts || 0);
    if ((+maxTurns || 0) !== a.maxTurns) patch.max_turns = Math.max(0, +maxTurns || 0);
    if (Object.keys(patch).length === 0) return onClose();
    setSaving(true);
    try {
      await api.agentUpdate(state.ns, a.id, patch);
      await syncNamespace(state.ns, dispatch);
      // Name and role show at once; the rest is how it runs, so it takes a restart.
      const needsRestart = Object.keys(patch).some((k) => k !== "name" && k !== "role");
      const active = ["running", "starting", "restarting", "paused"].includes(a.status);
      if (needsRestart && active && confirm(`Restart ${n} now so the changes apply? Otherwise they apply from its next start.`)) {
        await api.agentStop(state.ns, a.id);
        await api.agentStart(state.ns, a.id);
        await syncNamespace(state.ns, dispatch);
        toast(`${n} saved and restarted`);
      } else {
        toast(needsRestart && active ? `${n} saved. The changes apply from its next start.` : `${n} saved`);
      }
      onClose();
    } catch (e) {
      toast(errorMessage(e), "err");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`Edit ${a.name}`} subtitle="Name and role change at once. The rest applies from its next start." onClose={onClose}>
      <div className="field-row">
        <Field label="Name" error={errors.name} hint={a.master ? "kalypso keeps its name." : undefined}>
          <input className="input" value={name} disabled={a.master} onChange={(e) => { setName(e.target.value); clear("name"); }} />
        </Field>
        <label className="field">Sandbox
          <select className="select" value={sandboxId} onChange={(e) => setSandboxId(e.target.value)}>
            <option value="">None</option>
            {sandboxes.map((s) => <option key={s.id} value={s.id}>{s.name}{hasRunner(s.image) ? "" : " (no agent runner)"}</option>)}
          </select>
        </label>
      </div>
      <label className="field">Role<input className="input" value={role} onChange={(e) => setRole(e.target.value)} placeholder="What does this agent do?" /></label>
      {runner && (
        <div className="field-row">
          <Field label="Model" hint={<>Any connected provider. <button className="link" onClick={() => { onClose(); openSettings(dispatch, "models"); }}>Connect another</button></>}>
            <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
              {!known && model && <option value={model}>{model}</option>}
              {choices.map((c) => (
                <optgroup key={c.provider.id} label={c.provider.name}>
                  {c.loading && <option disabled>Loading models…</option>}
                  {c.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </optgroup>
              ))}
            </select>
          </Field>
          <Field label="Effort" hint={EFFORT_HINT}>
            <select className="select" value={effort} onChange={(e) => setEffort(e.target.value)}>
              {EFFORTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
          </Field>
        </div>
      )}
      {runner ? (
        <Field label="First task" hint="What it works on when it starts. Leave it empty to give it work by message.">
          <textarea className="input" rows={3} value={command} onChange={(e) => setCommand(e.target.value)} />
        </Field>
      ) : (
        <Field label="Command" error={errors.command}>
          <input className="input mono" value={command} onChange={(e) => { setCommand(e.target.value); clear("command"); }} />
        </Field>
      )}
      <div className="field-row">
        <label className="field">If it stops
          <select className="select" value={restart} onChange={(e) => setRestart(e.target.value)}>
            <option value="on-failure">Restart after a crash</option>
            <option value="always">Always restart</option>
            <option value="never">Leave it stopped</option>
          </select>
        </label>
        <label className="field">Restarts, at most
          <input className="input mono" type="number" min={0} max={100} value={maxRestarts} disabled={restart === "never"} onChange={(e) => setMaxRestarts(e.target.value)} />
        </label>
        <label className="field">{runner ? "Turns per task" : "Turns per run"}
          <input className="input mono" type="number" min={0} value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} />
        </label>
      </div>
      <ModalActions onCancel={onClose} onConfirm={save} confirm={saving ? "Saving…" : "Save"} />
    </Modal>
  );
}

const RUNTIMES = [
  { id: "claude-sdk", label: "Claude Agent SDK", hint: "Claude works in the sandbox with its tools. KALYPSO checks every tool call against your policies.", ready: true },
  { id: "openai-compat", label: "Any model (OpenAI-compatible)", hint: "OpenAI, OpenRouter, Ollama, vLLM, LM Studio… through the gateway, with the same tools and policy checks.", ready: true },
  { id: "command", label: "Command", hint: "Any program run in the sandbox. Messages go to its input; what it prints is the transcript.", ready: true },
  { id: "claude-code", label: "Claude Code", hint: "Coming with #15.", ready: false },
];
/** Reasoning effort: how hard the model thinks. Reasoning is billed as output, the most expensive kind. */
const EFFORTS = [
  { id: "", label: "Model default" },
  { id: "low", label: "Low: lookups, summaries, small edits" },
  { id: "medium", label: "Medium: routine coding" },
  { id: "high", label: "High: hard problems" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max: costs the most" },
];
const EFFORT_HINT = "Reasoning is billed as output, the priciest tokens. Lower effort costs less; it is fixed for a run so the prompt cache holds.";

/** The image with KALYPSO's agent runner, which Claude Agent SDK agents need. */
export const RUNNER_IMAGE = "ghcr.io/kalyppso/agent-runner:latest";
const hasRunner = (image: string) => /agent-runner/.test(image);

/** New agent, created in the core. */
function NewLiveAgent({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { agents, sandboxes } = useNamespaced();
  const { errors, check, clear } = useErrors();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [command, setCommand] = useState("");
  const [runtime, setRuntime] = useState("claude-sdk");
  const [model, setModel] = useState(MODELS[1]);
  const [sandboxId, setSandboxId] = useState((sandboxes.find((s) => hasRunner(s.image)) ?? sandboxes[0])?.id ?? "");
  const [restart, setRestart] = useState("on-failure");
  const [maxRestarts, setMaxRestarts] = useState("3");
  const [maxTurns, setMaxTurns] = useState("0");
  const [effort, setEffort] = useState("");
  const [repo, setRepo] = useState<RepoChoice>(null);
  const sdk = runtime === "claude-sdk";
  // Any OpenAI-compatible model: a gateway provider route and the model name there.
  const anyModel = runtime === "openai-compat";
  const runner = sdk || anyModel;
  // Other providers come from Settings → Models; Claude is the Claude runtime's.
  const { connected } = useProviders();
  const otherProviders = connected.filter((p) => p.id !== "anthropic");
  const [provider, setProvider] = useState("");
  useEffect(() => { if (!provider && otherProviders[0]) setProvider(otherProviders[0].id); }, [otherProviders.length]);
  const [otherModel, setOtherModel] = useState("");
  const [modelList, setModelList] = useState<string[] | null>([]);
  useEffect(() => {
    if (!anyModel || !provider) return;
    let live = true;
    setModelList(null);
    providerModels(state.ns, provider).then((m) => live && setModelList(m)).catch(() => live && setModelList([]));
    return () => { live = false; };
  }, [anyModel, provider, state.ns]);
  const providerId = provider.trim().toLowerCase();
  const picked = sandboxes.find((s) => s.id === sandboxId);

  const create = () => {
    const n = name.trim();
    const ok = check({
      name: !n ? "Give the agent a name."
        : !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(n) ? "Use letters, digits, - and _, starting with a letter or digit."
        : agents.some((a) => a.name.toLowerCase() === n.toLowerCase()) ? `An agent called ${n} already exists here.`
        : undefined,
      command: runner || command.trim() ? undefined : "Say what to run, for example: python agent.py",
      provider: !anyModel ? undefined : providerId ? undefined : "Connect a provider first, in Settings, Models.",
      model: !anyModel || !providerId ? undefined : !otherModel.trim() ? "Pick or type the model." : undefined,
      sandbox: sandboxId ? undefined : sandboxes.length ? "Pick a sandbox." : "Create a sandbox first.",
    });
    if (!ok) return;
    api.agentCreate(state.ns, {
      name: n, role: role.trim() || undefined, runtime, model: sdk ? model : anyModel ? `${providerId}/${otherModel.trim()}` : undefined, command: command.trim(), sandbox_id: sandboxId,
      restart, max_restarts: Math.max(0, +maxRestarts || 0), max_turns: Math.max(0, +maxTurns || 0),
      repo: repo?.repo, repo_account: repo?.account, effort: runner && effort ? effort : undefined,
    })
      .then((rec) => { dispatch({ type: "hydrateAgents", ns: state.ns, agents: [...agents.filter((x) => x.ns === state.ns), toAgent(rec)] }); toast(`Agent ${n} created`); onClose(); })
      .catch((e) => toast(errorMessage(e), "err"));
  };

  return (
    <Modal title="New agent" subtitle={`Runs in a sandbox in ${state.ns}. Its policies and budgets apply.`} onClose={onClose}>
      <div className="field-row">
        <Field label="Name" error={errors.name}>
          <input className="input" autoFocus value={name} onChange={(e) => { setName(e.target.value); clear("name"); }} placeholder="scout" />
        </Field>
        <Field label="Sandbox" error={errors.sandbox}>
          <select className="select" value={sandboxId} onChange={(e) => { setSandboxId(e.target.value); clear("sandbox"); }}>
            <option value="">Pick a sandbox</option>
            {sandboxes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
      </div>
      <label className="field">Role<input className="input" value={role} onChange={(e) => setRole(e.target.value)} placeholder="What does this agent do?" /></label>
      <div className="field-row">
        <Field label="Runtime" hint={RUNTIMES.find((r) => r.id === runtime)?.hint}>
          <select className="select" value={runtime} onChange={(e) => { setRuntime(e.target.value); clear("command"); }}>
            {RUNTIMES.map((r) => <option key={r.id} value={r.id} disabled={!r.ready}>{r.label}{r.ready ? "" : ` (${r.hint})`}</option>)}
          </select>
        </Field>
        {sdk && (
          <label className="field">Model
            <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => <option key={m}>{m}</option>)}
            </select>
          </label>
        )}
      </div>
      {runner && (
        <Field label="Effort" hint={EFFORT_HINT}>
          <select className="select" value={effort} onChange={(e) => setEffort(e.target.value)}>
            {EFFORTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </Field>
      )}
      {anyModel && (
        <div className="field-row">
          <Field label="Provider" error={errors.provider} hint={otherProviders.length ? undefined : <>No other provider is connected. <button className="link" onClick={() => { onClose(); openSettings(dispatch, "models"); }}>Connect one</button>.</>}>
            <select className="select" value={provider} onChange={(e) => { setProvider(e.target.value); setOtherModel(""); clear("model"); clear("provider"); }}>
              {!otherProviders.some((p) => p.id === provider) && <option value={provider}>{provider || "Pick a provider"}</option>}
              {otherProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Model" error={errors.model} hint={modelList === null ? "Loading its models…" : modelList.length ? `${modelList.length} available` : "Type the model name."}>
            <input className="input mono" list="provider-models" value={otherModel} onChange={(e) => { setOtherModel(e.target.value); clear("model"); }} placeholder={modelList?.[0] ?? "model name"} />
            <datalist id="provider-models">
              {(modelList ?? []).map((m) => <option key={m} value={m} />)}
            </datalist>
          </Field>
        </div>
      )}
      {runner && picked && !hasRunner(picked.image) && (
        <p className="agent-reason bad" style={{ margin: 0 }}>
          {picked.name} runs <span className="mono">{picked.image}</span>, which has no agent runner. Use a sandbox with <span className="mono">{RUNNER_IMAGE}</span>, or an image built FROM it.
        </p>
      )}
      {/* Not a <label>: it holds buttons, which a label would take over. */}
      <div className="field" role="group" aria-labelledby="repo-field">
        <span id="repo-field">Repository</span>
        <RepoPicker value={repo} onChange={setRepo} />
        <span className="faint small">Optional. Cloned into its sandbox on start; it works on its own branch and opens pull requests.</span>
      </div>
      {runner ? (
        <Field label="Task" hint="What to do first. Leave it empty to give it work later from the transcript.">
          <textarea className="input" rows={3} value={command} onChange={(e) => setCommand(e.target.value)} placeholder="Fix the failing tests in /work/app and open a summary of what changed." />
        </Field>
      ) : (
        <Field label="Command" error={errors.command} hint={RUNTIMES[1].hint}>
          <input className="input mono" value={command} onChange={(e) => { setCommand(e.target.value); clear("command"); }} placeholder="python agent.py" />
        </Field>
      )}
      <div className="field-row">
        <label className="field">If it stops
          <select className="select" value={restart} onChange={(e) => setRestart(e.target.value)}>
            <option value="on-failure">Restart after a crash</option>
            <option value="always">Always restart</option>
            <option value="never">Leave it stopped</option>
          </select>
        </label>
        <label className="field">Restarts, at most
          <input className="input mono" type="number" min={0} max={100} value={maxRestarts} disabled={restart === "never"} onChange={(e) => setMaxRestarts(e.target.value)} />
        </label>
        <label className="field">{runner ? "Turns per task" : "Turns per run"}
          <input className="input mono" type="number" min={0} value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} title={runner ? "Model turns for each task or message; 0 means no limit" : "Messages per run; 0 means no limit"} />
        </label>
      </div>
      <ModalActions onCancel={onClose} onConfirm={create} confirm="Create agent" />
    </Modal>
  );
}

/** The agent's GitHub repository (#100): its branch and pull requests, and changing or unlinking it. */
function RepoSection({ agent: a }: { agent: Agent }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { agents } = useNamespaced();
  const [prs, setPrs] = useState<PullRequest[] | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!a.repo || !a.branch) { setPrs([]); return; }
    api.agentPullRequests(state.ns, a.id).then(setPrs).catch(() => setPrs([]));
  }, [a.id, a.repo, a.branch]);
  const save = (choice: RepoChoice) => {
    api.agentUpdate(state.ns, a.id, { repo: choice?.repo ?? "", repo_account: choice?.account ?? "" })
      .then((rec) => {
        dispatch({ type: "hydrateAgents", ns: state.ns, agents: agents.map((x) => (x.id === a.id ? toAgent(rec) : x)) });
        setEditing(false);
        toast(choice ? `${a.name} will work on ${choice.repo} from its next start` : "Repository unlinked", "info");
      })
      .catch((e) => toast(errorMessage(e), "err"));
  };
  return (
    <Section title="Repository">
      {!a.repo || editing ? (
        <RepoPicker value={null} onChange={(c) => c && save(c)} />
      ) : (
        <div className="repo-facts">
          <div className="row" style={{ gap: 10 }}>
            <a className="mono" href={`https://github.com/${a.repo}`} target="_blank" rel="noreferrer">{a.repo}</a>
            {a.branch && <span className="badge mono">{a.branch}</span>}
            <span className="spacer" />
            <button className="btn ghost sm" onClick={() => setEditing(true)}>Change</button>
            <button className="btn ghost sm" onClick={() => confirm(`Unlink ${a.repo} from ${a.name}? Its clone stays in the sandbox.`) && save(null)}>Unlink</button>
          </div>
          {!a.branch && <p className="faint small" style={{ margin: 0 }}>Cloned on its next start, onto its own branch.</p>}
          {prs && prs.length > 0 && (
            <ul className="pr-list">
              {prs.map((p) => (
                <li key={p.number}>
                  <span className={`badge pr-${p.merged_at ? "merged" : p.draft ? "draft" : p.state}`}>{p.merged_at ? "merged" : p.draft ? "draft" : p.state}</span>
                  <a href={p.html_url} target="_blank" rel="noreferrer">#{p.number} {p.title}</a>
                </li>
              ))}
            </ul>
          )}
          {prs && prs.length === 0 && a.branch && <p className="faint small" style={{ margin: 0 }}>No pull requests from {a.branch} yet.</p>}
        </div>
      )}
    </Section>
  );
}
