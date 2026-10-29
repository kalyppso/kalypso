# KALYPSO — Architecture

KALYPSO is a desktop workspace for running and supervising AI agents. You use it to manage sandboxes, secrets, agents, budgets, guardrail policies, skills and MCP servers, links to outside tools (Obsidian, Notion, wikis, any MCP or REST API), and the links between agents. A built-in browser and phone preview sit next to all of it, and namespaces separate one workspace from another.

Status: **UI prototype** (mock data in `src/mock.ts`). This document is the plan for turning it into the real application.

---

## 1. Goals and non-goals

**Goals**
- A native desktop app (Linux, Windows, macOS). It is not a website or a hosted service.
- **Namespaces are the security boundary.** Two namespaces can't see each other's network, secrets, browser cookies or budget.
- Real enforcement, not just dashboards. A budget limit pauses agents, a policy blocks an action before it runs, a secret scope decides what gets injected, and a network setting decides which packets leave.
- KALYPSO connects to the tools you already use. Any wiki or notes app can become a shared long-term memory for agents (a "brain").
- **Code only when asked.** The UI shows outcomes and status first. Configs, manifests and diffs stay hidden until the user expands them or turns on "Show code" globally.
- A polished product feel. Black and violet *Void* is the default theme, with an animated web of nodes in the background. The other themes are *Dark Blur* (frosted glass), *Cappuccino*, *Blossom* (girls), *Ocean* (boys) and *Daylight*.

**Non-goals (v1)**
- Multi-user or team servers. The design leaves room for them (§9).
- Hosting models. KALYPSO calls providers' APIs and does not run models itself.

---

## 2. Big picture

```
┌──────────────────────────── KALYPSO.app (Tauri 2) ────────────────────────────┐
│                                                                                │
│  React UI (webview)                                                            │
│  ├─ Shell: sidebar · namespace switcher · theme · "show code"                  │
│  ├─ Views: Overview Agents Sandboxes Connections Secrets Budget Registry ...    │
│  └─ Child webviews: Browser tabs · Phone preview  (one data dir per namespace) │
│            │  invoke() / events                                                │
│  ──────────┼──────────────────────────────────────────────────────────────    │
│  Rust core │                                                                   │
│  ├─ ipc      typed commands, per-namespace authorisation                       │
│  ├─ ns       namespace registry, isolation resources                           │
│  ├─ store    SQLite (sqlx) + migrations                                        │
│  ├─ vault    secrets: XChaCha20-Poly1305, per-ns keys, master key in keychain  │
│  ├─ sandbox  Docker/Podman (bollard) · Firecracker (later)                     │
│  ├─ agents   supervisor + runtime adapters                                     │
│  ├─ gateway  local LLM proxy → metering, budgets, key injection                │
│  ├─ mesh     agent-to-agent bus, tunnels (WireGuard/SSH/relay)                 │
│  ├─ registry skills + MCP servers, health checks                               │
│  ├─ policy   guardrail engine: rules → checks at every enforcement point       │
│  ├─ connect  integrations (Obsidian, Notion, GitHub, REST…) → MCP servers      │
│  └─ events   tokio broadcast → UI live updates                                 │
└──────────────┬───────────────────────────┬────────────────────────────────────┘
               │ Docker socket             │ HTTPS
        ┌──────▼───────┐            ┌──────▼──────────┐
        │ ns-work net  │            │ Model providers  │
        │ ┌──────────┐ │            │ (Anthropic, …)   │
        │ │ sandbox  │─┼── gateway ─┤                  │
        │ │ + agent  │ │            └──────────────────┘
        │ └──────────┘ │
        └──────────────┘
```

All privileged work runs in one Rust process. The UI never holds raw secret values, except for a short window after the user explicitly clicks "Reveal".

---

## 3. Technology choices

