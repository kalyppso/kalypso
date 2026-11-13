// KALYPSO agent runner for any OpenAI-compatible model: OpenAI, OpenRouter, Ollama, vLLM,
// LM Studio, or anything else that speaks /chat/completions with tools.
//
//   env     KALYPSO_PROVIDER  the gateway route (openai, openrouter, ollama, …)
//           KALYPSO_MODEL     the model name at that provider
//           KALYPSO_TASK      the first task, KALYPSO_ROLE, KALYPSO_MAX_TURNS, KALYPSO_REPO*
//   stdin   one JSON object per line: {"type":"message","text":"..."}
//   stdout  one JSON event per line: {"t":"ready"|"text"|"tool"|"output"|"policy"|"result"|"error","text":...}
//
// Model calls go through the KALYPSO gateway (socket or relay) with the sandbox's virtual key;
// the provider's real key and base URL are gateway secrets and never enter the sandbox. Every
// tool call is checked by KALYPSO's policy engine first, and a blocked call never runs.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";

const SOCK = process.env.KALYPSO_GATEWAY_SOCK || "/run/kalypso/gateway/gateway.sock";
const KEY_FILE = process.env.KALYPSO_GATEWAY_KEY_FILE || "/run/kalypso/secrets/KALYPSO_GATEWAY_KEY";
const AGENT = process.env.KALYPSO_AGENT || "agent";
const AGENT_ID = process.env.KALYPSO_AGENT_ID || "agent";
const PROVIDER = process.env.KALYPSO_PROVIDER || "";
const MODEL = process.env.KALYPSO_MODEL || "";
const STATE = path.join(process.env.KALYPSO_STATE_DIR || "/work/.kalypso", "agents", AGENT_ID);
const MAX_OUT = 20000;
// 0 means no limit; still stop a runaway loop eventually.
const MAX_TURNS = Number(process.env.KALYPSO_MAX_TURNS) || 200;
const WORK = process.env.KALYPSO_REPO_DIR || process.env.KALYPSO_CWD || "/work";

const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const clip = (s, n = MAX_OUT) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s);
const fail = (text, code = 2) => {
  emit({ t: "error", text });
  process.exit(code);
};

if (!PROVIDER || !MODEL) fail("This agent has no model. Set it as provider/model, for example ollama/llama3.1.");
let key;
try {
  key = fs.readFileSync(KEY_FILE, "utf8").trim();
} catch {
  fail("This sandbox has no KALYPSO gateway key. Restart the sandbox so KALYPSO can deliver one.");
}
const RELAY = process.env.KALYPSO_GATEWAY_URL;
const viaSocket = fs.existsSync(SOCK);
if (!viaSocket && !RELAY) fail("This sandbox has no way to reach the KALYPSO gateway (no socket, no KALYPSO_GATEWAY_URL).");
const target = viaSocket ? { socketPath: SOCK } : (() => { const u = new URL(RELAY); return { host: u.hostname, port: Number(u.port || 80) }; })();

/** POST JSON to the gateway; resolves to { status, body } (body parsed when it's JSON). */
function post(urlPath, payload, timeoutMs = 600_000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      { ...target, path: urlPath, method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = data;
          try { parsed = JSON.parse(data); } catch { /* not JSON: keep the text */ }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`)));
    req.on("error", reject);
    req.end(body);
  });
}

/** Ask KALYPSO whether a tool call may run. Fails closed. */
async function check(call) {
  try {
    const { status, body } = await post("/_kalypso/policy/check", call, 3_600_000);
    if (status !== 200 || typeof body !== "object") return { decision: "deny", reason: `KALYPSO could not check this call (${status})` };
    return body;
  } catch (e) {
    return { decision: "deny", reason: `KALYPSO's policy check is unreachable: ${e.message}` };
  }
}

// ---------- Tools ----------

const inWork = (p) => path.resolve(WORK, String(p ?? "."));

