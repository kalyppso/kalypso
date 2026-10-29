import { useState } from "react";
import { Logo } from "./Logo";
import {
  BarChart3,
  Bot,
  Boxes,
  BrainCircuit,
  Cable,
  Check,
  ChevronsUpDown,
  GitCommitHorizontal,
  Globe,
  KanbanSquare,
  KeyRound,
  LogOut,
  LayoutDashboard,
  Plus,
  Puzzle,
  Settings,
  ShieldCheck,
  Smartphone,
  SquareTerminal,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useNamespaced, useStore, useToast } from "../store";
import { api, errorMessage, isLive, toNamespace } from "../backend";
import { Modal, ModalActions, usePopover } from "./ui";
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
      { id: "analytics", label: "Analytics", icon: BarChart3 },
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
    <aside className="sidebar" aria-hidden={!state.sidebarOpen}>
      <NamespaceSwitcher />
      {NAV.map((g) => (
        <div key={g.title} className="nav-section">
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
        <UserMenu />
      </div>
    </aside>
  );
}

function UserMenu() {
  const { state, dispatch } = useStore();
  const { open, setOpen, ref } = usePopover();
  const user = state.session;
  if (!user) return null;
  return (
    <div className="pop-wrap" ref={ref} style={{ marginTop: 4 }}>
      <button className="user-btn" onClick={() => setOpen(!open)}>
        <span className="avatar">{user.name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase()}</span>
        <div style={{ minWidth: 0 }}>
          <div className="clip" style={{ fontWeight: 500 }}>{user.name}</div>
          <div className="faint small clip">{user.email}</div>
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

function NamespaceSwitcher() {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { open, setOpen, ref } = usePopover();
  const [creating, setCreating] = useState(false);
  const [newNs, setNewNs] = useState("");
  const current = state.namespaces.find((n) => n.id === state.ns);

  const createNs = () => {
    const id = newNs.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
    if (!id || state.namespaces.some((n) => n.id === id)) return;
    const done = () => { toast(`Created namespace ${id}`); setNewNs(""); setCreating(false); };
    if (isLive()) {
      api.nsCreate(id, "New isolated namespace")
        .then((n) => { dispatch({ type: "addNamespace", ns: toNamespace(n) }); done(); })
        .catch((e) => toast(errorMessage(e), "err"));
      return;
    }
    dispatch({ type: "addNamespace", ns: { id, name: id, color: "#5b2aaa", description: "New isolated namespace" } });
    done();
  };

  return (
    <div className="pop-wrap" ref={ref} style={{ marginBottom: 6 }}>
      <button className="user-btn" onClick={() => setOpen(!open)} title="Switch namespace" aria-expanded={open}>
        <Logo size={26} />
        <div style={{ minWidth: 0 }}>
          <div className="clip" style={{ fontWeight: 500 }}>{current?.name}</div>
          <div className="faint small clip">{current?.description}</div>
        </div>
        <ChevronsUpDown size={14} className="faint" style={{ marginLeft: "auto", flex: "none" }} />
      </button>
      {open && (
        <div className="popover" style={{ left: 0, right: "auto", width: "100%", minWidth: 0, transformOrigin: "top left" }}>
          <div className="pop-label">Namespaces</div>
          {state.namespaces.map((n) => (
            <button
              key={n.id}
              className={`pop-item ${n.id === state.ns ? "active" : ""}`}
              onClick={() => { dispatch({ type: "ns", ns: n.id }); setOpen(false); }}
            >
              <div>
                <div>{n.name}</div>
                <div className="faint small">{n.description}</div>
              </div>
              {n.id === state.ns && <Check size={14} style={{ marginLeft: "auto", color: "var(--accent-hi)" }} />}
            </button>
          ))}
          <button className="pop-item" onClick={() => { setCreating(true); setOpen(false); }}>
            <Plus size={14} /> New namespace
          </button>
        </div>
      )}
      {creating && (
        <Modal title="New namespace" subtitle="Gets its own network, secrets, budget, policies and browser profile." onClose={() => setCreating(false)}>
          <label className="field">
            Name
            <input className="input" autoFocus value={newNs} onChange={(e) => setNewNs(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createNs()} placeholder="e.g. client-acme" />
          </label>
          <ModalActions onCancel={() => setCreating(false)} onConfirm={createNs} confirm="Create namespace" />
        </Modal>
      )}
    </div>
  );
}