| Concern | Choice | Why |
|---|---|---|
| Shell | **Tauri 2** | Native binary of about 10 MB, Rust backend, OS webview, multi-webview support for the browser |
| UI | React 18 + TypeScript + Vite | Already used by the prototype |
| State (UI) | Reducer store → later TanStack Query over IPC | Prototype store maps 1:1 to IPC commands |
| Persistence | SQLite via `rusqlite` (bundled) | Single file, embedded migrations (`PRAGMA user_version`), works offline, no build-time database |
| Secrets | `chacha20poly1305` + `keyring` crate | Encryption at rest; master key kept in the OS keychain |
| Containers | `bollard` (Docker API), Podman via its Docker-compatible socket | Same code path for both |
| MicroVMs | Firecracker (Linux only, phase 4) | Stronger isolation for untrusted code |
| Agent bus | Embedded NATS (`async-nats` + `nats-server` sidecar), one account per namespace | Pub/sub and request/reply, subject ACLs give namespace isolation |
| Tunnels | `boringtun` (userspace WireGuard), SSH (`russh`), optional cloudflared | No root needed for the default path |
| Async | `tokio` | — |

---

## 4. Components

### 4.1 Namespaces (isolation boundary)

Creating a namespace `X` creates:

| Resource | Isolation |
|---|---|
| Docker network `kalypso-ns-X` (internal, no default route) | Sandboxes in different namespaces can't reach each other |
| Vault data key `K_X`, wrapped by the master key | A leaked row from another namespace can't be decrypted with `K_X` |
| NATS account `X` | Agents can only publish and subscribe inside their own account |
| Webview data dir `…/profiles/X/` | Separate cookies, storage and logins in the browser and phone panels |
| Budget record | Its own spending limit |
| Gateway virtual keys tagged `ns=X` | Spend is charged to the correct namespace |

Every IPC command takes `ns` as its first argument. The `ipc` layer checks that each referenced entity belongs to `ns` before the command reaches any service, so a buggy view can't cross namespaces. Switching namespaces in the UI remounts the views; the prototype already does this with `key={state.ns}`.

### 4.2 Secrets vault
- Master key: 256-bit random, stored in the OS keychain (`keyring`). If no keychain service is reachable (headless Linux, WSL), it falls back to a `master.key` file in the app data dir with mode 0600; a passphrase-derived key (Argon2id) is planned as an alternative. The status bar shows which is in use.
- Each namespace has its own data key, encrypted ("wrapped") with the master key. Each secret is stored as `nonce ‖ ciphertext` in SQLite.
- **Delivery to agents:** when a sandbox starts, the vault decrypts the secrets the agent is allowed (namespace scope plus explicit agent grants). It mounts them as files in a tmpfs at `/run/kalypso/secrets/` and also exposes them as environment variables if the agent opted in.
- **Model API keys never enter sandboxes.** Agents call the gateway (§4.5) with a per-agent virtual key, and the gateway adds the real provider key.
- Revealing a secret in the UI requires a recent OS authentication (Touch ID, Windows Hello or polkit) when that's available. Every reveal is written to the audit log.

### 4.3 Sandboxes
- `SandboxSpec { runtime, image, cpu, mem_mb, network: isolated|namespace|internet, mounts, ports }`.
- **Docker/Podman.** Containers are labelled `kalypso.ns=X` and `kalypso.sandbox=<id>`. They run with a read-only root filesystem plus a writable `/work` volume, `--cap-drop=ALL`, `no-new-privileges` and a seccomp profile.
- Network modes:
  - `isolated`: no network at all.
  - `namespace`: joins `kalypso-ns-X` only.
  - `internet`: also allowed out through an egress proxy (squid or a Rust proxy) with an allow-list that can be configured per namespace.
- Port forwarding to `localhost`, so the Phone and Browser panels can show an app an agent is building.
- **Firecracker** (phase 4): same spec, run as a microVM through `firecracker-go-sdk` or a direct API client. Linux only; the option is hidden on other platforms.
- The UI gets live status from the Docker events stream, sent as `sandbox://status` events.

### 4.4 Agents and the supervisor
An agent is a declarative record (name, role, model, sandbox, skills, mcps, secrets, max_turns, autonomy level) plus a **runtime adapter**:

```rust
#[async_trait]
trait AgentRuntime {
    async fn start(&self, ctx: AgentCtx) -> Result<RunHandle>;
    async fn send(&self, run: &RunHandle, msg: Message) -> Result<()>;
    async fn stop(&self, run: &RunHandle) -> Result<()>;
    fn events(&self, run: &RunHandle) -> BoxStream<AgentEvent>; // turns, tool calls, artifacts
}
```

Adapters, in priority order:
1. **Claude Agent SDK.** A small Node or Python runner inside the sandbox, talking to the core over a Unix socket or NATS.
2. **Claude Code CLI** in headless mode (`claude -p --output-format stream-json`).
3. **Generic HTTP/A2A** agent, for agents you bring yourself.

The supervisor restarts agents according to a policy, enforces `max_turns` and pauses an agent when its budget runs out. It also turns agent events into UI events. Transcripts are stored per run, and the code and diffs inside them are rendered collapsed (code on demand).

### 4.5 Model gateway (budget enforcement)
A local HTTP proxy at `127.0.0.1:<port>`. Inside the namespace network, sandboxes reach it at `http://gateway.kalypso`.
- Each agent authenticates with a virtual key that maps to `(ns, agent)`.
- On every response the gateway reads `usage` (input, output and cache tokens), prices it from `pricing.toml`, and writes a `usage_events` row.
- **Before** forwarding a request, it checks the namespace and agent budgets. When a budget is exceeded the request is rejected with HTTP 402, and the supervisor marks the agent `paused:budget`.
- Alerts fire at `alert_at` (for example 80%) as a desktop notification.
- This is why the Budget view can show *enforced* limits and month-end projections.

### 4.6 Connections and tunnels (mesh)
- **Direct:** NATS subjects `ns.X.agent.<id>.inbox`. Each link is an ACL entry allowing A to publish to B's inbox (and the reverse, if two-way). Protocol envelopes cover A2A and MCP-over-NATS, plus an HTTP bridge.
- **Tunnel:** connects an agent to a service or agent on another machine. Uses userspace WireGuard (`boringtun`) with a peer config created in the UI, or an SSH reverse tunnel. The tunnel endpoint is attached only to `kalypso-ns-X`.
- **Relay:** an optional hosted or self-hosted relay for peers behind NAT (phase 4).
- The graph in the Connections view *is* the source of truth. Exporting it produces the topology manifest that the prototype shows behind "Show topology manifest".
- Health: a heartbeat every 10 s; the measured latency is shown on each link.

### 4.7 Skills and MCP registry
- **Skills** are folders containing a `SKILL.md`, installed from local paths or git. They are versioned, and mounted read-only into a sandbox at `/opt/kalypso/skills/<name>` when attached to an agent.
- **MCP servers** come in two kinds:
  - `stdio` servers run *inside* the agent's sandbox, so their filesystem access is limited by the sandbox.
  - `http` and `sse` servers are reached through the namespace network or the egress allow-list.
- For each agent, KALYPSO writes an `mcp.json` (shown behind "Show generated mcp.json").
- A health checker connects every 60 s and calls `tools/list` to fill in the tool count and health status.

### 4.8 Integrated browser
- Each tab is a Tauri 2 **child webview** placed in the content area (`Window::add_child`, behind the `unstable` feature). Unlike the prototype's iframe, it can't be blocked by `X-Frame-Options`.
- The webview data directory is set to `profiles/<ns>`, which keeps browser profiles separate per namespace.
- **Agent control (opt-in):** the core exposes a "browser" MCP server backed by the active namespace's webview. Its tools are navigate, click, type, read DOM and screenshot. A banner shows whenever an agent is driving the browser.

### 4.9 Phone panel
- **v1 (prototype direction):** a device-frame child webview with a mobile user agent and viewport presets. It's meant for previewing what agents build, usually through a sandbox's forwarded port.
- **Later:** mirror a real Android device or emulator via `scrcpy`, embedded as a video stream, with `adb` exposed as an MCP tool so agents can test on real devices.
- **Optional:** a telephony adapter (Twilio) so agents can place calls or send SMS, with every action gated by user approval.

