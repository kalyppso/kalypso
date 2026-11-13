import { useEffect, useState } from "react";
import { Plus, ScrollText, Trash2, UserRound } from "lucide-react";
import { api, errorMessage, isLive } from "../backend";
import type { Prompt } from "../bindings/Prompt";
import { AgentFace, EmptyState, Field, Modal, PageHead, PrimaryButton, Skeleton, useErrors } from "../components/ui";
import { useNamespaced, useStore, useToast } from "../store";
import type { Agent } from "../types";
import "../styles/prompts.css";

/**
 * Prompts: write them once, give them to any agents. A persona says who an agent is; an
 * instruction says how it works. An agent gets its prompts the next time it starts.
 */

type Kind = "persona" | "instruction";

const EXAMPLES: { name: string; kind: Kind; description: string; content: string }[] = [
  {
    name: "Careful reviewer",
    kind: "persona",
    description: "A senior engineer who reviews before approving",
    content: "You are a careful senior engineer. You read the whole change before judging it, say plainly what is wrong and why, and separate blocking problems from suggestions. You never approve something you haven't run.",
  },
  {
    name: "Tests first",
    kind: "instruction",
    description: "Reproduce bugs with a failing test before fixing",
    content: "When fixing a bug, first write a test that fails because of it. Then fix the code until that test passes, and run the full test suite before you report back.",
  },
  {
    name: "Short reports",
    kind: "instruction",
    description: "End every task with a short summary",
    content: "Finish every task with at most five lines: what you changed, where, how you checked it, and anything the user must do next.",
  },
];

