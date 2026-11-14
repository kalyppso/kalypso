import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Paperclip, X, Check, ChevronRight, Copy, RotateCcw, ShieldAlert } from "lucide-react";
import { api, errorMessage, isLive, onAgentUpdate, openUrl } from "../backend";
import type { AgentEvent } from "../bindings/AgentEvent";
import type { AgentRun } from "../bindings/AgentRun";
import { useStore, useToast } from "../store";
import type { Agent } from "../types";
import { useChatPrefs } from "./ChatSettings";
import { FailureCard, explainFailure } from "./Failure";
import "../styles/chat.css";

/**
 * One conversation with an agent, the same on the agent page and the Chat page: what you
 * sent, what it answered, and the steps it took in between (collapsed until you open them).
 */

// ---------- From transcript events to conversation items ----------

interface Step { id: number; name: string; detail: string; output: string[]; failed: boolean }

type Item =
  | { kind: "user"; id: number; text: string; ts: string }
  | { kind: "text"; id: number; text: string }
  | { kind: "steps"; id: number; steps: Step[] }
  | { kind: "raw"; id: number; lines: string[] }
  | { kind: "note"; id: number; tone: "status" | "result" | "policy" | "blocked" | "error"; text: string }
  | { kind: "run"; id: number; run: AgentRun };

/** Groups the flat transcript: a tool call takes the output that follows it, plain output merges into one block. */
export function toItems(events: AgentEvent[], runs: AgentRun[] = []): Item[] {
  const items: Item[] = [];
  const runOf = new Map(runs.map((r) => [r.id, r]));
  let run = "";
  for (const e of events) {
    if (e.run_id !== run) {
      run = e.run_id;
      const r = runOf.get(run);
      if (r && runs.length > 1) items.push({ kind: "run", id: -e.id, run: r });
    }
    const last = items[items.length - 1];
    switch (e.kind) {
      case "input":
        items.push({ kind: "user", id: e.id, text: e.text, ts: e.ts });
        break;
      case "text":
        items.push({ kind: "text", id: e.id, text: e.text });
        break;
      case "tool": {
        const [, name = e.text, detail = ""] = /^(\S+)\s+([\s\S]*)$/.exec(e.text) ?? [];
        const step = { id: e.id, name, detail, output: [], failed: false };
        if (last?.kind === "steps") last.steps.push(step);
        else items.push({ kind: "steps", id: e.id, steps: [step] });
        break;
      }
      case "output":
        if (last?.kind === "steps") last.steps[last.steps.length - 1].output.push(e.text);
        else if (last?.kind === "raw") last.lines.push(e.text);
        else items.push({ kind: "raw", id: e.id, lines: [e.text] });
        break;
      case "policy": {
        const blocked = e.text.startsWith("Blocked");
        if (blocked && last?.kind === "steps") last.steps[last.steps.length - 1].failed = true;
        items.push({ kind: "note", id: e.id, tone: blocked ? "blocked" : "policy", text: e.text });
        break;
      }
      case "result":
      case "error":
        items.push({ kind: "note", id: e.id, tone: e.kind, text: e.text });
        break;
      default:
        items.push({ kind: "note", id: e.id, tone: "status", text: e.text });
    }
  }
  return items;
}

// ---------- Loading and following an agent's conversation ----------

const RUNS_PER_PAGE = 4;