### 4.10 Appearance
- Defaults: **Black** (pure `#000`) and **White** (pure `#fff`), with a purple accent as the only colour. Status uses the same palette: purple for healthy, grey for warning, inverted badges for errors.
- **Custom** theme: the user picks background, text and accent colours. Every other surface (borders, hover, muted text) is mixed from those with `color-mix`, so any combination stays consistent. A contrast check warns below 4.5:1, and button text switches between black and white automatically for the chosen accent.
- **Fonts**: seven bundled fonts (Geist, Inter, Manrope, DM Sans, IBM Plex Sans, Space Grotesk, JetBrains Mono) work offline. Any font installed on the computer can also be used by name. There are three UI sizes.
- Appearance belongs to the user account and is stored in `settings`, so it follows the user across machines once sync exists (phase 5).

### 4.11 "Code only when asked"
- One component (`CodeReveal`) is the only way code appears in the UI.
- There is a global "Show code" toggle in the top bar and in Settings, plus a reveal button on each block.
- Agent transcripts collapse tool inputs and outputs and file diffs into summaries such as "edited 3 files (+42 −7)". The full code is one click away.

### 4.12 Policies (guardrails)
Users write a policy in plain language ("Never force-push to main"). It is stored together with a **spec**, a rule the engine can check, which stays hidden unless code is requested. A policy has:
- **enforcement:** `block`, `approve` (ask the user) or `warn`
- **scope:** one namespace, or `*` for every namespace
- **targets:** all agents, or a list of agents
- **category:** filesystem, network, git, secrets, spend, comms, deploy or custom

**Enforcement points.** Each policy is checked at the place where the action can actually be stopped:

| Point | What it sees | How |
|---|---|---|
| Agent runtime hook | Every tool call (bash, edit, MCP tool, browser) *before* it runs | Claude Agent SDK `PreToolUse` hook / permission callback → `policy.check()` over a Unix socket |
| Model gateway (§4.5) | Every model request and its cost | Spend and runaway-run rules; secret-value scanning on prompts and outputs |
| Egress proxy | Every outbound host | Domain allow-list rules; `approve` turns into an approval prompt |
| Mesh (§4.6) | Agent-to-agent messages | Secret scanning; communication rules |

**Evaluation.** Rules with a fixed structure (path globs, command regexes, host lists, cost thresholds) are checked deterministically in Rust. A rule written only in free text is also checked by a small, fast model acting as a judge, with the action and the rule as input. The judge **fails closed**: if it times out, the action is blocked. `approve` pauses the agent and sends a desktop notification with Approve/Deny buttons, and the decision can be remembered for the rest of the run. Every decision is written to `policy_events`, which feeds the enforcement log in the UI.

**Defaults.** Every new namespace starts with these rules: never reveal secrets, stay inside the workspace, ask before new domains, ask before messages that impersonate the user, and stop runaway runs.

### 4.13 Integrations and brains
An integration connects an outside tool to a namespace. It always reaches agents **as an MCP server**, so it reuses the access model of §4.7.

| Kind | Transport |
|---|---|
| Obsidian | Vault folder mounted into permitted sandboxes, plus the Obsidian Local REST API plugin for search and links |
| Logseq, local folder | Folder mount plus a local BM25/embedding index |
| Notion, Confluence, Google Drive, GitHub, Linear, Slack | Their official or community MCP servers. The token comes from the vault |
| Any MCP server | Used as-is |
| REST / webhook | KALYPSO's OpenAPI→MCP bridge turns each endpoint into a tool |

- **Access** is either `read` or `read-write`, and is granted per agent. Write access is still subject to policies.
- **Brain flag.** Marking an integration as a brain gives every permitted agent a `memory` toolset (`recall`, `remember`, `link`) backed by that store. This gives agents shared long-term memory that persists across runs and that the user can read in their own app. With an Obsidian brain, for example, notes appear in the vault with `source: kalypso/<agent>` frontmatter.
- **Credentials** are vault secrets with `agent` scope, given only to the integration's MCP process, never to the agent itself.

