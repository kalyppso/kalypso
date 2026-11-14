import { useEffect, useState, type ReactNode } from "react";
import { BookText, KeyRound, Plug, Plus, RotateCw, Sparkles, X } from "lucide-react";
import { api, errorMessage, isLive, syncNamespace } from "../backend";
import type { McpServer } from "../bindings/McpServer";
import type { Prompt } from "../bindings/Prompt";
import type { Skill } from "../bindings/Skill";
import { useNamespaced, useStore, useToast } from "../store";
import type { Agent, ViewId } from "../types";
import { Field, Modal, ModalActions, useErrors, usePopover } from "./ui";

/**
 * Everything an agent gets, in one place on its page: secrets, prompts, tools (MCP servers) and
 * skills. Each shows as a chip; × takes it away, + Add gives it more, and "New…" makes one for
 * this agent. Secrets reach a running agent at once; the rest from its next start.
 */
export function AgentGear({ agent: a }: { agent: Agent }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { secrets } = useNamespaced();
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [newSecret, setNewSecret] = useState(false);
  const [changed, setChanged] = useState(false);
  const live = isLive();

  const load = () => {
    if (!live) return;
    api.promptList(state.ns).then(setPrompts).catch(() => {});
    api.mcpList(state.ns).then(setServers).catch(() => {});
    api.skillList(state.ns).then(setSkills).catch(() => {});
  };
  useEffect(load, [state.ns, a.id]);

  const run = async (fn: () => Promise<unknown>, done: string, nextStart = true) => {
    try {
      await fn();
      load();
      await syncNamespace(state.ns, dispatch);
      if (nextStart && ["running", "starting", "restarting", "paused"].includes(a.status)) setChanged(true);
      toast(done);
    } catch (e) {
      toast(errorMessage(e), "err");
    }
  };
  const go = (view: ViewId) => dispatch({ type: "view", view });

  // Secrets: namespace-wide ones reach every agent; agent-scoped ones are granted here.
  const granted = a.secrets ?? [];
  const shared = secrets.filter((x) => x.scope === "namespace");
  const own = secrets.filter((x) => x.scope === "agent" && granted.includes(x.id));
  const grantable = secrets.filter((x) => x.scope === "agent" && !granted.includes(x.id));
  const setSecrets = (ids: string[], done: string) => run(() => api.agentUpdate(state.ns, a.id, { secrets: ids }), done, false);

  // Prompts, tools and skills: what applies to this agent, and what could be given to it.
  const itsPrompts = prompts.filter((p) => p.agents.includes(a.id));
  const otherPrompts = prompts.filter((p) => !p.agents.includes(a.id));
  const applies = <T extends { scope: string; agents: string[]; enabled: boolean }>(x: T) =>
    x.enabled && (x.scope === "all" || (x.scope === "master" ? !!a.master : x.agents.includes(a.id)));
  const itsServers = servers.filter(applies);
  const moreServers = servers.filter((x) => x.enabled && x.scope === "chosen" && !x.agents.includes(a.id));
  const itsSkills = skills.filter(applies);
  const moreSkills = skills.filter((x) => x.enabled && x.scope === "chosen" && !x.agents.includes(a.id));

  if (!live) return null;
  return (
    <div className="gear">
      <div className="gear-head">
        <h3>What {a.name} gets</h3>
        {changed && (
          <button className="btn sm" onClick={() => run(async () => { await api.agentStop(state.ns, a.id); await api.agentStart(state.ns, a.id); setChanged(false); }, `${a.name} restarted with its changes`, false)}>
            <RotateCw size={12} /> Restart to apply
          </button>
        )}
      </div>

      <GearSection icon={<KeyRound size={13} />} title="Secrets" hint="Files in /run/kalypso/secrets, there at once.">
        {shared.map((x) => <Chip key={x.id} label={x.key} mono note="every agent" />)}
        {own.map((x) => <Chip key={x.id} label={x.key} mono onRemove={() => setSecrets(granted.filter((g) => g !== x.id), `${x.key} taken from ${a.name}`)} />)}
        <Add
          label="Add"
          items={grantable.map((x) => ({ id: x.id, label: x.key, mono: true }))}
          empty="No other secrets for chosen agents."
          onPick={(id) => setSecrets([...granted, id], `${secrets.find((x) => x.id === id)?.key} given to ${a.name}`)}
          extra={[{ label: "New secret for this agent", run: () => setNewSecret(true) }]}
        />
      </GearSection>

      <GearSection icon={<BookText size={13} />} title="Prompts" hint="Personas and instructions from the Playbook.">
        {itsPrompts.map((p) => (
          <Chip key={p.id} label={p.name} note={p.kind} onRemove={() => run(() => api.promptAssign(state.ns, p.id, a.id, false), `${p.name} taken from ${a.name}`)} />
        ))}
        <Add
          label="Add"
          items={otherPrompts.map((p) => ({ id: p.id, label: p.name, note: p.kind }))}
          empty="No other prompts yet."
          onPick={(id) => run(() => api.promptAssign(state.ns, id, a.id, true), `${prompts.find((p) => p.id === id)?.name} given to ${a.name}`)}
          extra={[{ label: "Write a new prompt", run: () => go("prompts") }]}
        />
      </GearSection>

      <GearSection icon={<Plug size={13} />} title="Tools" hint="MCP servers from the Toolkit.">
        {itsServers.map((x) =>
          x.scope === "chosen" ? (
            <Chip key={x.id} label={x.name} mono onRemove={() => run(() => api.mcpAssign(state.ns, x.id, a.id, false), `${x.name} taken from ${a.name}`)} />
          ) : (
            <Chip key={x.id} label={x.name} mono note={x.scope === "all" ? "every agent" : "kalypso"} />
          ),
        )}
        <Add
          label="Add"
          items={moreServers.map((x) => ({ id: x.id, label: x.name, mono: true }))}
          empty="No other MCP servers for chosen agents."
          onPick={(id) => run(() => api.mcpAssign(state.ns, id, a.id, true), `${servers.find((x) => x.id === id)?.name} given to ${a.name}`)}
          extra={[{ label: "Add an MCP server", run: () => go("registry") }]}
        />
      </GearSection>

      <GearSection icon={<Sparkles size={13} />} title="Skills" hint="SKILL.md files from the Toolkit.">
        {itsSkills.map((x) =>
          x.scope === "chosen" ? (
            <Chip key={x.id} label={x.name} title={x.description} onRemove={() => run(() => api.skillAssign(state.ns, x.id, a.id, false), `${x.name} taken from ${a.name}`)} />
          ) : (
            <Chip key={x.id} label={x.name} title={x.description} note={x.scope === "all" ? "every agent" : "kalypso"} />
          ),
        )}
        <Add
          label="Add"
          items={moreSkills.map((x) => ({ id: x.id, label: x.name, note: x.description }))}
          empty="No other skills yet."
          onPick={(id) => run(() => api.skillAssign(state.ns, id, a.id, true), `${skills.find((x) => x.id === id)?.name} given to ${a.name}`)}
          extra={[{ label: "Add a skill", run: () => go("registry") }]}
        />
      </GearSection>

      {newSecret && (
        <NewAgentSecret
          agent={a}
          onClose={() => setNewSecret(false)}
          onSaved={(id, key) => setSecrets([...granted, id], `${key} saved and given to ${a.name}`)}
        />
      )}
    </div>
  );
}

