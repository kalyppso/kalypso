import { useEffect, useRef, useState } from "react";
import { Columns2, Rows2, X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { uid, useNamespaced, useStore } from "../store";
import { PageHead } from "../components/ui";
import { disposeSession, getSession } from "../components/shell";
import type { PaneNode } from "../types";

// ---------- Tree helpers ----------
const panes = (n: PaneNode): Extract<PaneNode, { kind: "pane" }>[] => (n.kind === "pane" ? [n] : [...panes(n.a), ...panes(n.b)]);

function split(n: PaneNode, id: string, dir: "row" | "column", fresh: PaneNode): PaneNode {
  if (n.kind === "pane") return n.id === id ? { kind: "split", id: uid("s"), dir, ratio: 0.5, a: n, b: fresh } : n;
  return { ...n, a: split(n.a, id, dir, fresh), b: split(n.b, id, dir, fresh) };
}

// Removing a pane promotes its sibling into the parent's place.
function close(n: PaneNode, id: string): PaneNode | null {
  if (n.kind === "pane") return n.id === id ? null : n;
  const a = close(n.a, id);
  const b = close(n.b, id);
  if (!a) return b;
  if (!b) return a;
  return { ...n, a, b };
}

function update(n: PaneNode, id: string, fn: (x: PaneNode) => PaneNode): PaneNode {
  if (n.id === id) return fn(n);
  return n.kind === "split" ? { ...n, a: update(n.a, id, fn), b: update(n.b, id, fn) } : n;
}

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function Terminal() {
  const { state, dispatch } = useStore();
  const { sandboxes } = useNamespaced();
  const fallback: PaneNode = { kind: "pane", id: `p-${state.ns}-1`, sandboxId: sandboxes[0]?.id ?? null };
  const layout = state.terminals[state.ns] ?? fallback;
  const all = panes(layout);
  const [active, setActive] = useState(all[0].id);
  const activeId = all.some((p) => p.id === active) ? active : all[0].id;

  const save = (next: PaneNode) => dispatch({ type: "terminalLayout", ns: state.ns, layout: next });
  const splitPane = (id: string, dir: "row" | "column") => {
    const source = all.find((p) => p.id === id);
    const fresh: PaneNode = { kind: "pane", id: uid("p"), sandboxId: source?.sandboxId ?? null };
    save(split(layout, id, dir, fresh));
    setActive(fresh.id);
  };
  const closePane = (id: string) => {
    if (all.length === 1) return;
    disposeSession(id);
    save(close(layout, id)!);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && e.shiftKey)) return;
      const k = e.key.toLowerCase();
      if (k === "d") { e.preventDefault(); splitPane(activeId, "row"); }
      if (k === "e") { e.preventDefault(); splitPane(activeId, "column"); }
      if (k === "w") { e.preventDefault(); closePane(activeId); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <>
      <PageHead title="Terminal" subtitle="Shells inside your sandboxes. Split panes to watch several at once.">
        <button className="btn" onClick={() => splitPane(activeId, "row")} title="Ctrl+Shift+D"><Columns2 size={14} /> Split right</button>
        <button className="btn" onClick={() => splitPane(activeId, "column")} title="Ctrl+Shift+E"><Rows2 size={14} /> Split down</button>
      </PageHead>
      <div className="term-root">
        <Node node={layout} activeId={activeId} onActivate={setActive} onSplit={splitPane} onClose={closePane} canClose={all.length > 1}
          onRatio={(id, ratio) => save(update(layout, id, (n) => (n.kind === "split" ? { ...n, ratio } : n)))}
          onSandbox={(id, sandboxId) => save(update(layout, id, (n) => (n.kind === "pane" ? { ...n, sandboxId } : n)))} />
      </div>
      <div className="faint small" style={{ marginTop: 10 }}>
        <kbd>Ctrl Shift D</kbd> split right <kbd>Ctrl Shift E</kbd> split down <kbd>Ctrl Shift W</kbd> close pane
      </div>
    </>
  );
}

