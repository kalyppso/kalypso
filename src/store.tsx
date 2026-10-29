import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from "react";
import * as mock from "./mock";
import type { Activity } from "./mock";
import type {
  Agent,
  AgentStatus,
  Appearance,
  AuthProvider,
  Commit,
  Budget,
  BudgetRule,
  Connection,
  Integration,
  McpServer,
  Namespace,
  PaneNode,
  Policy,
  PolicyEvent,
  PullRequest,
  Repo,
  Sandbox,
  SandboxStatus,
  Secret,
  Session,
  Skill,
  Task,
  TaskStatus,
  ThemeId,
  UsageDay,
  ViewId,
} from "./types";

// Prototype store. In the real app every mutating action becomes a Tauri
// `invoke()` against the Rust core and the reducer only applies the result.

export interface Toast {
  id: string;
  text: string;
  tone: "ok" | "warn" | "err" | "info";
}

export interface State {
  session: Session | null;
  appearance: Appearance;
  view: ViewId;
  ns: string;
  showCode: boolean;
  ambient: boolean;
  paletteOpen: boolean;
  toasts: Toast[];
  namespaces: Namespace[];
  agents: Agent[];
  sandboxes: Sandbox[];
  secrets: Secret[];
  connections: Connection[];
  budgets: Budget[];
  budgetRules: BudgetRule[];
  usage: UsageDay[];
  skills: Skill[];
  mcps: McpServer[];
  integrations: Integration[];
  policies: Policy[];
  policyEvents: PolicyEvent[];
  activity: Activity[];
  tasks: Task[];
  repos: Repo[];
  commits: Commit[];
  pullRequests: PullRequest[];
  terminals: Record<string, PaneNode>; // layout per namespace
}

export type Action =
  | { type: "login"; session: Session }
  | { type: "logout" }
  | { type: "linkProvider"; provider: AuthProvider }
  | { type: "theme"; theme: ThemeId }
  | { type: "appearance"; patch: Partial<Appearance> }
  | { type: "addTask"; task: Task }
  | { type: "moveTask"; id: string; status: TaskStatus }
  | { type: "removeTask"; id: string }
  | { type: "terminalLayout"; ns: string; layout: PaneNode }
  | { type: "hydrateNamespaces"; namespaces: Namespace[] }
  | { type: "hydrateNs"; ns: string; secrets: Secret[]; sandboxes: Sandbox[] }
  | { type: "view"; view: ViewId }
  | { type: "ns"; ns: string }
  | { type: "showCode"; value: boolean }
  | { type: "ambient"; value: boolean }
  | { type: "palette"; open: boolean }
  | { type: "toast"; toast: Toast }
  | { type: "dismissToast"; id: string }
  | { type: "addNamespace"; ns: Namespace }
  | { type: "agentStatus"; id: string; status: AgentStatus }
  | { type: "addAgent"; agent: Agent }
  | { type: "sandboxStatus"; id: string; status: SandboxStatus }
  | { type: "addSandbox"; sandbox: Sandbox }
  | { type: "removeSandbox"; id: string }
  | { type: "addSecret"; secret: Secret }
  | { type: "removeSecret"; id: string }
  | { type: "addConnection"; connection: Connection }
  | { type: "removeConnection"; id: string }
  | { type: "setBudget"; ns: string; monthlyLimit: number; alertAt?: number }
  | { type: "addBudgetRule"; rule: BudgetRule }
  | { type: "removeBudgetRule"; id: string }
  | { type: "toggleSkill"; id: string }
  | { type: "toggleMcp"; id: string }
  | { type: "addIntegration"; integration: Integration }
  | { type: "removeIntegration"; id: string }
  | { type: "toggleIntegrationAgent"; id: string; agentId: string }
  | { type: "toggleBrain"; id: string }
  | { type: "addPolicy"; policy: Policy }
  | { type: "updatePolicy"; id: string; patch: Partial<Policy> }
  | { type: "removePolicy"; id: string }
  | { type: "reset" };

const STORAGE_KEY = "kalypso.proto.v2";

export const DEFAULT_APPEARANCE: Appearance = {
  theme: "black",
  bg: "#0b0b0f",
  text: "#f2f2f5",
  accent: "#5b2aaa",
  font: "geist",
  size: "default",
};

function initial(): State {
  return {
    session: null,
    appearance: DEFAULT_APPEARANCE,
    view: "overview",
    ns: "work",
    showCode: false,
    ambient: false,
    paletteOpen: false,
    toasts: [],
    namespaces: mock.namespaces,
    agents: mock.agents,
    sandboxes: mock.sandboxes,
    secrets: mock.secrets,
    connections: mock.connections,
    budgets: mock.budgets,
    budgetRules: mock.budgetRules,
    usage: mock.usage,
    skills: mock.skills,
    mcps: mock.mcps,
    integrations: mock.integrations,
    policies: mock.policies,
    policyEvents: mock.policyEvents,
    activity: mock.activity,
    tasks: mock.tasks,
    repos: mock.repos,
    commits: mock.commits,
    pullRequests: mock.pullRequests,
    terminals: {},
  };
}

