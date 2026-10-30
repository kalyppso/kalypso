import { useState } from "react";
import { ArrowLeft, Brain, ChevronRight, FolderOpen, Hash, LifeBuoy, Plus, RefreshCw, Trash2, Webhook, type LucideIcon } from "lucide-react";
import {
  siAsana, siConfluence, siGithub, siGitlab, siGoogledrive, siJira, siLinear, siLogseq, siModelcontextprotocol, siNotion, siObsidian, siZendesk,
  type SimpleIcon,
} from "simple-icons";
import { luminance } from "../appearance";
import { uid, useNamespaced, useStore, useToast } from "../store";
import { CodeReveal, Field, Modal, ModalActions, PageHead, Status, Toggle, useErrors } from "../components/ui";
import "../styles/integrations.css";
import type { Integration, IntegrationKind } from "../types";

interface KindDef {
  kind: IntegrationKind;
  label: string;
  glyph: string;
  group: "Notes and wikis" | "Ticketing" | "Work tools" | "Anything else";
  ticketing?: { projectLabel: string; projectPlaceholder: string };
  blurb: string;
  targetLabel: string;
  placeholder: string;
  token: boolean;
  brain: boolean;
  via: string;
}

export const KINDS: KindDef[] = [
  { kind: "obsidian", label: "Obsidian", glyph: "Ob", group: "Notes and wikis", blurb: "Your vault as agent memory", targetLabel: "Vault folder", placeholder: "~/Documents/Obsidian/Brain", token: false, brain: true, via: "vault mounted read/write + Local REST API plugin" },
  { kind: "notion", label: "Notion", glyph: "N", group: "Notes and wikis", blurb: "Pages & databases", targetLabel: "Workspace or page URL", placeholder: "notion.so/acme/wiki", token: true, brain: true, via: "Notion MCP server" },
  { kind: "logseq", label: "Logseq", glyph: "Lq", group: "Notes and wikis", blurb: "Outliner graph", targetLabel: "Graph folder", placeholder: "~/logseq/graph", token: false, brain: true, via: "graph folder mount" },
  { kind: "confluence", label: "Confluence", glyph: "Cf", group: "Notes and wikis", blurb: "Team wiki spaces", targetLabel: "Site URL", placeholder: "acme.atlassian.net/wiki", token: true, brain: true, via: "Atlassian MCP server" },
  { kind: "gdrive", label: "Google Drive", glyph: "Dr", group: "Notes and wikis", blurb: "Docs, sheets & folders", targetLabel: "Folder URL", placeholder: "drive.google.com/drive/folders/…", token: true, brain: true, via: "Google Drive MCP server" },
  { kind: "jira", label: "Jira", glyph: "Ji", group: "Ticketing", blurb: "Issues, sprints, service desk", targetLabel: "Site URL", placeholder: "acme.atlassian.net", token: true, brain: false, via: "Atlassian MCP server", ticketing: { projectLabel: "Project key", projectPlaceholder: "ENG" } },
  { kind: "linear", label: "Linear", glyph: "Li", group: "Ticketing", blurb: "Issues & projects", targetLabel: "Workspace URL", placeholder: "linear.app/acme", token: true, brain: false, via: "Linear MCP server", ticketing: { projectLabel: "Team key", projectPlaceholder: "ENG" } },
  { kind: "github-issues", label: "GitHub Issues", glyph: "GI", group: "Ticketing", blurb: "Issues in any repository", targetLabel: "Repository", placeholder: "github.com/acme/platform", token: true, brain: false, via: "GitHub MCP server", ticketing: { projectLabel: "Milestone or project", projectPlaceholder: "Optional" } },
  { kind: "gitlab-issues", label: "GitLab Issues", glyph: "GL", group: "Ticketing", blurb: "Issues and boards", targetLabel: "Project URL", placeholder: "gitlab.com/acme/infra", token: true, brain: false, via: "GitLab MCP server", ticketing: { projectLabel: "Board or milestone", projectPlaceholder: "Optional" } },
  { kind: "servicenow", label: "ServiceNow", glyph: "SN", group: "Ticketing", blurb: "Incidents and requests", targetLabel: "Instance URL", placeholder: "acme.service-now.com", token: true, brain: false, via: "ServiceNow REST API", ticketing: { projectLabel: "Assignment group", projectPlaceholder: "Platform Ops" } },
  { kind: "zendesk", label: "Zendesk", glyph: "Zd", group: "Ticketing", blurb: "Support tickets", targetLabel: "Subdomain", placeholder: "acme.zendesk.com", token: true, brain: false, via: "Zendesk REST API", ticketing: { projectLabel: "Group or view", projectPlaceholder: "Tier 1" } },
  { kind: "asana", label: "Asana", glyph: "As", group: "Ticketing", blurb: "Tasks and projects", targetLabel: "Workspace", placeholder: "app.asana.com/0/acme", token: true, brain: false, via: "Asana MCP server", ticketing: { projectLabel: "Project", projectPlaceholder: "Platform" } },
  { kind: "github", label: "GitHub", glyph: "GH", group: "Work tools", blurb: "Repos, issues, PRs", targetLabel: "Repository", placeholder: "github.com/acme/platform", token: true, brain: false, via: "GitHub MCP server" },
  { kind: "slack", label: "Slack", glyph: "Sl", group: "Work tools", blurb: "Channels & threads", targetLabel: "Channel", placeholder: "acme.slack.com/#deploys", token: true, brain: false, via: "Slack MCP server" },
  { kind: "mcp", label: "Any MCP server", glyph: "MCP", group: "Anything else", blurb: "stdio, HTTP or SSE", targetLabel: "Command or URL", placeholder: "npx my-mcp-server or https://host/mcp", token: false, brain: false, via: "MCP" },
  { kind: "rest", label: "REST / webhook", glyph: "API", group: "Anything else", blurb: "Wrap any HTTP API as tools", targetLabel: "Base URL", placeholder: "https://api.example.com/v1", token: true, brain: false, via: "KALYPSO REST→MCP bridge (OpenAPI)" },
  { kind: "folder", label: "Local folder", glyph: "Fd", group: "Anything else", blurb: "Notes, docs, any files", targetLabel: "Folder path", placeholder: "~/notes", token: false, brain: true, via: "read-only folder mount + local index" },
];

