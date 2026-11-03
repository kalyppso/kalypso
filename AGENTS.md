## Agent skills

### Issue tracker

Issues live as GitHub issues in this repo's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles mapped to matching label strings. See `docs/agents/triage-labels.md`.

### Domain docs

single-context layout: one `GLOSSARY.md` at the repo root plus `docs/adr/`. See `docs/agents/domain.md`.

## Project conventions

- **Commits and PR titles** follow [Conventional Commits](https://www.conventionalcommits.org): `type(scope): subject`, lowercase subject, no trailing period. Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`. CI checks PR titles; PRs are squash-merged with the title as the commit.
- **Labels**: `area: *` for the subsystem (core, sandbox, agents, vault, gateway, policy, mesh, integrations, terminal, auth, ui, observability), `p0` / `p1` / `p2` for priority, plus the triage labels above.
- **Milestones** are the roadmap phases; the pinned [Roadmap](https://github.com/kalyppso/kalypso/issues/41) issue lists every issue per phase. Tick its box when an issue closes.
- **Architecture**: `docs/ARCHITECTURE.md` is the design reference; update the relevant section in the same PR as the change.
- **Types across IPC** are generated from Rust with `ts-rs` into `src/bindings/` by `cargo test`; commit them, don't edit them by hand.
- **Checks** before a PR: `npm run build`, and in `src-tauri/` `cargo fmt --check`, `cargo clippy --all-targets` and `cargo test`. Container tests run with `KALYPSO_TEST_RUNTIME=1` against Docker or Podman.
