// KALYPSO agent runner: runs one Claude Agent SDK agent inside a sandbox.
//
// The core starts it with `node runner.mjs` and talks to it over stdio:
//   stdin   one JSON object per line: {"type":"message","text":"..."}
//   stdout  one JSON object per line: {"t":"<kind>", ...} (see emit() calls below)
//
// Model calls go to the KALYPSO gateway over its Unix socket, through a loopback
// shim, with the sandbox's virtual key; the real provider key never enters the
// sandbox. Every tool call is checked against the namespace's policies first.

import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";

const SOCK = process.env.KALYPSO_GATEWAY_SOCK || "/run/kalypso/gateway/gateway.sock";
const KEY_FILE = process.env.KALYPSO_GATEWAY_KEY_FILE || "/run/kalypso/secrets/KALYPSO_GATEWAY_KEY";
const AGENT_ID = process.env.KALYPSO_AGENT_ID || "agent";
const STATE = path.join(process.env.KALYPSO_STATE_DIR || "/work/.kalypso", "agents", AGENT_ID);
const MAX_TEXT = 8000;

const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const clip = (s, n = MAX_TEXT) => (s.length > n ? s.slice(0, n) + ` … (${s.length - n} more characters)` : s);
const fail = (text, code = 2) => {
  emit({ t: "error", text });
  process.exit(code);
};

let key;
try {
  key = fs.readFileSync(KEY_FILE, "utf8").trim();
} catch {
  fail("This sandbox has no KALYPSO gateway key. Restart the sandbox so KALYPSO can deliver one.");
}
// Linux engines mount the gateway's socket; engines in a VM (Docker Desktop, Podman
// machine) can't, and reach it over a private network instead (KALYPSO_GATEWAY_URL).
const RELAY = process.env.KALYPSO_GATEWAY_URL;
const viaSocket = fs.existsSync(SOCK);
if (!viaSocket && !RELAY) fail("This sandbox has no way to reach the KALYPSO gateway (no socket, no KALYPSO_GATEWAY_URL).");
/** Where gateway requests go: the socket, or the relay's host and port. */
const target = viaSocket ? { socketPath: SOCK } : (() => { const u = new URL(RELAY); return { host: u.hostname, port: Number(u.port || 80) }; })();

// The SDK speaks TCP; over a socket, pipe a loopback port to it. The relay is TCP already.
let shim = null;
let base = RELAY;
if (viaSocket) {
  shim = net.createServer((client) => {
    const upstream = net.connect(SOCK);
    client.pipe(upstream).pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  await new Promise((resolve) => shim.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${shim.address().port}`;
}

/** Ask KALYPSO whether a tool call may run. Approvals hold the answer until the user decides. */
function check(call) {
  return new Promise((resolve) => {
    const body = JSON.stringify(call);
    const req = http.request(
      {
        ...target,
        path: "/_kalypso/policy/check",
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const d = JSON.parse(data);
            if (res.statusCode !== 200) return resolve({ decision: "deny", reason: `KALYPSO could not check this call: ${d.error || res.statusCode}` });
            resolve(d);
          } catch {
            resolve({ decision: "deny", reason: "KALYPSO's policy check answered with something unreadable" });
          }
        });
      },
    );
    // Fail closed: if KALYPSO cannot be asked, the call does not run.
    req.on("error", (e) => resolve({ decision: "deny", reason: `KALYPSO's policy check is unreachable: ${e.message}` }));
    req.end(body);
  });
}

/** Translate an SDK tool call into the policy engine's terms. */
export function toolCall(name, input = {}) {
  const s = (v) => (typeof v === "string" ? v : undefined);
  switch (name) {
    case "Bash":
      return { kind: "bash", command: s(input.command) };
    case "Read":
    case "Glob":
    case "Grep":
    case "LS":
      return { kind: "file_read", path: s(input.file_path) ?? s(input.path) ?? s(input.pattern) };
    case "Write":
      return { kind: "file_write", path: s(input.file_path), content: s(input.content) };
    case "Edit":
    case "MultiEdit":
      return { kind: "file_write", path: s(input.file_path), content: s(input.new_string) ?? JSON.stringify(input.edits ?? "") };
    case "NotebookEdit":
      return { kind: "file_write", path: s(input.notebook_path), content: s(input.new_source) };
    case "WebFetch":
      return { kind: "http", url: s(input.url) };
    case "WebSearch":
      return { kind: "web_search", content: s(input.query) };
    default:
      if (name.startsWith("mcp__")) return { kind: "mcp", tool: name, content: clip(JSON.stringify(input), 4000) };
      return { kind: name.toLowerCase(), tool: name, content: clip(JSON.stringify(input), 4000) };
  }
}

/** One line for the transcript: the tool and what it is acting on. */
export function summary(name, input = {}) {
  const target = input.command ?? input.file_path ?? input.notebook_path ?? input.url ?? input.query ?? input.pattern ?? input.path ?? input.description;
  return target ? `${name}  ${String(target).split("\n")[0].slice(0, 300)}` : name;
}

const preToolUse = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  const d = await check(toolCall(input.tool_name, input.tool_input));
  for (const w of d.warnings ?? []) emit({ t: "policy", text: `Warning: ${w}` });
  if (d.decision === "deny") {
    const reason = d.reason || "Blocked by a KALYPSO policy.";
    emit({ t: "policy", text: `Blocked ${summary(input.tool_name, input.tool_input)}: ${reason}` });
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
  }
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
};