/** An agent's recent runs as one conversation, oldest first, kept current as it works. */
export function useAgentConversation(ns: string, agent: Agent | undefined) {
  const live = isLive();
  const id = agent?.id;
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>(() => (agent && !live ? sampleEvents(agent) : []));
  const [shown, setShown] = useState(RUNS_PER_PAGE);
  const [loading, setLoading] = useState(live);
  const newest = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!id || !live) return;
    const all = await api.agentRuns(ns, id);
    const recent = all.slice(0, shown).reverse();
    const pages = await Promise.all(recent.map((r) => api.agentEvents(ns, r.id).catch(() => [] as AgentEvent[])));
    newest.current = all[0]?.id ?? null;
    setRuns(all);
    setEvents(pages.flat());
  }, [ns, id, shown, live]);

  useEffect(() => {
    if (!live) return setEvents(agent ? sampleEvents(agent) : []);
    setLoading(true);
    load().catch(() => {}).finally(() => setLoading(false));
  }, [load]);

  useEffect(() => {
    if (!id || !live) return;
    const off = onAgentUpdate((u) => {
      if (u.agent_id !== id) return;
      // A line for the run on screen is appended; anything else (a new run, a status change) reloads.
      if (u.event && u.event.run_id === newest.current) setEvents((l) => (l.some((e) => e.id === u.event!.id) ? l : [...l, u.event!]));
      else load().catch(() => {});
    });
    return () => void off.then((f) => f());
  }, [id, load, live]);

  const send = useCallback(
    async (text: string) => {
      if (!id) return;
      if (live) return void (await api.agentSend(ns, id, text));
      // Sample data: echo the message and say plainly that nothing is answering.
      const at = Date.now();
      setEvents((l) => [...l, { id: at, run_id: "sample", ts: "", kind: "input", text }]);
      setTimeout(() => setEvents((l) => [...l, { id: at + 1, run_id: "sample", ts: "", kind: "status", text: "Sample data: agents answer in the KALYPSO desktop app." }]), 500);
    },
    [ns, id, live],
  );

  const shownRuns = useMemo(() => runs.slice(0, shown), [runs, shown]);
  return { runs: shownRuns, events, loading, send, hasEarlier: runs.length > shown, showEarlier: () => setShown((n) => n + RUNS_PER_PAGE) };
}

const SAMPLE_MASTER: [string, string][] = [
  ["status", "claude-sonnet-5-5 · 14 tools"],
  ["input", "The login test is flaky on CI and the README is out of date. Can you sort both out?"],
  ["text", "Two separate jobs, so I'll run them in parallel: **coder** takes the flaky test, and a new **writer** agent updates the README."],
  ["tool", "Bash  kx-agent list"],
  ["output", "coder\tstopped\tclaude-opus-5-5\tImplements tickets in repos\trepo acme/platform\nreviewer\tstopped\tclaude-opus-5-5\tReviews PRs from coder"],
  ["tool", "Bash  kx-agent create writer --role \"Keeps the docs accurate\" --repo acme/platform"],
  ["output", "Created writer\tstopped\tclaude-sonnet-5-5\tKeeps the docs accurate\trepo acme/platform"],
  ["tool", "Bash  kx-agent send coder \"tests/auth/login.test.ts fails about 1 in 7 runs on CI…\" --wait 0"],
  ["tool", "Bash  kx-agent send writer \"Update README.md: the install steps still mention Docker only…\" --wait 0"],
  ["tool", "Bash  kx-agent wait coder"],
  ["output", "The test checked the URL before the redirect finished. It now waits for the navigation; 20 of 20 runs pass.\n[coder: Done · 6 turns · $0.08]"],
  ["tool", "Bash  kx-agent wait writer"],
  ["output", "README install section rewritten for Docker and Podman, with the Podman Desktop note.\n[writer: Done · 3 turns · $0.02]"],
  ["text", "Both are done.\n\n- **coder** fixed the flaky login test: it checked the URL before the redirect finished. It now waits for the navigation, and 20 of 20 runs pass. Its branch is `agent/coder/flaky-login`.\n- **writer** rewrote the README's install section to cover Podman as well as Docker.\n\nI stopped both agents. Open either one under Team to see exactly what it did."],
  ["result", "Done · 9 turns · $0.05"],
];