export const kindDef = (k: IntegrationKind) => KINDS.find((d) => d.kind === k)!;

// Brand marks from simple-icons. Slack and ServiceNow asked to be removed from it,
// so they get a neutral icon rather than a hand-drawn copy of their logo.
const BRANDS: Partial<Record<IntegrationKind, SimpleIcon>> = {
  obsidian: siObsidian, notion: siNotion, logseq: siLogseq, confluence: siConfluence, gdrive: siGoogledrive,
  jira: siJira, linear: siLinear, "github-issues": siGithub, "gitlab-issues": siGitlab, zendesk: siZendesk, asana: siAsana,
  github: siGithub, mcp: siModelcontextprotocol,
};
const NEUTRAL: Partial<Record<IntegrationKind, LucideIcon>> = { slack: Hash, servicenow: LifeBuoy, rest: Webhook, folder: FolderOpen };

/** Near-black and near-white marks follow the theme's text colour so they stay visible. */
const brandFill = (hex: string) => {
  const l = luminance(`#${hex}`);
  return l < 0.04 || l > 0.8 ? "currentColor" : `#${hex}`;
};

export function Logo({ kind, size = 18 }: { kind: IntegrationKind; size?: number }) {
  const brand = BRANDS[kind];
  const Icon = NEUTRAL[kind];
  const box = Math.round(size * 1.8);
  return (
    <span className="logo" style={{ width: box, height: box }} aria-hidden>
      {brand ? (
        <svg viewBox="0 0 24 24" width={size} height={size} fill={brandFill(brand.hex)} role="img" aria-label={brand.title}><path d={brand.path} /></svg>
      ) : Icon ? (
        <Icon size={size} strokeWidth={1.75} />
      ) : (
        <span style={{ fontSize: 11 }}>{kindDef(kind).glyph}</span>
      )}
    </span>
  );
}

