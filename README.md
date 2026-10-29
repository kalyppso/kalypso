# KALYPSO

Desktop workspace for your AI agents: sandboxes, secrets, agents, budgets, skills & MCPs, agent-to-agent connections and tunnels, an integrated browser and phone preview — all separated by namespaces.

Status: **UI prototype** on mock data. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design and roadmap.

## Run

Prerequisites: Node 20+, Rust (stable, via rustup), and Tauri's system deps
(Linux: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev`; see https://tauri.app/start/prerequisites/).

```bash
npm install
npm run tauri dev     # desktop app
npm run dev           # UI only, in a browser at http://localhost:1420
npm run tauri build   # installers in src-tauri/target/release/bundle
```

## Backend (Phase 1)
The desktop build talks to a Rust core (`src-tauri/src/`): SQLite store, namespaces, an encrypted secrets vault and sandboxes on Docker or Podman. In a plain browser (`npm run dev`) the UI falls back to sample data.

- Sandboxes need Docker, or Podman with its API socket: `systemctl --user enable --now podman.socket`.
- Tests: `cd src-tauri && cargo test`. Add `KALYPSO_TEST_RUNTIME=1` to also run the real container lifecycle test.
- Generated TypeScript types live in `src/bindings/` (refreshed by `cargo test`).

## Tour
- **Ctrl/⌘ K** opens the command menu: jump anywhere, switch namespace or theme, toggle code.
- **Namespace switcher** (top-left): everything you see is scoped to it.
- **Themes** (top-right): Void (default), Dark Blur, Cappuccino, Blossom, Ocean, Daylight.
- **Code** toggle: code stays hidden unless this is on or you click "Show …" on a block.
- **Policies**: plain-language guardrails ("Never force-push to main") with Block / Ask me / Warn.
- **Integrations**: connect Obsidian, Notion, GitHub, any MCP or REST API; mark one as a *Brain* for shared agent memory.
- **Budget**: monthly limit plus per-agent / daily / per-run caps that pause, alert or downgrade.
- **Connections**: click an agent, then another agent or an integration, to wire them together.
- The spider is clickable. Settings → *Ambient web* turns the motion off.