/** What the conversation looks like, for the browser preview where no core is running. */
function sampleEvents(a: Agent): AgentEvent[] {
  if (a.master) return SAMPLE_MASTER.map(([kind, text], i) => ({ id: i + 1, run_id: "sample", ts: "", kind, text }));
  const lines: [string, string][] =
    a.status === "stopped"
      ? []
      : [
          ["status", `${a.model} · 12 tools`],
          ["input", "The login test is flaky on CI. Find out why and fix it."],
          ["text", "I'll reproduce it first, then look at what the test waits for."],
          ["tool", "Bash  npm test -- auth/login.test.ts --repeat 20"],
          ["output", "PASS  auth/login.test.ts (17/20)\nFAIL  auth/login.test.ts (3/20)\n  ● login › redirects after sign-in\n    expected \"/home\", received \"/login\""],
          ["tool", "Read  src/auth/session.ts"],
          ["tool", "Grep  waitForNavigation"],
          ["output", "tests/auth/login.test.ts:42:  await page.click(\"#submit\");\ntests/auth/login.test.ts:43:  expect(page.url()).toContain(\"/home\");"],
          ["text", "Found it. The test checks the URL **right after the click**, before the redirect has happened. It passes only when the session cookie is already warm.\n\nThe fix is to wait for the navigation:\n\n```ts\nawait Promise.all([\n  page.waitForURL(\"**/home\"),\n  page.click(\"#submit\"),\n]);\n```\n\nThree things changed:\n- `tests/auth/login.test.ts` waits for the redirect\n- the same pattern in `logout.test.ts`\n- a short note in `CONTRIBUTING.md`"],
          ["tool", "Edit  tests/auth/login.test.ts"],
          ["tool", "Bash  npm test -- auth --repeat 20"],
          ["output", "PASS  auth/login.test.ts (20/20)\nPASS  auth/logout.test.ts (20/20)"],
          ["policy", "Warning: pushing to a shared branch needs a review (Protect main)"],
          ["text", "All 20 runs pass now. I committed the change on `agent/" + a.name + "/flaky-login` and opened a pull request."],
          ["result", "Done · 6 turns · $0.08"],
        ];
  return lines.map(([kind, text], i) => ({ id: i + 1, run_id: "sample", ts: "", kind, text }));
}

// ---------- The conversation ----------

interface ConversationProps {
  events: AgentEvent[];
  runs?: AgentRun[];
  /** Shows "Working" under the last message while the agent is busy. */
  working?: boolean;
  loading?: boolean;
  empty?: ReactNode;
  onShowEarlier?: () => void;
  /** A message on its way: shown at once, with what's happening, until the agent records it. */
  pending?: { text: string; status: string } | null;
  /** Offered on an error at the end of the conversation: send the last message again. */
  onRetry?: () => void;
  /** Who answers: its name and mark, shown on each of its replies. */
  who?: { name: string; mark?: ReactNode };
}

// ---------- Replies: everything the agent did between two of your messages ----------

type Turn =
  | { kind: "user"; id: number; item: Extract<Item, { kind: "user" }> }
  | { kind: "rule"; id: number; item: Item }
  | { kind: "agent"; id: number; items: Item[] };

/** Your messages, the agent's replies (text, steps, notes and its result together), and run lines between. */
function toTurns(items: Item[]): Turn[] {
  const out: Turn[] = [];
  for (const it of items) {
    // Lifecycle chatter ("started", "model · 5 tools") says nothing a reader needs; the run line stays.
    if (it.kind === "note" && it.tone === "status" && /^(started|resumed)$|·\s*\d+ tools(\s*·\s*resumed)?$/i.test(it.text.trim())) continue;
    if (it.kind === "user") out.push({ kind: "user", id: it.id, item: it });
    else if (it.kind === "run" || (it.kind === "note" && it.tone === "status")) out.push({ kind: "rule", id: it.id, item: it });
    else {
      const last = out[out.length - 1];
      if (last?.kind === "agent") last.items.push(it);
      else out.push({ kind: "agent", id: it.id, items: [it] });
    }
  }
  return out;
}

const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches || !!document.querySelector(".reduce-motion");

/** Text that has just arrived flows out over about a second, word by word, instead of appearing at once. */
function Reveal({ text, animate }: { text: string; animate: boolean }) {
  const [shown, setShown] = useState(() => (animate && !reduceMotion() ? 0 : text.length));
  useEffect(() => {
    if (shown >= text.length) return;
    const step = Math.max(3, Math.ceil(text.length / 55));
    const id = requestAnimationFrame(() => setShown((n) => Math.min(text.length, n + step)));
    return () => cancelAnimationFrame(id);
  }, [shown, text]);
  if (shown >= text.length) return <Markdown text={text} />;
  const cut = text.lastIndexOf(" ", shown);
  return <Markdown text={text.slice(0, cut > 0 ? cut : shown)} />;
}

function Who({ who }: { who?: ConversationProps["who"] }) {
  if (!who) return null;
  return <div className="cv-who">{who.mark && <span className="cv-who-mark">{who.mark}</span>}<span>{who.name}</span></div>;
}

