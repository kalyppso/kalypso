#!/usr/bin/env node
// kx-secret: ask KALYPSO to run one command with an on-request secret (#87).
//
//   kx-secret run STRIPE_KEY --purpose "run the billing tests" [--ttl 15m] [--cwd /work/app] -- npm test
//
// KALYPSO checks its policies (and asks you if needed), then runs the command in this
// sandbox as a separate user with STRIPE_KEY in that command's environment only. This
// process never receives the value: it prints the command's output, with the value
// redacted, and exits with the command's exit code.

import fs from "node:fs";
import http from "node:http";

const SOCK = process.env.KALYPSO_GATEWAY_SOCK || "/run/kalypso/gateway/gateway.sock";
const KEY_FILE = process.env.KALYPSO_GATEWAY_KEY_FILE || "/run/kalypso/secrets/KALYPSO_GATEWAY_KEY";

const USAGE = `usage: kx-secret run NAME --purpose "why" [--ttl 15m] [--cwd DIR] -- command [args...]

Runs the command with the on-request secret NAME in its environment, once KALYPSO's
policies or the user approve. The value never reaches this shell: output comes back
with it replaced by ‹NAME›.`;

function die(msg, code = 2) {
  process.stderr.write(`kx-secret: ${msg}\n`);
  process.exit(code);
}

function seconds(s) {
  const m = /^(\d+)(s|m|h)?$/.exec(s || "");
  if (!m) die(`can't read the duration "${s}" (use 90s, 15m or 1h)`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2] || "s"];
}

const args = process.argv.slice(2);
if (args[0] === "-h" || args[0] === "--help" || !args.length) {
  process.stdout.write(USAGE + "\n");
  process.exit(args.length ? 0 : 2);
}
if (args[0] !== "run") die(`unknown command "${args[0]}"\n\n${USAGE}`);
const sep = args.indexOf("--");
if (sep < 0 || sep === args.length - 1) die(`put the command to run after --\n\n${USAGE}`);
const opts = args.slice(1, sep);
const command = args.slice(sep + 1);
const name = opts.shift();
if (!name || name.startsWith("-")) die(`name the secret first, for example STRIPE_KEY\n\n${USAGE}`);
let purpose = "";
let ttl;
let cwd = process.cwd();
while (opts.length) {
  const o = opts.shift();
  if (o === "--purpose") purpose = opts.shift() ?? "";
  else if (o === "--ttl") ttl = seconds(opts.shift());
  else if (o === "--cwd") cwd = opts.shift() ?? cwd;
  else die(`unknown option ${o}`);
}
if (!purpose.trim()) die("say what the secret is for with --purpose");

let key;
try {
  key = fs.readFileSync(KEY_FILE, "utf8").trim();
} catch {
  die("this sandbox has no KALYPSO gateway key; restart the sandbox");
}

// The gateway socket on Linux engines, or the relay on engines that run in a VM.
const RELAY = process.env.KALYPSO_GATEWAY_URL;
const target = fs.existsSync(SOCK) || !RELAY ? { socketPath: SOCK } : (() => { const u = new URL(RELAY); return { host: u.hostname, port: Number(u.port || 80) }; })();

const body = JSON.stringify({ name, purpose, command, cwd, ttl });
const req = http.request(
  {
    ...target,
    path: "/_kalypso/secrets/run",
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
  },
  (res) => {
    let buf = "";
    let code = 126;
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (res.statusCode !== 200) { buf = raw + "\n" + buf; break; }
        let ev;
        try {
          ev = JSON.parse(raw);
        } catch {
          continue;
        }
        if (ev.t === "out") process.stdout.write(ev.text);
        else if (ev.t === "status") process.stderr.write(`kx-secret: ${ev.text}\n`);
        else if (ev.t === "error") {
          process.stderr.write(`kx-secret: ${ev.text}\n`);
          code = 126;
        } else if (ev.t === "end") {
          if (ev.removed) process.stderr.write(`kx-secret: removed ${ev.removed} file(s) the command left holding ${name}\n`);
          if (ev.outcome === "expired") process.stderr.write(`kx-secret: stopped: the grant for ${name} expired\n`);
          if (ev.outcome === "revoked") process.stderr.write(`kx-secret: stopped: the grant for ${name} was revoked\n`);
          code = ev.outcome === "expired" ? 124 : ev.outcome === "revoked" ? 137 : typeof ev.exit === "number" ? ev.exit : 1;
        }
      }
    });
    res.on("end", () => {
      // Errors before the stream starts come back as one JSON object (or nothing).
      if (res.statusCode !== 200) {
        let msg = buf.trim();
        try { msg = JSON.parse(msg).text || JSON.parse(msg).error || msg; } catch { /* plain text */ }
        die(msg || `the secret gateway answered ${res.statusCode}`, 126);
      }
      process.exit(code);
    });
  },
);
req.on("error", (e) => die(`can't reach KALYPSO's secret gateway: ${e.message}`, 126));
// Ctrl-C here stops the command there: KALYPSO kills it when this connection closes.
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { req.destroy(); process.exit(130); });
req.end(body);
