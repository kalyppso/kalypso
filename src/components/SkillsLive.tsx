import { useEffect, useRef, useState } from "react";
import { Pencil, Plus, Sparkles, Trash2, Upload } from "lucide-react";
import { api, errorMessage } from "../backend";
import type { Skill } from "../bindings/Skill";
import { useNamespaced, useStore, useToast } from "../store";
import { EmptyState, Field, Modal, ModalActions, Skeleton, Toggle } from "./ui";

/**
 * Skills in the desktop app (#24): a SKILL.md (what to do, and when) that agents pick up when
 * they next start. Give one to every agent, chosen agents (also from each agent's page), or
 * kalypso only. Skill files are readable by the agent: never put secrets in them.
 */
export function SkillsLive() {
  const { state } = useStore();
  const toast = useToast();
  const { agents } = useNamespaced();
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [editing, setEditing] = useState<Skill | "new" | null>(null);
  const load = () => api.skillList(state.ns).then(setSkills).catch((e) => { setSkills([]); toast(errorMessage(e), "err"); });
  useEffect(() => { load(); }, [state.ns]);
  const who = (s: Skill) => (s.scope === "all" ? "Every agent" : s.scope === "master" ? "kalypso only" : agents.filter((a) => s.agents.includes(a.id)).map((a) => a.name).join(", ") || "No agents yet");
  const save = (s: Skill, patch: Partial<Skill>, done: string) =>
    api.skillSave(state.ns, { ...s, ...patch, id: s.id }).then(() => { toast(done); load(); }).catch((e) => toast(errorMessage(e), "err"));
  const remove = (s: Skill) => {
    if (!confirm(`Remove ${s.name}? Agents lose it when they next start.`)) return;
    api.skillDelete(state.ns, s.id).then(() => { toast(`Removed ${s.name}`, "warn"); load(); }).catch((e) => toast(errorMessage(e), "err"));
  };

  if (!skills) return <Skeleton rows={3} />;
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <p className="dim" style={{ margin: 0, flex: 1 }}>Skills teach agents how to do a job. Give them here or from an agent's page; agents pick them up when they next start.</p>
        <button className="btn primary" onClick={() => setEditing("new")}><Plus size={14} /> Add skill</button>
      </div>
      {skills.length === 0 ? (
        <EmptyState icon={Sparkles} title="No skills yet" action={<button className="btn primary sm" onClick={() => setEditing("new")}><Plus size={13} /> Add one</button>}>
          Paste or upload a SKILL.md: what to do, and when to use it.
        </EmptyState>
      ) : (
        <div className="skill-grid">
          {skills.map((s) => (
            <div key={s.id} className="card">
              <div className="row">
                <h2 className="clip">{s.name}</h2>
                <span className="spacer" />
                <Toggle on={s.enabled} onChange={() => save(s, { enabled: !s.enabled }, `${s.name} ${s.enabled ? "off" : "on"}`)} label={`Turn ${s.name} ${s.enabled ? "off" : "on"}`} />
              </div>
              <p className="dim clamp-3" style={{ margin: "8px 0" }} title={s.description}>{s.description}</p>
              <div className="row small" style={{ gap: 6 }}>
                <span className="faint clip">{who(s)}</span>
                <span className="spacer" />
                <button className="btn ghost sm icon" title={`Edit ${s.name}`} onClick={() => setEditing(s)}><Pencil size={12} /></button>
                <button className="btn ghost sm icon danger" title={`Remove ${s.name}`} onClick={() => remove(s)}><Trash2 size={12} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && <SkillForm skill={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={load} />}
    </>
  );
}

function SkillForm({ skill, onClose, onSaved }: { skill: Skill | null; onClose: () => void; onSaved: () => void }) {
  const { state } = useStore();
  const toast = useToast();
  const crew = useNamespaced().agents.filter((a) => !a.master);
  const [content, setContent] = useState(skill?.content ?? "");
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [source, setSource] = useState(skill?.source ?? "");
  const [scope, setScope] = useState(skill?.scope ?? "chosen");
  const [chosen, setChosen] = useState<string[]>(skill?.agents ?? []);
  const file = useRef<HTMLInputElement>(null);

  // Name and description come from the SKILL.md's front matter when it has one.
  const fill = (text: string) => {
    setContent(text);
    const fm = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, "\n"))?.[1] ?? "";
    const get = (k: string) => new RegExp(`^${k}:\\s*["']?(.+?)["']?\\s*$`, "m").exec(fm)?.[1];
    if (get("name") && !name) setName(get("name")!);
    if (get("description") && !description) setDescription(get("description")!);
  };
  const upload = (f: File | undefined) => {
    if (!f) return;
    f.text().then((t) => { fill(t); setSource(f.name); }).catch((e) => toast(errorMessage(e), "err"));
  };
  const save = async () => {
    try {
      await api.skillSave(state.ns, { id: skill?.id, name: name.trim() || undefined, description: description.trim() || undefined, content, source, scope, agents: scope === "chosen" ? chosen : [], enabled: skill?.enabled ?? true });
      toast(`${name.trim() || "Skill"} saved. Agents get it when they next start.`);
      onSaved();
      onClose();
    } catch (e) {
      toast(errorMessage(e), "err");
    }
  };

  return (
    <Modal title={skill ? `Edit ${skill.name}` : "Add skill"} subtitle="A SKILL.md: what to do, and when. Agents can read its files, so never put secrets in it." onClose={onClose} wide>
      <Field label="SKILL.md" hint={<>Paste it, or <button className="link" onClick={() => file.current?.click()}><Upload size={11} /> upload the file</button>.</>}>
        <textarea className="input mono" rows={10} value={content} onChange={(e) => fill(e.target.value)} placeholder={"---\nname: release-notes\ndescription: Write release notes from merged pull requests\n---\n\n# Release notes\n…"} />
        <input ref={file} type="file" accept=".md,text/markdown,text/plain" hidden onChange={(e) => upload(e.target.files?.[0])} />
      </Field>
      <div className="field-row">
        <Field label="Name" hint="From the file when it has one.">
          <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="release-notes" />
        </Field>
        <Field label="When to use it" hint="Agents decide from this.">
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Write release notes from merged pull requests" />
        </Field>
      </div>
      <div className="field" role="group" aria-labelledby="skill-who">
        <span id="skill-who">Who gets it</span>
        <div className="row" style={{ gap: 14 }}>
          {([["chosen", "Chosen agents"], ["all", "Every agent"], ["master", "kalypso only"]] as const).map(([v, label]) => (
            <label key={v} className="row" style={{ gap: 6 }}><input type="radio" name="skill-scope" checked={scope === v} onChange={() => setScope(v)} /> {label}</label>
          ))}
        </div>
        {scope === "chosen" && (
          <div className="grant-list">
            {crew.length === 0 && <span className="faint small">No agents yet. You can give it from an agent's page later.</span>}
            {crew.map((a) => (
              <label key={a.id} className="grant-item">
                <input type="checkbox" checked={chosen.includes(a.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, a.id] : chosen.filter((x) => x !== a.id))} />
                <span>{a.name}</span>
                <span className="faint small clip">{a.role}</span>
              </label>
            ))}
          </div>
        )}
      </div>
      <ModalActions onCancel={onClose} onConfirm={save} confirm="Save" />
    </Modal>
  );
}
