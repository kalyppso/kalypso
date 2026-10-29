import type {
  Agent,
  Budget,
  BudgetRule,
  Commit,
  Connection,
  Integration,
  McpServer,
  Namespace,
  Policy,
  PolicyEvent,
  PullRequest,
  Repo,
  Ticket,
  Sandbox,
  Secret,
  Skill,
  Task,
  UsageDay,
} from "./types";

export const namespaces: Namespace[] = [
  { id: "personal", name: "personal", color: "#5b2aaa", description: "Side projects and experiments" },
  { id: "work", name: "work", color: "#5b2aaa", description: "Client agents, production credentials" },
  { id: "lab", name: "lab", color: "#5b2aaa", description: "Throwaway sandboxes, no internet secrets" },
];

const agentConfig = (name: string, model: string, tools: string[]) =>
  `# ${name}.agent.yaml
name: ${name}
model: ${model}
max_turns: 40
sandbox:
  network: namespace
tools:
${tools.map((t) => `  - ${t}`).join("\n")}
`;

export const agents: Agent[] = [
  {
    id: "a-researcher", ns: "personal", name: "researcher", role: "Web research & summaries",
    model: "claude-sonnet-5-5", status: "running", sandboxId: "sb-research",
    skills: ["sk-web"], mcps: ["mcp-fetch"], secrets: ["s-brave"],
    config: agentConfig("researcher", "claude-sonnet-5-5", ["web_search", "fetch"]),
  },
  {
    id: "a-writer", ns: "personal", name: "writer", role: "Drafts posts from research",
    model: "claude-haiku-5-5", status: "idle", sandboxId: "sb-research",
    skills: ["sk-docs"], mcps: [], secrets: [],
    config: agentConfig("writer", "claude-haiku-5-5", ["docs"]),
  },
  {
    id: "a-coder", ns: "work", name: "coder", role: "Implements tickets in repos",
    model: "claude-opus-5-5", status: "running", sandboxId: "sb-repo",
    skills: ["sk-git", "sk-tests"], mcps: ["mcp-github", "mcp-fs"], secrets: ["s-gh", "s-anthropic"],
    config: agentConfig("coder", "claude-opus-5-5", ["bash", "edit", "github"]),
  },
  {
    id: "a-reviewer", ns: "work", name: "reviewer", role: "Reviews PRs from coder",
    model: "claude-sonnet-5-5", status: "running", sandboxId: "sb-repo",
    skills: ["sk-git"], mcps: ["mcp-github"], secrets: ["s-gh"],
    config: agentConfig("reviewer", "claude-sonnet-5-5", ["github"]),
  },
  {
    id: "a-ops", ns: "work", name: "ops", role: "Watches deploys and alerts",
    model: "claude-haiku-5-5", status: "error", sandboxId: "sb-ops",
    skills: [], mcps: ["mcp-k8s"], secrets: ["s-kube"],
    config: agentConfig("ops", "claude-haiku-5-5", ["kubectl"]),
  },
  {
    id: "a-fuzzer", ns: "lab", name: "fuzzer", role: "Generates test inputs",
    model: "claude-haiku-5-5", status: "stopped", sandboxId: "sb-lab",
    skills: ["sk-tests"], mcps: [], secrets: [],
    config: agentConfig("fuzzer", "claude-haiku-5-5", ["bash"]),
  },
];

export const sandboxes: Sandbox[] = [
  { id: "sb-research", ns: "personal", name: "research-box", runtime: "docker", image: "kalypso/agent-base:1.4", status: "running", cpu: 2, memMb: 2048, network: "internet", createdAt: "2026-10-21" },
  { id: "sb-repo", ns: "work", name: "repo-workspace", runtime: "docker", image: "kalypso/dev-node22:1.4", status: "running", cpu: 4, memMb: 8192, network: "namespace", createdAt: "2026-10-12" },
  { id: "sb-ops", ns: "work", name: "ops-runner", runtime: "podman", image: "kalypso/ops:0.9", status: "paused", cpu: 1, memMb: 1024, network: "namespace", createdAt: "2026-09-30" },
  { id: "sb-lab", ns: "lab", name: "fuzz-vm", runtime: "firecracker", image: "kalypso/microvm-min:0.3", status: "stopped", cpu: 2, memMb: 1024, network: "isolated", createdAt: "2026-10-27" },
];