### 4.14 Budget rules
These caps stack on top of the namespace's monthly limit:

- **Applies to:** the whole namespace, or one agent.
- **Period:** `per-run`, `daily` or `monthly`.
- **When hit:** `pause`, `alert` or `downgrade`. Downgrade switches the agent to a cheaper model tier until the period resets.

The gateway (§4.5) checks the tightest applicable rule before forwarding each request.

### 4.15 Experience principles
- **Command menu (⌘/Ctrl-K)** for every navigation and action. Every action also has a keyboard path.
- **Calm by default.** Code, specs and diffs stay collapsed. The ambient web can be turned off and honours `prefers-reduced-motion`.
- **Motion.** Only `transform` and `opacity` are animated, with spring-like curves. Blur is limited to fixed layers, apart from the Dark Blur theme's glass cards.
- **Fonts are bundled** (Geist, Geist Mono, Fraunces, Space Grotesk, Nunito via `@fontsource-variable`), so the app looks the same offline.

### 4.16 Accounts and sign-in
- Sign-in options are **Google, GitHub and GitLab** (OAuth 2.0 / OIDC) and **email with password**.
- **Desktop OAuth flow:** KALYPSO opens the provider in the system browser, never in an embedded webview, so users can trust the page. It uses **PKCE** with a one-time loopback redirect (`http://127.0.0.1:<random>/callback`) and falls back to a `kalypso://auth` deep link (`tauri-plugin-deep-link`).
- **Identity service:** a small backend (or a hosted provider such as Supabase Auth or Clerk) issues the KALYPSO session. A desktop-only install can skip the account entirely and work offline.
- **Tokens:** session and refresh tokens are kept in the OS keychain, never in `localStorage`.
- **Linked accounts:** GitHub and GitLab OAuth grants can be reused, with the user's consent, as credentials for the matching integrations (§4.13). Their scopes are requested step by step: identity scopes at sign-in, repo scopes only when an integration is added.
- **Passwords:** hashed with Argon2id on the server, plus email verification and rate-limited sign-in.

### 4.17 Monitoring (shown on the Overview)
- **Where the data comes from:**
  - The model gateway: requests, tokens, latency, errors and cost, per agent.
  - The Docker or Podman stats stream: CPU, memory and network per sandbox.
  - Supervisor heartbeats: agent liveness.
- **Storage:** a local time-series store, either SQLite tables bucketed per minute or DuckDB, kept for 30 days. Live updates reach the UI through the `metrics://tick` event every 2 seconds.
- **Optional export:** OpenTelemetry (OTLP) so teams can send the same metrics to Grafana or Datadog.

### 4.18 Agent tracker
- **Tasks** are the unit of work given to an agent. A task moves through `queued → running → review → done` or `failed`.
- **Updates:** the supervisor moves tasks as the agent works. A human moves a task from `review` to `done` (or back) by approving.
- **Links:** each task records its runs, cost, minutes and any PR it produced. Dragging a card on the board calls `task_move`.

### 4.19 Git tracker
- Pulls commits, PRs and CI status from the GitHub and GitLab APIs using the integration token (§4.13). It refreshes on webhooks where available, or polls every 60 seconds.
- **Agent attribution:** agent commits carry a `KALYPSO-Agent: <agent-id>` trailer and use `agent/<name>/…` branches. This separates agent work from human work without guessing, and powers the "Written by agents" share and the agents-vs-people chart.
- **Diffs** are fetched only when the user expands a commit, which keeps code hidden unless asked.

- **Overview contribution graph:** a GitHub-profile-style grid of daily commits for the last year. It can be filtered to agents or people, and uses the same agent attribution.

