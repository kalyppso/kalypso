import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api, errorMessage, isLive, syncNamespace } from "../backend";
import type { ChatSettings as Settings } from "../bindings/ChatSettings";
import type { Memory } from "../bindings/Memory";
import type { Prompt } from "../bindings/Prompt";
import { useStore, useToast } from "../store";
import type { Agent } from "../types";
import { Modal, Toggle } from "./ui";
import "../styles/prompts.css";

// ---------- Preferences kept on this machine ----------

export interface ChatPrefs {
  /** "enter": Enter sends, Shift+Enter is a new line. "mod": Ctrl/⌘+Enter sends, Enter is a new line. */
  send: "enter" | "mod";
  /** Show every step an agent takes, instead of folding long stretches. */
  expandSteps: boolean;
}

const PREFS_KEY = "kalypso.chat.prefs";
const DEFAULT_PREFS: ChatPrefs = { send: "enter", expandSteps: false };

function readPrefs(): ChatPrefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** The chat's local preferences, kept current when they change anywhere in the app. */
export function useChatPrefs(): [ChatPrefs, (p: Partial<ChatPrefs>) => void] {
  const [prefs, set] = useState(readPrefs);
  useEffect(() => {
    const on = () => set(readPrefs());
    window.addEventListener("kalypso:chat-prefs", on);
    return () => window.removeEventListener("kalypso:chat-prefs", on);
  }, []);
  const update = (p: Partial<ChatPrefs>) => {
    const next = { ...readPrefs(), ...p };
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* private window */ }
    window.dispatchEvent(new Event("kalypso:chat-prefs"));
  };
  return [prefs, update];
}

// ---------- The settings window ----------

type Tab = "instructions" | "memory" | "preferences";
const DEFAULTS: Settings = { instructions: "", style: "balanced", stop_when_done: true, memory: true };