function load(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // Transient UI state never comes back from storage.
    if (raw) {
      const saved = { ...initial(), ...JSON.parse(raw), paletteOpen: false, toasts: [] } as State;
      // The default accent moved to the logo purple; only migrate people who never changed it.
      if (saved.appearance.accent === "#8b5cf6") saved.appearance = { ...saved.appearance, accent: DEFAULT_APPEARANCE.accent };
      return saved;
    }
  } catch {
    // Corrupt or unavailable storage: fall back to seed data.
  }
  return initial();
}

const mapIf = <T extends { id: string }>(list: T[], id: string, fn: (x: T) => T) => list.map((x) => (x.id === id ? fn(x) : x));

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "login":
      return { ...s, session: a.session, view: "overview" };
    case "logout":
      return { ...s, session: null, paletteOpen: false };
    case "linkProvider":
      return s.session && !s.session.linked.includes(a.provider)
        ? { ...s, session: { ...s.session, linked: [...s.session.linked, a.provider] } }
        : s;
    case "theme":
      return { ...s, appearance: { ...s.appearance, theme: a.theme } };
    case "appearance":
      return { ...s, appearance: { ...s.appearance, ...a.patch } };
    case "addTask":
      return { ...s, tasks: [...s.tasks, a.task] };
    case "moveTask":
      return {
        ...s,
        tasks: mapIf(s.tasks, a.id, (t) => ({
          ...t,
          status: a.status,
          progress: a.status === "done" || a.status === "review" ? 1 : a.status === "queued" ? 0 : t.progress,
          startedAt: t.startedAt || (a.status === "running" ? new Date().toTimeString().slice(0, 5) : ""),
        })),
      };
    // Data from the Rust core replaces the mock records it covers.
    case "hydrateNamespaces": {
      const ids = new Set(a.namespaces.map((n) => n.id));
      const missing = a.namespaces.filter((n) => !s.budgets.some((b) => b.ns === n.id)).map((n) => ({ ns: n.id, monthlyLimit: 25, alertAt: 0.8 }));
      return { ...s, namespaces: a.namespaces, budgets: [...s.budgets, ...missing], ns: ids.has(s.ns) ? s.ns : a.namespaces[0]?.id ?? s.ns };
    }
    case "hydrateNs":
      return {
        ...s,
        secrets: [...s.secrets.filter((x) => x.ns !== a.ns), ...a.secrets],
        sandboxes: [...s.sandboxes.filter((x) => x.ns !== a.ns), ...a.sandboxes],
      };
    case "terminalLayout":
      return { ...s, terminals: { ...s.terminals, [a.ns]: a.layout } };
    case "removeTask":
      return { ...s, tasks: s.tasks.filter((t) => t.id !== a.id) };
    case "view":
      return { ...s, view: a.view, paletteOpen: false };
    case "ns":
      return { ...s, ns: a.ns };
    case "showCode":
      return { ...s, showCode: a.value };
    case "ambient":
      return { ...s, ambient: a.value };
    case "palette":
      return { ...s, paletteOpen: a.open };
    case "toast":
      return { ...s, toasts: [...s.toasts.slice(-3), a.toast] };
    case "dismissToast":
      return { ...s, toasts: s.toasts.filter((t) => t.id !== a.id) };
    case "addNamespace":
      return { ...s, namespaces: [...s.namespaces, a.ns], budgets: [...s.budgets, { ns: a.ns.id, monthlyLimit: 25, alertAt: 0.8 }], ns: a.ns.id };
    case "agentStatus":
      return { ...s, agents: mapIf(s.agents, a.id, (x) => ({ ...x, status: a.status })) };
    case "addAgent":
      return { ...s, agents: [...s.agents, a.agent] };
    case "sandboxStatus":
      return { ...s, sandboxes: mapIf(s.sandboxes, a.id, (x) => ({ ...x, status: a.status })) };
    case "addSandbox":
      return { ...s, sandboxes: [...s.sandboxes, a.sandbox] };
    case "removeSandbox":
      return {
        ...s,
        sandboxes: s.sandboxes.filter((x) => x.id !== a.id),
        agents: s.agents.map((x) => (x.sandboxId === a.id ? { ...x, sandboxId: null, status: "stopped" } : x)),
      };
    case "addSecret":
      return { ...s, secrets: [...s.secrets, a.secret] };
    case "removeSecret":
      return {
        ...s,
        secrets: s.secrets.filter((x) => x.id !== a.id),
        agents: s.agents.map((x) => ({ ...x, secrets: x.secrets.filter((id) => id !== a.id) })),
        integrations: s.integrations.map((x) => (x.secretId === a.id ? { ...x, secretId: null } : x)),
      };
    case "addConnection":
      return { ...s, connections: [...s.connections, a.connection] };
    case "removeConnection":
      return { ...s, connections: s.connections.filter((x) => x.id !== a.id) };
    case "setBudget":
      return {
        ...s,
        budgets: s.budgets.map((b) => (b.ns === a.ns ? { ...b, monthlyLimit: a.monthlyLimit, alertAt: a.alertAt ?? b.alertAt } : b)),
      };
    case "addBudgetRule":
      return { ...s, budgetRules: [...s.budgetRules, a.rule] };
    case "removeBudgetRule":
      return { ...s, budgetRules: s.budgetRules.filter((r) => r.id !== a.id) };
    case "toggleSkill":
      return { ...s, skills: mapIf(s.skills, a.id, (x) => ({ ...x, enabled: !x.enabled })) };
    case "toggleMcp":
      return { ...s, mcps: mapIf(s.mcps, a.id, (x) => ({ ...x, enabled: !x.enabled })) };
    case "addIntegration":
      return { ...s, integrations: [...s.integrations, a.integration] };
    case "removeIntegration":
      return { ...s, integrations: s.integrations.filter((x) => x.id !== a.id) };
    case "toggleIntegrationAgent":
      return {
        ...s,
        integrations: mapIf(s.integrations, a.id, (x) => ({
          ...x,
          agents: x.agents.includes(a.agentId) ? x.agents.filter((id) => id !== a.agentId) : [...x.agents, a.agentId],
        })),
      };
    case "toggleBrain":
      return { ...s, integrations: mapIf(s.integrations, a.id, (x) => ({ ...x, brain: !x.brain })) };
    case "addPolicy":
      return { ...s, policies: [...s.policies, a.policy] };
    case "updatePolicy":
      return { ...s, policies: mapIf(s.policies, a.id, (x) => ({ ...x, ...a.patch })) };
    case "removePolicy":
      return { ...s, policies: s.policies.filter((x) => x.id !== a.id) };
    case "reset":
      return { ...initial(), session: s.session, appearance: s.appearance };
  }
}