// Messages: the agent's task first, then whatever arrives on stdin, until stdin closes.
const queue = [];
let wake = null;
let closed = false;
const push = (text) => {
  queue.push(text);
  wake?.();
};
{
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const m = JSON.parse(line);
      if (m.type === "message" && typeof m.text === "string" && m.text.trim()) push(m.text);
    } catch {
      push(line); // a plain line is a message too
    }
  });
  rl.on("close", () => {
    closed = true;
    wake?.();
  });
}
const task = (process.env.KALYPSO_TASK || "").trim();
if (task) push(task);

async function* messages() {
  for (;;) {
    while (queue.length) {
      yield { type: "user", message: { role: "user", content: queue.shift() }, parent_tool_use_id: null, session_id: "" };
    }
    if (closed) return;
    await new Promise((r) => (wake = r));
    wake = null;
  }
}

// Resume the previous conversation after a restart, so a crash does not redo finished work.
fs.mkdirSync(path.join(STATE, "home"), { recursive: true });
const sessionFile = path.join(STATE, "session");
const resume = fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, "utf8").trim() || undefined : undefined;

const maxTurns = Number(process.env.KALYPSO_MAX_TURNS) || undefined;
const role = (process.env.KALYPSO_ROLE || "").trim();
const append = [
  `You are ${process.env.KALYPSO_AGENT || "an agent"}, running inside a KALYPSO sandbox. Your working directory is /work.`,
  "KALYPSO checks every tool call against the workspace's policies. If a call is blocked, the reason says why: do not try to get around it, find another way or explain what you need.",
  "Secrets marked on-request are not in your environment. To run a command that needs one, use: kx-secret run NAME --purpose \"why\" -- <command>. KALYPSO runs that command with the secret (after approval if needed) and shows you its output with the value hidden. Never try to read, print or copy secret values.",
  role && `Your role: ${role}`,
]
  .filter(Boolean)
  .join("\n");

const options = {
  model: process.env.KALYPSO_MODEL || undefined,
  cwd: process.env.KALYPSO_CWD || "/work",
  maxTurns,
  resume,
  // KALYPSO is the permission system: the hook below asks it about every call.
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  hooks: { PreToolUse: [{ hooks: [preToolUse], timeout: 900 }] },
  systemPrompt: { type: "preset", preset: "claude_code", append },
  settingSources: ["project"],
  env: {
    ...process.env,
    ANTHROPIC_BASE_URL: `${base}/anthropic`,
    ANTHROPIC_API_KEY: key,
    // The image's root file system is read-only; keep the SDK's files with the agent.
    HOME: path.join(STATE, "home"),
    CLAUDE_CONFIG_DIR: path.join(STATE, "claude"),
    IS_SANDBOX: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  },
};

try {
  for await (const m of query({ prompt: messages(), options })) {
    if (m.type === "system" && m.subtype === "init") {
      fs.writeFileSync(sessionFile, m.session_id);
      emit({ t: "ready", text: `${m.model} · ${m.tools.length} tools${resume ? " · resumed" : ""}` });
    } else if (m.type === "assistant") {
      for (const b of m.message.content ?? []) {
        if (b.type === "text" && b.text.trim()) emit({ t: "text", text: clip(b.text) });
        else if (b.type === "tool_use") emit({ t: "tool", text: summary(b.name, b.input) });
      }
      if (m.error) emit({ t: "error", text: `Model call failed: ${m.error}` });
    } else if (m.type === "user" && Array.isArray(m.message.content)) {
      for (const b of m.message.content) {
        if (b.type !== "tool_result") continue;
        const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => c.text ?? "").join("\n");
        if (text.trim()) emit({ t: "output", text: clip(text, 2000), error: !!b.is_error });
      }
    } else if (m.type === "result") {
      const ok = m.subtype === "success" && !m.is_error;
      const cost = typeof m.total_cost_usd === "number" ? ` · about $${m.total_cost_usd.toFixed(4)}` : "";
      const turns = `${m.num_turns} turn${m.num_turns === 1 ? "" : "s"}`;
      const what = {
        success: "Done",
        error_max_turns: `Stopped at its limit of ${maxTurns} turns`,
        error_max_budget_usd: "Stopped at its budget",
        error_during_execution: "Stopped by an error",
      }[m.subtype] ?? m.subtype;
      emit({ t: "result", ok, text: `${what} · ${turns}${cost}` });
    }
  }
} catch (e) {
  fail(`The agent stopped: ${e?.message ?? e}`, 1);
}
// stdin closed: the conversation is over. How the last task went is in the result event.
shim?.close();
process.exit(0);
