import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, KeyRound, MessageSquare, Pause, Play, Plus, Settings2, SlidersHorizontal, Square } from "lucide-react";
import { api, errorMessage, isLive, syncNamespace, toAgent } from "../backend";
import type { AgentEvent } from "../bindings/AgentEvent";
import { Composer, Conversation, useAgentConversation, useAgentGate } from "../components/Conversation";
import { initials, Skeleton, Status } from "../components/ui";
import { Orb } from "../components/Orb";
import { ChatSettingsModal } from "../components/ChatSettings";
import { useNamespaced, useStore, useToast } from "../store";
import type { Agent } from "../types";
import "../styles/agents.css";

/**
 * Chat with the master agent, laid out like a chat app: your chats and your agents on the right,
 * the model on top, the conversation in the middle. kalypso plans the work, creates and runs
 * the namespace's other agents through KALYPSO, and reports back here.
 */

const MODELS = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "Fast, good for most work" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", note: "Stronger planning" },
  { id: "claude-fable-5-2", label: "Claude Fable 5.2", note: "Most capable, costs more" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", note: "Cheapest" },
];

const STARTERS = [
  "Find out why the tests fail on main and fix them",
  "Review my open pull requests and summarize what needs attention",
  "Research how other tools handle prompt caching and write up the options",
  "Set up an agent that watches the deploy and tells me when it breaks",
];

// ---------- Chats: each is a stretch of the master agent's transcript ----------

/** A chat begins at a moment (UTC "YYYY-MM-DD HH:MM:SS", as the core stamps events); "" is the very start. */
interface ChatRec { id: string; title: string; since: string }

const chatsKey = (ns: string) => `kalypso.chats.${ns}`;
function loadChats(ns: string): ChatRec[] {
  try {
    const v = JSON.parse(localStorage.getItem(chatsKey(ns)) ?? "[]");
    if (Array.isArray(v) && v.length) return v;
  } catch { /* fall through */ }
  return [{ id: "first", title: "", since: "" }];
}
function saveChats(ns: string, chats: ChatRec[]) {
  try { localStorage.setItem(chatsKey(ns), JSON.stringify(chats)); } catch { /* private window */ }
}
const utcNow = () => new Date().toISOString().replace("T", " ").slice(0, 19);

/** The events inside a chat. Events still arriving live carry no time stamp yet: they belong to the newest chat. */
function inChat(events: AgentEvent[], chats: ChatRec[], i: number) {
  const since = chats[i].since;
  const until = chats[i + 1]?.since;
  const newest = i === chats.length - 1;
  return events.filter((e) => (e.ts ? e.ts >= since && (!until || e.ts < until) : newest));
}

const titleOf = (events: AgentEvent[]) => {
  const first = events.find((e) => e.kind === "input")?.text.trim();
  return first ? (first.length > 48 ? `${first.slice(0, 46)}…` : first) : "";
};