const Ctx = createContext<{ state: State; dispatch: (a: Action) => void } | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, load);

  useEffect(() => {
    try {
      const { paletteOpen: _p, toasts: _t, ...persisted } = state;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    } catch {
      // Persistence is a convenience in the prototype; ignore failures.
    }
  }, [state]);

  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useStore must be used inside StoreProvider");
  return ctx;
}

export function useToast() {
  const { dispatch } = useStore();
  return useCallback(
    (text: string, tone: Toast["tone"] = "ok") => {
      const id = uid("toast");
      dispatch({ type: "toast", toast: { id, text, tone } });
      setTimeout(() => dispatch({ type: "dismissToast", id }), 3200);
    },
    [dispatch],
  );
}

// Everything a view renders is scoped to the active namespace.
export function useNamespaced() {
  const { state } = useStore();
  const ns = state.ns;
  return {
    agents: state.agents.filter((x) => x.ns === ns),
    sandboxes: state.sandboxes.filter((x) => x.ns === ns),
    secrets: state.secrets.filter((x) => x.ns === ns),
    connections: state.connections.filter((x) => x.ns === ns),
    integrations: state.integrations.filter((x) => x.ns === ns),
    policies: state.policies.filter((x) => x.ns === ns || x.ns === "*"),
    policyEvents: state.policyEvents.filter((x) => x.ns === ns),
    budgetRules: state.budgetRules.filter((x) => x.ns === ns),
    activity: state.activity.filter((x) => x.ns === ns),
    tasks: state.tasks.filter((x) => x.ns === ns),
    repos: state.repos.filter((x) => x.ns === ns),
    budget: state.budgets.find((b) => b.ns === ns),
    namespace: state.namespaces.find((n) => n.id === ns),
  };
}

export function monthSpend(usage: UsageDay[], agentIds: string[]) {
  const ids = new Set(agentIds);
  return usage.reduce((sum, d) => sum + Object.entries(d.byAgent).reduce((s, [id, v]) => (ids.has(id) ? s + v : s), 0), 0);
}

export function dailySeries(usage: UsageDay[], agentIds: string[]) {
  return usage.map((d) => agentIds.reduce((s, id) => s + (d.byAgent[id] ?? 0), 0));
}

export const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
