import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, KeyRound, MessageSquare, Pause, Play, Plus, Settings2, SlidersHorizontal, Square } from "lucide-react";
import { api, errorMessage, isLive, syncNamespace, toAgent } from "../backend";
import type { AgentEvent } from "../bindings/AgentEvent";
import { Composer, Conversation, fileToBase64, useAgentConversation, useAgentGate, useOrbState } from "../components/Conversation";
import { Skeleton, Status } from "../components/ui";
import { Orb } from "../components/Orb";
import { Pecten } from "../components/Pecten";
import { Logo } from "../components/Logo";
import { ChatSettingsModal } from "../components/ChatSettings";
import { CLAUDE_MODELS, ConnectProvider, modelLabel, providerModels, useModelChoices, useProviders } from "../components/Providers";
import type { ModelProvider } from "../bindings/ModelProvider";
import { useNamespaced, useStore, useToast } from "../store";
import type { Agent } from "../types";
import "../styles/agents.css";

/**
 * Chat with the master agent, laid out like a chat app: your chats and your agents on the right,
 * the model on top, the conversation in the middle. kalypso plans the work, creates and runs
 * the namespace's other agents through KALYPSO, and reports back here.
 */

/** Which provider a model id belongs to: `provider/model`, or a bare Claude id. */
const providerOf = (model: string) => (model.includes("/") ? model.split("/")[0] : "anthropic");

/** The model picked for kalypso before it exists; it is created with it on the first message. */
const pickedKey = (ns: string) => `kalypso.model.${ns}`;
const picked = (ns: string) => { try { return localStorage.getItem(pickedKey(ns)) || undefined; } catch { return undefined; } };
const pick = (ns: string, model: string) => { try { localStorage.setItem(pickedKey(ns), model); } catch { /* used for this session only */ } };

/** A model to create kalypso with: the one picked, Claude Sonnet if Anthropic is connected, else the first model of a connected provider. */
async function startModel(ns: string): Promise<string | undefined> {
  const p = picked(ns);
  if (p) return p;
  const connected = (await api.providerList(ns)).filter((x) => x.connected);
  if (connected.some((x) => x.id === "anthropic")) return undefined;
  for (const x of connected) {
    const models = await providerModels(ns, x.id).catch(() => []);
    if (models.length) return `${x.id}/${models[0]}`;
  }
  return undefined;
}

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
  const { loading, agents } = useNamespaced();
  const live = isLive();
  const { connected } = useProviders();
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
          hasKey={!live || (master ? connected.some((p) => p.id === providerOf(master.model)) : connected.length > 0)}
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
          Crew <span className="faint">{team.filter((a) => a.status === "running").length ? `${team.filter((a) => a.status === "running").length} working` : ""}</span>
        </div>
        <div className="chat-list agents">
          {team.map((a) => (
            <button key={a.id} className={`chat-item ${a.id === member ? "on" : ""}`} onClick={() => setMember(a.id)} title={a.role}>
              <Pecten size={22} active={a.status === "running"} />
              <span className="clip">{a.name}</span>
              {a.status === "running" && <span className="chat-item-live" aria-label="working" />}
            </button>
          ))}
          {team.length === 0 && <p className="chat-side-empty">kalypso creates agents as it needs them.</p>}
        </div>
        <button className="btn ghost sm chat-manage" onClick={() => dispatch({ type: "view", view: "agents" })}><SlidersHorizontal size={12} /> Manage crew</button>
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
        m = toAgent(await api.masterEnsure(state.ns, await startModel(state.ns)));
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

  // Files go into kalypso's sandbox; kalypso is created first if this is the first message.
  const attachForMaster = async (file: File) => {
    let m = master;
    if (!m) {
      m = toAgent(await api.masterEnsure(state.ns, await startModel(state.ns)));
      await sync();
    }
    return api.agentAttach(state.ns, m.id, file.name, await fileToBase64(file));
  };

  const act = (done: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    fn().then(sync).then(() => toast(done)).catch((e) => toast(errorMessage(e), "err")).finally(() => setBusy(false));
  };

  const lastInput = [...events].reverse().find((e) => e.kind === "input")?.text;
  const retry = lastInput ? () => { send(lastInput).catch((e) => toast(errorMessage(e), "err")); } : undefined;
  const working = live && master?.status === "running";
  const fresh = !loading && events.length === 0 && !pending;

  // The pinned orb: busy while a message is on its way or unanswered, a wave on each reply.
  const lastIn = events.map((e) => e.kind).lastIndexOf("input");
  const lastEnd = Math.max(events.map((e) => e.kind).lastIndexOf("result"), events.map((e) => e.kind).lastIndexOf("error"));
  const thinking = !!pending || (working && lastIn > lastEnd);
  const replies = events.filter((e) => e.kind === "text" || e.kind === "result").length;
  const [received, setReceived] = useState(0);
  const seenReplies = useRef<number | null>(null);
  useEffect(() => {
    if (loading) return;
    if (seenReplies.current !== null && replies > seenReplies.current) setReceived((n) => n + 1);
    seenReplies.current = replies;
  }, [replies, loading]);

  const head = (
    <header className="chat-top">
      {!fresh && (
        <span className="chat-top-orb" aria-hidden="true">
          <Orb size={78} active={thinking} pulse={sent + received} beat={beat} />
        </span>
      )}
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

  const keyCard = !hasKey && <ConnectModel master={master} />;
  const blocked = !hasKey ? <>Connect a model above to start.</>
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
            <Composer onSend={send} placeholder="Ask anything, or describe the work" autoFocus value={draft} onValue={type} large blocked={blocked} attach={live ? attachForMaster : undefined} />
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
      <Conversation events={events} runs={runs} loading={loading} working={working} pending={pending} onRetry={past ? undefined : retry} who={{ name: "kalypso", mark: <Logo size={26} fine /> }} />
      {past ? (
        <div className="cv-composer blocked"><div className="cv-composer-foot"><span className="cv-composer-hint">This is an earlier chat. <button className="link" onClick={toLatest}>Go to the current one</button> to keep talking.</span></div></div>
      ) : (
        <>
          {keyCard && <div className="chat-key-wrap">{keyCard}</div>}
          <Composer onSend={send} placeholder="Message kalypso" value={draft} onValue={type} blocked={blocked} attach={live ? attachForMaster : undefined} />
        </>
      )}
    </section>
  );
}