function configFor(i: Integration) {
  const d = kindDef(i.kind);
  return [
    `# ${i.name} → exposed to agents as MCP server "${i.kind}-${i.id.slice(-4)}"`,
    `integration: ${i.kind}`,
    `via: ${d.via}`,
    `target: ${i.target}`,
    `access: ${i.access}`,
    `memory: ${i.brain ? "enabled  # agents may read and write long-term notes here" : "disabled"}`,
    i.secretId ? `auth: secret://${i.secretId}` : "auth: none",
    `agents: [${i.agents.join(", ")}]`,
  ].join("\n");
}

type Group = KindDef["group"];
const GROUPS = [...new Set(KINDS.map((k) => k.group))] as Group[];

function syncLine(i: Integration) {
  const scope = i.ticketing
    ? `${i.ticketing.project || "All projects"}${i.ticketing.label ? `, label "${i.ticketing.label}"` : ""}, ${i.ticketing.twoWay ? "two-way sync" : "import only"}. `
    : `${i.access === "read" ? "Read only" : "Read and write"}. `;
  return scope + (i.status === "syncing" ? "Syncing now" : i.status === "error" ? `Error: ${i.lastSync}` : `Synced ${i.lastSync}`);
}

export function Integrations() {
  const { integrations } = useNamespaced();
  const [tab, setTab] = useState<"connected" | "browse">(integrations.length ? "connected" : "browse");
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState<IntegrationKind | null>(null);
  const open = integrations.find((i) => i.id === openId);

  return (
    <>
      <PageHead title="Integrations" subtitle="Connect the tools you already use. Mark a notes app or wiki as a brain and agents can use it as shared long-term memory." />

      {open ? (
        <IntegrationDetail i={open} onBack={() => setOpenId(null)} />
      ) : (
        <>
          <div className="ptabs" role="tablist">
            <button role="tab" aria-selected={tab === "connected"} className={`ptab ${tab === "connected" ? "active" : ""}`} onClick={() => setTab("connected")}>
              Connected <span className="ptab-count">{integrations.length}</span>
            </button>
            <button role="tab" aria-selected={tab === "browse"} className={`ptab ${tab === "browse" ? "active" : ""}`} onClick={() => setTab("browse")}>
              Add an integration
            </button>
          </div>

          {tab === "connected" ? (
            integrations.length === 0 ? (
              <div className="empty">Nothing connected yet. Pick a tool under Add an integration.</div>
            ) : (
              <div className="rows">
                {integrations.map((i) => (
                  <button key={i.id} className="row-link" onClick={() => setOpenId(i.id)}>
                    <Logo kind={i.kind} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="clip"><strong style={{ fontWeight: 500 }}>{i.name}</strong> <span className="faint">{kindDef(i.kind).label}</span></div>
                      <div className="mono faint small clip">{i.target}</div>
                    </div>
                    {i.brain && <span className="badge accent" title="Agents use this as long-term memory"><Brain size={11} /> brain</span>}
                    <span className="faint small" style={{ minWidth: 70, textAlign: "right" }}>{i.agents.length} agent{i.agents.length === 1 ? "" : "s"}</span>
                    <Status value={i.status} />
                    <ChevronRight size={14} className="chev" />
                  </button>
                ))}
              </div>
            )
          ) : (
            <div className="logo-wall">
              {GROUPS.map((g) => (
                <section key={g}>
                  <div className="section-title">{g}</div>
                  <div className="logo-grid">
                    {KINDS.filter((k) => k.group === g).map((k) => {
                      const connected = integrations.filter((i) => i.kind === k.kind).length;
                      return (
                        <button key={k.kind} className="logo-tile" onClick={() => setAdding(k.kind)} title={`${k.label}: ${k.blurb}`}>
                          <Logo kind={k.kind} size={26} />
                          <span className="logo-tile-name">{k.label}</span>
                          <span className="faint small clip">{connected ? `${connected} connected` : k.blurb}</span>
                          <Plus size={13} className="logo-tile-add" />
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}

      {adding && <AddIntegration kind={adding} onClose={() => setAdding(null)} onAdded={(id) => { setTab("connected"); setOpenId(id); }} />}
    </>
  );
}

function IntegrationDetail({ i, onBack }: { i: Integration; onBack: () => void }) {
  const { dispatch } = useStore();
  const toast = useToast();
  const { agents } = useNamespaced();
  return (
    <>
      <button className="btn ghost sm back" onClick={onBack}><ArrowLeft size={13} /> All integrations</button>
      <div className="detail">
        <div className="row">
          <Logo kind={i.kind} />
          <div style={{ minWidth: 0 }}>
            <h2>{i.name} <span className="faint" style={{ fontWeight: 400 }}>{kindDef(i.kind).label}</span></h2>
            <div className="mono faint clip">{i.target}</div>
          </div>
          <span className="spacer" />
          <Status value={i.status} />
        </div>
        <div className="faint small">{syncLine(i)}</div>
        <div className="row">
          <div>
            <div>Use as a brain</div>
            <div className="faint small">Agents can recall from and write notes to it as shared long-term memory.</div>
          </div>
          <span className="spacer" />
          <Toggle on={i.brain} onChange={() => dispatch({ type: "toggleBrain", id: i.id })} label="Use as brain" />
        </div>
        <div className="detail-section">
          <div className="detail-label">Agents with access</div>
          <div className="chips">
            {agents.map((a) => (
              <button key={a.id} className={`btn sm ${i.agents.includes(a.id) ? "on" : ""}`} aria-pressed={i.agents.includes(a.id)} onClick={() => dispatch({ type: "toggleIntegrationAgent", id: i.id, agentId: a.id })}>
                {a.name}
              </button>
            ))}
            {agents.length === 0 && <span className="faint">No agents in this namespace.</span>}
          </div>
        </div>
        <CodeReveal code={configFor(i)} label="connector config" />
        <div className="row">
          <button className="btn sm" onClick={() => toast(`Re-syncing ${i.name}…`, "info")}><RefreshCw size={12} /> Sync now</button>
          <span className="spacer" />
          <button className="btn sm danger" onClick={() => { dispatch({ type: "removeIntegration", id: i.id }); toast(`Disconnected ${i.name}`, "warn"); onBack(); }}><Trash2 size={12} /> Disconnect</button>
        </div>
      </div>
    </>
  );
}

// Loose host[/path] check for targets that are URLs; the scheme is optional except for raw HTTP APIs.
const HOST = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/i;
function targetError(d: KindDef, target: string) {
  const t = target.trim();
  if (!t) return `${d.targetLabel} is required.`;
  if (d.kind === "rest" && !/^https?:\/\//i.test(t)) return "Start the base URL with http:// or https://.";
  if (/URL|Site|Subdomain|Repository|Workspace$/.test(d.targetLabel) && !HOST.test(t)) return `That doesn't look like a valid address, e.g. ${d.placeholder}.`;
  return undefined;
}

function AddIntegration({ kind, onClose, onAdded }: { kind: IntegrationKind; onClose: () => void; onAdded: (id: string) => void }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { agents, secrets } = useNamespaced();
  const d = kindDef(kind);
  const [name, setName] = useState(kind === "obsidian" ? "My Vault" : "");
  const [target, setTarget] = useState("");
  const [access, setAccess] = useState<Integration["access"]>(d.brain ? "read-write" : "read");
  const [brain, setBrain] = useState(d.brain);
  const [secretId, setSecretId] = useState<string>("");
  const [token, setToken] = useState("");
  const [granted, setGranted] = useState<string[]>(agents.map((a) => a.id));
  const [project, setProject] = useState("");
  const [label, setLabel] = useState("agent");
  const [twoWay, setTwoWay] = useState(true);
  const { errors, check, clear } = useErrors();
  const projectRequired = !!d.ticketing && d.ticketing.projectPlaceholder !== "Optional";

  const connect = () => {
    const ok = check({
      target: targetError(d, target),
      token: d.token && !secretId && !token.trim() ? "Paste a token or pick a stored credential." : undefined,
      project: projectRequired && !project.trim() ? `${d.ticketing!.projectLabel} is required.` : undefined,
    });
    if (!ok) return;
    let sid: string | null = secretId || null;
    if (d.token && !sid && token) {
      sid = uid("s");
      dispatch({ type: "addSecret", secret: { id: sid, ns: state.ns, key: `${kind.toUpperCase()}_TOKEN`, value: token, scope: "agent", updatedAt: new Date().toISOString().slice(0, 10) } });
    }
    const id = uid("i");
    dispatch({
      type: "addIntegration",
      integration: {
        id, ns: state.ns, kind, name: name.trim() || d.label, target: target.trim(), access, brain, secretId: sid,
        agents: granted, status: "connected", lastSync: "just now",
        ticketing: d.ticketing ? { project: project.trim(), label: label.trim(), twoWay } : undefined,
      },
    });
    toast(`Connected ${d.label}`);
    onClose();
    onAdded(id);
  };

  return (
    <Modal title={`Connect ${d.label}`} subtitle={`Connected via ${d.via}.`} onClose={onClose}>
      <div className="field-row">
        <label className="field">Display name<input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={d.label} /></label>
        <label className="field">Access
          <select className="select" value={access} onChange={(e) => setAccess(e.target.value as Integration["access"])}>
            <option value="read">Read only</option><option value="read-write">Read & write</option>
          </select>
        </label>
      </div>
      <Field label={d.targetLabel} error={errors.target}>
        <input className="input mono" value={target} onChange={(e) => { setTarget(e.target.value); clear("target"); }} placeholder={d.placeholder} />
      </Field>
      {d.token && (
        <div className="field-row">
          <label className="field">Credential
            <select className="select" value={secretId} onChange={(e) => { setSecretId(e.target.value); clear("token"); }}>
              <option value="">New token…</option>
              {secrets.map((s) => <option key={s.id} value={s.id}>{s.key}</option>)}
            </select>
          </label>
          {!secretId && (
            <Field label="Token" error={errors.token}>
              <input className="input mono" type="password" value={token} onChange={(e) => { setToken(e.target.value); clear("token"); }} placeholder="stored in the vault" />
            </Field>
          )}
        </div>
      )}
      <div className="row">
        <div>
          <div style={{ color: "var(--text)" }}>Use as a brain</div>
          <div className="faint small">Agents can recall from and write notes to it as shared long-term memory.</div>
        </div>
        <span className="spacer" />
        <Toggle on={brain} onChange={setBrain} label="Use as brain" />
      </div>
      {d.ticketing && (
        <>
          <div className="field-row">
            <Field label={d.ticketing.projectLabel} error={errors.project}>
              <input className="input" value={project} onChange={(e) => { setProject(e.target.value); clear("project"); }} placeholder={d.ticketing.projectPlaceholder} />
            </Field>
            <label className="field">Only tickets labelled<input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Empty: every ticket assigned to an agent" /></label>
          </div>
          <div className="row">
            <div>
              <div style={{ color: "var(--text)" }}>Sync status back to {d.label}</div>
              <div className="faint small">Moving a task in the Tracker moves its ticket, and comments name the agent.</div>
            </div>
            <span className="spacer" />
            <Toggle on={twoWay} onChange={setTwoWay} label="Two-way sync" />
          </div>
        </>
      )}
      <div className="field">Agents with access
        <div className="chips">
          {agents.map((a) => (
            <button key={a.id} className={`btn sm ${granted.includes(a.id) ? "on" : ""}`} onClick={() => setGranted(granted.includes(a.id) ? granted.filter((x) => x !== a.id) : [...granted, a.id])}>{a.name}</button>
          ))}
        </div>
      </div>
      <ModalActions onCancel={onClose} onConfirm={connect} confirm="Connect" />
    </Modal>
  );
}