export function Chat() {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { loading, agents, secrets } = useNamespaced();
  const live = isLive();
  const master = useMemo(() => (live ? agents.find((a) => a.master) : SAMPLE_MASTER), [agents, live]);
  const team = agents.filter((a) => !a.master);
  const convo = useAgentConversation(state.ns, master);
  const [chats, setChats] = useState<ChatRec[]>(() => loadChats(state.ns));
  const [open, setOpen] = useState(chats.length - 1);
  const [member, setMember] = useState<string | null>(null);
  const viewing = team.find((a) => a.id === member);

  useEffect(() => saveChats(state.ns, chats), [chats, state.ns]);
  // Show more history once there is more than one chat.
  useEffect(() => { if (chats.length > 1 && convo.hasEarlier) convo.showEarlier(); }, [chats.length, convo.hasEarlier]);

  const newChat = async () => {
    setMember(null);
    const current = chats[chats.length - 1];
    if (!inChat(convo.events, chats, chats.length - 1).length && current) return setOpen(chats.length - 1);
    try {
      if (live) await api.masterNewChat(state.ns);
      await syncNamespace(state.ns, dispatch);
    } catch (e) {
      return toast(errorMessage(e), "err");
    }
    const next = [...chats, { id: `c${Date.now()}`, title: "", since: utcNow() }];
    setChats(next);
    setOpen(next.length - 1);
  };

  if (loading) return <div className="chat"><div className="chat-main" style={{ padding: 32 }}><Skeleton rows={4} /></div></div>;

  const titled = chats.map((c, i) => ({ ...c, title: c.title || titleOf(inChat(convo.events, chats, i)) }));
  const listed = titled.map((c, i) => ({ ...c, i })).filter((c) => c.title || c.i === chats.length - 1).reverse();

  return (
    <div className="chat">

      {viewing ? (
        <MemberThread agent={viewing} onBack={() => setMember(null)} />
      ) : (
        <MasterThread
          master={master}
          events={inChat(convo.events, chats, open)}
          runs={convo.runs}
          loading={convo.loading}
          past={open !== chats.length - 1}
          toLatest={() => setOpen(chats.length - 1)}
          send={convo.send}
          hasKey={!live || secrets.some((s) => s.key === "ANTHROPIC_API_KEY" && s.scope === "gateway") || !!master?.model.includes("/")}
        />
      )}
      <aside className="chat-side" aria-label="Chats and agents">
        <button className="chat-new" onClick={newChat}>
          <Plus size={15} /> New chat
        </button>
        <div className="chat-side-label">Chats</div>
        <div className="chat-list">
          {listed.map((c) => (
            <button key={c.id} className={`chat-item ${!viewing && c.i === open ? "on" : ""}`} onClick={() => { setMember(null); setOpen(c.i); }}>
              <MessageSquare size={13} />
              <span className="clip">{c.title || "New chat"}</span>
            </button>
          ))}
        </div>
        <div className="chat-side-label">
          Agents <span className="faint">{team.filter((a) => a.status === "running").length ? `${team.filter((a) => a.status === "running").length} working` : ""}</span>
        </div>
        <div className="chat-list agents">
          {team.map((a) => (
            <button key={a.id} className={`chat-item ${a.id === member ? "on" : ""}`} onClick={() => setMember(a.id)} title={a.role}>
              <span className={`agent-avatar ${a.status}`}>{initials(a.name)}</span>
              <span className="clip">{a.name}</span>
              {a.status === "running" && <span className="chat-item-live" aria-label="working" />}
            </button>
          ))}
          {team.length === 0 && <p className="chat-side-empty">kalypso creates agents as it needs them.</p>}
        </div>
        <button className="btn ghost sm chat-manage" onClick={() => dispatch({ type: "view", view: "agents" })}><SlidersHorizontal size={12} /> Manage agents</button>
      </aside>
    </div>
  );
}

interface MasterProps {
  master: Agent | undefined;
  events: AgentEvent[];
  runs: ReturnType<typeof useAgentConversation>["runs"];
  loading: boolean;
  past: boolean;
  toLatest: () => void;
  send: (text: string) => Promise<void>;
  hasKey: boolean;
}