export const secrets: Secret[] = [
  { id: "s-brave", ns: "personal", key: "BRAVE_API_KEY", value: "example-brave-key", scope: "agent", updatedAt: "2026-10-02" },
  { id: "s-anthropic", ns: "work", key: "ANTHROPIC_API_KEY", value: "example-anthropic-key", scope: "namespace", updatedAt: "2026-10-15" },
  { id: "s-gh", ns: "work", key: "GITHUB_TOKEN", value: "example-github-token", scope: "namespace", updatedAt: "2026-10-20" },
  { id: "s-kube", ns: "work", key: "KUBECONFIG", value: "apiVersion: v1\nclusters: …", scope: "agent", updatedAt: "2026-09-28" },
];

export const connections: Connection[] = [
  { id: "c1", ns: "personal", from: "a-researcher", to: "a-writer", kind: "direct", protocol: "a2a", status: "up", latencyMs: 2 },
  { id: "c2", ns: "work", from: "a-coder", to: "a-reviewer", kind: "direct", protocol: "a2a", status: "up", latencyMs: 3 },
  { id: "c3", ns: "work", from: "a-reviewer", to: "a-ops", kind: "tunnel", protocol: "mcp", status: "down", latencyMs: 0 },
];

export const budgets: Budget[] = [
  { ns: "personal", monthlyLimit: 40, alertAt: 0.8 },
  { ns: "work", monthlyLimit: 300, alertAt: 0.75 },
  { ns: "lab", monthlyLimit: 15, alertAt: 0.9 },
];

// Deterministic pseudo-random so the chart is stable between reloads.
function seeded(seed: number) {
  let s = seed;
  return () => ((s = (s * 9301 + 49297) % 233280) / 233280);
}

export const usage: UsageDay[] = (() => {
  const rand = seeded(7);
  const days: UsageDay[] = [];
  for (let d = 1; d <= 29; d++) {
    const byAgent: Record<string, number> = {};
    for (const a of agents) {
      const base = a.model.includes("opus") ? 4 : a.model.includes("sonnet") ? 1.4 : 0.3;
      byAgent[a.id] = a.status === "stopped" && d > 20 ? 0 : +(base * (0.4 + rand() * 1.2)).toFixed(2);
    }
    days.push({ date: `2026-10-${String(d).padStart(2, "0")}`, byAgent });
  }
  return days;
})();

export const skills: Skill[] = [
  { id: "sk-web", name: "web-research", version: "1.2.0", description: "Search, fetch and cite web sources", source: "~/.kalypso/skills/web-research", enabled: true },
  { id: "sk-docs", name: "docs-writer", version: "0.8.1", description: "Long-form writing with outlines", source: "~/.kalypso/skills/docs-writer", enabled: true },
  { id: "sk-git", name: "git-workflow", version: "2.0.0", description: "Branching, commits and PR hygiene", source: "github.com/kalypso/skills", enabled: true },
  { id: "sk-tests", name: "test-runner", version: "1.0.3", description: "Detects and runs project test suites", source: "github.com/kalypso/skills", enabled: false },
];

export const mcps: McpServer[] = [
  { id: "mcp-fetch", name: "fetch", transport: "stdio", endpoint: "uvx mcp-server-fetch", tools: 1, health: "healthy", enabled: true },
  { id: "mcp-github", name: "github", transport: "http", endpoint: "https://api.githubcopilot.com/mcp/", tools: 38, health: "healthy", enabled: true },
  { id: "mcp-fs", name: "filesystem", transport: "stdio", endpoint: "npx @modelcontextprotocol/server-filesystem /work", tools: 11, health: "healthy", enabled: true },
  { id: "mcp-k8s", name: "kubernetes", transport: "sse", endpoint: "http://localhost:7788/sse", tools: 14, health: "offline", enabled: true },
];

export const budgetRules: BudgetRule[] = [
  { id: "br1", ns: "work", target: "a-coder", period: "monthly", limit: 120, action: "downgrade" },
  { id: "br2", ns: "work", target: "namespace", period: "daily", limit: 15, action: "pause" },
  { id: "br3", ns: "work", target: "a-ops", period: "per-run", limit: 0.5, action: "pause" },
  { id: "br4", ns: "personal", target: "namespace", period: "daily", limit: 3, action: "alert" },
];

