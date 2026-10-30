import { useState } from "react";
import { ExternalLink, Plug, Sparkles, Trash2 } from "lucide-react";
import { siGithub } from "simple-icons";
import { uid, useStore, useToast } from "../store";
import { CodeReveal, Field, Modal, ModalActions, PageHead, PrimaryButton, Status, Toggle, useErrors } from "../components/ui";
import { BrandIcon } from "./Auth";
import { lookupSkills, parseRepo, type SkillLookup } from "../github";
import "../styles/integrations.css";

export function Registry() {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const [tab, setTab] = useState<"skills" | "mcps">("skills");
  const [adding, setAdding] = useState(false);
  const usedBy = (field: "skills" | "mcps", id: string) =>
    state.agents.filter((a) => a[field].includes(id)).map((a) => `${a.name}@${a.ns}`);

  const mcpJson = JSON.stringify(
    {
      mcpServers: Object.fromEntries(
        state.mcps.filter((m) => m.enabled).map((m) => [m.name, m.transport === "stdio" ? { command: m.endpoint } : { type: m.transport, url: m.endpoint }]),
      ),
    },
    null,
    2,
  );

  return (
    <>
      <PageHead title="Skills & MCP servers" subtitle="Shared catalog across namespaces. Each agent only gets what you attach to it.">
        {tab === "skills" && <PrimaryButton onClick={() => setAdding(true)} icon={<BrandIcon icon={siGithub} size={14} />}>Add from GitHub</PrimaryButton>}
      </PageHead>

      <div className="ptabs" role="tablist">
        <button role="tab" aria-selected={tab === "skills"} className={`ptab ${tab === "skills" ? "active" : ""}`} onClick={() => setTab("skills")}>
          <Sparkles size={13} /> Skills <span className="ptab-count">{state.skills.length}</span>
        </button>
        <button role="tab" aria-selected={tab === "mcps"} className={`ptab ${tab === "mcps" ? "active" : ""}`} onClick={() => setTab("mcps")}>
          <Plug size={13} /> MCP servers <span className="ptab-count">{state.mcps.length}</span>
        </button>
      </div>

      {tab === "skills" ? (
        <div className="skill-grid">
          {state.skills.map((s) => (
            <div key={s.id} className="card">
              <div className="row">
                <h2 className="clip">{s.name}</h2>
                <span className="badge mono">{/^\d/.test(s.version) ? `v${s.version}` : s.version}</span>
                <span className="spacer" />
                <Toggle on={s.enabled} onChange={() => dispatch({ type: "toggleSkill", id: s.id })} label={`Enable ${s.name}`} />
              </div>
              <p className="dim clamp-3" style={{ margin: "8px 0" }} title={s.description}>{s.description}</p>
              <div className="row dim mono" style={{ fontSize: 11.5, marginBottom: 8, gap: 6 }}>
                {s.url && <BrandIcon icon={siGithub} size={12} />}
                {s.url ? <a href={s.url} target="_blank" rel="noreferrer" className="clip">{s.source}</a> : <span className="clip">{s.source}</span>}
                {s.url && <ExternalLink size={11} />}
                <span className="spacer" />
                <button className="btn ghost sm icon danger" title={`Remove ${s.name}`} onClick={() => { dispatch({ type: "removeSkill", id: s.id }); toast(`Removed ${s.name}`, "warn"); }}><Trash2 size={12} /></button>
              </div>
              <div className="chips">{usedBy("skills", s.id).map((u) => <span key={u} className="badge">{u}</span>)}{usedBy("skills", s.id).length === 0 && <span className="faint small">Not attached to any agent</span>}</div>
            </div>
          ))}
          {state.skills.length === 0 && <div className="empty">No skills yet. Add one from GitHub.</div>}
        </div>
      ) : (
        <>
          <div className="card flush" style={{ marginBottom: 20 }}>
            <table className="table">
              <thead><tr><th>Server</th><th>Transport</th><th>Tools</th><th>Used by</th><th>Health</th><th>Enabled</th></tr></thead>
              <tbody>
                {state.mcps.map((m) => (
                  <tr key={m.id}>
                    <td><strong>{m.name}</strong></td>
                    <td><span className="badge">{m.transport}</span></td>
                    <td>{m.tools}</td>
                    <td className="dim">{usedBy("mcps", m.id).join(", ") || "None"}</td>
                    <td><Status value={m.health} /></td>
                    <td><Toggle on={m.enabled} onChange={() => dispatch({ type: "toggleMcp", id: m.id })} label={`Enable ${m.name}`} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <CodeReveal code={mcpJson} label="generated mcp.json" />
        </>
      )}

      {adding && <AddFromGitHub existing={state.skills.map((s) => s.name)} onClose={() => setAdding(false)} />}
    </>
  );
}

/** Find the skills in a public GitHub repository and add the ones you pick, pinned to a commit. */
function AddFromGitHub({ existing, onClose }: { existing: string[]; onClose: () => void }) {
  const { dispatch } = useStore();
  const toast = useToast();
  const [repo, setRepo] = useState("");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<SkillLookup | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const { errors, check, clear } = useErrors();

  const look = () => {
    const parsed = parseRepo(repo, ref);
    if (!check({ repo: parsed ? undefined : "Use owner/repo, owner/repo/folder or a github.com link." }) || !parsed) return;
    setBusy(true);
    setFound(null);
    lookupSkills(parsed)
      .then((r) => {
        if (r.skills.length === 0) return void check({ repo: `No SKILL.md found in ${parsed.owner}/${parsed.repo}${parsed.path ? `/${parsed.path}` : ""} at ${r.ref}.` });
        setFound(r);
        // One skill, or the folder the link pointed at: pick it for them.
        setPicked(r.skills.length === 1 ? [r.skills[0].path] : r.skills.filter((s) => parsed.path && s.path === parsed.path).map((s) => s.path));
      })
      .catch((e) => check({ repo: e instanceof Error ? e.message : String(e) }))
      .finally(() => setBusy(false));
  };

  const add = () => {
    if (!found) return look();
    const chosen = found.skills.filter((s) => picked.includes(s.path));
    const clash = chosen.find((s) => existing.includes(s.name));
    if (!check({ pick: chosen.length ? (clash ? `A skill called ${clash.name} is already installed.` : undefined) : "Pick at least one skill." })) return;
    const short = found.sha.slice(0, 7);
    for (const s of chosen) {
      const where = `${found.owner}/${found.repo}${s.path ? `/${s.path}` : ""}`;
      dispatch({
        type: "addSkill",
        skill: {
          id: uid("sk"), name: s.name, description: s.description || "No description in SKILL.md", enabled: true,
          version: found.ref === short ? short : `${found.ref} (${short})`,
          source: `github.com/${where}`,
          url: `https://github.com/${found.owner}/${found.repo}/tree/${found.sha}${s.path ? `/${s.path}` : ""}`,
        },
      });
    }
    toast(`Added ${chosen.length === 1 ? chosen[0].name : `${chosen.length} skills`} from ${found.owner}/${found.repo}`);
    onClose();
  };

  const toggle = (p: string) => { setPicked(picked.includes(p) ? picked.filter((x) => x !== p) : [...picked, p]); clear("pick"); };

  return (
    <Modal title="Add skills from GitHub" subtitle="Reads SKILL.md from a public repository and pins it to an exact commit." onClose={onClose}>
      <div className="field-row">
        <Field label="Repository" error={errors.repo} hint="owner/repo, a subfolder, or a github.com link.">
          <input
            className="input mono"
            autoFocus
            value={repo}
            placeholder="anthropics/skills"
            onChange={(e) => { setRepo(e.target.value); setFound(null); clear("repo"); }}
            onKeyDown={(e) => e.key === "Enter" && look()}
          />
        </Field>
        <Field label="Version (optional)" hint="Tag, branch or commit. Latest release by default.">
          <input className="input mono" value={ref} placeholder="latest" onChange={(e) => { setRef(e.target.value); setFound(null); }} onKeyDown={(e) => e.key === "Enter" && look()} />
        </Field>
      </div>

      {busy && <div className="faint small">Looking in {repo.trim()}…</div>}

      {found && (
        <div>
          <div className="row small" style={{ marginBottom: 8 }}>
            <span className="dim">{found.skills.length} skill{found.skills.length === 1 ? "" : "s"} at</span>
            <span className="badge mono">{found.ref} · {found.sha.slice(0, 7)}</span>
            <span className="spacer" />
            {found.skills.length > 1 && (
              <button className="btn ghost sm" onClick={() => setPicked(picked.length === found.skills.length ? [] : found.skills.map((s) => s.path))}>
                {picked.length === found.skills.length ? "Clear" : "Select all"}
              </button>
            )}
          </div>
          <div style={{ maxHeight: 280, overflow: "auto", margin: "0 -4px" }}>
            {found.skills.map((s) => (
              <label key={s.path} className="list-row" style={{ cursor: "pointer", padding: "8px 4px", alignItems: "flex-start" }}>
                <input type="checkbox" checked={picked.includes(s.path)} onChange={() => toggle(s.path)} style={{ accentColor: "var(--accent)", marginTop: 3 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <strong style={{ fontWeight: 500 }}>{s.name}</strong>
                    {existing.includes(s.name) && <span className="badge">installed</span>}
                    <span className="faint small mono clip">{s.path || "/"}</span>
                  </div>
                  {s.description && <div className="dim small clamp-2" style={{ marginTop: 2 }} title={s.description}>{s.description}</div>}
                </div>
              </label>
            ))}
          </div>
          {errors.pick && <span className="field-error" role="alert">{errors.pick}</span>}
        </div>
      )}

      <ModalActions onCancel={onClose} onConfirm={add} confirm={!found ? (busy ? "Looking…" : "Look up") : picked.length > 1 ? `Add ${picked.length} skills` : "Add skill"} />
    </Modal>
  );
}
