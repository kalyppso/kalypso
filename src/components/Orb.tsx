import { useEffect, useRef } from "react";

/**
 * A ring of bars around an egg-shaped body, like a music visualizer, drawn in the theme's text colour.
 * At rest it breathes; while `active` the bars ripple and the ring turns; each change of
 * `pulse` sends one wave around it. Every value eases toward its target, so changes of
 * state never jump. Pauses when off screen or in a hidden window; still with reduced motion.
 */
interface OrbProps {
  size: number;
  active?: boolean;
  /** Change it (a counter) to send a wave around the ring, for example when a message is sent. */
  pulse?: number;
  className?: string;
  label?: string;
}

export function Orb({ size, active = false, pulse = 0, className, label }: OrbProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // Read by the animation loop without restarting it.
  const want = useRef({ active, pulse });
  want.current.active = active;

  const kick = useRef(0);
  const lastPulse = useRef(pulse);
  if (pulse !== lastPulse.current) {
    lastPulse.current = pulse;
    kick.current = 1;
  }

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.width = Math.round(size * dpr);
    el.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const small = size < 64;
    const bars = small ? 28 : 72;
    const c = size / 2;
    const core = size * (small ? 0.2 : 0.24); // the egg-shaped body
    const base = size * (small ? 0.3 : 0.31); // where the bars start
    const reach = size * (small ? 0.18 : 0.17); // the longest a bar can grow
    const width = Math.max(1.25, size * (small ? 0.045 : 0.016));

    // Eased state: how lively the ring is, its spin, and the wave travelling round it.
    let energy = want.current.active ? 1 : 0;
    let spin = 0;
    let wave = 0;
    let waveAt = 0;
    let rgb = "221, 222, 223";
    const rgba = (alpha: number) => `rgba(${rgb}, ${alpha.toFixed(3)})`;
    const heights = new Float32Array(bars);

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = true;
    let raf = 0;
    let last = performance.now();
    const t0 = last;

    const readColour = () => {
      const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(el).color);
      if (m) rgb = m[1].split(",").slice(0, 3).map((x) => x.trim()).join(", ");
    };
    readColour();
    // The theme can change while the orb is on screen.
    const themeWatch = new MutationObserver(readColour);
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });

    const draw = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const t = (now - t0) / 1000;

      // Ease toward the wanted state: about half a second to wake, a second to settle.
      const target = want.current.active ? 1 : 0;
      energy += (target - energy) * (1 - Math.exp(-dt * (target > energy ? 4 : 2)));
      spin += dt * (0.08 + energy * 0.35);
      if (kick.current > 0) {
        wave = 1;
        waveAt = 0;
        kick.current = 0;
      }
      wave *= Math.exp(-dt * 1.6);
      waveAt += dt * 2.4;

      ctx.clearRect(0, 0, size, size);
      ctx.lineCap = "round";
      ctx.lineWidth = width;

      // The body is an egg, not a circle: fuller at the bottom, with a slow organic wobble.
      // `outline(ang)` is the body's radius at a screen angle (0 = right, π/2 = down).
      const swell = 1 + 0.035 * Math.sin(t * 1.4) * (1 - energy) + 0.05 * energy * (0.5 + 0.5 * Math.sin(t * 4.2)) + wave * 0.07;
      const outline = (ang: number) =>
        swell *
        (1 +
          0.085 * Math.sin(ang) + // egg: wider below, narrower above
          (0.025 + 0.02 * energy) * Math.sin(2 * ang + t * 0.7) +
          (0.018 + 0.015 * energy) * Math.sin(3 * ang - t * 0.5 + 1.1));

      for (let i = 0; i < bars; i++) {
        const a = (i / bars) * Math.PI * 2;
        // Layered slow sines around the ring give a smooth, never-repeating shape.
        const shape =
          0.5 +
          0.28 * Math.sin(a * 3 + t * 1.7) +
          0.16 * Math.sin(a * 5 - t * 2.3 + 1.3) +
          0.1 * Math.sin(a * 9 + t * 3.1 + 2.1);
        const breathe = 0.12 + 0.06 * Math.sin(t * 1.4);
        // The wave: a bump travelling round from the top.
        const d = Math.abs(((a - waveAt * Math.PI + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        const bump = wave * Math.exp(-d * d * 3);
        const h = Math.max(0.04, breathe * (1 - energy) + shape * energy * 0.95 + bump * 0.9);
        // Each bar follows its target a little behind, so the motion stays soft.
        heights[i] += (h - heights[i]) * (1 - Math.exp(-dt * 14));

        // The pattern turns; the egg stays upright.
        const ang = a + spin - Math.PI / 2;
        const cos = Math.cos(ang);
        const sin = Math.sin(ang);
        const k = outline(ang);
        const r0 = base * k;
        const r1 = r0 + heights[i] * reach;
        const x0 = c + cos * r0, y0 = c + sin * r0, x1 = c + cos * r1, y1 = c + sin * r1;
        // Solid at the root, fading to nothing at the tip.
        const g = ctx.createLinearGradient(x0, y0, x1, y1);
        const strength = 0.45 + 0.55 * Math.min(1, heights[i] * 1.4);
        g.addColorStop(0, rgba(strength));
        g.addColorStop(1, rgba(0));
        ctx.strokeStyle = g;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }

      // The core: no outline, just a softly shaded egg, lit from the upper left like a sphere.
      ctx.beginPath();
      for (let j = 0; j <= 96; j++) {
        const ang = (j / 96) * Math.PI * 2;
        const r = core * outline(ang);
        const x = c + Math.cos(ang) * r, y = c + Math.sin(ang) * r;
        if (j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      const lit = ctx.createRadialGradient(c - core * 0.35, c - core * 0.45, core * 0.05, c, c, core * 1.15);
      lit.addColorStop(0, rgba(0.26 + 0.1 * energy));
      lit.addColorStop(0.55, rgba(0.1 + 0.05 * energy));
      lit.addColorStop(1, rgba(0.02));
      ctx.fillStyle = lit;
      ctx.fill();

      if (visible && !reduce.matches && !document.hidden) raf = requestAnimationFrame(draw);
      else raf = 0;
    };

    const resume = () => {
      if (!raf && visible && !document.hidden) {
        last = performance.now();
        raf = requestAnimationFrame(draw);
      }
    };
    const seen = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      resume();
    });
    seen.observe(el);
    document.addEventListener("visibilitychange", resume);
    reduce.addEventListener("change", resume);
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      seen.disconnect();
      themeWatch.disconnect();
      document.removeEventListener("visibilitychange", resume);
      reduce.removeEventListener("change", resume);
    };
  }, [size]);

  return <canvas ref={canvas} className={`orb ${className ?? ""}`} style={{ width: size, height: size }} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}