/** The conversation with kalypso: a start screen for a new chat, the thread after. */
function MasterThread({ master, events, runs, loading, past, toLatest, send: sampleSend, hasKey }: MasterProps) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const live = isLive();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState(0);
  // Every change to the draft is a beat for the orb.
  const [beat, setBeat] = useState(0);
  const type = (v: string) => { setDraft(v); setBeat((n) => n + 1); };
  const [pending, setPending] = useState<{ text: string; status: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const sync = () => syncNamespace(state.ns, dispatch);

  // The message shows at once; KALYPSO creates kalypso and starts it as needed behind it.
  useEffect(() => {
    if (pending && events.some((e) => e.kind === "input" && e.text === pending.text)) setPending(null);
  }, [events, pending]);

  const send = async (text: string) => {
    setSent((n) => n + 1);
    if (!live) return sampleSend(text);
    setPending({ text, status: master && master.status === "running" ? "Thinking" : "Starting kalypso" });
    try {
      let m = master;
      if (!m) {
        m = toAgent(await api.masterEnsure(state.ns));
        await sync();
      }
      if (m.status === "paused") throw new Error("kalypso is paused. Resume it first.");
      if (!["running", "starting", "restarting"].includes(m.status)) {
        await api.agentStart(state.ns, m.id);
        await sync();
      }
      setPending({ text, status: "Thinking" });
      await api.agentSend(state.ns, m.id, text);
      setDraft("");
    } catch (e) {
      setPending(null);
      throw e;
    }
  };

  const act = (done: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    fn().then(sync).then(() => toast(done)).catch((e) => toast(errorMessage(e), "err")).finally(() => setBusy(false));
  };

  const lastInput = [...events].reverse().find((e) => e.kind === "input")?.text;
  const retry = lastInput ? () => { send(lastInput).catch((e) => toast(errorMessage(e), "err")); } : undefined;
  const working = live && master?.status === "running";
  const fresh = !loading && events.length === 0 && !pending;

  const head = (
    <header className="chat-top">
      <ModelPicker master={master} />
      <span className="spacer" />
      {master && live && <Status value={master.status} />}
      {live && master?.status === "running" && <button className="btn ghost sm" disabled={busy} onClick={() => act("kalypso paused", () => api.agentPause(state.ns, master.id))}><Pause size={12} /> Pause</button>}
      {live && master?.status === "paused" && <button className="btn ghost sm" disabled={busy} onClick={() => act("kalypso resumed", () => api.agentResume(state.ns, master.id))}><Play size={12} /> Resume</button>}
      {live && master && ["running", "starting", "restarting", "paused"].includes(master.status) && (
        <button className="btn ghost sm" disabled={busy} onClick={() => act("kalypso stopped", () => api.agentStop(state.ns, master.id))} title="Stops kalypso. The agents it started keep running.">
          <Square size={12} /> Stop
        </button>
      )}
      <button className="btn ghost sm icon" onClick={() => setSettingsOpen(true)} title="Chat settings: instructions, memory and preferences" aria-label="Chat settings"><Settings2 size={15} /></button>
      {settingsOpen && <ChatSettingsModal master={master} onClose={() => setSettingsOpen(false)} />}
    </header>
  );

  const keyCard = !hasKey && <ConnectModel />;
  const blocked = !hasKey ? <>Add a model key above to start.</>
    : master?.status === "paused" ? <>kalypso is paused. <button className="link" disabled={busy} onClick={() => act("kalypso resumed", () => api.agentResume(state.ns, master.id))}>Resume it</button> to continue.</>
    : undefined;

  if (fresh && !past) {
    return (
      <section className="chat-main" aria-label="New chat">
        {head}
        <div className="chat-start">
          <div className="chat-start-inner">
            <Orb size={124} active={!!pending} pulse={sent} beat={beat} className="chat-orb" label="kalypso" />
            <h1 className="chat-hello">What should we work on?</h1>
            <p className="chat-hello-sub">kalypso plans the work, creates agents for each part, and reports back here.</p>
            {keyCard}
            <Composer onSend={send} placeholder="Ask anything, or describe the work" autoFocus value={draft} onValue={type} large blocked={blocked} />
            {hasKey && (
              <div className="chat-starters">
                {STARTERS.map((s) => <button key={s} className="chat-starter" onClick={() => type(s)}>{s}</button>)}
              </div>
            )}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="chat-main" aria-label="Conversation with kalypso">
      {head}
      <Conversation events={events} runs={runs} loading={loading} working={working} pending={pending} onRetry={past ? undefined : retry} />
      {past ? (
        <div className="cv-composer blocked"><div className="cv-composer-foot"><span className="cv-composer-hint">This is an earlier chat. <button className="link" onClick={toLatest}>Go to the current one</button> to keep talking.</span></div></div>
      ) : (
        <>
          {keyCard && <div className="chat-key-wrap">{keyCard}</div>}
          <Composer onSend={send} placeholder="Message kalypso" value={draft} onValue={setDraft} blocked={blocked} />
        </>
      )}
    </section>
  );
}

/** The model kalypso thinks with, switchable like in any chat app. */
function ModelPicker({ master }: { master: Agent | undefined }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const current = master?.model ?? MODELS[0].id;
  const known = MODELS.some((m) => m.id === current);
  const change = async (model: string) => {
    if (!master || !isLive()) return toast("kalypso is created with your first message; pick its model after that.", "warn");
    try {
      const running = ["running", "starting", "restarting", "paused"].includes(master.status);
      if (running) await api.agentStop(state.ns, master.id);
      await api.agentUpdate(state.ns, master.id, { model });
      await syncNamespace(state.ns, dispatch);
      toast(`kalypso now uses ${MODELS.find((m) => m.id === model)?.label ?? model}`);
    } catch (e) {
      toast(errorMessage(e), "err");
    }
  };
  return (
    <label className="chat-model" title="The model kalypso thinks with. Agents it creates use the same one unless it picks another.">
      <span className="chat-model-name">kalypso</span>
      <select className="chat-model-select" value={current} onChange={(e) => change(e.target.value)}>
        {!known && <option value={current}>{current}</option>}
        {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
    </label>
  );
}

/** No model key yet: add one right here instead of hunting through Settings. */
function ConnectModel() {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const v = key.trim();
    if (!v) return;
    setSaving(true);
    try {
      await api.secretSet(state.ns, "ANTHROPIC_API_KEY", v, "gateway");
      const check = await api.setupKeyCheck(state.ns).catch(() => null);
      await syncNamespace(state.ns, dispatch);
      setKey("");
      toast(check && !check.ok ? check.message : "Key saved. You can start chatting.", check && !check.ok ? "warn" : "ok");
    } catch (e) {
      toast(errorMessage(e), "err");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="chat-key">
      <div className="chat-key-title"><KeyRound size={14} /> Connect a model</div>
      <p>kalypso needs an Anthropic API key for <b>{state.ns}</b>. It's stored in the vault, added to model calls by KALYPSO, and never shown to agents.</p>
      <div className="chat-key-row">
        <input className="input mono" type="password" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} placeholder="sk-ant-…" aria-label="Anthropic API key" autoComplete="off" />
        <button className="btn primary" onClick={save} disabled={!key.trim() || saving}>{saving ? "Saving…" : "Save key"}</button>
      </div>
    </div>
  );
}

/** One agent's own conversation, opened from the list. */
function MemberThread({ agent: a, onBack }: { agent: Agent; onBack: () => void }) {
  const { state, dispatch } = useStore();
  const convo = useAgentConversation(state.ns, a);
  const gate = useAgentGate(a, () => syncNamespace(state.ns, dispatch));
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onBack();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onBack]);
  return (
    <section className="chat-main" aria-label={`Conversation with ${a.name}`}>
      <header className="chat-top">
        <button className="btn ghost sm icon" onClick={onBack} title="Back to kalypso (Esc)" aria-label="Back to kalypso"><ArrowLeft size={14} /></button>
        <span className={`agent-avatar ${a.status}`}>{initials(a.name)}</span>
        <div style={{ minWidth: 0 }}>
          <div className="chat-head-name"><span className="clip">{a.name}</span><Status value={a.status} /></div>
          <div className="chat-head-sub clip"><span className="mono">{a.model || a.runtime}</span>{a.role ? ` · ${a.role}` : ""}</div>
        </div>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={() => dispatch({ type: "view", view: "agents", focus: a.id })}><SlidersHorizontal size={12} /> Details</button>
      </header>
      <Conversation events={convo.events} runs={convo.runs} loading={convo.loading} working={gate.working} onShowEarlier={convo.hasEarlier ? convo.showEarlier : undefined}
        empty={<>{a.name} hasn't done anything yet.</>} />
      <Composer onSend={convo.send} placeholder={`Message ${a.name} directly`} blocked={gate.blocked} />
    </section>
  );
}

// ---------- Sample data, for the browser preview ----------

const SAMPLE_MASTER: Agent = {
  id: "master-sample", ns: "work", name: "kalypso", role: "Coordinates your agents", model: "claude-sonnet-5-5", status: "running", master: true,
  sandboxId: "sb", skills: [], mcps: [], secrets: [], config: "",
};
