import { useEffect, useRef, useState } from "react";
import { Columns2, Globe, Plus, Rows2, Smartphone, SquareTerminal, X, type LucideIcon } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import "../styles/tools.css";
import { panesOf, uid, useNamespaced, useStore, type State } from "../store";
import { usePopover } from "../components/ui";
import { disposeSession, getSession } from "../components/shell";
import type { PaneNode, ToolKind, ToolTab } from "../types";
import { BrowserPane } from "./Browser";
import { PhonePane } from "./Phone";

type Pane = Extract<PaneNode, { kind: "pane" }>;

export const TOOLS: { kind: ToolKind; label: string; icon: LucideIcon }[] = [
  { kind: "terminal", label: "Terminal", icon: SquareTerminal },
  { kind: "browser", label: "Browser", icon: Globe },
  { kind: "phone", label: "Phone", icon: Smartphone },
];
const toolOf = (p: Pane): ToolKind => p.tool ?? "terminal";
const toolDef = (k: ToolKind) => TOOLS.find((t) => t.kind === k)!;

/** The tab the tools layer shows for the current namespace, if any. */
export function currentToolTab(state: State): ToolTab | undefined {
  const tabs = state.toolTabs[state.ns] ?? [];
  return tabs.find((t) => t.id === state.toolsTab) ?? tabs[0];
}
export const tabHasTool = (tab: ToolTab | undefined, kind: ToolKind) => !!tab && panesOf(tab.layout).some((p) => toolOf(p) === kind);

// ---------- Tree helpers ----------
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