interface NodeProps {
  node: PaneNode;
  activeId: string;
  canClose: boolean;
  onActivate: (id: string) => void;
  onSplit: (id: string, dir: "row" | "column") => void;
  onClose: (id: string) => void;
  onRatio: (id: string, ratio: number) => void;
  onSandbox: (id: string, sandboxId: string) => void;
}

function Node(props: NodeProps) {
  const { node } = props;
  const ref = useRef<HTMLDivElement>(null);
  if (node.kind === "pane") return <Pane {...props} node={node} />;

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const rect = ref.current!.getBoundingClientRect();
    const move = (ev: MouseEvent) => {
      const r = node.dir === "row" ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      props.onRatio(node.id, Math.min(0.85, Math.max(0.15, r)));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = node.dir === "row" ? "col-resize" : "row-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div ref={ref} className="term-split" style={{ flexDirection: node.dir }}>
      <div style={{ flex: `${node.ratio} 1 0`, minWidth: 0, minHeight: 0, display: "flex" }}><Node {...props} node={node.a} /></div>
      <div className={`term-divider dir-${node.dir}`} onMouseDown={startDrag} role="separator" aria-orientation={node.dir === "row" ? "vertical" : "horizontal"} />
      <div style={{ flex: `${1 - node.ratio} 1 0`, minWidth: 0, minHeight: 0, display: "flex" }}><Node {...props} node={node.b} /></div>
    </div>
  );
}

function Pane({ node, activeId, canClose, onActivate, onSplit, onClose, onSandbox }: NodeProps & { node: Extract<PaneNode, { kind: "pane" }> }) {
  const { state } = useStore();
  const { sandboxes, agents, repos } = useNamespaced();
  const host = useRef<HTMLDivElement>(null);
  const sandbox = sandboxes.find((s) => s.id === node.sandboxId) ?? null;
  const repoIds = new Set(repos.map((r) => r.id));
  const ctx = { sandbox, agents, commits: state.commits.filter((c) => repoIds.has(c.repoId)) };

  // Sessions live outside React so a pane keeps its scrollback when the layout around it changes.
  useEffect(() => {
    const theme = {
      background: cssVar("--bg"),
      foreground: cssVar("--text"),
      cursor: cssVar("--text"),
      selectionBackground: "rgba(124, 92, 220, 0.35)",
    };
    const session = getSession(node.id, theme, `${cssVar("--mono") || "monospace"}`, ctx);
    host.current!.appendChild(session.el);
    const ro = new ResizeObserver(() => {
      try { session.fit.fit(); } catch { /* not visible yet */ }
    });
    ro.observe(host.current!);
    return () => {
      ro.disconnect();
      session.el.remove();
    };
    // Mount once per pane; context changes are pushed below.
  }, [node.id]);

  useEffect(() => {
    getSession(node.id, {}, "", ctx).setContext(ctx);
  }, [node.id, sandbox?.id]);

  // Follow the app theme.
  useEffect(() => {
    getSession(node.id, {}, "", ctx).term.options.theme = { background: cssVar("--bg"), foreground: cssVar("--text"), cursor: cssVar("--text"), selectionBackground: "rgba(124, 92, 220, 0.35)" };
  }, [state.appearance]);

  const active = node.id === activeId;
  return (
    <div className={`term-pane ${active ? "active" : ""}`} onMouseDown={() => onActivate(node.id)}>
      <div className="term-head">
        <select className="select" value={node.sandboxId ?? ""} onChange={(e) => onSandbox(node.id, e.target.value)} style={{ height: 24, fontSize: 12 }}>
          {sandboxes.length === 0 && <option value="">No sandboxes</option>}
          {sandboxes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <span className="spacer" />
        <button className="btn ghost sm icon" title="Split right" onClick={() => onSplit(node.id, "row")}><Columns2 size={13} /></button>
        <button className="btn ghost sm icon" title="Split down" onClick={() => onSplit(node.id, "column")}><Rows2 size={13} /></button>
        <button className="btn ghost sm icon" title="Close pane" disabled={!canClose} onClick={() => onClose(node.id)}><X size={13} /></button>
      </div>
      <div className="term-body" ref={host} />
    </div>
  );
}