export function ChatSettingsModal({ master, onClose }: { master: Agent | undefined; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const live = isLive();
  const [tab, setTab] = useState<Tab>("instructions");
  const [settings, setSettings] = useState<Settings | null>(live ? null : DEFAULTS);
  const [saved, setSaved] = useState<Settings | null>(live ? null : DEFAULTS);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [prefs, setPrefs] = useChatPrefs();

  useEffect(() => {
    if (!live) return;
    api.chatSettingsGet(state.ns).then((s) => { setSettings(s); setSaved(s); }).catch((e) => toast(errorMessage(e), "err"));
    api.memoryList(state.ns).then(setMemories).catch(() => {});
    api.promptList(state.ns).then(setPrompts).catch(() => {});
  }, [state.ns]);

  const dirty = !!settings && !!saved && JSON.stringify(settings) !== JSON.stringify(saved);
  const running = !!master && ["running", "starting", "restarting", "paused"].includes(master.status);

  const save = async (restart: boolean) => {
    if (!settings) return;
    try {
      const s = live ? await api.chatSettingsSet(state.ns, settings) : settings;
      setSettings(s);
      setSaved(s);
      if (restart && master && live) {
        // Its conversation carries on: the session is kept across a restart.
        await api.agentStop(state.ns, master.id);
        await api.agentStart(state.ns, master.id);
        await syncNamespace(state.ns, dispatch);
        toast("Saved, and kalypso restarted with it");
      } else {
        toast(running ? "Saved. kalypso uses it from its next start." : "Saved");
      }
    } catch (e) {
      toast(errorMessage(e), "err");
    }
  };

  const mine = prompts.filter((p) => master && p.agents.includes(master.id));

  return (
    <Modal wide title="Chat settings" subtitle={`For kalypso in ${state.ns}.`} onClose={onClose}>
      <div className="segmented cs-tabs">
        <button className={tab === "instructions" ? "active" : ""} onClick={() => setTab("instructions")}>Instructions</button>
        <button className={tab === "memory" ? "active" : ""} onClick={() => setTab("memory")}>Memory</button>
        <button className={tab === "preferences" ? "active" : ""} onClick={() => setTab("preferences")}>Preferences</button>
      </div>

      {!settings ? (
        <p className="faint">Loading…</p>
      ) : tab === "instructions" ? (
        <>
          <p className="cs-note">What kalypso should always keep in mind: how you work, what to avoid, who it's working for. It's added to kalypso's system prompt.</p>
          <textarea className="textarea pr-content" value={settings.instructions} onChange={(e) => setSettings({ ...settings, instructions: e.target.value })}
            placeholder={"For example:\nI work mostly in acme/platform. Ask before touching the database migrations.\nPrefer small pull requests, one change each."} />
          <div className="cs-row" style={{ borderTop: 0 }}>
            <div className="cs-row-text">
              <b>Prompts from the Prompts page</b>
              <span>{mine.length ? "Also given to kalypso:" : "None given to kalypso yet."}</span>
              {mine.length > 0 && <div className="cs-assigned">{mine.map((p) => <span key={p.id} className="badge">{p.kind === "persona" ? "Persona" : "Instruction"} · {p.name}</span>)}</div>}
            </div>
            <button className="btn ghost sm" onClick={() => { onClose(); dispatch({ type: "view", view: "prompts" }); }}>Open Prompts</button>
          </div>
        </>
      ) : tab === "memory" ? (
        <MemoryTab settings={settings} setSettings={setSettings} memories={memories} setMemories={setMemories} />
      ) : (
        <>
          <div className="cs-row">
            <div className="cs-row-text"><b>Reply style</b><span>How much kalypso says when it reports back.</span></div>
            <div className="segmented">
              {(["concise", "balanced", "detailed"] as const).map((s) => (
                <button key={s} className={settings.style === s ? "active" : ""} onClick={() => setSettings({ ...settings, style: s })}>{s[0].toUpperCase() + s.slice(1)}</button>
              ))}
            </div>
          </div>
          <div className="cs-row">
            <div className="cs-row-text"><b>Stop agents when their work is done</b><span>Off: kalypso leaves them running for follow-ups.</span></div>
            <Toggle on={settings.stop_when_done} onChange={(v) => setSettings({ ...settings, stop_when_done: v })} label="Stop agents when done" />
          </div>
          <div className="cs-row">
            <div className="cs-row-text"><b>Send with</b><span>The other combination adds a new line.</span></div>
            <div className="segmented">
              <button className={prefs.send === "enter" ? "active" : ""} onClick={() => setPrefs({ send: "enter" })}>Enter</button>
              <button className={prefs.send === "mod" ? "active" : ""} onClick={() => setPrefs({ send: "mod" })}>{/Mac/.test(navigator.platform) ? "⌘" : "Ctrl"}+Enter</button>
            </div>
          </div>
          <div className="cs-row">
            <div className="cs-row-text"><b>Show every step</b><span>Off: long stretches of agent work fold into one line.</span></div>
            <Toggle on={prefs.expandSteps} onChange={(v) => setPrefs({ expandSteps: v })} label="Show every step" />
          </div>
        </>
      )}

      {settings && tab !== "memory" && (
        <div className="row" style={{ marginTop: 18 }}>
          <span className="faint small">{tab === "preferences" ? "Send and steps apply right away, on this computer." : ""}</span>
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>Close</button>
          {running && <button className="btn" disabled={!dirty} onClick={() => save(true)} title="Restart kalypso so it uses this now. The conversation carries on.">Save and restart</button>}
          <button className="btn primary" disabled={!dirty} onClick={() => save(false)}>Save</button>
        </div>
      )}
    </Modal>
  );
}

function MemoryTab({ settings, setSettings, memories, setMemories }: { settings: Settings; setSettings: (s: Settings) => void; memories: Memory[]; setMemories: (m: Memory[]) => void }) {
  const { state } = useStore();
  const toast = useToast();
  const live = isLive();
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  const toggle = async (on: boolean) => {
    const next = { ...settings, memory: on };
    try {
      setSettings(live ? await api.chatSettingsSet(state.ns, next) : next);
      toast(on ? "kalypso remembers again from its next start" : "Memory off: kalypso won't see or save memories");
    } catch (e) {
      toast(errorMessage(e), "err");
    }
  };
  const add = async () => {
    const t = text.trim();
    if (!t) return;
    try {
      const m = live ? await api.memoryAdd(state.ns, t) : { id: `me-${Date.now()}`, text: t, source: "you", created_at: "" };
      setMemories([m, ...memories]);
      setText("");
    } catch (e) {
      toast(errorMessage(e), "err");
    }
  };
  const saveEdit = async () => {
    if (!editing) return;
    try {
      if (live) await api.memoryEdit(state.ns, editing.id, editing.text);
      setMemories(memories.map((m) => (m.id === editing.id ? { ...m, text: editing.text.trim() } : m)));
      setEditing(null);
    } catch (e) {
      toast(errorMessage(e), "err");
    }
  };
  const remove = async (id: string) => {
    try {
      if (live) await api.memoryDelete(state.ns, id);
      setMemories(memories.filter((m) => m.id !== id));
    } catch (e) {
      toast(errorMessage(e), "err");
    }
  };

  return (
    <>
      <div className="cs-row" style={{ borderTop: 0, paddingTop: 0 }}>
        <div className="cs-row-text"><b>Memory</b><span>Facts kalypso knows in every chat. It saves new ones itself when something will matter next time.</span></div>
        <Toggle on={settings.memory} onChange={toggle} label="Memory" />
      </div>
      <div className="cs-add">
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder="Add something kalypso should remember" disabled={!settings.memory} />
        <button className="btn" onClick={add} disabled={!text.trim() || !settings.memory}><Plus size={13} /> Add</button>
      </div>
      <div className="cs-mem">
        {memories.length === 0 && <p className="faint small" style={{ margin: "8px 10px" }}>Nothing yet.</p>}
        {memories.map((m) =>
          editing?.id === m.id ? (
            <div key={m.id} className="cs-add" style={{ padding: "4px 0" }}>
              <input className="input" autoFocus value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditing(null); }} />
              <button className="btn" onClick={saveEdit}>Save</button>
            </div>
          ) : (
            <div key={m.id} className="cs-mem-item">
              <p onDoubleClick={() => setEditing({ id: m.id, text: m.text })} title="Double-click to edit">{m.text}</p>
              <span className="cs-mem-src">{m.source === "you" ? "You" : m.source}</span>
              <button className="btn ghost sm icon danger" onClick={() => remove(m.id)} aria-label="Forget this"><Trash2 size={12} /></button>
            </div>
          ),
        )}
      </div>
    </>
  );
}