const TOOLS = [
  {
    name: "bash",
    description: "Run a shell command in the sandbox (bash). Returns its output and exit code. Use it to run tests, git, build tools and so on.",
    parameters: { type: "object", properties: { command: { type: "string" }, timeout_seconds: { type: "integer", description: "default 120, at most 1800" } }, required: ["command"] },
    policy: (a) => ({ kind: "bash", command: a.command }),
    summary: (a) => a.command,
    run: (a) => new Promise((resolve) => {
      const limit = Math.min(Math.max(Number(a.timeout_seconds) || 120, 1), 1800) * 1000;
      const child = spawn("/bin/bash", ["-lc", String(a.command ?? "")], { cwd: WORK, env: process.env });
      let out = "";
      const add = (c) => { if (out.length < MAX_OUT * 2) out += c; };
      child.stdout.on("data", add);
      child.stderr.on("data", add);
      const timer = setTimeout(() => { child.kill("SIGKILL"); add(`\n(stopped after ${limit / 1000} s)`); }, limit);
      child.on("close", (code) => { clearTimeout(timer); resolve(`${clip(out) || "(no output)"}\n[exit ${code}]`); });
      child.on("error", (e) => { clearTimeout(timer); resolve(`could not run: ${e.message}`); });
    }),
  },
  {
    name: "read_file",
    description: "Read a text file. Paths are relative to your working directory unless absolute.",
    parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer", description: "first line, from 1" }, limit: { type: "integer", description: "how many lines" } }, required: ["path"] },
    policy: (a) => ({ kind: "file_read", path: inWork(a.path) }),
    summary: (a) => a.path,
    run: async (a) => {
      const lines = fs.readFileSync(inWork(a.path), "utf8").split("\n");
      const from = Math.max(Number(a.offset) || 1, 1) - 1;
      const to = a.limit ? from + Number(a.limit) : lines.length;
      return clip(lines.slice(from, to).map((l, i) => `${from + i + 1}\t${l}`).join("\n"));
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with this content.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    policy: (a) => ({ kind: "file_write", path: inWork(a.path), content: String(a.content ?? "").slice(0, 4000) }),
    summary: (a) => a.path,
    run: async (a) => {
      fs.mkdirSync(path.dirname(inWork(a.path)), { recursive: true });
      fs.writeFileSync(inWork(a.path), String(a.content ?? ""));
      return `wrote ${inWork(a.path)} (${Buffer.byteLength(String(a.content ?? ""))} bytes)`;
    },
  },
  {
    name: "edit_file",
    description: "Replace one exact piece of text in a file with another. old_text must appear exactly once.",
    parameters: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] },
    policy: (a) => ({ kind: "file_write", path: inWork(a.path), content: String(a.new_text ?? "").slice(0, 4000) }),
    summary: (a) => a.path,
    run: async (a) => {
      const file = inWork(a.path);
      const text = fs.readFileSync(file, "utf8");
      const n = text.split(String(a.old_text)).length - 1;
      if (n !== 1) return `not changed: old_text appears ${n} times in ${file} (it must appear exactly once)`;
      fs.writeFileSync(file, text.replace(String(a.old_text), String(a.new_text)));
      return `edited ${file}`;
    },
  },
  {
    name: "list_files",
    description: "List a directory's entries (directories end with /).",
    parameters: { type: "object", properties: { path: { type: "string", description: "default: your working directory" } } },
    policy: (a) => ({ kind: "file_read", path: inWork(a.path) }),
    summary: (a) => a.path || ".",
    run: async (a) => {
      const entries = fs.readdirSync(inWork(a.path), { withFileTypes: true });
      return entries.map((e) => e.name + (e.isDirectory() ? "/" : "")).sort().join("\n") || "(empty)";
    },
  },
];
const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
const toolSpecs = TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

// ---------- The conversation ----------

const role = (process.env.KALYPSO_ROLE || "").trim();
const repo = process.env.KALYPSO_REPO;
const branch = process.env.KALYPSO_BRANCH;
const system = [
  `You are ${AGENT}, an agent running inside a KALYPSO sandbox. Your working directory is ${WORK}. You act through tools: bash, read_file, write_file, edit_file and list_files.`,
  "KALYPSO checks every tool call against the workspace's policies. If a call is blocked, the reason says why: do not try to get around it, find another way or explain what you need.",
  "Secrets marked on-request are not in your environment. To run a command that needs one, use: kx-secret run NAME --purpose \"why\" -- <command>. Never try to read, print or copy secret values.",
  repo && `You work in the GitHub repository ${repo}, cloned at ${WORK}, on your own branch ${branch}. Commit your work there. To share it, push your branch (git push -u origin ${branch}) and open a pull request with: gh-api POST /repos/${repo}/pulls '{"title":"…","head":"${branch}","base":"<default branch>","body":"…"}'. Never push to main or master, and never force-push.`,
  "Work step by step, check your results (run the tests), and finish with a short summary of what you did.",
  role && `Your role: ${role}`,
].filter(Boolean).join("\n");

fs.mkdirSync(STATE, { recursive: true });
const historyFile = path.join(STATE, "openai-messages.json");
let messages = [{ role: "system", content: system }];
try {
  // After a restart, carry on the same conversation.
  const saved = JSON.parse(fs.readFileSync(historyFile, "utf8"));
  if (Array.isArray(saved) && saved.length) messages = [{ role: "system", content: system }, ...saved.filter((m) => m.role !== "system")];
} catch { /* first run */ }
const save = () => { try { fs.writeFileSync(historyFile, JSON.stringify(messages.slice(1))); } catch { /* best effort */ } };