export const integrations: Integration[] = [
  { id: "i-obsidian", ns: "personal", kind: "obsidian", name: "Second Brain", target: "~/Documents/Obsidian/Brain", access: "read-write", brain: true, secretId: null, agents: ["a-researcher", "a-writer"], status: "connected", lastSync: "2 min ago" },
  { id: "i-notion", ns: "work", kind: "notion", name: "Engineering Wiki", target: "notion.so/acme/engineering", access: "read", brain: true, secretId: null, agents: ["a-coder", "a-reviewer"], status: "syncing", lastSync: "syncing…" },
  { id: "i-github", ns: "work", kind: "github", name: "acme/platform", target: "github.com/acme/platform", access: "read-write", brain: false, secretId: "s-gh", agents: ["a-coder", "a-reviewer"], status: "connected", lastSync: "just now" },
  { id: "i-jira", ns: "work", kind: "jira", name: "Jira ENG", target: "acme.atlassian.net", access: "read-write", brain: false, secretId: null, agents: ["a-coder", "a-reviewer", "a-ops"], status: "connected", lastSync: "1 min ago", ticketing: { project: "ENG", label: "agent", twoWay: true } },
  { id: "i-slack", ns: "work", kind: "slack", name: "#deploys", target: "acme.slack.com/#deploys", access: "read", brain: false, secretId: null, agents: ["a-ops"], status: "error", lastSync: "token expired" },
];

const spec = (lines: string[]) => lines.join("\n");

export const policies: Policy[] = [
  {
    id: "p-secrets", ns: "*", name: "Never reveal secrets", category: "secrets", enforcement: "block", appliesTo: "all", enabled: true,
    rule: "Never print, log, commit or send secret values anywhere, including to other agents.",
    spec: spec(["policy: never-reveal-secrets", "on: [tool_output, message, file_write, http_request]", "deny_if: contains_secret_value(payload)", "action: block"]),
  },
  {
    id: "p-fs", ns: "*", name: "Stay inside the workspace", category: "filesystem", enforcement: "block", appliesTo: "all", enabled: true,
    rule: "Never read or write files outside /work and /tmp inside the sandbox.",
    spec: spec(["policy: workspace-only", "on: [file_read, file_write, bash]", "allow_paths: [/work/**, /tmp/**]", "action: block"]),
  },
  {
    id: "p-git", ns: "work", name: "No force-push to protected branches", category: "git", enforcement: "block", appliesTo: "all", enabled: true,
    rule: "Never force-push, rewrite history or delete main, master or release/* branches.",
    spec: spec(["policy: protect-branches", "on: [bash, github.push]", "deny_if: cmd ~= 'git push.*(--force|-f)' and branch in [main, master, release/*]", "action: block"]),
  },
  {
    id: "p-deploy", ns: "work", name: "Human approval for production", category: "deploy", enforcement: "approve", appliesTo: ["a-ops"], enabled: true,
    rule: "Never deploy, scale or delete anything in production without my approval.",
    spec: spec(["policy: prod-approval", "on: [kubectl, helm, terraform]", "match: context == 'prod' and verb in [apply, delete, scale, rollout]", "action: require_approval"]),
  },
  {
    id: "p-egress", ns: "*", name: "Approve new domains", category: "network", enforcement: "approve", appliesTo: "all", enabled: true,
    rule: "Ask before contacting a domain that isn't on the namespace allow-list.",
    spec: spec(["policy: egress-allowlist", "on: [http_request, fetch, browser.navigate]", "match: host not in ns.allowlist", "action: require_approval"]),
  },
  {
    id: "p-comms", ns: "*", name: "No messages on my behalf", category: "comms", enforcement: "approve", appliesTo: "all", enabled: true,
    rule: "Never send emails, Slack messages, SMS or calls as me without approval.",
    spec: spec(["policy: no-impersonation", "on: [email.send, slack.post, phone.call, phone.sms]", "action: require_approval"]),
  },
  {
    id: "p-spend", ns: "*", name: "Stop runaway runs", category: "spend", enforcement: "block", appliesTo: "all", enabled: true,
    rule: "Stop any single run that costs more than $5 or exceeds 200 turns.",
    spec: spec(["policy: runaway-guard", "on: [model_request]", "deny_if: run.cost_usd > 5 or run.turns > 200", "action: block"]),
  },
  {
    id: "p-pkg", ns: "lab", name: "Verified packages only", category: "custom", enforcement: "warn", appliesTo: "all", enabled: false,
    rule: "Warn before installing packages from registries other than npm, PyPI and crates.io.",
    spec: spec(["policy: verified-registries", "on: [bash]", "match: cmd ~= '(npm|pip|cargo) install' and registry not in [npmjs, pypi, crates]", "action: warn"]),
  },
];