/** One reply: who, what it said and did, and a quiet row to copy it, with how the task ended. */
function AgentTurn({ turn, who, fresh, last, waiting, onRetry }: {
  turn: Extract<Turn, { kind: "agent" }>; who?: ConversationProps["who"]; fresh: Set<number>; last: boolean; waiting: ReactNode; onRetry?: () => void;
}) {
  const body = turn.items.filter((i) => !(i.kind === "note" && i.tone === "result"));
  const result = turn.items.find((i): i is Extract<Item, { kind: "note" }> => i.kind === "note" && i.tone === "result");
  const said = turn.items.filter((i): i is Extract<Item, { kind: "text" }> => i.kind === "text").map((i) => i.text).join("\n\n");
  return (
    <div className={`cv-turn ${fresh.has(turn.id) ? "fresh" : ""} ${last ? "last" : ""}`}>
      <Who who={who} />
      <div className="cv-body">
        {body.map((it, i) =>
          it.kind === "text" ? (
            <div key={it.id} className="cv-text"><Reveal text={it.text} animate={fresh.has(it.id)} /></div>
          ) : (
            <ItemView key={it.id} item={it} open={last && i === body.length - 1} onRetry={last && i === body.length - 1 ? onRetry : undefined} />
          ),
        )}
        {waiting}
      </div>
      {(said || result) && !waiting && (
        <div className="cv-foot">
          {result && <span className="cv-result"><Check size={12} /> {result.text}</span>}
          {said && <CopyText text={said} />}
        </div>
      )}
    </div>
  );
}

/** Words while it works, changing every few seconds. Kalypso weaves at her loom on Ogygia. */
const VERBS = ["Thinking", "Weaving", "Charting a course", "Reading the tides", "Working", "Gathering threads", "Pondering", "Navigating"];
/** The star that turns while it works, as in Claude Code. */
const GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];

/**
 * Shown while an agent works or a message is on its way: a turning star, a word with light
 * sweeping across it, and how long it has been. `label` fixes the word ("Starting kalypso").
 * Still with reduced motion, apart from the timer.
 */
export function Waiting({ label }: { label?: string }) {
  const [tick, setTick] = useState(0);
  const started = useRef(Date.now());
  const [verb] = useState(() => Math.floor(Math.random() * VERBS.length));
  useEffect(() => {
    // With reduced motion the star holds still; the clock still counts, once a second.
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches || !!document.querySelector(".reduce-motion");
    const id = window.setInterval(() => setTick((t) => t + (still ? 0 : 1) + (still ? 0.0001 : 0)), still ? 1000 : 120);
    return () => window.clearInterval(id);
  }, []);
  const secs = Math.floor((Date.now() - started.current) / 1000);
  const word = label ?? VERBS[(verb + Math.floor(secs / 4)) % VERBS.length];
  const time = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return (
    <div className="cv-working" role="status" aria-label={`${word}, ${time}`}>
      <span className="cv-star" aria-hidden="true">{GLYPHS[Math.floor(tick) % GLYPHS.length]}</span>
      <span className="cv-shimmer" key={word}>{word}…</span>
      {secs >= 1 && <span className="cv-elapsed">{time}</span>}
    </div>
  );
}

