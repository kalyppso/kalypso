import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { Agent, Commit, Sandbox } from "../types";

// Prototype shell. The desktop build replaces this with a PTY streamed from
// `docker exec -it <sandbox> sh` over Tauri IPC (ARCHITECTURE.md §4.20).

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
}

const sessions = new Map<string, Session>();

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

  const term = new Terminal({ fontFamily: font, fontSize: 12.5, lineHeight: 1.25, cursorBlink: true, theme, allowTransparency: true, scrollback: 2000 });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const el = document.createElement("div");
  el.style.cssText = "width:100%;height:100%";
  term.open(el);

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
  sessions.set(id, session);
  term.write(`Connected to \x1b[1m${host()}\x1b[0m. Type 'help' to see what you can do.`);
  prompt();
  return session;
}

export function disposeSession(id: string) {
  sessions.get(id)?.term.dispose();
  sessions.delete(id);
}