function GearSection({ icon, title, hint, children }: { icon: ReactNode; title: string; hint: string; children: ReactNode }) {
  return (
    <section className="gear-section">
      <div className="gear-title" title={hint}>{icon} {title}</div>
      <div className="gear-chips">{children}</div>
    </section>
  );
}

function Chip({ label, note, mono, title, onRemove }: { label: string; note?: string; mono?: boolean; title?: string; onRemove?: () => void }) {
  return (
    <span className={`gear-chip ${onRemove ? "" : "fixed"}`} title={title ?? (onRemove ? undefined : `Given to ${note}; change it where it's managed`)}>
      <span className={mono ? "mono" : ""}>{label}</span>
      {note && <span className="gear-note">{note}</span>}
      {onRemove && <button onClick={onRemove} aria-label={`Take ${label} away`}><X size={11} /></button>}
    </span>
  );
}

/** "+ Add": the things that could be given, and a way to make a new one. */
function Add({ label, items, empty, onPick, extra }: {
  label: string; items: { id: string; label: string; note?: string; mono?: boolean }[]; empty: string; onPick: (id: string) => void; extra: { label: string; run: () => void }[];
}) {
  const { open, setOpen, ref } = usePopover();
  return (
    <span className="pop-wrap" ref={ref}>
      <button className="gear-add" onClick={() => setOpen(!open)} aria-expanded={open}><Plus size={11} /> {label}</button>
      {open && (
        <div className="popover gear-pop">
          {items.length === 0 && <div className="faint small" style={{ padding: "6px 8px" }}>{empty}</div>}
          {items.map((i) => (
            <button key={i.id} className="pop-item" onClick={() => { onPick(i.id); setOpen(false); }}>
              <span className={`clip ${i.mono ? "mono" : ""}`}>{i.label}</span>
              {i.note && <span className="faint small clip" style={{ marginLeft: "auto", maxWidth: 140 }}>{i.note}</span>}
            </button>
          ))}
          <div className="pop-sep" />
          {extra.map((e) => <button key={e.label} className="pop-item" onClick={() => { e.run(); setOpen(false); }}><Plus size={13} /> {e.label}</button>)}
        </div>
      )}
    </span>
  );
}

/** A secret only this agent gets: saved with the "chosen agents" scope and granted to it at once. */
function NewAgentSecret({ agent: a, onClose, onSaved }: { agent: Agent; onClose: () => void; onSaved: (id: string, key: string) => void }) {
  const { state } = useStore();
  const toast = useToast();
  const { secrets } = useNamespaced();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const { errors, check, clear } = useErrors();
  const save = async () => {
    const k = key.trim();
    const ok = check({
      key: !/^[A-Z][A-Z0-9_]*$/.test(k) ? "Capitals, digits and underscores, starting with a letter, like DEPLOY_TOKEN." : secrets.some((x) => x.key === k) ? `${k} already exists here.` : undefined,
      value: value ? undefined : "Paste the value.",
    });
    if (!ok) return;
    try {
      const meta = await api.secretSet(state.ns, k, value, "agent");
      onSaved(meta.id, k);
      onClose();
    } catch (e) {
      toast(errorMessage(e), "err");
    }
  };
  return (
    <Modal title={`New secret for ${a.name}`} subtitle="Encrypted in the Vault and given only to this agent. It reads it as a file, never in its prompt." onClose={onClose}>
      <Field label="Key" error={errors.key}>
        <input className="input mono" autoFocus value={key} onChange={(e) => { setKey(e.target.value.toUpperCase()); clear("key"); }} placeholder="DEPLOY_TOKEN" />
      </Field>
      <Field label="Value" error={errors.value}>
        <input className="input mono" type="password" autoComplete="off" value={value} onChange={(e) => { setValue(e.target.value); clear("value"); }} />
      </Field>
      <ModalActions onCancel={onClose} onConfirm={save} confirm="Save and give it" />
    </Modal>
  );
}
