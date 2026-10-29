import { useEffect, useMemo, useRef, useState } from "react";
import type { Commit } from "../types";

const WEEKS = 53;
const GAP = 3;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// One hue, light to dark: empty, then four steps of the accent.
const LEVELS = [0, 32, 55, 78, 100];

interface Day {
  date: Date;
  agents: number;
  people: number;
}

// The last 14 days come from real commit data; older days are seeded history
// so the year looks lived-in. The real build reads the full commit log.
function buildYear(commits: Commit[], seed: number): Day[] {
  let s = seed;
  const rand = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (WEEKS - 1) * 7 - today.getDay());
  const days: Day[] = [];
  for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const ago = Math.round((today.getTime() - d.getTime()) / 86400000);
    if (ago < 14) {
      const list = commits.filter((c) => c.day === ago);
      days.push({ date: new Date(d), agents: list.filter((c) => c.isAgent).length, people: list.filter((c) => !c.isAgent).length });
    } else {
      const weekend = d.getDay() === 0 || d.getDay() === 6;
      const busy = rand();
      const total = busy < (weekend ? 0.6 : 0.25) ? 0 : Math.floor(busy * (weekend ? 3 : 8));
      const agents = Math.round(total * (0.3 + rand() * 0.5));
      days.push({ date: new Date(d), agents, people: total - agents });
    }
  }
  return days;
}

export function ContributionGraph({ commits, seed }: { commits: Commit[]; seed: number }) {
  const [who, setWho] = useState<"all" | "agents" | "people">("all");
  const [hover, setHover] = useState<{ day: Day; x: number; y: number } | null>(null);
  // Squares grow to fill the card, like the GitHub profile graph.
  const wrap = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(760);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setAvail(e.contentRect.width));
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);
  const days = useMemo(() => buildYear(commits, seed), [commits, seed]);

  const count = (d: Day) => (who === "agents" ? d.agents : who === "people" ? d.people : d.agents + d.people);
  const total = days.reduce((s, d) => s + count(d), 0);
  const max = Math.max(1, ...days.map(count));
  const level = (n: number) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)));
  const fill = (lv: number) => (lv === 0 ? "var(--card-3)" : `color-mix(in srgb, var(--accent-hi) ${LEVELS[lv]}%, var(--card-3))`);

  const weeks: Day[][] = [];
  days.forEach((d, i) => {
    const w = Math.floor(i / 7);
    (weeks[w] ??= []).push(d);
  });
  const LEFT = 28;
  const TOP = 16;
  const CELL = Math.max(9, Math.min(17, Math.floor((avail - LEFT) / weeks.length) - GAP));
  const width = LEFT + weeks.length * (CELL + GAP);
  const height = TOP + 7 * (CELL + GAP);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <span className="card-title">{total.toLocaleString()} commits in the last year</span>
        <span className="spacer" />
        <div className="segmented">
          {(["all", "agents", "people"] as const).map((w) => (
            <button key={w} className={who === w ? "active" : ""} onClick={() => setWho(w)}>{w === "all" ? "Everyone" : w === "agents" ? "Agents" : "People"}</button>
          ))}
        </div>
      </div>
      <div ref={wrap} style={{ position: "relative", overflowX: "auto" }} onMouseLeave={() => setHover(null)}>
        <svg width={width} height={height} style={{ display: "block" }}>
          {weeks.map((w, wi) => {
            const first = w[0].date;
            const showMonth = first.getDate() <= 7 && wi > 0;
            return (
              <g key={wi}>
                {showMonth && <text x={LEFT + wi * (CELL + GAP)} y={11} fill="var(--text-3)" fontSize={10}>{MONTHS[first.getMonth()]}</text>}
                {w.map((d, di) => {
                  const n = count(d);
                  const x = LEFT + wi * (CELL + GAP);
                  const y = TOP + di * (CELL + GAP);
                  return (
                    <rect
                      key={di}
                      x={x}
                      y={y}
                      width={CELL}
                      height={CELL}
                      rx={3}
                      fill={fill(level(n))}
                      onMouseEnter={() => setHover({ day: d, x, y })}
                    />
                  );
                })}
              </g>
            );
          })}
          {[["Mon", 1], ["Wed", 3], ["Fri", 5]].map(([label, row]) => (
            <text key={label} x={0} y={TOP + (row as number) * (CELL + GAP) + CELL - 2} fill="var(--text-3)" fontSize={10}>{label}</text>
          ))}
        </svg>
        {hover && (
          <div className="tip" style={{ left: hover.x + CELL / 2, top: hover.y < 34 ? hover.y + CELL + 6 : hover.y - 34 }}>
            <strong style={{ fontWeight: 600 }}>{count(hover.day) || "No"} commit{count(hover.day) === 1 ? "" : "s"}</strong>{" "}
            <span className="faint">on {hover.day.date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
            {who === "all" && count(hover.day) > 0 && <span className="faint">, {hover.day.agents} by agents</span>}
          </div>
        )}
      </div>
      <div className="row faint small" style={{ marginTop: 10 }}>
        <span>Agent commits are tagged with a KALYPSO-Agent trailer.</span>
        <span className="spacer" />
        Less
        {LEVELS.map((_, i) => <span key={i} style={{ width: CELL, height: CELL, borderRadius: 3, background: fill(i) }} />)}
        More
      </div>
    </div>
  );
}
