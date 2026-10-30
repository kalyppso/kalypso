import { useEffect, useRef, useState } from "react";
import { Check, Pipette } from "lucide-react";
import { ACCENTS } from "../appearance";

// A colour picker that looks the same on every platform: a saturation/brightness
// square, a hue strip, a hex field, presets and recently used colours.

const HEX = /^#[0-9a-fA-F]{6}$/;
const RECENT_KEY = "kalypso.recent-colors";

type Hsv = { h: number; s: number; v: number };

function hexToHsv(hex: string): Hsv {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => x / 255);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

function hsvToHex({ h, s, v }: Hsv) {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return "#" + [f(5), f(3), f(1)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((c) => typeof c === "string" && HEX.test(c)).slice(0, 9) : [];
  } catch {
    return [];
  }
}

function remember(c: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([c, ...readRecent().filter((x) => x !== c)].slice(0, 9)));
  } catch {
    /* storage unavailable: recents are a convenience */
  }
}

/** Drag inside `el`, reporting the pointer as 0..1 on each axis. */
function useDrag(onMove: (x: number, y: number) => void, onEnd: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const move = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    onMove(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
  };
  return {
    ref,
    onPointerDown: (e: React.PointerEvent) => { ref.current!.setPointerCapture(e.pointerId); move(e); },
    onPointerMove: (e: React.PointerEvent) => { if (ref.current!.hasPointerCapture(e.pointerId)) move(e); },
    onPointerUp: () => onEnd(),
  };
}

export function ColorPicker({ value, onChange, presets = ACCENTS }: { value: string; onChange: (v: string) => void; presets?: string[] }) {
  const [open, setOpen] = useState(false);
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  const [draft, setDraft] = useState(value);
  const [recent, setRecent] = useState<string[]>([]);
  const wrap = useRef<HTMLDivElement>(null);

  // Follow outside changes, but keep our hue when the colour is grey (it has none).
  useEffect(() => {
    setDraft(value);
    setHsv((cur) => (hsvToHex(cur) === value.toLowerCase() ? cur : { ...hexToHsv(value), h: hexToHsv(value).s ? hexToHsv(value).h : cur.h }));
  }, [value]);

  useEffect(() => {
    if (!open) return;
    setRecent(readRecent());
    const away = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  const commit = (next: Hsv) => { setHsv(next); const hex = hsvToHex(next); setDraft(hex); onChange(hex); };
  const pick = (hex: string) => { setHsv(hexToHsv(hex)); setDraft(hex); onChange(hex); remember(hex); setRecent(readRecent()); };
  const done = () => remember(hsvToHex(hsv));

  const area = useDrag((x, y) => commit({ ...hsv, s: x, v: 1 - y }), done);
  const hue = useDrag((x) => commit({ ...hsv, h: Math.min(359.9, x * 360) }), done);

  const EyeDropper = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
  const sample = () => EyeDropper && new EyeDropper().open().then((r) => HEX.test(r.sRGBHex) && pick(r.sRGBHex.toLowerCase())).catch(() => {});

  // Arrow keys nudge the square and the strip, so the picker works without a mouse.
  const keyArea = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (!d) return;
    e.preventDefault();
    commit({ ...hsv, s: Math.min(1, Math.max(0, hsv.s + d[0])), v: Math.min(1, Math.max(0, hsv.v + d[1])) });
  };
  const keyHue = (e: React.KeyboardEvent) => {
    const d = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (!d) return;
    e.preventDefault();
    commit({ ...hsv, h: (hsv.h + d * (e.shiftKey ? 10 : 1) + 360) % 360 });
  };

  return (
    <div className="cp" ref={wrap}>
      <button type="button" className="cp-trigger" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`Colour ${value}`}>
        <span className="cp-chip" style={{ background: value }} />
        <span className="mono">{value.toUpperCase()}</span>
      </button>

      {open && (
        <div className="cp-pop" role="dialog" aria-label="Pick a colour">
          <div
            {...area}
            className="cp-area"
            tabIndex={0}
            role="slider"
            aria-label="Saturation and brightness"
            aria-valuetext={`saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
            onKeyDown={keyArea}
            style={{ background: `hsl(${hsv.h} 100% 50%)` }}
          >
            <span className="cp-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hsvToHex(hsv) }} />
          </div>

          <div className="row" style={{ gap: 10 }}>
            {EyeDropper && (
              <button type="button" className="btn ghost icon" title="Pick from screen" onClick={sample}><Pipette size={14} /></button>
            )}
            <div
              {...hue}
              className="cp-hue"
              tabIndex={0}
              role="slider"
              aria-label="Hue"
              aria-valuemin={0}
              aria-valuemax={360}
              aria-valuenow={Math.round(hsv.h)}
              onKeyDown={keyHue}
            >
              <span className="cp-thumb" style={{ left: `${(hsv.h / 360) * 100}%`, top: "50%", background: `hsl(${hsv.h} 100% 50%)` }} />
            </div>
          </div>

          <div className="row" style={{ gap: 8 }}>
            <span className="cp-chip lg" style={{ background: hsvToHex(hsv) }} />
            <input
              className="input mono"
              aria-label="Hex"
              value={draft}
              spellCheck={false}
              onChange={(e) => {
                const v = e.target.value.startsWith("#") ? e.target.value : `#${e.target.value}`;
                setDraft(v);
                if (HEX.test(v)) pick(v.toLowerCase());
              }}
              onBlur={() => setDraft(value)}
            />
          </div>

          <Swatches label="Presets" colors={presets} value={value} onPick={pick} />
          {recent.length > 0 && <Swatches label="Recent" colors={recent} value={value} onPick={pick} />}
        </div>
      )}
    </div>
  );
}

function Swatches({ label, colors, value, onPick }: { label: string; colors: string[]; value: string; onPick: (c: string) => void }) {
  return (
    <div>
      <div className="faint small" style={{ marginBottom: 6 }}>{label}</div>
      <div className="cp-swatches">
        {colors.map((c) => (
          <button type="button" key={c} title={c} aria-label={c} className="cp-swatch" style={{ background: c }} onClick={() => onPick(c)}>
            {c === value.toLowerCase() && <Check size={12} color={parseInt(c.slice(1), 16) > 0xbbbbbb ? "#000" : "#fff"} />}
          </button>
        ))}
      </div>
    </div>
  );
}