### 4.20 Terminal
- **Panes:** each terminal pane is an **xterm.js** view attached to a sandbox. The layout is a binary split tree (`PaneNode`), saved per namespace. Panes split right or down, the dividers can be dragged, and Ctrl+Shift+D / E / W split and close.
- **Backend:** each pane opens a PTY in Rust (`portable-pty`) running `docker exec -it <container> sh`, or a microVM console. Bytes stream over Tauri IPC (`term://data/<pane>`), and resizes go through `term_resize`.
- **Scrollback:** sessions outlive the React view, so a pane keeps its scrollback while the layout around it changes.
- **Policies:** terminal input from a person is not subject to agent policies, but an agent typing into a shared pane is.

---

## 5. Data model (SQLite)

```
namespaces(id PK, name, color, description, created_at)
sandboxes(id PK, ns FK, name, runtime, image, cpu, mem_mb, network, status, container_ref, created_at)
agents(id PK, ns FK, name, role, model, runtime, sandbox_id FK?, autonomy, max_turns, config_json, status)
agent_skills(agent_id, skill_id)          agent_mcps(agent_id, mcp_id)
secrets(id PK, ns FK, key, ciphertext, nonce, scope, updated_at)
secret_grants(secret_id, agent_id)
connections(id PK, ns FK, from_agent, to_agent, kind, protocol, config_json, status)
tunnels(id PK, ns FK, kind, peer_config_enc, endpoint, status)
budgets(ns PK, monthly_limit_usd, alert_at)
budget_rules(id PK, ns FK, target, period, limit_usd, action)
policies(id PK, ns|'*', name, rule_text, spec, category, enforcement, applies_to_json, enabled)
policy_events(id PK, ns, policy_id, agent_id, outcome, detail, ts)
integrations(id PK, ns FK, kind, name, target, access, brain, secret_id?, status, last_sync)
integration_grants(integration_id, agent_id)
usage_events(id PK, ns, agent_id, model, in_tok, out_tok, cache_tok, cost_usd, ts)
skills(id PK, name, version, source, path, enabled)
mcp_servers(id PK, name, transport, endpoint, env_secret_ids, enabled, health, tools)
runs(id PK, agent_id, started_at, ended_at, status, transcript_path)
audit_log(id PK, ns, actor, action, target, ts)
settings(key PK, value)
accounts(id PK, name, email, provider, linked_json, created_at)        -- tokens live in the OS keychain
tasks(id PK, ns FK, title, agent_id, status, priority, progress, started_at, minutes, cost_usd, pr_ref)
metrics(ts, ns, source, key, value)                                    -- per-minute buckets, 30-day retention
repos(id PK, ns FK, host, name, default_branch, integration_id)
commits(sha PK, repo_id, author, is_agent, branch, additions, deletions, ts)
pull_requests(id PK, repo_id, number, title, author, is_agent, ci, review, updated_at)
```

The TypeScript types in `src/types.ts` mirror these records. Rust structs derive `serde` and are exported to TypeScript with `ts-rs` so the two can't drift apart.

---

## 6. IPC surface (Tauri commands)

All commands are `async`, return `Result<T, KALYPSOError>` and take `ns` first.

```
ns_list / ns_create / ns_delete
sandbox_list / sandbox_create / sandbox_start / sandbox_pause / sandbox_stop / sandbox_delete / sandbox_logs
agent_list / agent_create / agent_update / agent_start / agent_stop / agent_send / agent_runs
secret_list (metadata only) / secret_set / secret_reveal (auth-gated) / secret_delete / secret_grant
connection_list / connection_create / connection_delete / tunnel_create / tunnel_delete
budget_get / budget_set / budget_rule_add / budget_rule_delete / usage_daily / usage_by_agent
policy_list / policy_create / policy_update / policy_delete / policy_events / policy_decide (approve|deny)
integration_list / integration_connect / integration_grant / integration_set_brain / integration_sync / integration_disconnect
skill_list / skill_install / skill_toggle / mcp_list / mcp_add / mcp_toggle / mcp_check
browser_open_tab / browser_close_tab / browser_navigate
settings_get / settings_set / appearance_set
auth_begin(provider) / auth_complete / auth_sign_out / auth_link(provider) / auth_session
task_list / task_create / task_move / task_delete
metrics_query(ns, keys, range) / metrics_subscribe
git_commits(ns, repo?, who?) / git_pull_requests / git_diff(sha) / git_contributions(ns, year)
term_open(ns, sandbox) / term_write(pane, bytes) / term_resize(pane, cols, rows) / term_close(pane)
```

