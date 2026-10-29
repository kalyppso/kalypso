import { useState } from "react";
import { ArrowLeftRight, Loader2, Plus, Trash2 } from "lucide-react";
import { uid, useNamespaced, useStore, useToast } from "../store";
import { CodeReveal, Modal, ModalActions, PageHead, PrimaryButton, Status } from "../components/ui";
import { kindDef } from "./Integrations";
import type { Connection, ConnectionKind } from "../types";

const W = 960;
const H = 460;
const NODE_W = 156;
const NODE_H = 54;

export function Connections() {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { agents, connections, integrations } = useNamespaced();
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ from?: string; to?: string } | null>(state.compose ? {} : null);

  // Agents on an inner ellipse, integrations on an outer arc along the bottom.
  const pos = new Map<string, { x: number; y: number }>();
  agents.forEach((a, i) => {
    const t = (i / Math.max(agents.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const r = agents.length === 1 ? 0 : 1;
    pos.set(a.id, { x: W / 2 + Math.cos(t) * 250 * r, y: H / 2 - 30 + Math.sin(t) * 120 * r });
  });
  integrations.forEach((it, i) => {
    const span = Math.min(integrations.length - 1, 4) || 1;
    const t = integrations.length === 1 ? 0.5 : i / span;
    pos.set(it.id, { x: 120 + t * (W - 240), y: H - 46 });
  });

  const isAgent = (id: string) => agents.some((a) => a.id === id);
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? integrations.find((i) => i.id === id)?.name ?? id.replace(/^remote:/, "");
  const linked = (a: string, b: string) => connections.some((c) => (c.from === a && c.to === b) || (c.from === b && c.to === a));

  // Agents that share a sandbox but can't talk yet are the most likely links.
  const suggestions = agents.flatMap((a, i) =>
    agents.slice(i + 1).filter((b) => a.sandboxId && a.sandboxId === b.sandboxId && !linked(a.id, b.id)).map((b) => [a, b] as const),
  );

  const clickNode = (id: string) => {
    if (!selected) return setSelected(id);
    if (selected === id) return setSelected(null);
    const [a, b] = [selected, id];
    setSelected(null);

    if (isAgent(a) && isAgent(b)) {
      if (linked(a, b)) return toast("Those agents are already linked", "info");
      return setDraft({ from: a, to: b });
    }
    const agent = isAgent(a) ? a : isAgent(b) ? b : null;
    const integ = isAgent(a) ? b : a;
    if (!agent) return toast("Pick at least one agent", "warn");
    const it = integrations.find((i) => i.id === integ)!;
    dispatch({ type: "toggleIntegrationAgent", id: integ, agentId: agent });
    toast(it.agents.includes(agent) ? `${name(agent)} lost access to ${it.name}` : `${name(agent)} can now use ${it.name}`, it.agents.includes(agent) ? "warn" : "ok");
  };

  const manifest = [
    "links:",
    ...connections.map((c) => `  - { from: ${name(c.from)}, to: ${name(c.to)}, kind: ${c.kind}, protocol: ${c.protocol} }`),
    "integrations:",
    ...integrations.map((i) => `  - { name: ${JSON.stringify(i.name)}, kind: ${i.kind}, brain: ${i.brain}, agents: [${i.agents.map(name).join(", ")}] }`),
  ].join("\n");

  return (
    <>
      <PageHead title="Connections & tunnels" subtitle="Let agents talk to each other, to your tools, or to machines elsewhere. Links stay inside this namespace.">
        <PrimaryButton onClick={() => setDraft({})} icon={<Plus size={14} />}>New connection</PrimaryButton>
      </PageHead>

      {suggestions.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div className="section-title">Suggested</div>
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            {suggestions.map(([a, b]) => (
              <button key={a.id + b.id} className="btn sm" onClick={() => setDraft({ from: a.id, to: b.id })}>
                <ArrowLeftRight size={12} /> Link {a.name} and {b.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ marginBottom: 12 }}>
          <span className="dim">{selected ? <>Linking from <span style={{ color: "var(--text)" }}>{name(selected)}</span>. Pick a target.</> : "Or click two agents on the map."}</span>
          <span className="spacer" />
          <span className="legend" style={{ marginTop: 0 }}>
            <span>Solid: direct</span>
            <span>Dashed: tunnel</span>
            <span>Dotted: integration</span>
            <span>Bold dots: down</span>
          </span>
        </div>
        {agents.length === 0 ? (
          <div className="empty">Add agents to this namespace to connect them.</div>
        ) : (
          <svg className="graph" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
            {integrations.flatMap((it) =>
              it.agents.map((aid) => {
                const a = pos.get(aid), b = pos.get(it.id);
                if (!a || !b) return null;
                return <line key={`${it.id}-${aid}`} className="edge integration" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
              }),
            )}
            {connections.map((c) => {
              const a = pos.get(c.from), b = pos.get(c.to);
              if (!a || !b) return null;
              return (
                <line key={c.id} className={`edge ${c.kind} ${c.status}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
              );
            })}
            {integrations.map((it) => {
              const p = pos.get(it.id)!;
              const d = kindDef(it.kind);
              return (
                <g key={it.id} className={`node ${selected === it.id ? "sel" : ""}`} transform={`translate(${p.x} ${p.y})`} onClick={() => clickNode(it.id)}>
                  <rect x={-18} y={-18} width={36} height={36} rx={8} />
                  <text textAnchor="middle" y={4} style={{ fontSize: 11 }}>{d.glyph}</text>
                  <text textAnchor="middle" y={34} className="sub">{it.name}{it.brain ? " (brain)" : ""}</text>
                </g>
              );
            })}
            {agents.map((a) => {
              const p = pos.get(a.id)!;
              return (
                <g key={a.id} className={`node ${selected === a.id ? "sel" : ""}`} transform={`translate(${p.x - NODE_W / 2} ${p.y - NODE_H / 2})`} onClick={() => clickNode(a.id)}>
                  <rect width={NODE_W} height={NODE_H} rx={8} />
                  <circle cx={18} cy={NODE_H / 2} r={4} fill={a.status === "running" ? "var(--ok)" : a.status === "error" ? "var(--err)" : "var(--text-3)"} />
                  <text x={32} y={24}>{a.name}</text>
                  <text x={32} y={41} className="sub">{a.model.replace("claude-", "")}</text>
                </g>
              );
            })}
          </svg>
        )}
      </div>

      <div className="card flush" style={{ marginBottom: 16 }}>
        <table className="table">
          <thead><tr><th>From</th><th>To</th><th>Kind</th><th>Protocol</th><th>Latency</th><th>Status</th><th /></tr></thead>
          <tbody>
            {connections.map((c) => (
              <tr key={c.id}>
                <td><strong style={{ fontWeight: 600 }}>{name(c.from)}</strong></td>
                <td><strong style={{ fontWeight: 600 }}>{name(c.to)}</strong>{c.remote && <div className="faint small mono">remote</div>}</td>
                <td><span className="badge">{c.kind}</span></td>
                <td className="mono">{c.protocol}</td>
                <td className="mono dim">{c.status === "up" ? `${c.latencyMs} ms` : ""}</td>
                <td><Status value={c.status} /></td>
                <td style={{ textAlign: "right" }}>
                  <button className="btn ghost icon danger" onClick={() => dispatch({ type: "removeConnection", id: c.id })}><Trash2 size={13} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {connections.length === 0 && <div className="empty" style={{ margin: 18 }}>No links yet.</div>}
      </div>

      <CodeReveal code={manifest} label="topology manifest" />
      {draft && <NewConnection seed={draft} onClose={() => setDraft(null)} />}
    </>
  );
}

const KINDS: { id: ConnectionKind; label: string; hint: string }[] = [
  { id: "direct", label: "Direct", hint: "Same machine. Fastest, nothing leaves this computer." },
  { id: "tunnel", label: "WireGuard tunnel", hint: "Encrypted link to another machine you control." },
  { id: "relay", label: "Relay", hint: "For machines behind NAT or firewalls. Slower." },
];

function NewConnection({ seed, onClose }: { seed: { from?: string; to?: string }; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { agents, integrations, connections } = useNamespaced();
  const isLinked = (x: string, y: string) => connections.some((c) => (c.from === x && c.to === y) || (c.from === y && c.to === x));
  // Start on the first pair that isn't linked yet, so the form opens ready to submit.
  const firstPair = agents.flatMap((x) => agents.filter((y) => y.id !== x.id && !isLinked(x.id, y.id)).map((y) => [x.id, y.id]))[0];
  const [from, setFrom] = useState(seed.from ?? firstPair?.[0] ?? agents[0]?.id ?? "");
  const [to, setTo] = useState(seed.to ?? firstPair?.[1] ?? "remote");
  const [remote, setRemote] = useState("");
  const isRemote = to === "remote";
  const isIntegration = integrations.some((i) => i.id === to);
  const fromAgent = agents.find((a) => a.id === from);
  const toAgent = agents.find((a) => a.id === to);
  const sameSandbox = !!fromAgent?.sandboxId && fromAgent.sandboxId === toAgent?.sandboxId;

  // Sensible defaults that follow the target; the user can still override them.
  const defaultKind: ConnectionKind = isRemote ? "tunnel" : "direct";
  const [kind, setKind] = useState<ConnectionKind>(defaultKind);
  const [protocol, setProtocol] = useState<Connection["protocol"]>(isRemote ? "mcp" : "a2a");
  const [twoWay, setTwoWay] = useState(true);
  const [test, setTest] = useState<"idle" | "running" | "ok" | "fail">("idle");

  const changeTo = (v: string) => {
    setTo(v);
    setTest("idle");
    setKind(v === "remote" ? "tunnel" : "direct");
    setProtocol(v === "remote" || integrations.some((i) => i.id === v) ? "mcp" : "a2a");
  };

  const duplicate = !isRemote && isLinked(from, to);
  const remoteOk = /^[\w.-]+(:\d{2,5})?$|^https?:\/\/\S+$/.test(remote.trim());
  const error = !from ? "Pick an agent to connect from." : from === to ? "An agent can't connect to itself." : duplicate ? "These two are already linked." : isRemote && remote && !remoteOk ? "Use host:port or a URL." : "";
  const ready = !error && (!isRemote || remoteOk);
  const latency = kind === "direct" ? 2 : kind === "tunnel" ? 18 : 45;

  const runTest = () => {
    setTest("running");
    setTimeout(() => setTest(isRemote && remote.includes("unreachable") ? "fail" : "ok"), 700);
  };

  const create = () => {
    if (!ready) return;
    if (isIntegration) {
      const it = integrations.find((i) => i.id === to)!;
      if (!it.agents.includes(from)) dispatch({ type: "toggleIntegrationAgent", id: to, agentId: from });
      toast(`${fromAgent?.name} can now use ${it.name}`);
      return onClose();
    }
    dispatch({
      type: "addConnection",
      connection: {
        id: uid("c"), ns: state.ns, from, to: isRemote ? `remote:${remote.trim()}` : to, kind, protocol, twoWay,
        status: "up", latencyMs: latency, remote: isRemote ? remote.trim() : undefined,
      },
    });
    toast(`Connected ${fromAgent?.name} to ${isRemote ? remote.trim() : toAgent?.name}`);
    onClose();
  };

  return (
    <Modal title="New connection" subtitle="Pick two ends. KALYPSO suggests the rest." onClose={onClose}>
      <div className="field-row">
        <label className="field">From
          <select className="select" value={from} onChange={(e) => { setFrom(e.target.value); setTest("idle"); }}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label className="field">To
          <select className="select" value={to} onChange={(e) => changeTo(e.target.value)}>
            <optgroup label="Agents">
              {agents.filter((a) => a.id !== from).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </optgroup>
            {integrations.length > 0 && (
              <optgroup label="Integrations">
                {integrations.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </optgroup>
            )}
            <optgroup label="Elsewhere">
              <option value="remote">Another machine…</option>
            </optgroup>
          </select>
        </label>
      </div>

      {isRemote && (
        <label className="field">Address
          <input className="input mono" autoFocus value={remote} onChange={(e) => { setRemote(e.target.value); setTest("idle"); }} placeholder="build-box.local:7443 or https://agents.example.com" />
        </label>
      )}

      {isIntegration ? (
        <div className="dim small">{fromAgent?.name} will get access to this integration through its MCP server. Policies still apply.</div>
      ) : (
        <>
          <div className="field">How they connect
            <div style={{ display: "grid", gap: 6 }}>
              {KINDS.map((k) => (
                <button key={k.id} type="button" className="tile" onClick={() => setKind(k.id)} style={{ padding: "8px 10px", borderColor: kind === k.id ? "var(--accent-hi)" : undefined }}>
                  <span style={{ width: 14, height: 14, borderRadius: 99, border: "1px solid var(--border-strong)", display: "grid", placeItems: "center", flex: "none" }}>
                    {kind === k.id && <span style={{ width: 8, height: 8, borderRadius: 99, background: "var(--accent-hi)" }} />}
                  </span>
                  <div>
                    <div style={{ color: "var(--text)" }}>{k.label}{k.id === defaultKind && <span className="faint"> (recommended)</span>}</div>
                    <div className="faint small">{k.hint}</div>
                  </div>
                </button>
              ))}
            </div>
            {kind === "direct" && !isRemote && !sameSandbox && <span className="faint small">These agents are in different sandboxes; KALYPSO bridges them over the namespace network.</span>}
          </div>
          <div className="field-row">
            <label className="field">Protocol
              <select className="select" value={protocol} onChange={(e) => setProtocol(e.target.value as Connection["protocol"])}>
                <option value="a2a">A2A (agent to agent)</option><option value="mcp">MCP</option><option value="http">HTTP</option><option value="grpc">gRPC</option>
              </select>
            </label>
            <div className="field">Direction
              <div className="segmented" style={{ alignSelf: "flex-start" }}>
                <button className={twoWay ? "active" : ""} onClick={() => setTwoWay(true)}>Both ways</button>
                <button className={!twoWay ? "active" : ""} onClick={() => setTwoWay(false)}>One way</button>
              </div>
            </div>
          </div>
        </>
      )}

      <div className="row small" style={{ minHeight: 26 }}>
        {error ? <span className="field-error">{error}</span> : (
          <>
            <button className="btn sm" disabled={!ready || test === "running"} onClick={runTest}>
              {test === "running" ? <Loader2 size={12} className="spin" /> : null} Test connection
            </button>
            {test === "ok" && <span className="dim">Reachable, {latency} ms round trip.</span>}
            {test === "fail" && <span className="field-error">Could not reach {remote}. Check the address and firewall.</span>}
          </>
        )}
      </div>

      <ModalActions onCancel={onClose} onConfirm={create} confirm={isIntegration ? "Grant access" : "Connect"} />
    </Modal>
  );
}
