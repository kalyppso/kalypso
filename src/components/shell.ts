import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { api, errorMessage, isLive, onTermData, onTermExit } from "../backend";
import type { Agent, Commit, Sandbox } from "../types";

// In the desktop app each pane is a real shell in its sandbox (src-tauri/src/terminal.rs).
// In a plain browser (`npm run dev`) it is a small simulated shell on sample data.

export interface ShellContext {
  sandbox: Sandbox | null;
  agents: Agent[];
  commits: Commit[];
}

export interface Session {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  setContext: (ctx: ShellContext) => void;
  /** Closes the pane's shell in the sandbox, when there is one. */
  dispose?: () => void;
}

const sessions = new Map<string, Session>();

type TermPrefs = { fontSize: number; cursorStyle: "block" | "bar" | "underline"; scrollback: number };
let termPrefs: TermPrefs = { fontSize: 12.5, cursorStyle: "block", scrollback: 5000 };

/** Apply terminal preferences to every open pane and to new ones. */
export function setTerminalPrefs(p: TermPrefs) {
  termPrefs = p;
  for (const s of sessions.values()) {
    s.term.options.fontSize = p.fontSize;
    s.term.options.cursorStyle = p.cursorStyle;
    s.term.options.scrollback = p.scrollback;
    try { s.fit.fit(); } catch { /* pane hidden */ }
  }
}

const HELP = [
  "Available commands:",
  "  help            show this list",
  "  ls, pwd, cd     look around the workspace",
  "  cat <file>      print a file",
  "  whoami, date    who and when",
  "  agents          agents attached to this sandbox",
  "  ps              running processes",
  "  git log         recent commits",
  "  git status      working tree status",
  "  echo <text>     print text",
  "  clear           clear the screen (or Ctrl+L)",
];

const FILES: Record<string, string> = {
  "README.md": "# platform\r\n\r\nWebhook delivery and billing services.\r\nRun `make test` before pushing.",
  "package.json": '{\r\n  "name": "platform",\r\n  "scripts": { "test": "vitest run" }\r\n}',
  "Makefile": "test:\r\n\tnpm test",
};

