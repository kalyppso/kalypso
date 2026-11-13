import { useEffect, useRef, useState } from "react";

/**
 * The pecten: a scallop shell, its ribs fanning from a hinge, as on the website. kalypso is
 * drawn as Kalypso; the crew, the agents she sends out, are her shells.
 *
 * While `active` (the agent is working) light runs out along the ribs. Each change of `pulse`
 * (a counter, raised when a reply arrives) fans the shell open once. Still with reduced motion.
 */
interface PectenProps {
  size: number;
  active?: boolean;
  /** Change it to fan the shell open once, for example when a message is received. */
  pulse?: number;
  className?: string;
  label?: string;
}

const RIBS = 13;
const HINGE = { x: 50, y: 62 };
const SPREAD = (150 * Math.PI) / 180;

/** Points on the rim: one per rib, at the rib's tip, a little longer in the middle. */
const tips = Array.from({ length: RIBS }, (_, i) => {
  const t = i / (RIBS - 1);
  const a = -Math.PI / 2 - SPREAD / 2 + t * SPREAD;
  const r = 44 + 6 * Math.sin(t * Math.PI);
  return { x: HINGE.x + r * Math.cos(a), y: HINGE.y + r * Math.sin(a), a };
});

const ribs = tips.map((p) => `M${HINGE.x} ${HINGE.y}L${p.x.toFixed(1)} ${p.y.toFixed(1)}`);

/** The scalloped edge: a small bulge between neighbouring ribs. */
const rim = tips
  .map((p, i) => {
    if (i === 0) return `M${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    const q = tips[i - 1];
    const mid = (q.a + p.a) / 2;
    const r = Math.hypot(p.x - HINGE.x, p.y - HINGE.y) + 4;
    const cx = HINGE.x + r * Math.cos(mid);
    const cy = HINGE.y + r * Math.sin(mid);
    return `Q${cx.toFixed(1)} ${cy.toFixed(1)} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  })
  .join("");

/** Growth lines across the ribs. */
const arcs = [0.45, 0.7].map((k) => {
  const r = 44 * k;
  const a0 = -Math.PI / 2 - SPREAD / 2;
  const a1 = -Math.PI / 2 + SPREAD / 2;
  const x0 = HINGE.x + r * Math.cos(a0), y0 = HINGE.y + r * Math.sin(a0);
  const x1 = HINGE.x + r * Math.cos(a1), y1 = HINGE.y + r * Math.sin(a1);
  return `M${x0.toFixed(1)} ${y0.toFixed(1)}A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}).join("");

/** The two small wings either side of the hinge. */
const ears = `M38 70L46 63L50 66L54 63L62 70Z`;

export function Pecten({ size, active = false, pulse = 0, className, label }: PectenProps) {
  // Restart the fan animation on every pulse after the first render.
  const first = useRef(true);
  const [fan, setFan] = useState(0);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setFan((n) => n + 1);
  }, [pulse]);
  return (
    <svg
      className={`pecten ${active ? "active" : ""} ${className ?? ""}`}
      width={size}
      height={size * 0.78}
      viewBox="0 0 100 78"
      // One screen pixel in the drawing's units, so lines keep their weight at any size.
      style={{ ["--px" as string]: (100 / size).toFixed(3) }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <g key={fan} className={fan ? "pecten-body fan" : "pecten-body"} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <path className="pecten-ribs" d={ribs.join("")} />
        {/* Light running out along each rib, staggered from the middle out, while it works. */}
        {ribs.map((d, i) => (
          <path key={i} className="pecten-glow" d={d} pathLength={1} style={{ animationDelay: `${Math.abs(i - (RIBS - 1) / 2) * 0.08}s` }} />
        ))}
        <path className="pecten-arcs" d={arcs} />
        <path className="pecten-rim" d={rim} />
        <path className="pecten-ears" d={ears} />
      </g>
    </svg>
  );
}