export function Conversation({ events, runs, working, loading, empty, onShowEarlier, pending, onRetry, who }: ConversationProps) {
  const items = useMemo(() => toItems(events, runs), [events, runs]);
  const turns = useMemo(() => toTurns(items), [items]);

  // What arrives after the conversation has loaded rises in and flows out; what was there doesn't.
  const seen = useRef<Set<number> | null>(null);
  const fresh = new Set<number>();
  if (seen.current) {
    for (const t of turns) {
      if (!seen.current.has(t.id)) fresh.add(t.id);
      if (t.kind === "agent") for (const it of t.items) if (!seen.current.has(it.id)) fresh.add(it.id);
    }
  }
  useEffect(() => {
    if (loading) return;
    const all = seen.current ?? new Set<number>();
    for (const t of turns) { all.add(t.id); if (t.kind === "agent") t.items.forEach((it) => all.add(it.id)); }
    seen.current = all;
  });
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true); // follow new messages until the reader scrolls up
  const [behind, setBehind] = useState(false);

  const toEnd = (smooth = false) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };
  useLayoutEffect(() => {
    if (pinned.current) toEnd();
    else setBehind(true);
  }, [events.length, working, pending]);

  // Sending a message always brings you to the end, wherever you had scrolled.
  const lastSent = events.filter((e) => e.kind === "input").length;
  const sentBefore = useRef(lastSent);
  useLayoutEffect(() => {
    const sent = (pending && pending.text) || lastSent > sentBefore.current;
    sentBefore.current = lastSent;
    if (!sent) return;
    pinned.current = true;
    setBehind(false);
    toEnd(true);
  }, [lastSent, pending?.text]);

  // Text flowing out grows the page without new events: keep up with it while following.
  const column = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = column.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { if (pinned.current) toEnd(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (pinned.current) setBehind(false);
  };

  // "Working" only while something is in flight: after your message or in the middle of its steps,
  // not once it has reported a result or is waiting at a lifecycle line.
  const last = items[items.length - 1];
  const settled = !last || last.kind === "run" || (last.kind === "note" && last.tone !== "policy");

  return (
    <div className="cv">
      <div className="cv-scroll" ref={scroller} onScroll={onScroll} role="log" aria-live="polite">
        <div className="cv-col" ref={column}>
          {onShowEarlier && <button className="btn ghost sm cv-earlier" onClick={onShowEarlier}>Show earlier runs</button>}
          {loading && items.length === 0 && <div className="cv-empty faint">Loading the conversation…</div>}
          {!loading && items.length === 0 && !pending && <div className="cv-empty">{empty}</div>}
          {turns.map((t, i) => {
            const isLast = i === turns.length - 1;
            if (t.kind === "user") return <div key={t.id} className={`cv-user ${fresh.has(t.id) ? "fresh" : ""}`} title={clock(t.item.ts)}>{t.item.text}</div>;
            if (t.kind === "rule") return <ItemView key={t.id} item={t.item} open={false} />;
            return (
              <AgentTurn key={t.id} turn={t} who={who} fresh={fresh} last={isLast}
                waiting={isLast && working && !settled && !pending ? <Waiting /> : null}
                onRetry={isLast && !pending ? onRetry : undefined} />
            );
          })}
          {/* Your message is in, and the reply hasn't started: its place, already thinking. */}
          {pending && <div className="cv-user cv-pending fresh">{pending.text}</div>}
          {(pending || (working && !settled && turns[turns.length - 1]?.kind !== "agent")) && (
            <div className="cv-turn fresh last">
              <Who who={who} />
              <div className="cv-body"><Waiting label={pending && pending.status !== "Thinking" ? pending.status : undefined} /></div>
            </div>
          )}
        </div>
      </div>
      {behind && (
        <button className="cv-latest" onClick={() => { pinned.current = true; setBehind(false); toEnd(true); }}>
          <ArrowDown size={13} /> Latest
        </button>
      )}
    </div>
  );
}

function ItemView({ item, open, onRetry }: { item: Item; open: boolean; onRetry?: () => void }) {
  switch (item.kind) {
    case "user":
      return <div className="cv-user" title={clock(item.ts)}>{item.text}</div>;
    case "text":
      return <div className="cv-text"><Markdown text={item.text} /></div>;
    case "steps":
      return <Steps steps={item.steps} live={open} />;
    case "raw":
      return <pre className="cv-raw">{item.lines.join("\n")}</pre>;
    case "run": {
      const r = item.run;
      const how = r.outcome === "running" ? "running" : `${r.outcome}${r.exit_code !== null && r.exit_code !== 0 ? `, exit ${r.exit_code}` : ""}`;
      return <div className="cv-rule"><span>Run {r.attempt} · {how}{r.reason && !how.includes(r.reason) ? ` · ${r.reason}` : ""}</span></div>;
    }
    case "note":
      if (item.tone === "status") return <div className="cv-rule"><span>{item.text}</span></div>;
      if (item.tone === "result") return <div className="cv-note result"><Check size={13} /> {item.text}</div>;
      // A warning from a rule stays a quiet line; a block or a failure explains itself.
      if (item.tone === "policy") {
        return <div className="cv-note policy"><ShieldAlert size={14} /><span>{item.text}</span></div>;
      }
      return (
        <FailureCard
          failure={explainFailure(item.text)}
          tone={item.tone === "blocked" ? "blocked" : "error"}
          actions={onRetry && item.tone === "error" ? <button className="btn sm primary" onClick={onRetry}><RotateCcw size={12} /> Try again</button> : undefined}
        />
      );
  }
}

