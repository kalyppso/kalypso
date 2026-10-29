import { useEffect, useRef, useState } from "react";
import { Logo } from "./Logo";
import {
  Bot,
  Boxes,
  BrainCircuit,
  Cable,
  Command,
  GitCommitHorizontal,
  Globe,
  KanbanSquare,
  KeyRound,
  LogOut,
  LayoutDashboard,
  Puzzle,
  Settings,
  ShieldCheck,
  Smartphone,
  SquareTerminal,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useNamespaced, useStore } from "../store";
import type { ViewId } from "../types";

export interface NavDef {
  id: ViewId;
  label: string;
  icon: LucideIcon;
}

export const NAV: { title: string; items: NavDef[] }[] = [
  {
    title: "Workspace",
    items: [
      { id: "overview", label: "Overview", icon: LayoutDashboard },
      { id: "agents", label: "Agents", icon: Bot },
      { id: "tracker", label: "Tracker", icon: KanbanSquare },
      { id: "git", label: "Git tracker", icon: GitCommitHorizontal },
      { id: "sandboxes", label: "Sandboxes", icon: Boxes },
      { id: "connections", label: "Connections", icon: Cable },
    ],
  },

  {
    title: "Control",
    items: [
      { id: "policies", label: "Policies", icon: ShieldCheck },
      { id: "budget", label: "Budget", icon: Wallet },
      { id: "secrets", label: "Secrets", icon: KeyRound },
    ],
  },
  {
    title: "Extend",
    items: [
      { id: "integrations", label: "Integrations", icon: BrainCircuit },
      { id: "registry", label: "Skills & MCPs", icon: Puzzle },
    ],
  },
  {
    title: "Tools",
    items: [
      { id: "terminal", label: "Terminal", icon: SquareTerminal },
      { id: "browser", label: "Browser", icon: Globe },
      { id: "phone", label: "Phone", icon: Smartphone },
      { id: "settings", label: "Settings", icon: Settings },
    ],
  },
];

export const viewLabel = (id: ViewId) => NAV.flatMap((g) => g.items).find((i) => i.id === id)?.label ?? id;

export function Sidebar() {
  const { state, dispatch } = useStore();
  const scoped = useNamespaced();
  const counts: Partial<Record<ViewId, number>> = {
    agents: scoped.agents.length,
    tracker: scoped.tasks.filter((t) => t.status === "running").length,
    sandboxes: scoped.sandboxes.length,
    connections: scoped.connections.length,
    secrets: scoped.secrets.length,
    integrations: scoped.integrations.length,
    policies: scoped.policies.filter((p) => p.enabled).length,
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <Logo size={26} />
        KALYPSO
      </div>
      {NAV.map((g) => (
        <div key={g.title}>
          <div className="nav-group">{g.title}</div>
          {g.items.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`nav-item ${state.view === id ? "active" : ""}`} onClick={() => dispatch({ type: "view", view: id })}>
              <Icon size={15} />
              {label}
              {counts[id] !== undefined && <span className="count">{counts[id]}</span>}
            </button>
          ))}
        </div>
      ))}
      <div className="sidebar-foot">
        <button className="kbd-hint" onClick={() => dispatch({ type: "palette", open: true })}>
          <Command size={14} />
          Commands
          <span className="spacer" />
          <kbd>Ctrl K</kbd>
        </button>
        <UserMenu />
      </div>
    </aside>
  );
}

function UserMenu() {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const user = state.session;
  if (!user) return null;
  return (
    <div className="pop-wrap" ref={ref} style={{ marginTop: 4 }}>
      <button className="user-btn" onClick={() => setOpen(!open)}>
        <span className="avatar">{user.name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase()}</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.name}</div>
          <div className="faint small" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.email}</div>
        </div>
      </button>
      {open && (
        <div className="popover" style={{ top: "auto", bottom: "calc(100% + 6px)", left: 0, right: "auto", width: "100%", minWidth: 0 }}>
          <button className="pop-item" onClick={() => { dispatch({ type: "view", view: "settings" }); setOpen(false); }}><Settings size={14} /> Account and appearance</button>
          <button className="pop-item" onClick={() => dispatch({ type: "logout" })}><LogOut size={14} /> Sign out</button>
        </div>
      )}
    </div>
  );
}
