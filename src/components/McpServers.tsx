import { useEffect, useState } from "react";
import { Pencil, Plug, Plus, Trash2, X } from "lucide-react";
import { api, errorMessage } from "../backend";
import type { McpServer } from "../bindings/McpServer";
import type { McpValue } from "../bindings/McpValue";
import { useNamespaced, useStore, useToast } from "../store";
import { EmptyState, Field, Modal, ModalActions, Skeleton, Toggle, useErrors } from "./ui";

/**
 * MCP servers in the desktop app (#25): tools for kalypso and the crew. A server is a command
 * run inside the agent's sandbox, or a URL; it goes to every agent, chosen ones, or kalypso only,
 * and every tool call it serves is checked against your Rules. Agents pick changes up when they
 * next start.
 */
export function McpServers() {
  const { state } = useStore();
  const toast = useToast();
  const { agents } = useNamespaced();
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [editing, setEditing] = useState<McpServer | "new" | null>(null);
  const load = () => api.mcpList(state.ns).then(setServers).catch((e) => { setServers([]); toast(errorMessage(e), "err"); });
  useEffect(() => { load(); }, [state.ns]);

  const who = (s: McpServer) =>
    s.scope === "all" ? "Every agent" : s.scope === "master" ? "kalypso only" : agents.filter((a) => s.agents.includes(a.id)).map((a) => a.name).join(", ") || "No agents yet";
  const toggle = async (s: McpServer) => {
    try {
      await api.mcpSave(state.ns, { ...s, id: s.id, enabled: !s.enabled });
      toast(`${s.name} ${s.enabled ? "off" : "on"}. Agents pick it up when they next start.`);
      load();
    } catch (e) { toast(errorMessage(e), "err"); }
  };
  const remove = async (s: McpServer) => {
    if (!confirm(`Remove ${s.name}? Agents lose its tools when they next start.`)) return;
    try { await api.mcpDelete(state.ns, s.id); toast(`Removed ${s.name}`, "warn"); load(); } catch (e) { toast(errorMessage(e), "err"); }
  };

  if (!servers) return <Skeleton rows={3} />;
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <p className="dim" style={{ margin: 0, flex: 1 }}>
          Tools for kalypso and your agents in <b>{state.ns}</b>. Every call they make goes through your Rules, like any other tool. Changes apply when an agent next starts.
        </p>
        <button className="btn primary" onClick={() => setEditing("new")}><Plus size={14} /> Add MCP server</button>
      </div>
      {servers.length === 0 ? (
        <EmptyState icon={Plug} title="No MCP servers yet" action={<button className="btn primary sm" onClick={() => setEditing("new")}><Plus size={13} /> Add one</button>}>
          MCP servers give agents more tools: GitHub, a database, a browser, your own services.
        </EmptyState>
      ) : (
        <div className="card flush">
          <table className="table">
            <thead><tr><th>Server</th><th>Runs</th><th>Who gets it</th><th>On</th><th /></tr></thead>
            <tbody>
              {servers.map((s) => (
                <tr key={s.id}>
                  <td><b>{s.name}</b><div className="faint small">{s.transport === "stdio" ? "In the agent's sandbox" : s.transport.toUpperCase()}</div></td>
                  <td className="mono small clip" style={{ maxWidth: 320 }} title={s.transport === "stdio" ? [s.command, ...s.args].join(" ") : s.url}>{s.transport === "stdio" ? [s.command, ...s.args].join(" ") : s.url}</td>
                  <td className="small">{who(s)}</td>
                  <td><Toggle on={s.enabled} onChange={() => toggle(s)} label={`Turn ${s.name} ${s.enabled ? "off" : "on"}`} /></td>
                  <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                    <button className="btn ghost sm icon" title={`Edit ${s.name}`} onClick={() => setEditing(s)}><Pencil size={13} /></button>
                    <button className="btn ghost sm icon danger" title={`Remove ${s.name}`} onClick={() => remove(s)}><Trash2 size={13} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <McpForm server={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={load} />}
    </>
  );
}

/** Common servers, filled in for you. Commands run inside the agent's sandbox, so `npx` needs internet access there. */
const PRESETS: { id: string; label: string; name: string; command: string; args: string[]; env: Record<string, McpValue> }[] = [
  { id: "github", label: "GitHub", name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: { secret: "GITHUB_TOKEN" } } },
  { id: "filesystem", label: "Files in /work", name: "files", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/work"], env: {} },
  { id: "memory", label: "Knowledge graph memory", name: "memory", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], env: {} },
];

interface Row { key: string; kind: "text" | "secret"; value: string }

function McpForm({ server, onClose, onSaved }: { server: McpServer | null; onClose: () => void; onSaved: () => void }) {
  const { state } = useStore();
  const toast = useToast();
  const { agents, secrets } = useNamespaced();
  const crew = agents.filter((a) => !a.master);
  const { errors, check, clear } = useErrors();
  const [name, setName] = useState(server?.name ?? "");
  const [transport, setTransport] = useState(server?.transport ?? "stdio");
  const [command, setCommand] = useState(server?.command ?? "");
  const [args, setArgs] = useState((server?.args ?? []).join("\n"));
  const [url, setUrl] = useState(server?.url ?? "");
  const [rows, setRows] = useState<Row[]>(() =>
    Object.entries(server?.env ?? {}).map(([key, v]) => (typeof v === "string" ? { key, kind: "text", value: v } : { key, kind: "secret", value: v.secret })),
  );
  const [scope, setScope] = useState(server?.scope ?? "all");
  const [chosen, setChosen] = useState<string[]>(server?.agents ?? []);
  const [saving, setSaving] = useState(false);
  // Secrets an agent's sandbox can hold: for every agent, or for chosen agents.
  const deliverable = secrets.filter((x) => x.scope === "namespace" || x.scope === "agent").map((x) => x.key);
  const stdio = transport === "stdio";

  const usePreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    setName(p.name); setTransport("stdio"); setCommand(p.command); setArgs(p.args.join("\n"));
    setRows(Object.entries(p.env).map(([key, v]) => (typeof v === "string" ? { key, kind: "text", value: v } : { key, kind: "secret", value: v.secret })));
  };

  const save = async () => {
    const ok = check({
      name: /^[a-z][a-z0-9_-]{0,39}$/.test(name.trim()) ? undefined : "Lowercase letters, digits, - and _, starting with a letter, like github.",
      command: !stdio || command.trim() ? undefined : "Which command starts it, for example npx.",
      url: stdio || /^https?:\/\//.test(url.trim()) ? undefined : "A URL starting with http:// or https://.",
    });
    if (!ok) return;
    const env: Record<string, McpValue> = {};
    for (const r of rows.filter((r) => r.key.trim())) env[r.key.trim()] = r.kind === "secret" ? { secret: r.value } : r.value;
    setSaving(true);
    try {
      await api.mcpSave(state.ns, {
        id: server?.id, name: name.trim(), transport, command: command.trim(), url: url.trim(),
        args: args.split("\n").map((a) => a.trim()).filter(Boolean), env, scope, agents: scope === "chosen" ? chosen : [], enabled: server?.enabled ?? true,
      });
      toast(`${name.trim()} saved. Agents get it when they next start.`);
      onSaved();
      onClose();
    } catch (e) {
      toast(errorMessage(e), "err");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={server ? `Edit ${server.name}` : "Add MCP server"} subtitle="Tools for your agents. Every call goes through your Rules." onClose={onClose} wide>
      {!server && (
        <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
          <span className="faint small">Start from:</span>
          {PRESETS.map((p) => <button key={p.id} className="btn sm" onClick={() => usePreset(p.id)}>{p.label}</button>)}
        </div>
      )}
      <div className="field-row">
        <Field label="Name" error={errors.name} hint="Its tools show up as mcp__name__tool.">
          <input className="input mono" value={name} onChange={(e) => { setName(e.target.value); clear("name"); }} placeholder="github" />
        </Field>
        <label className="field">Runs as
          <select className="select" value={transport} onChange={(e) => setTransport(e.target.value)}>
            <option value="stdio">A command in the agent's sandbox</option>
            <option value="http">A URL (HTTP)</option>
            <option value="sse">A URL (SSE)</option>
          </select>
        </label>
      </div>
      {stdio ? (
        <div className="field-row">
          <Field label="Command" error={errors.command} hint="Run inside the sandbox. npx and uvx need internet access there.">
            <input className="input mono" value={command} onChange={(e) => { setCommand(e.target.value); clear("command"); }} placeholder="npx" />
          </Field>
          <Field label="Arguments" hint="One per line.">
            <textarea className="input mono" rows={3} value={args} onChange={(e) => setArgs(e.target.value)} placeholder={"-y\n@modelcontextprotocol/server-github"} />
          </Field>
        </div>
      ) : (
        <Field label="URL" error={errors.url} hint="Reached from the agent's sandbox: an internet sandbox needs the host allowed by your Rules.">
          <input className="input mono" value={url} onChange={(e) => { setUrl(e.target.value); clear("url"); }} placeholder="https://example.com/mcp" />
        </Field>
      )}
      <div className="field" role="group" aria-labelledby="mcp-env">
        <span id="mcp-env">{stdio ? "Environment variables" : "Headers"}</span>
        {rows.map((r, i) => (
          <div key={i} className="mcp-row">
            <input className="input mono" value={r.key} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} placeholder={stdio ? "NAME" : "Authorization"} aria-label="Name" />
            <select className="select" value={r.kind} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, kind: e.target.value as Row["kind"], value: "" } : x)))} aria-label="Value from">
              <option value="text">Text</option>
              <option value="secret">Secret</option>
            </select>
            {r.kind === "secret" ? (
              <select className="select mono" value={r.value} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} aria-label="Secret">
                <option value="">Pick a secret</option>
                {[...new Set([...deliverable, r.value].filter(Boolean))].map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            ) : (
              <input className="input mono" value={r.value} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} aria-label="Value" />
            )}
            <button className="btn ghost sm icon" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove"><X size={13} /></button>
          </div>
        ))}
        <button className="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={() => setRows([...rows, { key: "", kind: "text", value: "" }])}><Plus size={12} /> Add</button>
        <span className="faint small">A secret is read inside the agent's sandbox when it starts, so it must reach that agent (every agent, or granted to it). Its value is never shown to the agent.</span>
      </div>
      <div className="field" role="group" aria-labelledby="mcp-who">
        <span id="mcp-who">Who gets it</span>
        <div className="row" style={{ gap: 14 }}>
          {([["all", "Every agent"], ["chosen", "Chosen agents"], ["master", "kalypso only"]] as const).map(([v, label]) => (
            <label key={v} className="row" style={{ gap: 6 }}><input type="radio" name="mcp-scope" checked={scope === v} onChange={() => setScope(v)} /> {label}</label>
          ))}
        </div>
        {scope === "chosen" && (
          <div className="grant-list">
            {crew.length === 0 && <span className="faint small">No agents yet.</span>}
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
      <ModalActions onCancel={onClose} onConfirm={save} confirm={saving ? "Saving…" : "Save"} />
    </Modal>
  );
}
