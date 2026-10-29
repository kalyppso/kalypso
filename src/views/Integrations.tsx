import { useState } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { uid, useNamespaced, useStore, useToast } from "../store";
import { CodeReveal, Modal, ModalActions, PageHead, Status, Toggle } from "../components/ui";
import type { Integration, IntegrationKind } from "../types";

interface KindDef {
  kind: IntegrationKind;
  label: string;
  glyph: string;
  group: "Notes and wikis" | "Work tools" | "Anything else";
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
  { kind: "github", label: "GitHub", glyph: "GH", group: "Work tools", blurb: "Repos, issues, PRs", targetLabel: "Repository", placeholder: "github.com/acme/platform", token: true, brain: false, via: "GitHub MCP server" },
  { kind: "linear", label: "Linear", glyph: "Li", group: "Work tools", blurb: "Issues & projects", targetLabel: "Team URL", placeholder: "linear.app/acme/team/ENG", token: true, brain: false, via: "Linear MCP server" },
  { kind: "slack", label: "Slack", glyph: "Sl", group: "Work tools", blurb: "Channels & threads", targetLabel: "Channel", placeholder: "acme.slack.com/#deploys", token: true, brain: false, via: "Slack MCP server" },
  { kind: "mcp", label: "Any MCP server", glyph: "MCP", group: "Anything else", blurb: "stdio, HTTP or SSE", targetLabel: "Command or URL", placeholder: "npx my-mcp-server or https://host/mcp", token: false, brain: false, via: "MCP" },
  { kind: "rest", label: "REST / webhook", glyph: "API", group: "Anything else", blurb: "Wrap any HTTP API as tools", targetLabel: "Base URL", placeholder: "https://api.example.com/v1", token: true, brain: false, via: "KALYPSO REST→MCP bridge (OpenAPI)" },
  { kind: "folder", label: "Local folder", glyph: "Fd", group: "Anything else", blurb: "Notes, docs, any files", targetLabel: "Folder path", placeholder: "~/notes", token: false, brain: true, via: "read-only folder mount + local index" },
];

export const kindDef = (k: IntegrationKind) => KINDS.find((d) => d.kind === k)!;

export function Logo({ kind }: { kind: IntegrationKind }) {
  const d = kindDef(kind);
  return <span className="logo" style={{ fontSize: d.glyph.length > 2 ? 10 : 12 }}>{d.glyph}</span>;
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

export function Integrations() {
  const { dispatch } = useStore();
  const toast = useToast();
  const { integrations, agents } = useNamespaced();
  const [adding, setAdding] = useState<IntegrationKind | null>(null);
  const groups = [...new Set(KINDS.map((k) => k.group))];

  return (
    <>
      <PageHead title="Integrations" subtitle="Connect the tools you already use. Mark a notes app or wiki as a brain and agents can use it as shared long-term memory.">
      </PageHead>

      {integrations.length > 0 && (
        <div className="grid cols-2" style={{ marginBottom: 32 }}>
          {integrations.map((i) => (
            <div key={i.id} className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="row">
                <Logo kind={i.kind} />
                <div style={{ minWidth: 0 }}>
                  <h2>{i.name} <span className="faint" style={{ fontWeight: 400 }}>{kindDef(i.kind).label}</span></h2>
                  <div className="mono faint" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.target}</div>
                </div>
                <span className="spacer" />
                <Status value={i.status} />
              </div>
              <div className="row" style={{ flexWrap: "wrap" }}>
                <span className="faint small">{i.access === "read" ? "Read only" : "Read and write"}. {i.status === "syncing" ? "Syncing now" : i.status === "error" ? `Error: ${i.lastSync}` : `Synced ${i.lastSync}`}</span>
                <span className="spacer" />
                <label className="row small dim" style={{ cursor: "pointer" }}>
                  Brain
                  <Toggle on={i.brain} onChange={() => dispatch({ type: "toggleBrain", id: i.id })} label="Use as brain" />
                </label>
              </div>
              <div>
                <div className="faint small" style={{ marginBottom: 6 }}>Agents with access</div>
                <div className="chips">
                  {agents.map((a) => (
                    <button key={a.id} className={`btn sm ${i.agents.includes(a.id) ? "on" : ""}`} onClick={() => dispatch({ type: "toggleIntegrationAgent", id: i.id, agentId: a.id })}>
                      {a.name}
                    </button>
                  ))}
                  {agents.length === 0 && <span className="faint">No agents in this namespace.</span>}
                </div>
              </div>
              <div className="row">
                <button className="btn sm" onClick={() => toast(`Re-syncing ${i.name}…`, "info")}><RefreshCw size={12} /> Sync now</button>
                <span className="spacer" />
                <button className="btn sm danger" onClick={() => { dispatch({ type: "removeIntegration", id: i.id }); toast(`Disconnected ${i.name}`, "warn"); }}><Trash2 size={12} /> Disconnect</button>
              </div>
              <CodeReveal code={configFor(i)} label="connector config" />
            </div>
          ))}
        </div>
      )}

      {groups.map((g) => (
        <div key={g} style={{ marginBottom: 24 }}>
          <div className="section-title">{g}</div>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 8 }}>
            {KINDS.filter((k) => k.group === g).map((k) => (
              <button key={k.kind} className="tile" onClick={() => setAdding(k.kind)}>
                <Logo kind={k.kind} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 500 }}>{k.label}</div>
                  <div className="faint small">{k.blurb}</div>
                </div>
                <span className="spacer" />
                <Plus size={14} className="faint" />
              </button>
            ))}
          </div>
        </div>
      ))}

      {adding && <AddIntegration kind={adding} onClose={() => setAdding(null)} />}
    </>
  );
}

function AddIntegration({ kind, onClose }: { kind: IntegrationKind; onClose: () => void }) {
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

  const connect = () => {
    if (!target.trim()) return;
    let sid: string | null = secretId || null;
    if (d.token && !sid && token) {
      sid = uid("s");
      dispatch({ type: "addSecret", secret: { id: sid, ns: state.ns, key: `${kind.toUpperCase()}_TOKEN`, value: token, scope: "agent", updatedAt: new Date().toISOString().slice(0, 10) } });
    }
    dispatch({
      type: "addIntegration",
      integration: {
        id: uid("i"), ns: state.ns, kind, name: name.trim() || d.label, target: target.trim(), access, brain, secretId: sid,
        agents: granted, status: "connected", lastSync: "just now",
      },
    });
    toast(`Connected ${d.label}`);
    onClose();
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
      <label className="field">{d.targetLabel}<input className="input mono" value={target} onChange={(e) => setTarget(e.target.value)} placeholder={d.placeholder} /></label>
      {d.token && (
        <div className="field-row">
          <label className="field">Credential
            <select className="select" value={secretId} onChange={(e) => setSecretId(e.target.value)}>
              <option value="">New token…</option>
              {secrets.map((s) => <option key={s.id} value={s.id}>{s.key}</option>)}
            </select>
          </label>
          {!secretId && <label className="field">Token<input className="input mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="stored in the vault" /></label>}
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