Events (Rust → UI): `sandbox://status`, `agent://event`, `mesh://link`, `budget://alert`, `mcp://health`, `policy://approval-needed`, `policy://event`, `integration://sync`.

Migration from the prototype: each `dispatch({type: …})` in `src/store.tsx` is replaced by an `invoke(...)`, and the reducer just applies the result or the incoming event. The views don't change.

---

## 7. Security model (summary)

| Threat | Mitigation |
|---|---|
| Agent reads another namespace's data | Separate Docker networks, NATS accounts, vault keys and webview profiles. IPC checks `ns` on every command |
| Agent leaks the provider API key | The key never enters a sandbox; the gateway adds it |
| Agent runs up costs | The gateway checks the budget before every request (HTTP 402) |
| Agent escapes its container | cap-drop, seccomp, read-only root, non-root user; Firecracker for untrusted work |
| Agent sends data out | `isolated` and `namespace` network modes; egress allow-list for `internet`; secret-scanning policy at the gateway and on the mesh |
| Agent does something destructive | Policy engine checks every tool call before it runs (block, ask or warn) |
| An integration exposes too much | Access granted per agent, read-only by default for non-brain integrations, credentials kept away from the agent |
| Prompt injection via the browser | Agents can drive the browser only when you opt in, with a visible indicator and per-namespace profiles |
| Malicious skill or MCP | Mounted read-only, stdio MCPs run inside the sandbox, install needs confirmation and shows the source |

---

## 8. Repository layout

```
kalypso/
├─ src/                    React UI (prototype)
│  ├─ components/          Sidebar, Topbar, shared UI (CodeReveal, Modal, …)
│  ├─ views/               one file per section
│  ├─ store.tsx            reducer store → becomes the IPC client
│  ├─ mock.ts              seed data
│  ├─ themes.ts / styles.css
├─ src-tauri/              Rust core
│  └─ src/  (planned) ipc/ ns/ store/ vault/ sandbox/ agents/ gateway/ mesh/ registry/ events/
└─ docs/ARCHITECTURE.md
```

---

## 9. Roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 — Prototype** ✅ | All screens, black/white/custom themes and fonts, sign-in, tracker, monitoring, Git activity, policies, integrations, budget rules, mock data | Clickable app (`npm run tauri dev`) |
| **1 — Core** | SQLite store, namespaces, vault, Docker sandboxes, IPC replacing mocks | Create a namespace → sandbox → secret, all persisted and isolated |
| **2 — Agents, budget and policies** | Supervisor + Claude Agent SDK adapter, model gateway, budget rules, policy engine (deterministic rules + approvals) | An agent is blocked from force-pushing and paused when its daily cap is hit |
| **3 — Mesh, registry and integrations** | NATS bus, direct links, skills and MCP install, Obsidian/Notion/GitHub integrations, brain memory toolset, judge-model policies | An agent writes a note to the Obsidian brain that another agent recalls the next day |
| **4 — Reach** | WireGuard/SSH tunnels, relay, browser child webviews and agent control, Firecracker, Android mirror | Agent tests a web app on a phone preview and reports back |
| **5 — Team** | Accounts (Google/GitHub/GitLab/email), sync server, shared namespaces, RBAC | Sign in on a second machine and see the same namespaces and appearance |

---

## 10. Open questions
1. **Agent runtimes:** is Claude-only acceptable for v1, or are other providers needed from the start? (This affects how general the gateway's pricing and parsing must be.)
2. **Phone:** is a device-frame preview enough, or is the Android mirror or telephony a near-term need?
3. **Remote sandboxes:** local Docker only, or should a namespace be able to target a remote Docker host or Kubernetes cluster?
4. **Sync:** should a namespace be exportable or importable (encrypted bundle) between machines?