/** The model kalypso thinks with, from any connected provider, switchable like in any chat app. */
function ModelPicker({ master }: { master: Agent | undefined }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { connected } = useProviders();
  const choices = useModelChoices(connected);
  const [chosen, setChosen] = useState(() => picked(state.ns));
  const fallback = connected.some((p) => p.id === "anthropic") ? CLAUDE_MODELS[0].id : choices.find((c) => c.models.length)?.models[0]?.id ?? CLAUDE_MODELS[0].id;
  const current = master?.model ?? chosen ?? fallback;
  const known = choices.some((c) => c.models.some((m) => m.id === current));
  const change = async (model: string) => {
    if (!master || !isLive()) {
      pick(state.ns, model);
      setChosen(model);
      return toast(`kalypso starts on ${modelLabel(model)}`);
    }
    try {
      const running = ["running", "starting", "restarting", "paused"].includes(master.status);
      if (running) await api.agentStop(state.ns, master.id);
      // Moving between Claude and another provider changes its runtime too; the core does that.
      await api.agentUpdate(state.ns, master.id, { model });
      await syncNamespace(state.ns, dispatch);
      toast(`kalypso now uses ${modelLabel(model)}`);
    } catch (e) {
      toast(errorMessage(e), "err");
    }
  };
  return (
    <label className="chat-model" title="The model kalypso thinks with. Agents it creates use the same one unless it picks another. Connect more providers in Settings, Models.">
      <span className="chat-model-mark"><Logo size={22} fine /></span>
      <span className="chat-model-name">kalypso</span>
      <select className="chat-model-select" value={current} onChange={(e) => change(e.target.value)}>
        {!known && <option value={current}>{modelLabel(current)}</option>}
        {choices.map((c) => (
          <optgroup key={c.provider.id} label={c.provider.name}>
            {c.loading && <option disabled>Loading models…</option>}
            {!c.loading && c.models.length === 0 && <option disabled>No models listed</option>}
            {c.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

/** No provider for kalypso's model yet: connect one right here instead of hunting through Settings. */
function ConnectModel({ master }: { master: Agent | undefined }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { providers, reload } = useProviders();
  const connected = async (p: ModelProvider, models: string[]) => {
    reload();
    // kalypso follows the provider just connected when its own isn't there.
    const model = p.id === "anthropic" ? CLAUDE_MODELS[0].id : models[0] ? `${p.id}/${models[0]}` : undefined;
    if (!model) return;
    if (!master) return pick(state.ns, model);
    if (providerOf(master.model) === p.id) return;
    try {
      if (["running", "starting", "restarting", "paused"].includes(master.status)) await api.agentStop(state.ns, master.id);
      await api.agentUpdate(state.ns, master.id, { model });
      await syncNamespace(state.ns, dispatch);
      toast(`kalypso now uses ${modelLabel(model)}`);
    } catch (e) {
      toast(errorMessage(e), "err");
    }
  };
  return (
    <div className="chat-key">
      <div className="chat-key-title"><KeyRound size={14} /> Connect a model</div>
      <p>
        kalypso needs a model provider for <b>{state.ns}</b>: Anthropic, OpenAI, Gemini, Mistral, DeepSeek, Groq, OpenRouter, Ollama on this machine, or anything OpenAI-compatible.
        Keys are stored in the vault, added to model calls by KALYPSO, and never shown to agents.
      </p>
      {providers ? <ConnectProvider providers={providers} onConnected={connected} compact /> : null}
    </div>
  );
}

/** One agent's own conversation, opened from the list. */
function MemberThread({ agent: a, onBack }: { agent: Agent; onBack: () => void }) {
  const { state, dispatch } = useStore();
  const convo = useAgentConversation(state.ns, a);
  const gate = useAgentGate(a, () => syncNamespace(state.ns, dispatch));
  const orb = useOrbState(convo.events, gate.working, convo.loading);
  // Its replies, counted once the transcript has loaded: each new one fans the shell open.
  const replies = convo.events.filter((e) => e.kind === "text" || e.kind === "result" || e.kind === "error").length;
  const [received, setReceived] = useState(0);
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (convo.loading) return;
    if (seen.current !== null && replies > seen.current) setReceived((n) => n + 1);
    seen.current = replies;
  }, [replies, convo.loading]);
  useEffect(() => { seen.current = null; }, [a.id]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onBack();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onBack]);
  return (
    <section className="chat-main" aria-label={`Conversation with ${a.name}`}>
      <header className="chat-top">
        <button className="btn ghost sm icon" onClick={onBack} title="Back to kalypso (Esc)" aria-label="Back to kalypso"><ArrowLeft size={14} /></button>
        <span className="chat-crew-mark"><Pecten size={38} active={gate.working} pulse={received} label={`${a.name}${gate.working ? ", working" : ""}`} /></span>
        <span className="chat-top-orb" aria-hidden="true"><Orb size={78} active={orb.thinking} pulse={orb.received} /></span>
        <div className="chat-top-who">
          <div className="chat-head-name"><span className="clip">{a.name}</span><Status value={a.status} /></div>
          <div className="chat-head-sub clip"><span className="mono">{a.model || a.runtime}</span>{a.role ? ` · ${a.role}` : ""}</div>
        </div>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={() => dispatch({ type: "view", view: "agents", focus: a.id })}><SlidersHorizontal size={12} /> Details</button>
      </header>
      <Conversation events={convo.events} runs={convo.runs} loading={convo.loading} working={gate.working} onShowEarlier={convo.hasEarlier ? convo.showEarlier : undefined}
        who={{ name: a.name, mark: <Pecten size={26} active={gate.working} pulse={received} /> }}
        empty={<div className="chat-crew-empty"><Pecten size={96} active={gate.working} pulse={received} /><span>{gate.working ? `${a.name} is working on it.` : `${a.name} hasn't done anything yet. Send it a message to give it work.`}</span></div>} />
      <Composer onSend={convo.send} placeholder={`Message ${a.name} directly`} blocked={gate.blocked}
        attach={isLive() && a.sandboxId ? async (f) => api.agentAttach(state.ns, a.id, f.name, await fileToBase64(f)) : undefined} />
    </section>
  );
}

// ---------- Sample data, for the browser preview ----------

const SAMPLE_MASTER: Agent = {
  id: "master-sample", ns: "work", name: "kalypso", role: "Coordinates your agents", model: "claude-sonnet-5-5", status: "running", master: true,
  sandboxId: "sb", skills: [], mcps: [], secrets: [], config: "",
};
