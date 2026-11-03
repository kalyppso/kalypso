import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, Pause, Play, Plus, Send, Square, Trash2 } from "lucide-react";
import { api, errorMessage, isLive, onAgentUpdate, syncNamespace, toAgent } from "../backend";
import type { AgentEvent } from "../bindings/AgentEvent";
import type { AgentRun } from "../bindings/AgentRun";
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

  if (open) return isLive() ? <LiveAgentDetail agent={open} onBack={() => setOpenId(null)} /> : <AgentDetail agent={open} onBack={() => setOpenId(null)} />;

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
              <span className="agent-meta mono small dim clip">{a.runtime ? a.runtime : a.model}</span>
              <span className="agent-meta small faint clip">{sb ? sb.name : "No sandbox"}</span>
              <span className="agent-meta small faint clip" title={a.statusReason}>{a.runtime ? a.statusReason || "" : `${a.skills.length + a.mcps.length} tools`}</span>
              <Status value={a.status} />
              <ChevronRight size={15} className="agent-chevron" />
            </button>
          );
        })}
      </div>

      {creating && (isLive() ? <NewLiveAgent onClose={() => setCreating(false)} /> : <NewAgent onClose={() => setCreating(false)} />)}
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

/** An agent run by the core's supervisor: real controls, run history and a live transcript. */
function LiveAgentDetail({ agent: a, onBack }: { agent: Agent; onBack: () => void }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { sandboxes } = useNamespaced();
  const sb = sandboxes.find((s) => s.id === a.sandboxId);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [lines, setLines] = useState<AgentEvent[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const follow = useRef(true); // keep showing the newest run until one is picked

  const loadRuns = () =>
    api.agentRuns(state.ns, a.id).then((r) => {
      setRuns(r);
      if (follow.current) setRunId(r[0]?.id ?? null);
    }).catch(() => {});

  useEffect(() => { follow.current = true; loadRuns(); }, [a.id]);
  useEffect(() => {
    if (!runId) return setLines([]);
    api.agentEvents(state.ns, runId).then(setLines).catch(() => setLines([]));
  }, [runId]);
  // New lines and new runs arrive as they happen.
  useEffect(() => {
    const off = onAgentUpdate((u) => {
      if (u.agent_id !== a.id) return;
      if (u.event) {
        if (u.event.run_id === runId) setLines((l) => [...l, u.event!]);
        else if (follow.current && u.event.kind === "status") loadRuns();
      } else loadRuns();
    });
    return () => void off.then((f) => f());
  }, [a.id, runId]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "nearest" }); }, [lines.length]);

  const act = (what: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    fn().then(() => syncNamespace(state.ns, dispatch)).then(() => toast(what)).catch((e) => toast(errorMessage(e), "err")).finally(() => setBusy(false));
  };
  const send = () => {
    const m = message.trim();
    if (!m) return;
    api.agentSend(state.ns, a.id, m).then(() => setMessage("")).catch((e) => toast(errorMessage(e), "err"));
  };
  const remove = () => {
    if (!confirm(`Delete ${a.name} and its run history?`)) return;
    api.agentDelete(state.ns, a.id).then(() => syncNamespace(state.ns, dispatch)).then(() => { toast(`Deleted ${a.name}`, "warn"); onBack(); }).catch((e) => toast(errorMessage(e), "err"));
  };

  const active = ["running", "starting", "restarting", "paused"].includes(a.status);
  const bad = a.status === "failed";

  return (
    <>
      <button className="btn ghost sm agent-back" onClick={onBack}><ArrowLeft size={13} /> Agents</button>
      <div className="agent-head">
        <span className={`agent-avatar lg ${a.status}`}>{initials(a.name)}</span>
        <div style={{ minWidth: 0 }}>
          <div className="row"><h1>{a.name}</h1><Status value={a.status} /></div>
          <p className="dim" style={{ margin: "4px 0 0" }}>{a.role || "No role yet"}</p>
          {a.statusReason && <p className={`agent-reason ${bad ? "bad" : ""}`}>{a.statusReason}</p>}
        </div>
        <span className="spacer" />
        {a.status === "running" && <button className="btn" disabled={busy} onClick={() => act(`${a.name} paused`, () => api.agentPause(state.ns, a.id))}><Pause size={13} /> Pause</button>}
        {a.status === "paused" && <button className="btn" disabled={busy} onClick={() => act(`${a.name} resumed`, () => api.agentResume(state.ns, a.id))}><Play size={13} /> Resume</button>}
        {active ? (
          <button className="btn" disabled={busy} onClick={() => act(`${a.name} stopped`, () => api.agentStop(state.ns, a.id))}><Square size={13} /> Stop</button>
        ) : (
          <button className="btn primary" disabled={busy || !sb} title={sb ? undefined : "Assign a sandbox first"} onClick={() => act(`${a.name} started`, () => api.agentStart(state.ns, a.id))}><Play size={13} /> Start</button>
        )}
        <button className="btn ghost icon danger" title="Delete agent" onClick={remove}><Trash2 size={14} /></button>
      </div>

      <div className="agent-facts">
        <Fact k="Runtime" v={<span className="mono">{a.runtime}</span>} />
        <Fact k="Sandbox" v={sb ? sb.name : <span className="faint">None assigned</span>} />
        <Fact k="If it stops" v={a.restart === "never" ? "Leave it stopped" : a.restart === "always" ? `Restart, up to ${a.maxRestarts}x` : `Restart after crashes, up to ${a.maxRestarts}x`} />
        <Fact k="Turns per run" v={a.maxTurns ? a.maxTurns : "No limit"} />
      </div>

      <Section title="Transcript">
        {runs.length > 0 && (
          <div className="runs" style={{ marginBottom: 10 }}>
            {runs.slice(0, 6).map((r) => (
              <button key={r.id} className={`run-row ${r.id === runId ? "on" : ""}`} onClick={() => { follow.current = false; setRunId(r.id); }}>
                <span className="mono small faint">#{r.attempt}</span>
                <span className="small clip">{r.reason || (r.outcome === "running" ? "running" : "")}</span>
                <span className="mono small faint">{r.exit_code !== null ? `exit ${r.exit_code}` : ""}</span>
                <Status value={r.outcome} />
              </button>
            ))}
          </div>
        )}
        {runs.length === 0 ? (
          <div className="empty">No runs yet. Start {a.name} to see what it prints here.</div>
        ) : (
          <pre className="transcript" aria-live="polite">
            {lines.map((l) => (
              <div key={l.id} className={l.kind === "input" ? "in" : l.kind === "status" ? "st" : ""}>{l.kind === "input" ? `> ${l.text}` : l.text}</div>
            ))}
            {lines.length === 0 && <span className="faint">Nothing printed yet.</span>}
            <div ref={bottom} />
          </pre>
        )}
        {a.status === "running" && (
          <div className="composer">
            <input className="input" value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder={`Send ${a.name} a message (a line on its input)`} />
            <button className="btn" onClick={send} disabled={!message.trim()}><Send size={13} /> Send</button>
          </div>
        )}
      </Section>

      <Section title="Command"><code className="mono small">{a.command || "None set"}</code></Section>
    </>
  );
}