export function getSession(id: string, theme: Terminal["options"]["theme"], font: string, initial: ShellContext): Session {
  const existing = sessions.get(id);
  if (existing) return existing;

  const term = new Terminal({ fontFamily: font, lineHeight: 1.25, cursorBlink: true, theme, allowTransparency: true, ...termPrefs });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const el = document.createElement("div");
  el.style.cssText = "width:100%;height:100%";
  term.open(el);

  const session = isLive() ? liveShell(id, term, fit, el, initial) : simulatedShell(id, term, fit, el, initial);
  sessions.set(id, session);
  return session;
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

/** A real shell in the pane's sandbox. Reconnects when the sandbox changes or starts. */
function liveShell(id: string, term: Terminal, fit: FitAddon, el: HTMLDivElement, initial: ShellContext): Session {
  let ctx = initial;
  let open: { ns: string; sandboxId: string } | null = null;
  let waiting = false; // a press of Enter reconnects
  let offs: (() => void)[] = [];
  let attempt = 0;

  const detach = () => { offs.forEach((f) => f()); offs = []; };
  const disconnect = () => {
    detach();
    if (open) void api.termClose(open.ns, id).catch(() => {});
    open = null;
  };

  const connect = async () => {
    disconnect();
    waiting = false;
    const sb = ctx.sandbox;
    if (!sb) return void term.write(`\r\n${dim("No sandbox here yet. Create one in Sandboxes, then pick it above.")}`);
    if (sb.status !== "running") {
      waiting = true;
      return void term.write(`\r\n${dim(`${sb.name} is ${sb.status}. Start it in Sandboxes; this pane connects when it runs.`)}`);
    }
    const mine = ++attempt;
    term.write(`\r\n${dim(`Connecting to ${sb.name}…`)}\r\n`);
    const [offData, offExit] = await Promise.all([
      onTermData(id, (bytes) => term.write(bytes)),
      onTermExit(id, () => {
        detach();
        open = null;
        waiting = true;
        term.write(`\r\n${dim("[session ended, press Enter to reconnect]")}`);
      }),
    ]);
    offs = [offData, offExit];
    if (mine !== attempt) return detach(); // superseded while subscribing
    try {
      await api.termOpen(sb.ns, sb.id, id, term.rows, term.cols);
      open = { ns: sb.ns, sandboxId: sb.id };
    } catch (e) {
      detach();
      waiting = true;
      term.write(`\r\n\x1b[31m${errorMessage(e)}\x1b[0m\r\n${dim("Press Enter to try again.")}`);
    }
  };

  term.onData((data) => {
    if (open) return void api.termWrite(open.ns, id, data).catch(() => {});
    if (waiting && data.includes("\r")) void connect();
  });
  term.onResize(({ rows, cols }) => {
    if (open) void api.termResize(open.ns, id, rows, cols).catch(() => {});
  });

  void connect();
  return {
    term,
    fit,
    el,
    setContext: (next) => {
      const moved = next.sandbox?.id !== ctx.sandbox?.id;
      const started = next.sandbox?.status === "running" && ctx.sandbox?.status !== "running";
      const stopped = next.sandbox?.status !== "running" && ctx.sandbox?.status === "running";
      ctx = next;
      if (moved || (started && !open)) void connect();
      else if (stopped) { disconnect(); waiting = true; term.write(`\r\n${dim(`${next.sandbox?.name} stopped.`)}`); }
    },
    dispose: disconnect,
  };
}

function simulatedShell(_id: string, term: Terminal, fit: FitAddon, el: HTMLDivElement, initial: ShellContext): Session {
  let ctx = initial;
  let line = "";
  let cwd = "~/work";
  const history: string[] = [];
  let hIndex = 0;

  const host = () => ctx.sandbox?.name ?? "local";
  const prompt = () => term.write(`\r\n\x1b[38;2;167;139;250magent@${host()}\x1b[0m:\x1b[2m${cwd}\x1b[0m$ `);
  const out = (text: string) => term.write(`\r\n${text}`);

  const run = (input: string) => {
    const [cmd, ...args] = input.trim().split(/\s+/);
    if (!cmd) return;
    switch (cmd) {
      case "help": out(HELP.join("\r\n")); break;
      case "clear": term.clear(); break;
      case "pwd": out(cwd.replace("~", "/home/agent")); break;
      case "cd": cwd = !args[0] || args[0] === "~" ? "~" : args[0] === ".." ? "~" : `~/${args[0].replace(/^~\//, "")}`; break;
      case "ls": out(cwd === "~/work" ? Object.keys(FILES).concat(["src/", "tests/"]).join("  ") : "work/"); break;
      case "cat": out(FILES[args[0]] ?? `cat: ${args[0] ?? ""}: No such file or directory`); break;
      case "whoami": out("agent"); break;
      case "date": out(new Date().toString()); break;
      case "echo": out(args.join(" ")); break;
      case "agents": {
        const list = ctx.agents.filter((a) => a.sandboxId === ctx.sandbox?.id);
        out(list.length ? list.map((a) => `${a.name.padEnd(12)}${a.status.padEnd(10)}${a.model}`).join("\r\n") : "No agents in this sandbox.");
        break;
      }
      case "ps": out(["  PID  CMD", "    1  /sbin/tini -- kalypso-runner", "   14  node /opt/kalypso/agent.js", "   88  npx @modelcontextprotocol/server-filesystem /work", `  ${200 + history.length}  ps`].join("\r\n")); break;
      case "git":
        if (args[0] === "log") out(ctx.commits.slice(0, 8).map((c) => `\x1b[33m${c.sha}\x1b[0m ${c.message}`).join("\r\n") || "fatal: your current branch does not have any commits yet");
        else if (args[0] === "status") out("On branch agent/coder/feat\r\nYour branch is up to date with 'origin/agent/coder/feat'.\r\n\r\nnothing to commit, working tree clean");
        else out("usage: git log | git status");
        break;
      case "exit": out("Close this pane with the x in its header."); break;
      default: out(`${cmd}: command not found. Type 'help' for the list.`);
    }
  };

  term.onData((data) => {
    for (const ch of data) {
      const code = ch.charCodeAt(0);
      if (ch === "\r") {
        if (line.trim()) history.push(line);
        hIndex = history.length;
        run(line);
        line = "";
        prompt();
      } else if (code === 127) {
        if (line) {
          line = line.slice(0, -1);
          term.write("\b \b");
        }
      } else if (code === 3) {
        term.write("^C");
        line = "";
        prompt();
      } else if (code === 12) {
        term.clear();
      } else if (code >= 32) {
        line += ch;
        term.write(ch);
      }
    }
    // Arrow keys arrive as escape sequences.
    if (data === "\x1b[A" || data === "\x1b[B") {
      if (!history.length) return;
      hIndex = Math.max(0, Math.min(history.length, hIndex + (data === "\x1b[A" ? -1 : 1)));
      term.write("\b \b".repeat(line.length));
      line = history[hIndex] ?? "";
      term.write(line);
    }
  });

  const session: Session = {
    term,
    fit,
    el,
    setContext: (next) => {
      const moved = next.sandbox?.id !== ctx.sandbox?.id;
      ctx = next;
      if (moved) {
        term.write(`\r\nSwitched to \x1b[1m${host()}\x1b[0m.`);
        prompt();
      }
    },
  };
  term.write(`Connected to \x1b[1m${host()}\x1b[0m (sample shell). Type 'help' to see what you can do.`);
  prompt();
  return session;
}

export function disposeSession(id: string) {
  const s = sessions.get(id);
  s?.dispose?.();
  s?.term.dispose();
  sessions.delete(id);
}