/** A reply's copy button, shown on hover like in chat apps. */
function CopyText({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="cv-actions">
      <button className="btn ghost sm" onClick={() => navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1400); })} aria-label="Copy reply">
        {done ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
      </button>
    </div>
  );
}

/** The work between messages. Long finished stretches fold into one line; the newest stays open. */
function Steps({ steps, live }: { steps: Step[]; live: boolean }) {
  const [prefs] = useChatPrefs();
  const foldable = steps.length > 4 && !live && !prefs.expandSteps;
  const [folded, setFolded] = useState(foldable);
  useEffect(() => { if (foldable) setFolded(true); }, [foldable]);
  if (foldable && folded) {
    return (
      <div className="cv-steps">
        <button className="cv-step" onClick={() => setFolded(false)} aria-expanded={false}>
          <ChevronRight size={12} className="cv-chev" />
          <span className="cv-step-name">{steps.length} steps</span>
          <span className="cv-step-detail">{[...new Set(steps.map((s) => s.name))].join(", ")}</span>
        </button>
      </div>
    );
  }
  return (
    <div className="cv-steps">
      {steps.map((s) => <StepRow key={s.id} step={s} />)}
    </div>
  );
}

function StepRow({ step: s }: { step: Step }) {
  const [prefs] = useChatPrefs();
  const [open, setOpen] = useState(prefs.expandSteps);
  const has = s.output.length > 0 || s.detail.includes("\n");
  const firstLine = s.detail.split("\n")[0];
  return (
    <>
      <button className={`cv-step ${s.failed ? "failed" : ""}`} onClick={() => has && setOpen(!open)} aria-expanded={has ? open : undefined} disabled={!has} title={has ? undefined : "This step printed nothing"}>
        <ChevronRight size={12} className="cv-chev" style={{ transform: open ? "rotate(90deg)" : undefined, visibility: has ? undefined : "hidden" }} />
        <span className="cv-step-name">{s.name}</span>
        <span className="cv-step-detail">{firstLine}</span>
      </button>
      {open && <pre className="cv-step-out">{[s.detail.includes("\n") ? s.detail : "", ...s.output].filter(Boolean).join("\n")}</pre>}
    </>
  );
}

/** "2026-11-12 09:14:03" (UTC, as the core stores it) as a local time; empty when unknown. */
function clock(ts: string) {
  if (!ts) return undefined;
  const d = new Date(`${ts.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString([], { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
}

// ---------- Markdown, the small subset agents actually write ----------

/** Paragraphs, headings, lists, quotes, fenced code and inline code, bold, italics and links. Builds elements, never HTML. */
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return <>{blocks.map((b, i) => <Block key={i} b={b} />)}</>;
}

type MdBlock =
  | { t: "p" | "h" | "quote"; text: string }
  | { t: "code"; lang: string; code: string }
  | { t: "ul" | "ol"; items: string[] };

function parseBlocks(src: string): MdBlock[] {
  const out: MdBlock[] = [];
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const fence = /^\s*```(\S*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out.push({ t: "code", lang: fence[1], code: body.join("\n") });
    } else if (!line.trim()) {
      i++;
    } else if (/^#{1,6}\s/.test(line)) {
      out.push({ t: "h", text: line.replace(/^#{1,6}\s+/, "") });
      i++;
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      for (; i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]); i++) items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
      out.push({ t: ordered ? "ol" : "ul", items });
    } else if (/^>\s?/.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) body.push(lines[i].replace(/^>\s?/, ""));
      out.push({ t: "quote", text: body.join("\n") });
    } else {
      const body: string[] = [];
      for (; i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) && !/^>\s?/.test(lines[i]); i++) body.push(lines[i]);
      out.push({ t: "p", text: body.join("\n") });
    }
  }
  return out;
}