export function Prompts() {
  const { state } = useStore();
  const toast = useToast();
  const { agents } = useNamespaced();
  const live = isLive();
  const [prompts, setPrompts] = useState<Prompt[] | null>(live ? null : SAMPLE_PROMPTS);
  const [editing, setEditing] = useState<Partial<Prompt> | null>(null);

  const load = () => api.promptList(state.ns).then(setPrompts).catch((e) => { setPrompts([]); toast(errorMessage(e), "err"); });
  useEffect(() => { if (live) load(); }, [state.ns]);

  const personas = (prompts ?? []).filter((p) => p.kind === "persona");
  const instructions = (prompts ?? []).filter((p) => p.kind === "instruction");

  return (
    <>
      <PageHead title="Playbook" subtitle="Write a prompt once and give it to any of your agents. Personas say who an agent is; instructions say how it works.">
        <PrimaryButton onClick={() => setEditing({ kind: "instruction" })} icon={<Plus size={14} />}>New prompt</PrimaryButton>
      </PageHead>

      {prompts === null ? (
        <Skeleton rows={3} height={84} />
      ) : prompts.length === 0 ? (
        <EmptyState icon={ScrollText} title="No prompts yet" action={<PrimaryButton onClick={() => setEditing({ kind: "instruction" })} icon={<Plus size={14} />}>New prompt</PrimaryButton>}>
          <p style={{ margin: "0 0 14px" }}>Start from one of these, or write your own.</p>
          <div className="pr-examples">
            {EXAMPLES.map((e) => (
              <button key={e.name} className="pr-example" onClick={() => setEditing({ ...e, agents: [] })}>
                <span className="pr-kind">{e.kind === "persona" ? "Persona" : "Instruction"}</span>
                <span className="pr-name">{e.name}</span>
                <span className="pr-desc">{e.description}</span>
              </button>
            ))}
          </div>
        </EmptyState>
      ) : (
        <>
          <Group title="Personas" hint="Who the agent is: its role, voice and judgment." items={personas} agents={agents} onOpen={setEditing} onNew={() => setEditing({ kind: "persona" })} />
          <Group title="Instructions" hint="How the agent works: rules, steps and habits." items={instructions} agents={agents} onOpen={setEditing} onNew={() => setEditing({ kind: "instruction" })} />
        </>
      )}

      {editing && (
        <Editor
          initial={editing}
          agents={agents}
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            setPrompts((all) => [...(all ?? []).filter((x) => x.id !== p.id), p].sort((a, b) => a.name.localeCompare(b.name)));
            setEditing(null);
          }}
          onDeleted={(id) => {
            setPrompts((all) => (all ?? []).filter((x) => x.id !== id));
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

function Group({ title, hint, items, agents, onOpen, onNew }: { title: string; hint: string; items: Prompt[]; agents: Agent[]; onOpen: (p: Prompt) => void; onNew: () => void }) {
  return (
    <section className="pr-group">
      <div className="pr-group-head">
        <h3>{title}</h3>
        <span className="faint small">{hint}</span>
      </div>
      <div className="pr-grid">
        {items.map((p) => {
          const who = agents.filter((a) => p.agents.includes(a.id));
          return (
            <button key={p.id} className="pr-card" onClick={() => onOpen(p)}>
              <span className="pr-card-top">
                {p.kind === "persona" ? <UserRound size={14} /> : <ScrollText size={14} />}
                <span className="pr-name clip">{p.name}</span>
              </span>
              <span className="pr-desc">{p.description || p.content}</span>
              <span className="pr-who">
                {who.length ? who.map((a) => <span key={a.id} className={`pr-agent ${a.master ? "mark" : ""}`} title={a.name}><AgentFace agent={a} size={18} /></span>) : <span className="faint small">Not given to any agent</span>}
              </span>
            </button>
          );
        })}
        <button className="pr-card pr-add" onClick={onNew}><Plus size={15} /> New {title === "Personas" ? "persona" : "instruction"}</button>
      </div>
    </section>
  );
}

function Editor({ initial, agents, onClose, onSaved, onDeleted }: { initial: Partial<Prompt>; agents: Agent[]; onClose: () => void; onSaved: (p: Prompt) => void; onDeleted: (id: string) => void }) {
  const { state } = useStore();
  const toast = useToast();
  const { errors, check, clear } = useErrors();
  const [name, setName] = useState(initial.name ?? "");
  const [kind, setKind] = useState<Kind>((initial.kind as Kind) ?? "instruction");
  const [description, setDescription] = useState(initial.description ?? "");
  const [content, setContent] = useState(initial.content ?? "");
  const [chosen, setChosen] = useState<string[]>(initial.agents ?? []);
  const [busy, setBusy] = useState(false);
  const existing = !!initial.id;

  const save = async () => {
    if (!check({ name: name.trim() ? undefined : "Give it a name.", content: content.trim() ? undefined : "Write the prompt." })) return;
    setBusy(true);
    try {
      const input = { id: initial.id, name, kind, description, content, agents: chosen };
      const saved = isLive() ? await api.promptSave(state.ns, input) : { ...input, id: initial.id ?? `pr-${Date.now()}`, ns: state.ns, updated_at: "" };
      toast(chosen.length ? `Saved. Agents get it the next time they start.` : "Saved");
      onSaved(saved as Prompt);
    } catch (e) {
      toast(errorMessage(e), "err");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!initial.id || !confirm(`Delete ${initial.name}? Agents stop getting it from their next start.`)) return;
    try {
      if (isLive()) await api.promptDelete(state.ns, initial.id);
      onDeleted(initial.id);
      toast(`Deleted ${initial.name}`, "warn");
    } catch (e) {
      toast(errorMessage(e), "err");
    }
  };
  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  return (
    <Modal wide title={existing ? initial.name ?? "Prompt" : kind === "persona" ? "New persona" : "New instruction"} subtitle={`In ${state.ns}. Agents get it the next time they start.`} onClose={onClose}>
      <div className="field-row">
        <Field label="Name" error={errors.name}>
          <input className="input" autoFocus={!existing} value={name} onChange={(e) => { setName(e.target.value); clear("name"); }} placeholder={kind === "persona" ? "Careful reviewer" : "Tests first"} />
        </Field>
        <div className="field">Type
          <div className="segmented" style={{ alignSelf: "flex-start" }}>
            <button className={kind === "persona" ? "active" : ""} onClick={() => setKind("persona")}>Persona</button>
            <button className={kind === "instruction" ? "active" : ""} onClick={() => setKind("instruction")}>Instruction</button>
          </div>
        </div>
      </div>
      <label className="field">Description<input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One line, so you recognise it later" /></label>
      <Field label={kind === "persona" ? "Who the agent is" : "What the agent should do"} error={errors.content} hint={`${content.length.toLocaleString()} characters`}>
        <textarea className="textarea pr-content" value={content} onChange={(e) => { setContent(e.target.value); clear("content"); }}
          placeholder={kind === "persona" ? "You are a careful senior engineer. You…" : "When fixing a bug, first write a test that fails because of it…"} />
      </Field>
      <div className="field">Give it to
        <div className="pr-pick">
          {agents.map((a) => (
            <button key={a.id} className={`pr-pick-item ${chosen.includes(a.id) ? "on" : ""}`} onClick={() => toggle(a.id)} aria-pressed={chosen.includes(a.id)}>
              <span className={`pr-agent ${a.master ? "mark" : ""}`}><AgentFace agent={a} size={18} /></span>
              {a.name}{a.master ? " (master)" : ""}
            </button>
          ))}
          {agents.length === 0 && <span className="faint small">No agents in {state.ns} yet. You can assign it later.</span>}
        </div>
      </div>
      <div className="row" style={{ marginTop: 18 }}>
        {existing && <button className="btn ghost danger" onClick={remove}><Trash2 size={13} /> Delete</button>}
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy}>{busy ? "Saving…" : existing ? "Save" : "Create"}</button>
      </div>
    </Modal>
  );
}

const SAMPLE_PROMPTS: Prompt[] = EXAMPLES.map((e, i) => ({ ...e, id: `pr-${i}`, ns: "work", agents: i === 0 ? ["a-reviewer"] : i === 1 ? ["a-coder"] : [], updated_at: "" }));
