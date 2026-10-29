import { useEffect, useRef, useState } from "react";
import type { ThemeId } from "../types";

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

const LINK = 140; // px: max distance for a strand between two nodes
const REACH = 200; // px: how far the cursor casts its web

// Drifting node graph behind the whole app. The cursor acts as an extra node
// that spins strands to anything nearby, like a spider walking its web.
export function NeuralWeb({ theme, active }: { theme: ThemeId; active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rgb = getComputedStyle(document.documentElement).getPropertyValue("--web").trim().split(/\s+/).join(",");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const mouse = { x: -9999, y: -9999 };
    let nodes: Node[] = [];
    let w = 0;
    let h = 0;
    let raf = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.min(120, Math.round((w * h) / 15000));
      nodes = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.22,
        vy: (Math.random() - 0.5) * 0.22,
        r: Math.random() < 0.12 ? 2.2 : 1.1 + Math.random() * 0.6,
      }));
    };

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      for (const n of nodes) {
        if (active && !reduced) {
          n.x += n.vx;
          n.y += n.vy;
          if (n.x < 0 || n.x > w) n.vx *= -1;
          if (n.y < 0 || n.y > h) n.vy *= -1;
          // Gentle pull toward the cursor.
          const dx = mouse.x - n.x;
          const dy = mouse.y - n.y;
          const d = Math.hypot(dx, dy);
          if (d < REACH && d > 1) {
            n.x += (dx / d) * 0.12;
            n.y += (dy / d) * 0.12;
          }
        }
      }
      ctx.lineWidth = 0.7;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < LINK) {
            ctx.strokeStyle = `rgba(${rgb},${(1 - d / LINK) * 0.22})`;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
        const dm = Math.hypot(a.x - mouse.x, a.y - mouse.y);
        if (dm < REACH) {
          ctx.strokeStyle = `rgba(${rgb},${(1 - dm / REACH) * 0.5})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(mouse.x, mouse.y);
          ctx.stroke();
        }
      }
      for (const n of nodes) {
        ctx.fillStyle = `rgba(${rgb},${n.r > 2 ? 0.9 : 0.55})`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fill();
        if (n.r > 2) {
          ctx.fillStyle = `rgba(${rgb},0.12)`;
          ctx.beginPath();
          ctx.arc(n.x, n.y, 7, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (active && !reduced && !document.hidden) raf = requestAnimationFrame(draw);
    };

    const onMove = (e: MouseEvent) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    };
    const onLeave = () => {
      mouse.x = mouse.y = -9999;
    };
    const onVisible = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) raf = requestAnimationFrame(draw);
    };

    resize();
    raf = requestAnimationFrame(draw);
    window.addEventListener("resize", resize);
    window.addEventListener("mousemove", onMove);
    document.addEventListener("mouseleave", onLeave);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseleave", onLeave);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [theme, active]);

  return <canvas ref={ref} className="web-canvas" aria-hidden />;
}

// A small spider hanging from the top bar on a silk thread. Click it and it climbs away for a moment.
export function Spider() {
  const [climbing, setClimbing] = useState(false);
  const climb = () => {
    if (climbing) return;
    setClimbing(true);
    setTimeout(() => setClimbing(false), 2600);
  };
  // Each leg: hip on the body, a raised knee, then a foot. Front pair reaches up, back pair trails down.
  const KNEE_Y = [-12, -8, -2, 4];
  const FOOT = [[9, -16], [14, -6], [14, 6], [10, 15]];
  const leg = (side: 1 | -1, i: number) => {
    const hipY = -2 + i * 2.4;
    const [fx, fy] = FOOT[i];
    return <path key={`${side}${i}`} d={`M ${side * 3} ${hipY} L ${side * 9} ${KNEE_Y[i]} L ${side * fx} ${fy}`} />;
  };
  return (
    <svg className={`spider ${climbing ? "climb" : ""}`} width="40" height="150" viewBox="-20 0 40 150" aria-hidden>
      <g className="body" onClick={climb}>
        <line className="thread" x1="0" y1="-80" x2="0" y2="112" />
        <g transform="translate(0 120)">
          <g className="bob">
          <g className="legs">
            {[0, 1, 2, 3].map((i) => leg(-1, i))}
            {[0, 1, 2, 3].map((i) => leg(1, i))}
          </g>
          <ellipse className="sp-body" cx="0" cy="5" rx="6" ry="7.5" />
          <circle className="sp-body" cx="0" cy="-4" r="4" />
          <circle className="eye" cx="-1.5" cy="-4.6" r="0.9" />
          <circle className="eye" cx="1.5" cy="-4.6" r="0.9" />
          </g>
        </g>
      </g>
    </svg>
  );
}
