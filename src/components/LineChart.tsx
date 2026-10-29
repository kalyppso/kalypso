import { useEffect, useRef, useState } from "react";

const PAD = { l: 40, r: 8, t: 8, b: 20 };

// Single-series line chart with a crosshair tooltip. Drawn in real pixels so
// text never stretches; width follows the container.
export function LineChart({ values, labels, format, height: H = 140 }: { values: number[]; labels: string[]; format: (v: number) => string; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(160, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const max = Math.max(...values, 0) * 1.15 || 1;
  const x = (i: number) => PAD.l + (i / Math.max(values.length - 1, 1)) * (w - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const line = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(values.length - 1)},${y(0)} L${x(0)},${y(0)} Z`;

  const onMove = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - PAD.l) / (w - PAD.l - PAD.r)) * (values.length - 1));
    setHover(Math.max(0, Math.min(values.length - 1, i)));
  };

  return (
    <div className="lchart" ref={ref} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg width={w} height={H}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line className="gridline" x1={PAD.l} x2={w - PAD.r} y1={y(max * f)} y2={y(max * f)} />
            <text className="axis" x={PAD.l - 6} y={y(max * f) + 3} textAnchor="end">{format(max * f)}</text>
          </g>
        ))}
        <text className="axis" x={PAD.l} y={H - 4}>{labels[0]}</text>
        <text className="axis" x={w - PAD.r} y={H - 4} textAnchor="end">{labels[labels.length - 1]}</text>
        <path className="area" d={area} />
        <path className="line" d={line} />
        {hover !== null && (
          <g>
            <line className="cross" x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} />
            <circle className="marker" cx={x(hover)} cy={y(values[hover])} r={4} />
          </g>
        )}
      </svg>
      {hover !== null && (
        <div className="tip" style={{ left: Math.min(Math.max(x(hover), 60), w - 60) }}>
          <span className="faint">{labels[hover]}</span> <strong style={{ fontWeight: 600 }}>{format(values[hover])}</strong>
        </div>
      )}
    </div>
  );
}
