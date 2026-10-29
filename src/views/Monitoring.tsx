import { useEffect, useMemo, useState } from "react";
import { Pause, Play } from "lucide-react";
import { useNamespaced } from "../store";
import { LineChart } from "../components/LineChart";

type Range = "15m" | "1h" | "24h";
const POINTS = 40;
const STEP_MIN: Record<Range, number> = { "15m": 15 / POINTS, "1h": 60 / POINTS, "24h": 1440 / POINTS };

interface Metric {
  key: string;
  label: string;
  base: number;
  jitter: number;
  format: (v: number) => string;
}

const METRICS: Metric[] = [
  { key: "rpm", label: "Model requests per minute", base: 42, jitter: 0.35, format: (v) => v.toFixed(0) },
  { key: "tpm", label: "Tokens per minute", base: 61000, jitter: 0.3, format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0)) },
  { key: "p95", label: "p95 latency", base: 1850, jitter: 0.25, format: (v) => `${(v / 1000).toFixed(1)}s` },
  { key: "err", label: "Error rate", base: 1.6, jitter: 0.6, format: (v) => `${v.toFixed(1)}%` },
];

// Mock telemetry: a bounded random walk per metric. The real feed comes from
// the model gateway and the Docker stats stream (ARCHITECTURE.md §4.17).
function walk(seed: number, base: number, jitter: number, n: number) {
  let s = seed;
  const rand = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const out: number[] = [];
  let v = base;
  for (let i = 0; i < n; i++) {
    v = Math.max(base * 0.25, Math.min(base * 1.9, v + (rand() - 0.5) * base * jitter));
    out.push(v);
  }
  return out;
}

const clock = (minsAgo: number) => {
  const d = new Date(Date.now() - minsAgo * 60000);
  return d.toTimeString().slice(0, 5);
};

export function MonitoringPanel() {
  const { namespace } = useNamespaced();
  const [range, setRange] = useState<Range>("1h");
  const [live, setLive] = useState(true);
  const seed = (namespace?.id ?? "").length * 97 + range.length * 13;

  const [series, setSeries] = useState(() => Object.fromEntries(METRICS.map((m, i) => [m.key, walk(seed + i * 31, m.base, m.jitter, POINTS)])));
  useEffect(() => {
    setSeries(Object.fromEntries(METRICS.map((m, i) => [m.key, walk(seed + i * 31, m.base, m.jitter, POINTS)])));
  }, [seed]);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => {
      setSeries((prev) =>
        Object.fromEntries(
          METRICS.map((m) => {
            const arr = prev[m.key];
            const last = arr[arr.length - 1];
            const next = Math.max(m.base * 0.25, Math.min(m.base * 1.9, last + (Math.random() - 0.5) * m.base * m.jitter));
            return [m.key, [...arr.slice(1), next]];
          }),
        ),
      );
    }, 2000);
    return () => clearInterval(t);
  }, [live]);

  const labels = useMemo(() => Array.from({ length: POINTS }, (_, i) => clock((POINTS - 1 - i) * STEP_MIN[range])), [range, series]);
  const now = (k: string) => series[k][series[k].length - 1];

  return (
    <section>
      <div className="row" style={{ margin: "0 0 12px" }}>
        <h2 style={{ fontSize: 15 }}>Monitoring</h2>
        <span className="spacer" />
        <div className="segmented">
          {(["15m", "1h", "24h"] as Range[]).map((r) => (
            <button key={r} className={range === r ? "active" : ""} onClick={() => setRange(r)}>{r}</button>
          ))}
        </div>
        <button className="btn sm" onClick={() => setLive(!live)} title={live ? "Pause live updates" : "Resume live updates"}>
          {live ? <Pause size={12} /> : <Play size={12} />} {live ? "Live" : "Paused"}
        </button>
      </div>

      <div className="metric-grid">
        {METRICS.map((m) => (
          <div key={m.key} className="card">
            <div className="card-head"><span className="card-title">{m.label}</span><span className="spacer" /><span className="mono">{m.format(now(m.key))}</span></div>
            <LineChart values={series[m.key]} labels={labels} format={m.format} height={96} />
          </div>
        ))}
      </div>

    </section>
  );
}
