import { useState } from "react";
import { Plug, Sparkles } from "lucide-react";
import { useStore } from "../store";
import { CodeReveal, PageHead, Status, Toggle } from "../components/ui";
import "../styles/integrations.css";

export function Registry() {
  const { state, dispatch } = useStore();
  const [tab, setTab] = useState<"skills" | "mcps">("skills");
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
      <PageHead title="Skills & MCP servers" subtitle="Shared catalog across namespaces. Each agent only gets what you attach to it." />

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
                <h2>{s.name}</h2>
                <span className="badge mono">v{s.version}</span>
                <span className="spacer" />
                <Toggle on={s.enabled} onChange={() => dispatch({ type: "toggleSkill", id: s.id })} label={`Enable ${s.name}`} />
              </div>
              <p className="dim" style={{ margin: "8px 0" }}>{s.description}</p>
              <div className="dim mono" style={{ fontSize: 11.5, marginBottom: 8 }}>{s.source}</div>
              <div className="chips">{usedBy("skills", s.id).map((u) => <span key={u} className="badge">{u}</span>)}{usedBy("skills", s.id).length === 0 && <span className="faint small">Not attached to any agent</span>}</div>
            </div>
          ))}
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
    </>
  );
}
