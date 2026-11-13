#!/usr/bin/env node
// kx-agent: the master agent's handle on the namespace's other agents.
//
//   kx-agent list
//   kx-agent create NAME --role "what it does" [--model M] [--repo owner/name] [--task "first task"]
//   kx-agent send NAME "message" [--wait 600]     start it if needed, send, wait for its answer
//   kx-agent wait NAME [--timeout 600]            wait for its current work to finish
//   kx-agent log NAME [--limit 30]                what it said and did most recently
//   kx-agent start NAME | stop NAME | delete NAME
//
// KALYPSO does the work (and checks that the caller is the master agent); this only asks.

import fs from "node:fs";
import http from "node:http";

const SOCK = process.env.KALYPSO_GATEWAY_SOCK || "/run/kalypso/gateway/gateway.sock";
const KEY_FILE = process.env.KALYPSO_GATEWAY_KEY_FILE || "/run/kalypso/secrets/KALYPSO_GATEWAY_KEY";
const RELAY = process.env.KALYPSO_GATEWAY_URL;

const USAGE = `usage:
  kx-agent list
  kx-agent create NAME --role "what it does" [--model M] [--repo owner/name] [--task "first task"]
  kx-agent send NAME "message" [--wait SECONDS]   (default: wait up to 600s for the answer; --wait 0 returns at once)
  kx-agent wait NAME [--timeout SECONDS]
  kx-agent log NAME [--limit N]
  kx-agent start NAME | stop NAME | delete NAME`;

function die(msg, code = 2) {
  process.stderr.write(`kx-agent: ${msg}\n`);
  process.exit(code);
}

const args = process.argv.slice(2);
const cmd = args.shift();
if (!cmd || cmd === "-h" || cmd === "--help") {
  process.stdout.write(USAGE + "\n");
  process.exit(cmd ? 0 : 2);
}

/** Splits the rest into positionals and --flags (each flag takes one value). */
function parse(rest) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) flags[rest[i].slice(2)] = rest[++i] ?? "";
    else pos.push(rest[i]);
  }
  return { pos, flags };
}
const { pos, flags } = parse(args);
const name = pos[0];
const needName = () => name || die(`name the agent\n\n${USAGE}`);
const num = (v, d) => (v === undefined ? d : Number.isFinite(Number(v)) ? Number(v) : die(`"${v}" is not a number`));

let key;
try {
  key = fs.readFileSync(KEY_FILE, "utf8").trim();
} catch {
  die("this sandbox has no KALYPSO gateway key", 1);
}
const target = fs.existsSync(SOCK)
  ? { socketPath: SOCK }
  : RELAY
    ? (() => { const u = new URL(RELAY); return { host: u.hostname, port: Number(u.port || 80) }; })()
    : die("this sandbox can't reach KALYPSO (no gateway socket, no KALYPSO_GATEWAY_URL)", 1);

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { ...target, method, path: `/_kalypso/agents${path}`, headers: { authorization: `Bearer ${key}`, ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}) } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let json;
          try { json = JSON.parse(text); } catch { json = { error: text.trim() || `KALYPSO answered ${res.statusCode}` }; }
          if (res.statusCode >= 400) reject(new Error(json.error || `KALYPSO answered ${res.statusCode}`));
          else resolve(json);
        });
      },
    );
    req.on("error", (e) => reject(new Error(`couldn't reach KALYPSO: ${e.message}`)));
    req.end(data);
  });
}

const line = (a) => `${a.name}\t${a.status}${a.reason ? ` (${a.reason})` : ""}\t${a.model}\t${a.role}${a.repo ? `\trepo ${a.repo}` : ""}`;
const enc = encodeURIComponent;

/** What an agent answered: its text, then how the work ended. */
function report(r) {
  const out = [];
  if (r.reply) out.push(r.reply);
  if (r.result) out.push(`[${r.name}: ${r.result}]`);
  if (r.error) out.push(`[${r.name} failed: ${r.error}]`);
  if (r.timed_out) out.push(`[${r.name} is still working after the wait. Check again with: kx-agent wait ${r.name}]`);
  if (!out.length) out.push(`[${r.name} is ${r.status}${r.reason ? `: ${r.reason}` : ""}]`);
  return out.join("\n");
}

try {
  switch (cmd) {
    case "list": {
      const agents = await call("GET", "");
      process.stdout.write(agents.length ? agents.map(line).join("\n") + "\n" : "No other agents yet. Create one with: kx-agent create NAME --role \"...\"\n");
      break;
    }
    case "create": {
      needName();
      if (!flags.role) die('say what the agent is for with --role "..."');
      const a = await call("POST", "", { name, role: flags.role, model: flags.model, repo: flags.repo, task: flags.task });
      process.stdout.write(`Created ${line(a)}\n${flags.task ? "It has started on its task." : `Give it work with: kx-agent send ${a.name} "..."`}\n`);
      break;
    }
    case "send": {
      needName();
      const text = pos.slice(1).join(" ").trim();
      if (!text) die("say what to send, in quotes");
      process.stdout.write(report(await call("POST", `/${enc(name)}/message`, { text, wait: num(flags.wait, 600) })) + "\n");
      break;
    }
    case "wait":
      needName();
      process.stdout.write(report(await call("GET", `/${enc(name)}?wait=${num(flags.timeout, 600)}`)) + "\n");
      break;
    case "log": {
      needName();
      const r = await call("GET", `/${enc(name)}?limit=${num(flags.limit, 30)}`);
      process.stdout.write(`${line(r)}\n${(r.log || []).map((e) => `${e.kind}: ${e.text}`).join("\n") || "(nothing yet)"}\n`);
      break;
    }
    case "start":
    case "stop": {
      needName();
      const a = await call("POST", `/${enc(name)}/${cmd}`, {});
      process.stdout.write(`${a.name} is ${a.status}${a.reason ? ` (${a.reason})` : ""}\n`);
      break;
    }
    case "delete":
      needName();
      await call("DELETE", `/${enc(name)}`);
      process.stdout.write(`Deleted ${name}\n`);
      break;
    default:
      die(`unknown command "${cmd}"\n\n${USAGE}`);
  }
} catch (e) {
  die(e.message, 1);
}
