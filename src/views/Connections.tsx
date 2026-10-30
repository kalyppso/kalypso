import { useEffect, useMemo, useState } from "react";
import { Background, BackgroundVariant, Controls, Handle, Position, ReactFlow, applyNodeChanges, type Connection as FlowLink, type Edge, type Node, type NodeChange, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "../styles/connections.css";
import { ArrowLeftRight, Loader2, Plus, Trash2 } from "lucide-react";
import { uid, useNamespaced, useStore, useToast } from "../store";
import { CodeReveal, Field, Modal, ModalActions, PageHead, PrimaryButton, Status, useErrors } from "../components/ui";
import { Logo } from "./Integrations";
import type { Agent, Connection, ConnectionKind, IntegrationKind } from "../types";

const W = 960;
const H = 460;

type AgentNodeData = { agent: Agent; sel: boolean };
type ToolNodeData = { kind: IntegrationKind; name: string; brain: boolean; sel: boolean };

function AgentNode({ data }: NodeProps<Node<AgentNodeData>>) {
  const { agent, sel } = data;
  return (
    <div className={`flow-agent ${sel ? "sel" : ""}`}>
      <Handle type="target" position={Position.Top} />
      <span className={`dot ${agent.status === "running" ? "ok" : agent.status === "error" ? "err" : ""}`} />
      <div style={{ minWidth: 0 }}>
        <div className="flow-name">{agent.name}</div>
        <div className="flow-sub">{agent.model.replace("claude-", "")}</div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function ToolNode({ data }: NodeProps<Node<ToolNodeData>>) {
  return (
    <div className={`flow-tool ${data.sel ? "sel" : ""}`}>
      <Handle type="target" position={Position.Top} />
      <Logo kind={data.kind} />
      <div className="flow-sub">{data.name}{data.brain ? " (brain)" : ""}</div>
    </div>
  );
}

const nodeTypes = { agent: AgentNode, tool: ToolNode };

export function Connections() {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { agents, connections, integrations } = useNamespaced();
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ from?: string; to?: string } | null>(state.compose ? {} : null);

  const isAgent = (id: string) => agents.some((a) => a.id === id);
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? integrations.find((i) => i.id === id)?.name ?? id.replace(/^remote:/, "");
  const linked = (a: string, b: string) => connections.some((c) => (c.from === a && c.to === b) || (c.from === b && c.to === a));

  // Agents that share a sandbox but can't talk yet are the most likely links.
  const suggestions = agents.flatMap((a, i) =>
    agents.slice(i + 1).filter((b) => a.sandboxId && a.sandboxId === b.sandboxId && !linked(a.id, b.id)).map((b) => [a, b] as const),
  );

  // Starting layout: agents on an ellipse, integrations along the bottom. Dragged positions are kept.
  const base: Node[] = [
    ...agents.map((a, i): Node<AgentNodeData> => {
      const t = (i / Math.max(agents.length, 1)) * Math.PI * 2 - Math.PI / 2;
      const r = agents.length === 1 ? 0 : 1;
      return { id: a.id, type: "agent", position: { x: W / 2 + Math.cos(t) * 250 * r - 80, y: H / 2 - 60 + Math.sin(t) * 130 * r }, data: { agent: a, sel: selected === a.id } };
    }),
    ...integrations.map((it, i): Node<ToolNodeData> => {
      const span = Math.min(integrations.length - 1, 4) || 1;
      const t = integrations.length === 1 ? 0.5 : i / span;
      return { id: it.id, type: "tool", position: { x: 80 + t * (W - 240), y: H - 40 }, data: { kind: it.kind, name: it.name, brain: it.brain, sel: selected === it.id } };
    }),
  ];
  const sig = JSON.stringify(base.map((n) => [n.id, n.data]));
  const [nodes, setNodes] = useState<Node[]>(base);
  useEffect(() => setNodes((prev) => base.map((n) => {
    const old = prev.find((p) => p.id === n.id);
    return old ? { ...old, data: n.data } : n;
  })), [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  const edges: Edge[] = useMemo(() => [
    ...integrations.flatMap((it) => it.agents.filter(isAgent).map((aid): Edge => ({
      id: `${it.id}-${aid}`, source: aid, target: it.id, className: "flow-edge access",
    }))),
    ...connections.filter((c) => isAgent(c.from) && isAgent(c.to)).map((c): Edge => ({
      id: c.id, source: c.from, target: c.to,
      animated: c.status === "up",
      className: `flow-edge ${c.kind} ${c.status}`,
      label: `${c.protocol} · ${c.kind}`,
    })),
  ], [sig, connections]); // eslint-disable-line react-hooks/exhaustive-deps

  const link = (a: string, b: string) => {
    if (a === b) return;
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

  const clickNode = (id: string) => {
    if (!selected) return setSelected(id);
    setSelected(null);
    if (selected !== id) link(selected, id);
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

      {agents.length === 0 ? (
        <div className="empty" style={{ marginBottom: 16 }}>Add agents to this namespace to connect them.</div>
      ) : (
        <div className="flow-wrap">
          <div className="flow-bar">
            <span className="dim">{selected ? <>Linking from <span style={{ color: "var(--text)" }}>{name(selected)}</span>. Pick a target.</> : "Drag from one node to another, or click two nodes, to link them."}</span>
            <span className="spacer" />
            <span className="legend" style={{ marginTop: 0 }}>
              <span><i className="flow-key up" />Link up</span>
              <span><i className="flow-key down" />Link down</span>
              <span><i className="flow-key access" />Integration access</span>
            </span>
          </div>
          <ReactFlow
            className="flow"
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={(c: NodeChange[]) => setNodes((ns) => applyNodeChanges(c, ns))}
            onNodeClick={(_, n) => clickNode(n.id)}
            onPaneClick={() => setSelected(null)}
            onConnect={(c: FlowLink) => link(c.source, c.target)}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.4}
            maxZoom={1.75}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      )}

      <div className="flow-table">
        <table className="table">
          <thead><tr><th>From</th><th>To</th><th>Kind</th><th>Protocol</th><th>Latency</th><th>Status</th><th /></tr></thead>
          <tbody>
            {connections.map((c) => (
              <tr key={c.id}>
                <td style={{ fontWeight: 500 }}>{name(c.from)}</td>
                <td style={{ fontWeight: 500 }}>{name(c.to)}{c.remote && <div className="faint small mono">remote</div>}</td>
                <td><span className="badge">{c.kind}</span></td>
                <td className="mono">{c.protocol}</td>
                <td className="mono dim">{c.status === "up" ? `${c.latencyMs} ms` : ""}</td>
                <td><Status value={c.status} /></td>
                <td style={{ textAlign: "right" }}>
                  <button className="btn ghost icon danger" aria-label="Remove link" onClick={() => dispatch({ type: "removeConnection", id: c.id })}><Trash2 size={13} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {connections.length === 0 && <div className="empty">No links yet.</div>}
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
  const { errors, check, clear } = useErrors();

  const changeTo = (v: string) => {
    setTo(v);
    clear("to");
    clear("remote");
    setTest("idle");
    setKind(v === "remote" ? "tunnel" : "direct");
    setProtocol(v === "remote" || integrations.some((i) => i.id === v) ? "mcp" : "a2a");
  };

  const duplicate = isIntegration ? !!integrations.find((i) => i.id === to)?.agents.includes(from) : !isRemote && isLinked(from, to);
  const validate = () => {
    const address = remote.trim();
    return check({
      from: !from ? "Pick an agent to connect from." : undefined,
      to: !to ? "Pick where to connect." : from === to ? "An agent can't connect to itself." : duplicate ? (isIntegration ? `${fromAgent?.name} already has access to this integration.` : "These two are already linked.") : undefined,
      remote: !isRemote ? undefined : !address ? "Enter the other machine's address." : !/^[\w.-]+(:\d{2,5})?$|^https?:\/\/\S+$/.test(address) ? "Use host:port or a URL." : undefined,
    });
  };
  const latency = kind === "direct" ? 2 : kind === "tunnel" ? 18 : 45;

  const runTest = () => {
    if (!validate()) return;
    setTest("running");
    setTimeout(() => setTest(isRemote && remote.includes("unreachable") ? "fail" : "ok"), 700);
  };

  const create = () => {
    if (!validate()) return;
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
        <Field label="From" error={errors.from}>
          <select className="select" value={from} onChange={(e) => { setFrom(e.target.value); setTest("idle"); clear("from"); clear("to"); }}>
            {agents.length === 0 && <option value="">No agents yet</option>}
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <Field label="To" error={errors.to}>
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
        </Field>
      </div>

      {isRemote && (
        <Field label="Address" error={errors.remote}>
          <input className="input mono" autoFocus value={remote} onChange={(e) => { setRemote(e.target.value); setTest("idle"); clear("remote"); }} placeholder="build-box.local:7443 or https://agents.example.com" />
        </Field>
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
        <button className="btn sm" disabled={test === "running"} onClick={runTest}>
          {test === "running" ? <Loader2 size={12} className="spin" /> : null} Test connection
        </button>
        {test === "ok" && <span className="dim">Reachable, {latency} ms round trip.</span>}
        {test === "fail" && <span className="field-error">Could not reach {remote}. Check the address and firewall.</span>}
      </div>

      <ModalActions onCancel={onClose} onConfirm={create} confirm={isIntegration ? "Grant access" : "Connect"} />
    </Modal>
  );
}