const RUNTIMES = [
  { id: "command", label: "Command", hint: "Any program run in the sandbox. Messages go to its input; what it prints is the transcript." },
  { id: "claude-sdk", label: "Claude Agent SDK", hint: "Coming with #14." },
  { id: "claude-code", label: "Claude Code", hint: "Coming with #15." },
];

/** New agent, created in the core. */
function NewLiveAgent({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { agents, sandboxes } = useNamespaced();
  const { errors, check, clear } = useErrors();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [command, setCommand] = useState("");
  const [sandboxId, setSandboxId] = useState(sandboxes[0]?.id ?? "");
  const [restart, setRestart] = useState("on-failure");
  const [maxRestarts, setMaxRestarts] = useState("3");
  const [maxTurns, setMaxTurns] = useState("0");

  const create = () => {
    const n = name.trim();
    const ok = check({
      name: !n ? "Give the agent a name."
        : !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(n) ? "Use letters, digits, - and _, starting with a letter or digit."
        : agents.some((a) => a.name.toLowerCase() === n.toLowerCase()) ? `An agent called ${n} already exists here.`
        : undefined,
      command: command.trim() ? undefined : "Say what to run, for example: python agent.py",
      sandbox: sandboxId ? undefined : sandboxes.length ? "Pick a sandbox." : "Create a sandbox first.",
    });
    if (!ok) return;
    api.agentCreate(state.ns, {
      name: n, role: role.trim() || undefined, runtime: "command", command: command.trim(), sandbox_id: sandboxId,
      restart, max_restarts: Math.max(0, +maxRestarts || 0), max_turns: Math.max(0, +maxTurns || 0),
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
      <label className="field">Runtime
        <select className="select" value="command" onChange={() => {}}>
          {RUNTIMES.map((r) => <option key={r.id} value={r.id} disabled={r.id !== "command"}>{r.label}{r.id !== "command" ? ` (${r.hint})` : ""}</option>)}
        </select>
      </label>
      <Field label="Command" error={errors.command} hint={RUNTIMES[0].hint}>
        <input className="input mono" value={command} onChange={(e) => { setCommand(e.target.value); clear("command"); }} placeholder="python agent.py" />
      </Field>
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
        <label className="field">Turns per run
          <input className="input mono" type="number" min={0} value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} title="0 means no limit" />
        </label>
      </div>
      <ModalActions onCancel={onClose} onConfirm={create} confirm="Create agent" />
    </Modal>
  );
}
