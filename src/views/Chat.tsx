import { useEffect, useState } from "react";
import { Bot, MessageSquare, Pause, Play, Plus, SlidersHorizontal, Square } from "lucide-react";
import { api, errorMessage, isLive, syncNamespace } from "../backend";
import { Composer, Conversation, useAgentConversation, useAgentGate } from "../components/Conversation";
import { EmptyState, initials, PrimaryButton, Skeleton, Status } from "../components/ui";
import { useNamespaced, useStore, useToast } from "../store";
import type { Agent } from "../types";
import "../styles/agents.css";

const LAST_KEY = "kalypso.chat.last";

/** One place to talk to your agents: pick one on the left, the conversation is on the right. */
export function Chat() {
  const { state, dispatch } = useStore();
  const { loading, agents } = useNamespaced();
  const [openId, setOpenId] = useState<string | null>(() => localStorage.getItem(`${LAST_KEY}.${state.ns}`));
  // Fall back to a running agent, then the first one, when nothing (or a deleted agent) was open.
  const open = agents.find((a) => a.id === openId) ?? agents.find((a) => a.status === "running") ?? agents[0];
  useEffect(() => {
    if (open) localStorage.setItem(`${LAST_KEY}.${state.ns}`, open.id);
  }, [open?.id, state.ns]);

  const newAgent = () => dispatch({ type: "view", view: "agents", compose: true });

  if (loading) return <div className="chat"><div className="chat-list" /><div className="chat-main" style={{ padding: 24 }}><Skeleton rows={4} /></div></div>;

  return (
    <div className="chat">
      <aside className="chat-list" aria-label="Conversations">
        <div className="chat-list-head">
          <h1>Chat</h1>
          <button className="btn ghost icon" onClick={newAgent} title="New agent" aria-label="New agent"><Plus size={15} /></button>
        </div>
        <div className="chat-threads">
          {agents.map((a) => (
            <button key={a.id} className={`chat-thread ${a.id === open?.id ? "on" : ""}`} onClick={() => setOpenId(a.id)} aria-current={a.id === open?.id} title={a.name}>
              <span className={`agent-avatar ${a.status}`}>{initials(a.name)}</span>
              <span style={{ minWidth: 0 }}>
                <span className="chat-thread-name clip" style={{ display: "block" }}>{a.name}</span>
                <span className="chat-thread-sub clip" style={{ display: "block" }}>{a.statusReason || a.role || a.status}</span>
              </span>
            </button>
          ))}
        </div>
        <p className="chat-list-note">
          Each conversation is with one agent. One orchestrator that plans and hands work to them is planned in{" "}
          <a href="https://github.com/kalyppso/kalypso/issues/85" target="_blank" rel="noreferrer">#85</a>.
        </p>
      </aside>

      {open ? (
        <Thread key={open.id} agent={open} />
      ) : (
        <div className="chat-main">
          <div className="chat-blank">
            <EmptyState icon={MessageSquare} title="No one to talk to yet" action={<PrimaryButton onClick={newAgent} icon={<Plus size={14} />}>New agent</PrimaryButton>}>
              Create an agent, give it a sandbox, and its conversation appears here.
            </EmptyState>
          </div>
        </div>
      )}
    </div>
  );
}

function Thread({ agent: a }: { agent: Agent }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const sync = () => syncNamespace(state.ns, dispatch);
  const convo = useAgentConversation(state.ns, a);
  const gate = useAgentGate(a, sync);

  const act = (done: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    fn().then(sync).then(() => toast(done)).catch((e) => toast(errorMessage(e), "err")).finally(() => setBusy(false));
  };
  const active = ["running", "starting", "restarting", "paused"].includes(a.status);
  const live = isLive();

  return (
    <section className="chat-main" aria-label={`Conversation with ${a.name}`}>
      <header className="chat-head">
        <span className={`agent-avatar ${a.status}`}>{initials(a.name)}</span>
        <div style={{ minWidth: 0 }}>
          <div className="chat-head-name"><span className="clip">{a.name}</span><Status value={a.status} /></div>
          <div className="chat-head-sub clip"><span className="mono">{a.model || a.runtime}</span>{a.role ? ` · ${a.role}` : ""}</div>
        </div>
        <span className="spacer" />
        {live && a.status === "running" && <button className="btn sm" disabled={busy} onClick={() => act(`${a.name} paused`, () => api.agentPause(state.ns, a.id))}><Pause size={12} /> Pause</button>}
        {live && a.status === "paused" && <button className="btn sm" disabled={busy} onClick={() => act(`${a.name} resumed`, () => api.agentResume(state.ns, a.id))}><Play size={12} /> Resume</button>}
        {live && active && <button className="btn sm" disabled={busy} onClick={() => act(`${a.name} stopped`, () => api.agentStop(state.ns, a.id))}><Square size={12} /> Stop</button>}
        <button className="btn ghost sm" onClick={() => dispatch({ type: "view", view: "agents", focus: a.id })} title={`Open ${a.name}'s page: settings, repository and run history`}>
          <SlidersHorizontal size={12} /> Details
        </button>
      </header>
      <Conversation
        events={convo.events}
        runs={convo.runs}
        loading={convo.loading}
        working={gate.working}
        onShowEarlier={convo.hasEarlier ? convo.showEarlier : undefined}
        empty={<><Bot size={20} style={{ opacity: 0.5 }} /><div style={{ marginTop: 10 }}>Nothing here yet. Tell {a.name} what you need.</div></>}
      />
      <Composer onSend={convo.send} placeholder={`Message ${a.name}`} blocked={gate.blocked} autoFocus />
    </section>
  );
}