// Covers the inset main panel. Mounted on first open and kept mounted after,
// so shells, browser tabs and the page underneath all keep their state.
export function ToolsLayer() {
  const { state, dispatch } = useStore();
  const { sandboxes } = useNamespaced();
  const open = state.toolsOpen;
  const tabs = state.toolTabs[state.ns] ?? [];
  const tab = currentToolTab(state);
  const [activePane, setActivePane] = useState<Record<string, string>>({});
  const newTab = usePopover();

  const all = tab ? panesOf(tab.layout) : [];
  const activeId = tab && all.some((p) => p.id === activePane[tab.id]) ? activePane[tab.id] : all[0]?.id;
  const setActive = (paneId: string) => tab && setActivePane((m) => ({ ...m, [tab.id]: paneId }));

  const saveTabs = (next: ToolTab[]) => dispatch({ type: "toolTabs", ns: state.ns, tabs: next });
  const saveLayout = (layout: PaneNode) => tab && saveTabs(tabs.map((t) => (t.id === tab.id ? { ...t, layout } : t)));
  const disposeAll = (n: PaneNode) => panesOf(n).forEach((p) => disposeSession(p.id));

  const closeTab = (id: string) => {
    const t = tabs.find((x) => x.id === id);
    if (t) disposeAll(t.layout);
    const rest = tabs.filter((x) => x.id !== id);
    saveTabs(rest);
    if (!rest.length) dispatch({ type: "tools", open: false, tab: undefined });
    else if (id === tab?.id) dispatch({ type: "tools", open: true, tab: rest[Math.max(0, tabs.findIndex((x) => x.id === id) - 1)].id });
  };
  // Splitting opens a fresh shell next to the pane, on the same sandbox when it has one.
  const splitPane = (id: string, dir: "row" | "column") => {
    if (!tab) return;
    const source = all.find((p) => p.id === id);
    const fresh: Pane = { kind: "pane", id: uid("p"), tool: "terminal", sandboxId: source?.sandboxId ?? sandboxes[0]?.id ?? null };
    saveLayout(split(tab.layout, id, dir, fresh));
    setActive(fresh.id);
  };
  const closePane = (id: string) => {
    if (!tab) return;
    if (all.length === 1) return closeTab(tab.id);
    disposeSession(id);
    saveLayout(close(tab.layout, id)!);
  };
  const setTool = (id: string, tool: ToolKind) => {
    if (!tab) return;
    if (tool !== "terminal") disposeSession(id);
    saveLayout(update(tab.layout, id, (n) => (n.kind === "pane" ? { ...n, tool } : n)));
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Esc closes the layer, except while typing in a shell or a field.
      const typing = (e.target as HTMLElement).closest?.(".xterm, input, select, textarea, .overlay");
      if (e.key === "Escape" && !typing) { e.preventDefault(); dispatch({ type: "tools", open: false }); return; }
      if (!(e.ctrlKey && e.shiftKey) || !activeId) return;
      const k = e.key.toLowerCase();
      if (k === "d") { e.preventDefault(); splitPane(activeId, "row"); }
      if (k === "e") { e.preventDefault(); splitPane(activeId, "column"); }
      if (k === "w") { e.preventDefault(); closePane(activeId); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const label = (t: ToolTab) => [...new Set(panesOf(t.layout).map(toolOf))].map((k) => toolDef(k).label).join(" · ");

  return (
    <section className={`tools ${open ? "open" : ""}`} aria-hidden={!open} aria-label="Tools">
      <header className="tools-head">
        <div className="tools-tabs" role="tablist">
          {tabs.map((t) => {
            const Icon = toolDef(toolOf(panesOf(t.layout)[0])).icon;
            return (
              <div key={t.id} role="tab" aria-selected={t.id === tab?.id} className={`tools-tab ${t.id === tab?.id ? "active" : ""}`} onClick={() => dispatch({ type: "tools", open: true, tab: t.id })}>
                <Icon size={13} />
                <span className="clip">{label(t)}</span>
                <button className="tools-tab-x" aria-label="Close tab" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}><X size={12} /></button>
              </div>
            );
          })}
          <div className="pop-wrap" ref={newTab.ref}>
            <button className="btn ghost sm icon" title="New tab" aria-label="New tab" onClick={() => newTab.setOpen(!newTab.open)}><Plus size={14} /></button>
            {newTab.open && (
              <div className="popover" style={{ left: 0, right: "auto", minWidth: 180, transformOrigin: "top left" }}>
                {TOOLS.map(({ kind, label: l, icon: Icon }) => (
                  <button key={kind} className="pop-item" onClick={() => { dispatch({ type: "openTool", tool: kind, fresh: true }); newTab.setOpen(false); }}>
                    <Icon size={14} /> New {l.toLowerCase()}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <span className="spacer" />
        <button className="btn ghost sm" disabled={!activeId} onClick={() => activeId && splitPane(activeId, "row")} title="Split right (Ctrl Shift D)"><Columns2 size={14} /> Split right</button>
        <button className="btn ghost sm" disabled={!activeId} onClick={() => activeId && splitPane(activeId, "column")} title="Split down (Ctrl Shift E)"><Rows2 size={14} /> Split down</button>
        <button className="btn ghost sm icon" onClick={() => dispatch({ type: "tools", open: false })} title="Close (Esc or Ctrl `)" aria-label="Close tools"><X size={15} /></button>
      </header>
      <div className="tools-body">
        {tabs.map((t) => (
          <div key={t.id} className="tools-page" style={{ display: t.id === tab?.id ? "flex" : "none" }}>
            <Node node={t.layout} activeId={activeId ?? ""} onActivate={setActive} onSplit={splitPane} onClose={closePane} onTool={setTool}
              onRatio={(id, ratio) => saveLayout(update(t.layout, id, (n) => (n.kind === "split" ? { ...n, ratio } : n)))}
              onSandbox={(id, sandboxId) => saveLayout(update(t.layout, id, (n) => (n.kind === "pane" ? { ...n, sandboxId } : n)))} />
          </div>
        ))}
      </div>
    </section>
  );
}

interface NodeProps {
  node: PaneNode;
  activeId: string;
  onActivate: (id: string) => void;
  onSplit: (id: string, dir: "row" | "column") => void;
  onClose: (id: string) => void;
  onRatio: (id: string, ratio: number) => void;
  onSandbox: (id: string, sandboxId: string) => void;
  onTool: (id: string, tool: ToolKind) => void;
}

function Node(props: NodeProps) {
  const { node } = props;
  const ref = useRef<HTMLDivElement>(null);
  if (node.kind === "pane") return <PaneView {...props} node={node} />;

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

function PaneView({ node, activeId, onActivate, onSplit, onClose, onSandbox, onTool }: NodeProps & { node: Pane }) {
  const { sandboxes } = useNamespaced();
  const tool = toolOf(node);
  return (
    <div className={`term-pane tool-pane ${node.id === activeId ? "active" : ""}`} onMouseDown={() => onActivate(node.id)}>
      <div className="term-head">
        <div className="segmented" role="radiogroup" aria-label="Pane tool">
          {TOOLS.map(({ kind, label, icon: Icon }) => (
            <button key={kind} className={tool === kind ? "active" : ""} onClick={() => onTool(node.id, kind)} title={label} aria-label={label} role="radio" aria-checked={tool === kind}>
              <Icon size={13} />
            </button>
          ))}
        </div>
        {tool === "terminal" && (
          <select className="select" value={node.sandboxId ?? ""} onChange={(e) => onSandbox(node.id, e.target.value)} style={{ height: 26, fontSize: 12 }}>
            {sandboxes.length === 0 && <option value="">No sandboxes</option>}
            {sandboxes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        <span className="spacer" />
        <button className="btn ghost sm icon" title="Split right" onClick={() => onSplit(node.id, "row")}><Columns2 size={13} /></button>
        <button className="btn ghost sm icon" title="Split down" onClick={() => onSplit(node.id, "column")}><Rows2 size={13} /></button>
        <button className="btn ghost sm icon" title="Close pane" onClick={() => onClose(node.id)}><X size={13} /></button>
      </div>
      {tool === "terminal" ? <Shell node={node} /> : tool === "browser" ? <BrowserPane /> : <PhonePane />}
    </div>
  );
}

function Shell({ node }: { node: Pane }) {
  const { state } = useStore();
  const { sandboxes, agents, repos } = useNamespaced();
  const host = useRef<HTMLDivElement>(null);
  const sandbox = sandboxes.find((s) => s.id === node.sandboxId) ?? null;
  const repoIds = new Set(repos.map((r) => r.id));
  const ctx = { sandbox, agents, commits: state.commits.filter((c) => repoIds.has(c.repoId)) };
  const theme = () => ({ background: cssVar("--page-bg"), foreground: cssVar("--text"), cursor: cssVar("--text"), selectionBackground: "rgba(124, 92, 220, 0.35)" });

  // Sessions live outside React so a pane keeps its scrollback when the layout around it changes.
  useEffect(() => {
    const session = getSession(node.id, theme(), `${cssVar("--mono") || "monospace"}`, ctx);
    host.current!.appendChild(session.el);
    const ro = new ResizeObserver(() => {
      try { session.fit.fit(); } catch { /* hidden tab or layer closed */ }
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
    getSession(node.id, {}, "", ctx).term.options.theme = theme();
  }, [state.appearance]);

  return <div className="term-body" ref={host} />;
}