function Block({ b }: { b: MdBlock }) {
  switch (b.t) {
    case "code": return <CodeBlock lang={b.lang} code={b.code} />;
    case "h": return <h4 className="md-h">{inline(b.text)}</h4>;
    case "quote": return <blockquote className="md-quote">{inline(b.text)}</blockquote>;
    case "ul": return <ul className="md-list">{b.items.map((x, i) => <li key={i}>{inline(x)}</li>)}</ul>;
    case "ol": return <ol className="md-list">{b.items.map((x, i) => <li key={i}>{inline(x)}</li>)}</ol>;
    default: return <p>{inline(b.text)}</p>;
  }
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > at) out.push(text.slice(at, m.index));
    const s = m[0];
    const key = m.index;
    if (m[1]) out.push(<code key={key} className="md-code">{s.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key}>{s.slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={key}>{s.slice(1, -1)}</em>);
    else {
      const [, label, url] = /^\[([^\]]+)\]\((.+)\)$/.exec(s)!;
      out.push(<a key={key} href={url} onClick={(e) => { e.preventDefault(); openUrl(url); }}>{label}</a>);
    }
    at = m.index! + s.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

const FOLD_AFTER = 14;

/** Code stays short until asked for: long blocks show their first lines and the rest on demand. */
function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const lines = code.split("\n");
  const long = lines.length > FOLD_AFTER;
  const [all, setAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => {});
  };
  return (
    <div className="md-pre">
      <div className="md-pre-head">
        <span>{lang || "code"}</span>
        <button className="btn ghost sm" onClick={copy}>{copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}</button>
      </div>
      <pre>{long && !all ? lines.slice(0, FOLD_AFTER).join("\n") : code}</pre>
      {long && <button className="md-pre-more" onClick={() => setAll(!all)}>{all ? "Show less" : `Show all ${lines.length} lines`}</button>}
    </div>
  );
}

// ---------- The message box ----------

interface ComposerProps {
  onSend: (text: string) => Promise<void>;
  placeholder: string;
  /** Controlled text, when the page fills the box itself (starter prompts). */
  value?: string;
  onValue?: (text: string) => void;
  /** The start screen's bigger box. */
  large?: boolean;
  /** Why nothing can be sent right now; shown in place of the hint, with the box disabled. */
  blocked?: ReactNode;
  autoFocus?: boolean;
  /** Puts a file where the agent can read it and returns its path there. Shows the paperclip, drop and paste. */
  attach?: (file: File) => Promise<string>;
}

/** A file waiting to go with the next message. */
interface Pending { id: string; file: File; preview?: string }

const IMAGE = /^image\//;
const MAX_FILE = 25 * 1024 * 1024;
const kind = (f: File) => (IMAGE.test(f.type) ? "image" : /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name) ? "PDF" : "file");
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** A file as base64, for the core. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error ?? new Error(`${file.name} could not be read`));
    r.readAsDataURL(file);
  });
}