export const policyEvents: PolicyEvent[] = [
  { id: "e1", ns: "work", policyId: "p-git", agentId: "a-coder", outcome: "blocked", detail: "git push --force origin main", at: "11:42" },
  { id: "e2", ns: "work", policyId: "p-deploy", agentId: "a-ops", outcome: "approved", detail: "kubectl rollout restart deploy/api -n prod", at: "10:18" },
  { id: "e3", ns: "work", policyId: "p-egress", agentId: "a-coder", outcome: "denied", detail: "GET https://pastebin.com/raw/…", at: "09:55" },
  { id: "e4", ns: "personal", policyId: "p-secrets", agentId: "a-writer", outcome: "blocked", detail: "draft contained BRAVE_API_KEY value", at: "09:12" },
  { id: "e5", ns: "work", policyId: "p-spend", agentId: "a-reviewer", outcome: "warned", detail: "run at $4.10 / $5.00", at: "08:47" },
];

export interface Activity {
  id: string;
  ns: string;
  agentId: string;
  text: string;
  at: string;
}

export const activity: Activity[] = [
  { id: "ac1", ns: "work", agentId: "a-coder", text: "opened PR #482, “Retry webhooks with backoff”", at: "12:03" },
  { id: "ac2", ns: "work", agentId: "a-reviewer", text: "requested 2 changes on PR #482", at: "12:09" },
  { id: "ac3", ns: "work", agentId: "a-ops", text: "lost connection to kubernetes MCP", at: "12:11" },
  { id: "ac4", ns: "work", agentId: "a-coder", text: "pushed 3 commits to feat/webhook-retry", at: "12:20" },
  { id: "ac5", ns: "personal", agentId: "a-researcher", text: "saved 6 notes to Second Brain", at: "11:30" },
  { id: "ac6", ns: "personal", agentId: "a-writer", text: "drafted “Agents in 2026” (1,840 words)", at: "11:52" },
  { id: "ac7", ns: "lab", agentId: "a-fuzzer", text: "stopped after 4,000 cases with 3 crashes", at: "08:10" },
];

export const tasks: Task[] = [
  { id: "t1", ns: "work", title: "Retry webhooks with exponential backoff", agentId: "a-coder", status: "review", priority: "high", progress: 1, startedAt: "11:02", minutes: 64, cost: 3.12, pr: "#482" },
  { id: "t2", ns: "work", title: "Review PR #482", agentId: "a-reviewer", status: "running", priority: "high", progress: 0.6, startedAt: "12:05", minutes: 18, cost: 0.41, pr: "#482" },
  { id: "t3", ns: "work", title: "Bump Node to 22 in CI images", agentId: "a-coder", status: "running", priority: "normal", progress: 0.35, startedAt: "12:14", minutes: 9, cost: 0.58, pr: null },
  { id: "t4", ns: "work", title: "Investigate kubernetes MCP disconnects", agentId: "a-ops", status: "failed", priority: "normal", progress: 0.2, startedAt: "12:09", minutes: 3, cost: 0.04, pr: null },
  { id: "t5", ns: "work", title: "Add rate limiting to public API", agentId: "a-coder", status: "queued", priority: "normal", progress: 0, startedAt: "", minutes: 0, cost: 0, pr: null, ticket: { integrationId: "i-jira", key: "ENG-142", url: "https://acme.atlassian.net/browse/ENG-142" } },
  { id: "t6", ns: "work", title: "Write runbook for webhook outages", agentId: "a-ops", status: "queued", priority: "low", progress: 0, startedAt: "", minutes: 0, cost: 0, pr: null },
  { id: "t7", ns: "work", title: "Fix flaky billing integration test", agentId: "a-coder", status: "done", priority: "normal", progress: 1, startedAt: "09:20", minutes: 41, cost: 1.87, pr: "#479" },
  { id: "t8", ns: "work", title: "Review PR #479", agentId: "a-reviewer", status: "done", priority: "normal", progress: 1, startedAt: "10:05", minutes: 12, cost: 0.33, pr: "#479" },
  { id: "t9", ns: "personal", title: "Research agent memory approaches", agentId: "a-researcher", status: "running", priority: "normal", progress: 0.7, startedAt: "11:15", minutes: 52, cost: 0.92, pr: null },
  { id: "t10", ns: "personal", title: "Draft post: agents in 2026", agentId: "a-writer", status: "review", priority: "normal", progress: 1, startedAt: "11:40", minutes: 22, cost: 0.11, pr: null },
  { id: "t11", ns: "lab", title: "Fuzz the config parser", agentId: "a-fuzzer", status: "done", priority: "low", progress: 1, startedAt: "07:30", minutes: 40, cost: 0.2, pr: null },
];