function modelError(status, body) {
  const msg = typeof body === "object" ? body?.error?.message ?? body?.error ?? body?.message ?? JSON.stringify(body) : String(body);
  if (status === 401) return `The gateway has no working key for ${PROVIDER}: ${msg}. Add ${PROVIDER.toUpperCase().replace(/-/g, "_")}_API_KEY (gateway scope) in the Vault page.`;
  if (status === 400 && /BASE_URL/.test(msg)) return `${msg}. Add ${PROVIDER.toUpperCase().replace(/-/g, "_")}_BASE_URL (gateway scope) in the Vault page, for example http://localhost:11434/v1 for Ollama on this machine.`;
  if (status === 402) return `Budget: ${msg}`;
  return `${PROVIDER} answered ${status}: ${msg}`;
}

async function work(task) {
  messages.push({ role: "user", content: task });
  let turns = 0;
  const tokens = { in: 0, out: 0 };
  while (turns < MAX_TURNS) {
    turns++;
    let res;
    try {
      res = await post(`/${PROVIDER}/chat/completions`, { model: MODEL, messages, tools: toolSpecs, tool_choice: "auto" });
    } catch (e) {
      emit({ t: "error", text: `Couldn't reach the model through KALYPSO: ${e.message}` });
      return;
    }
    if (res.status !== 200 || typeof res.body !== "object") {
      emit({ t: "error", text: modelError(res.status, res.body) });
      return;
    }
    tokens.in += res.body.usage?.prompt_tokens ?? 0;
    tokens.out += res.body.usage?.completion_tokens ?? 0;
    const msg = res.body.choices?.[0]?.message;
    if (!msg) {
      emit({ t: "error", text: `${PROVIDER} answered without a message.` });
      return;
    }
    // Keep only what the API accepts back.
    messages.push({ role: "assistant", content: msg.content ?? "", ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
    if (msg.content?.trim()) emit({ t: "text", text: msg.content.trim() });
    const calls = msg.tool_calls ?? [];
    if (!calls.length) break;
    for (const call of calls) {
      const tool = byName[call.function?.name];
      let args = {};
      try { args = JSON.parse(call.function?.arguments || "{}"); } catch { /* left empty: the tool reports what's missing */ }
      let result;
      if (!tool) {
        result = `There is no tool called ${call.function?.name}. Use one of: ${TOOLS.map((t) => t.name).join(", ")}.`;
      } else {
        const label = `${tool.name}  ${String(tool.summary(args) ?? "").split("\n")[0].slice(0, 300)}`;
        emit({ t: "tool", text: label });
        const d = await check(tool.policy(args));
        for (const w of d.warnings ?? []) emit({ t: "policy", text: `Warning: ${w}` });
        if (d.decision === "deny") {
          const reason = d.reason || "Blocked by a KALYPSO policy.";
          emit({ t: "policy", text: `Blocked ${label}: ${reason}` });
          result = `Blocked by KALYPSO: ${reason}`;
        } else {
          try {
            result = await tool.run(args);
          } catch (e) {
            result = `failed: ${e.message}`;
          }
          emit({ t: "output", text: clip(result, 4000) });
        }
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: clip(String(result)) });
    }
    save();
  }
  save();
  const used = tokens.in || tokens.out ? ` · ${tokens.in.toLocaleString()} in, ${tokens.out.toLocaleString()} out tokens` : "";
  emit({ t: "result", text: turns >= MAX_TURNS ? `Stopped at the limit of ${MAX_TURNS} turns${used}` : `Done · ${turns} turn${turns === 1 ? "" : "s"}${used}` });
}

emit({ t: "ready", text: `${PROVIDER}/${MODEL} · ${TOOLS.length} tools` });

// The task first, then whatever arrives on stdin, one at a time, until stdin closes.
const queue = [];
let busy = false;
const next = async () => {
  if (busy || !queue.length) return;
  busy = true;
  await work(queue.shift());
  busy = false;
  next();
};
const task = (process.env.KALYPSO_TASK || "").trim();
if (task) queue.push(task);
next();
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const m = JSON.parse(line);
    if (m?.type === "message" && String(m.text ?? "").trim()) { queue.push(String(m.text)); next(); }
  } catch { /* not a message */ }
});
rl.on("close", async () => {
  while (busy || queue.length) await new Promise((r) => setTimeout(r, 200));
  process.exit(0);
});
