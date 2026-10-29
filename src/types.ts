// Domain model shared by every view. Mirrors the Rust core's records
// (see docs/ARCHITECTURE.md §5) so the mock store can be swapped for IPC.

export type ThemeId = "black" | "white" | "custom";

export type ViewId =
  | "overview"
  | "agents"
  | "tracker"
  | "git"
  | "terminal"
  | "sandboxes"
  | "secrets"
  | "connections"
  | "budget"
  | "registry"
  | "integrations"
  | "policies"
  | "browser"
  | "phone"
  | "settings";

export interface Namespace {
  id: string;
  name: string;
  color: string;
  description: string;
}

export type AgentStatus = "running" | "idle" | "stopped" | "error";

export interface Agent {
  id: string;
  ns: string;
  name: string;
  role: string;
  model: string;
  status: AgentStatus;
  sandboxId: string | null;
  skills: string[];
  mcps: string[];
  secrets: string[];
  // Shown only when the user explicitly asks to see code.
  config: string;
}

export type SandboxStatus = "running" | "paused" | "stopped";

export interface Sandbox {
  id: string;
  ns: string;
  name: string;
  runtime: string; // provider kind: "docker", "podman", "microsandbox", …
  image: string;
  status: SandboxStatus;
  cpu: number; // cores
  memMb: number;
  network: "isolated" | "namespace" | "internet";
  createdAt: string;
}

export interface Secret {
  id: string;
  ns: string;
  key: string;
  value: string;
  scope: "namespace" | "agent";
  updatedAt: string;
}

export type ConnectionKind = "direct" | "tunnel" | "relay";

export interface Connection {
  id: string;
  ns: string;
  from: string; // agent id
  to: string; // agent id
  kind: ConnectionKind;
  protocol: "a2a" | "mcp" | "http" | "grpc";
  status: "up" | "down";
  latencyMs: number;
  twoWay?: boolean;
  remote?: string; // set when `to` is an address outside this machine
}

export interface UsageDay {
  date: string;
  byAgent: Record<string, number>; // USD
}

export interface Budget {
  ns: string;
  monthlyLimit: number;
  alertAt: number; // 0..1
}

export interface Skill {
  id: string;
  name: string;
  version: string;
  description: string;
  source: string;
  enabled: boolean;
}

export interface McpServer {
  id: string;
  name: string;
  transport: "stdio" | "http" | "sse";
  endpoint: string;
  tools: number;
  health: "healthy" | "degraded" | "offline";
  enabled: boolean;
}

export type BudgetPeriod = "daily" | "monthly" | "per-run";
export type BudgetAction = "pause" | "alert" | "downgrade";

// Extra caps on top of the namespace's monthly limit.
export interface BudgetRule {
  id: string;
  ns: string;
  target: "namespace" | string; // "namespace" or an agent id
  period: BudgetPeriod;
  limit: number; // USD
  action: BudgetAction;
}

export type IntegrationKind =
  | "jira"
  | "github-issues"
  | "gitlab-issues"
  | "servicenow"
  | "zendesk"
  | "asana"
  | "obsidian"
  | "notion"
  | "logseq"
  | "github"
  | "slack"
  | "linear"
  | "gdrive"
  | "confluence"
  | "mcp"
  | "rest"
  | "folder";

export interface Integration {
  id: string;
  ns: string;
  kind: IntegrationKind;
  name: string;
  target: string; // vault path, workspace URL, endpoint…
  access: "read" | "read-write";
  brain: boolean; // agents may use it as long-term memory
  secretId: string | null;
  agents: string[];
  status: "connected" | "syncing" | "error";
  ticketing?: TicketSync; // set for ticketing tools
  lastSync: string;
}

export type PolicyCategory = "filesystem" | "network" | "git" | "secrets" | "spend" | "comms" | "deploy" | "custom";
export type Enforcement = "block" | "approve" | "warn";

export interface Policy {
  id: string;
  ns: string | "*"; // "*" = every namespace
  name: string;
  rule: string; // plain-language "never…" statement shown to the user and the agent
  category: PolicyCategory;
  enforcement: Enforcement;
  appliesTo: "all" | string[];
  enabled: boolean;
  spec: string; // machine-checkable form, hidden unless code is requested
}

export interface PolicyEvent {
  id: string;
  ns: string;
  policyId: string;
  agentId: string;
  outcome: "blocked" | "approved" | "denied" | "warned";
  detail: string;
  at: string; // HH:MM today
}

// Appearance is per user. "custom" builds every surface from bg + text.
export interface Appearance {
  theme: ThemeId;
  bg: string; // used when theme === "custom"
  text: string; // used when theme === "custom"
  accent: string;
  font: string; // a key of FONTS, or "system:<family>" for any installed font
  size: "compact" | "default" | "large";
}

export type AuthProvider = "google" | "github" | "gitlab" | "email";

export interface Session {
  name: string;
  email: string;
  provider: AuthProvider;
  linked: AuthProvider[];
  since: string;
}

export type TaskStatus = "queued" | "running" | "review" | "done" | "failed";

export interface Task {
  id: string;
  ns: string;
  title: string;
  agentId: string;
  status: TaskStatus;
  priority: "low" | "normal" | "high";
  progress: number; // 0..1, meaningful while running
  startedAt: string; // HH:MM or "" when queued
  minutes: number;
  cost: number;
  pr: string | null;
  ticket?: TicketRef;
}

export interface Repo {
  id: string;
  ns: string;
  name: string; // owner/name
  host: "github" | "gitlab";
  defaultBranch: string;
}

export interface Commit {
  sha: string;
  repoId: string;
  message: string;
  author: string; // agent id or human handle
  isAgent: boolean;
  branch: string;
  additions: number;
  deletions: number;
  day: number; // days ago, 0 = today
  at: string; // HH:MM
  diff: string;
}

export interface PullRequest {
  id: string;
  repoId: string;
  number: number;
  title: string;
  author: string;
  isAgent: boolean;
  ci: "passing" | "failing" | "pending";
  review: "approved" | "changes" | "waiting";
  updated: string;
}

// Terminal layout: a binary tree of panes. Each split divides its area
// between two children at `ratio` (0..1, share of the first child).
export type PaneNode =
  | { kind: "pane"; id: string; sandboxId: string | null }
  | { kind: "split"; id: string; dir: "row" | "column"; ratio: number; a: PaneNode; b: PaneNode };

// Ticketing integrations: which tickets come into the Tracker, and whether
// status changes flow back to the ticketing tool.
export interface TicketSync {
  project: string; // Jira project key, Linear team, repo, queue…
  label: string; // only tickets with this label; empty = all assigned to agents
  twoWay: boolean;
}

export interface TicketRef {
  integrationId: string;
  key: string; // ENG-142, #311, INC0012345
  url: string;
}

export interface Ticket {
  integrationId: string;
  key: string;
  title: string;
  status: string;
  priority: "low" | "normal" | "high";
  url: string;
}
