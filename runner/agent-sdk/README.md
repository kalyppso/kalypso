# KALYPSO agent runner

The sandbox image for **Claude Agent SDK** agents: Node 22, the SDK, and
`runner.mjs`, which KALYPSO starts inside the sandbox for each run.

- **Model calls** go to the KALYPSO gateway over `/run/kalypso/gateway/gateway.sock`, through a loopback shim. They use the sandbox's virtual key from `/run/kalypso/secrets/KALYPSO_GATEWAY_KEY`. The provider key never enters the sandbox, and the gateway meters and budgets every call.
- **Every tool call** is first sent to KALYPSO's policy engine (`POST /_kalypso/policy/check`):
  - A denied call does not run, and Claude is told why.
  - Approval policies hold the call until you answer.
  - If KALYPSO cannot be reached, the call is denied.
- **Secrets on request:** `kx-secret run NAME --purpose "why" -- <command>` asks KALYPSO to run one command with an on-request secret in its environment. KALYPSO runs it as another user, after approval if a policy or you require it, and sends back its output with the value replaced by `‹NAME›`. The agent never holds the value (see ARCHITECTURE §4.2).
- **State** lives in `/work/.kalypso/agents/<id>/`, so a restarted agent resumes its conversation.

## Protocol

KALYPSO talks to the runner over standard input and output, one JSON object per line.

| Direction | Shape |
|---|---|
| in  | `{"type":"message","text":"…"}` |
| out | `{"t":"ready" \| "text" \| "tool" \| "output" \| "policy" \| "result" \| "error","text":"…"}` |

The agent's settings come from environment variables:
- `KALYPSO_AGENT` and `KALYPSO_AGENT_ID`
- `KALYPSO_MODEL`
- `KALYPSO_ROLE`
- `KALYPSO_TASK` (the first message)
- `KALYPSO_MAX_TURNS`

## Build

```sh
podman build -t ghcr.io/kalyppso/agent-runner:dev runner/agent-sdk
KALYPSO_TEST_RUNTIME=1 cargo test --manifest-path src-tauri/Cargo.toml --test agent_sdk
```

To use your own tools, build `FROM ghcr.io/kalyppso/agent-runner:latest`.