export const repos: Repo[] = [
  { id: "r-platform", ns: "work", name: "acme/platform", host: "github", defaultBranch: "main" },
  { id: "r-infra", ns: "work", name: "acme/infra", host: "gitlab", defaultBranch: "main" },
  { id: "r-notes", ns: "personal", name: "me/notes-site", host: "github", defaultBranch: "main" },
];

const COMMIT_SUBJECTS = [
  ["feat: retry webhooks with backoff", "a-coder", true],
  ["test: cover webhook retry edge cases", "a-coder", true],
  ["fix: flaky billing integration test", "a-coder", true],
  ["chore: bump node to 22 in ci", "a-coder", true],
  ["docs: add webhook troubleshooting notes", "a-reviewer", true],
  ["refactor: extract http client", "mira.k", false],
  ["feat: usage export endpoint", "mira.k", false],
  ["fix: timezone in invoice emails", "dmitri", false],
  ["ci: cache pnpm store", "a-ops", true],
  ["chore: rotate staging certs", "a-ops", true],
  ["feat: org-level api keys", "dmitri", false],
  ["fix: race in job scheduler", "a-coder", true],
] as const;

export const commits: Commit[] = (() => {
  const rand = seeded(42);
  const list: Commit[] = [];
  for (let day = 0; day < 14; day++) {
    const n = 1 + Math.floor(rand() * 4);
    for (let k = 0; k < n; k++) {
      const [message, author, isAgent] = COMMIT_SUBJECTS[Math.floor(rand() * COMMIT_SUBJECTS.length)];
      const additions = 4 + Math.floor(rand() * 180);
      const deletions = Math.floor(rand() * 60);
      const hh = String(8 + Math.floor(rand() * 11)).padStart(2, "0");
      const mm = String(Math.floor(rand() * 60)).padStart(2, "0");
      list.push({
        sha: Math.floor(rand() * 0xfffffff).toString(16).padStart(7, "0"),
        repoId: author === "a-ops" || rand() < 0.2 ? "r-infra" : "r-platform",
        message, author, isAgent, branch: isAgent ? `agent/${author.replace("a-", "")}/${message.split(":")[0]}` : "main",
        additions, deletions, day, at: `${hh}:${mm}`,
        diff: `--- a/src/${message.split(" ").pop()}.ts\n+++ b/src/${message.split(" ").pop()}.ts\n@@ -12,7 +12,${7 + (additions % 5)} @@\n-  const attempts = 1;\n+  const attempts = config.retries ?? 5;\n+  const delay = backoff(attempt);\n   return send(payload);`,
      });
    }
  }
  return list.sort((a, b) => a.day - b.day || b.at.localeCompare(a.at));
})();

export const pullRequests: PullRequest[] = [
  { id: "pr482", repoId: "r-platform", number: 482, title: "Retry webhooks with exponential backoff", author: "a-coder", isAgent: true, ci: "passing", review: "changes", updated: "12:09" },
  { id: "pr483", repoId: "r-platform", number: 483, title: "Bump Node to 22 in CI images", author: "a-coder", isAgent: true, ci: "pending", review: "waiting", updated: "12:20" },
  { id: "pr481", repoId: "r-platform", number: 481, title: "Org-level API keys", author: "dmitri", isAgent: false, ci: "failing", review: "waiting", updated: "10:44" },
  { id: "pr77", repoId: "r-infra", number: 77, title: "Rotate staging certificates", author: "a-ops", isAgent: true, ci: "passing", review: "approved", updated: "09:31" },
];

// Open tickets in connected ticketing tools that match their filters.
export const tickets: Ticket[] = [
  { integrationId: "i-jira", key: "ENG-142", title: "Add rate limiting to public API", status: "To Do", priority: "normal", url: "https://acme.atlassian.net/browse/ENG-142" },
  { integrationId: "i-jira", key: "ENG-151", title: "Audit log API returns 500 on empty filters", status: "To Do", priority: "high", url: "https://acme.atlassian.net/browse/ENG-151" },
  { integrationId: "i-jira", key: "ENG-153", title: "Paginate the webhooks list endpoint", status: "To Do", priority: "normal", url: "https://acme.atlassian.net/browse/ENG-153" },
  { integrationId: "i-jira", key: "ENG-157", title: "Upgrade Postgres driver to 3.x", status: "Backlog", priority: "low", url: "https://acme.atlassian.net/browse/ENG-157" },
  { integrationId: "i-jira", key: "ENG-160", title: "Flaky test: invoices_timezone_spec", status: "To Do", priority: "high", url: "https://acme.atlassian.net/browse/ENG-160" },
];