export function Composer({ onSend, placeholder, blocked, autoFocus, value, onValue, large, attach }: ComposerProps) {
  const [files, setFiles] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const addFiles = (list: FileList | File[] | null) => {
    if (!attach || !list) return;
    const next: Pending[] = [];
    for (const f of Array.from(list)) {
      if (f.size > MAX_FILE) { toast(`${f.name} is larger than 25 MB`, "warn"); continue; }
      next.push({ id: `${f.name}-${f.size}-${Math.random()}`, file: f, preview: IMAGE.test(f.type) ? URL.createObjectURL(f) : undefined });
    }
    if (next.length) setFiles((fs) => [...fs, ...next].slice(0, 10));
  };
  const removeFile = (id: string) => setFiles((fs) => { fs.find((f) => f.id === id)?.preview && URL.revokeObjectURL(fs.find((f) => f.id === id)!.preview!); return fs.filter((f) => f.id !== id); });
  const toast = useToast();
  const [own, setOwn] = useState("");
  const text = value ?? own;
  const setText = (t: string) => (onValue ? onValue(t) : setOwn(t));
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  // Grow with the text, up to a third of the window.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight / 3))}px`;
  }, [text]);
  // A starter prompt filled the box: put the cursor at its end.
  useEffect(() => {
    if (value === undefined || !value) return;
    const el = box.current;
    if (el && document.activeElement !== el) { el.focus(); el.setSelectionRange(value.length, value.length); }
  }, [value]);

  const ready = (!!text.trim() || files.length > 0) && !blocked && !sending;
  const send = async () => {
    if (!ready) return;
    setSending(true);
    try {
      let message = text.trim();
      if (files.length && attach) {
        // Each file goes into the agent's sandbox; the message says where, so the agent reads it with its tools.
        const lines: string[] = [];
        for (const f of files) lines.push(`- ${await attach(f.file)} (${kind(f.file)}, ${f.file.name})`);
        message = `${message || "Have a look at the attached files."}\n\nAttached files, in your sandbox (read them with your file tool; images and PDFs too):\n${lines.join("\n")}`;
      }
      await onSend(message);
      setText("");
      files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
      setFiles([]);
    } catch (e) {
      toast(errorMessage(e), "err");
    } finally {
      setSending(false);
      box.current?.focus();
    }
  };
  const [prefs] = useChatPrefs();
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (prefs.send === "enter" ? !e.shiftKey && !mod : mod) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className={`cv-compose ${large ? "large" : ""}`}>
      {files.length > 0 && (
        <div className="cv-files">
          {files.map((f) => (
            <span key={f.id} className="cv-file" title={`${f.file.name}, ${size(f.file.size)}`}>
              {f.preview ? <img src={f.preview} alt="" /> : <span className="cv-file-kind">{kind(f.file) === "PDF" ? "PDF" : "FILE"}</span>}
              <span className="clip">{f.file.name}</span>
              <button className="cv-file-x" onClick={() => removeFile(f.id)} aria-label={`Remove ${f.file.name}`} disabled={sending}><X size={12} /></button>
            </span>
          ))}
        </div>
      )}
      <div
        className={`cv-composer ${blocked ? "blocked" : ""} ${large ? "large" : ""} ${dragging ? "dragging" : ""}`}
        onDragOver={attach && !blocked ? (e) => { e.preventDefault(); setDragging(true); } : undefined}
        onDragLeave={() => setDragging(false)}
        onDrop={attach && !blocked ? (e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); } : undefined}
      >
        {blocked ? (
          <span className="cv-composer-hint">{blocked}</span>
        ) : (
          <>
            {attach && (
              <>
                <button type="button" className="btn ghost icon cv-attach" onClick={() => picker.current?.click()} aria-label="Attach files" title="Attach files, images or PDFs (or drop or paste them)" disabled={sending}><Paperclip size={16} /></button>
                <input ref={picker} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
              </>
            )}
            <textarea ref={box} rows={1} value={text} autoFocus={autoFocus} placeholder={placeholder} aria-label={placeholder}
              onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
              onPaste={attach ? (e) => { const imgs = Array.from(e.clipboardData.files); if (imgs.length) { e.preventDefault(); addFiles(imgs); } } : undefined} />
            <button className="btn primary icon cv-send" onClick={send} disabled={!ready} aria-label="Send" title={text.trim() ? "Send" : "Type a message first"}>
              <ArrowUp size={16} />
            </button>
          </>
        )}
      </div>
      {!blocked && <div className="cv-compose-note">{sending && files.length ? "Sending files…" : prefs.send === "enter" ? `Enter to send · Shift+Enter for a new line${attach ? " · drop or paste files" : ""}` : `${/Mac/.test(navigator.platform) ? "⌘" : "Ctrl"}+Enter to send · Enter for a new line`}</div>}
    </div>
  );
}

/** Why an agent can't take a message right now, with the way out when there is one. */
export function useAgentGate(agent: Agent | undefined, onChanged?: () => void) {
  const { state } = useStore();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!agent) return { blocked: undefined as ReactNode, working: false };
  const working = isLive() && agent.status === "running";
  if (!isLive() || working) return { blocked: undefined as ReactNode, working };
  const start = () => {
    setBusy(true);
    api.agentStart(state.ns, agent.id).then(onChanged).catch((e) => toast(errorMessage(e), "err")).finally(() => setBusy(false));
  };
  const resume = () => {
    setBusy(true);
    api.agentResume(state.ns, agent.id).then(onChanged).catch((e) => toast(errorMessage(e), "err")).finally(() => setBusy(false));
  };
  let blocked: ReactNode;
  if (agent.status === "paused") blocked = <>{agent.name} is paused. <button className="link" disabled={busy} onClick={resume}>Resume it</button> to send a message.</>;
  else if (agent.status === "starting" || agent.status === "restarting") blocked = <>{agent.name} is starting…</>;
  else if (!agent.sandboxId) blocked = <>{agent.name} has no sandbox yet. Assign one on its page to start it.</>;
  else blocked = <>{agent.name} is {agent.status === "failed" ? "not running (it failed)" : "stopped"}. <button className="link" disabled={busy} onClick={start}>Start it</button> to send a message.</>;
  return { blocked, working: false };
}
