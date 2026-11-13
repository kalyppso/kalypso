import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Pause, Play, SlidersHorizontal, Square } from "lucide-react";
import { api, errorMessage, isLive, syncNamespace, toAgent } from "../backend";
import { Composer, Conversation, useAgentConversation, useAgentGate } from "../components/Conversation";
import { initials, Skeleton, Status } from "../components/ui";
import { Orb } from "../components/Orb";
import { useNamespaced, useStore, useToast } from "../store";
import type { Agent } from "../types";
import "../styles/agents.css";

/**
 * Chat: the conversation with the master agent, the one that plans the work, creates and runs
 * the namespace's other agents through KALYPSO, and reports back. Its team is on the right;
 * any member's own conversation opens in place, and Back returns to the master.
 */
export function Chat() {
  const { dispatch } = useStore();
  const { loading, agents } = useNamespaced();
  const live = isLive();
  const master = useMemo(() => (live ? agents.find((a) => a.master) : SAMPLE_MASTER), [agents, live]);
  const team = agents.filter((a) => !a.master);
  const [viewing, setViewing] = useState<string | null>(null);
  const member = team.find((a) => a.id === viewing);

  if (loading) return <div className="chat"><div className="chat-main" style={{ padding: 32 }}><Skeleton rows={4} /></div></div>;

  return (
    <div className="chat">
      {member ? <MemberThread agent={member} onBack={() => setViewing(null)} /> : <MasterThread master={master} />}
      <aside className="chat-team" aria-label="Team">
        <div className="chat-team-head">
          <span>Team</span>
          <span className="faint small">{team.filter((a) => a.status === "running").length} working</span>
        </div>
        <button className={`chat-member master ${!member ? "on" : ""}`} onClick={() => setViewing(null)} aria-current={!member}>
          <span className={`agent-avatar ${master?.status ?? "stopped"}`}>K</span>
          <span className="chat-member-text">
            <span className="chat-member-name">kalypso</span>
            <span className="chat-member-sub">Coordinates your agents</span>
          </span>
        </button>
        <div className="chat-team-list">
          {team.map((a) => (
            <button key={a.id} className={`chat-member ${a.id === viewing ? "on" : ""}`} onClick={() => setViewing(a.id)} aria-current={a.id === viewing} title={`Open ${a.name}'s conversation`}>
              <span className={`agent-avatar ${a.status}`}>{initials(a.name)}</span>
              <span className="chat-member-text">
                <span className="chat-member-name">{a.name}</span>
                <span className="chat-member-sub">{a.status === "running" ? "Working" : a.statusReason || a.role || a.status}</span>
              </span>
            </button>
          ))}
          {team.length === 0 && <p className="chat-team-empty">No agents yet. Ask for something and kalypso creates the ones it needs.</p>}
        </div>
        <button className="btn ghost sm chat-team-manage" onClick={() => dispatch({ type: "view", view: "agents" })}>
          <SlidersHorizontal size={12} /> Manage agents
        </button>
      </aside>
    </div>
  );
}

const STARTERS = [
  "Find out why the tests fail on main and fix them",
  "Review my open pull requests and summarize what needs attention",
  "Research how other tools handle prompt caching and write up the options",
  "Set up an agent that watches the deploy and tells me when it breaks",
];

/** The master agent's conversation. Before it exists, a start screen; the first message creates and starts it. */
function MasterThread({ master }: { master: Agent | undefined }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const live = isLive();
  const convo = useAgentConversation(state.ns, master);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  // The orb wakes while you type and sends a wave round when a message goes.
  const [sent, setSent] = useState(0);
  const [sending, setSending] = useState(false);
  const sync = () => syncNamespace(state.ns, dispatch);

  // Sending always works: KALYPSO creates the master agent and starts it as needed.
  const send = async (text: string) => {
    if (!live) return convo.send(text);
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
    await api.agentSend(state.ns, m.id, text);
  };

  const act = (done: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    fn().then(sync).then(() => toast(done)).catch((e) => toast(errorMessage(e), "err")).finally(() => setBusy(false));
  };

  const fresh = !convo.loading && convo.events.length === 0;
  const working = live && master?.status === "running";

  if (fresh) {
    return (
      <section className="chat-main chat-start" aria-label="Start a conversation">
        <div className="chat-start-inner">
          <Orb size={132} active={!!draft.trim() || sending} pulse={sent} className="chat-orb" label="kalypso" />
          <h1 className="chat-hello">What should we work on?</h1>
          <p className="chat-hello-sub">Tell kalypso what you need. It plans the work, creates and runs agents for each part, and reports back here.</p>
          <Composer onSend={(t) => { setSent((n) => n + 1); setSending(true); return send(t).then(() => setDraft("")).finally(() => setSending(false)); }} placeholder="Describe the work, or ask a question" autoFocus value={draft} onValue={setDraft} large />
          <div className="chat-starters">
            {STARTERS.map((s) => <button key={s} className="chat-starter" onClick={() => setDraft(s)}>{s}</button>)}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="chat-main" aria-label="Conversation with kalypso">
      <header className="chat-head">
        <span className={`agent-avatar ${master?.status ?? "stopped"}`}>K</span>
        <div style={{ minWidth: 0 }}>
          <div className="chat-head-name"><span>kalypso</span>{master && <Status value={master.status} />}</div>
          <div className="chat-head-sub clip">Master agent · <span className="mono">{master?.model}</span></div>
        </div>
        <span className="spacer" />
        {live && master?.status === "running" && <button className="btn sm" disabled={busy} onClick={() => act("kalypso paused", () => api.agentPause(state.ns, master.id))}><Pause size={12} /> Pause</button>}
        {live && master?.status === "paused" && <button className="btn sm" disabled={busy} onClick={() => act("kalypso resumed", () => api.agentResume(state.ns, master.id))}><Play size={12} /> Resume</button>}
        {live && master && ["running", "starting", "restarting", "paused"].includes(master.status) && (
          <button className="btn sm" disabled={busy} onClick={() => act("kalypso stopped", () => api.agentStop(state.ns, master.id))} title="Stops kalypso. The agents it started keep running.">
            <Square size={12} /> Stop
          </button>
        )}
        {master && live && (
          <button className="btn ghost sm" onClick={() => dispatch({ type: "view", view: "agents", focus: master.id })} title="Model, sandbox and run history">
            <SlidersHorizontal size={12} /> Details
          </button>
        )}
      </header>
      <Conversation events={convo.events} runs={convo.runs} loading={convo.loading} working={working} onShowEarlier={convo.hasEarlier ? convo.showEarlier : undefined} />
      <Composer onSend={send} placeholder="Message kalypso" blocked={master?.status === "paused" ? <>kalypso is paused. <button className="link" disabled={busy} onClick={() => act("kalypso resumed", () => api.agentResume(state.ns, master.id))}>Resume it</button> to continue.</> : undefined} />
    </section>
  );
}

/** One team member's own conversation, opened from the team list. */
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
      <header className="chat-head">
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
