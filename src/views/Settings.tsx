import { useCallback, useEffect, useState } from "react";
import { api, errorMessage, isLive } from "../backend";
import type { AuditEntry } from "../bindings/AuditEntry";
import { Check, Palette, RefreshCw, ScrollText, SlidersHorizontal, User } from "lucide-react";
import "../styles/pages.css";
import { DEFAULT_APPEARANCE, useStore, useToast } from "../store";
import { themes } from "../themes";
import { ACCENTS, FONTS, contrast, fontFamily } from "../appearance";
import { PageHead, Toggle } from "../components/ui";
import { BrandIcon, providerIcon, providerLabel } from "./Auth";
import type { Appearance, AuthProvider } from "../types";

const HEX = /^#[0-9a-fA-F]{6}$/;

const SECTIONS = [
  { id: "account", label: "Account", icon: User },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "audit", label: "Audit log", icon: ScrollText },
  { id: "preferences", label: "Preferences", icon: SlidersHorizontal },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];
const SECTION_KEY = "kalypso.settings.section";

function savedSection(): SectionId {
  try {
    const v = localStorage.getItem(SECTION_KEY);
    if (SECTIONS.some((s) => s.id === v)) return v as SectionId;
  } catch {
    // Storage blocked: start on the first section.
  }
  return "account";
}

export function SettingsView() {
  const [section, setSection] = useState<SectionId>(savedSection);
  const pick = (id: SectionId) => {
    setSection(id);
    try { localStorage.setItem(SECTION_KEY, id); } catch { /* not remembered, still works */ }
  };
  const current = SECTIONS.find((s) => s.id === section)!;

  return (
    <>
      <PageHead title="Settings" />
      <div className="settings">
        <nav className="subnav" aria-label="Settings sections">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`subnav-item ${id === section ? "active" : ""}`} aria-current={id === section ? "page" : undefined} onClick={() => pick(id)}>
              <Icon size={15} /> {label}
            </button>
          ))}
        </nav>
        <section className="settings-body" key={section}>
          <h2 className="settings-title">{current.label}</h2>
          {section === "account" && <Account />}
          {section === "appearance" && <AppearanceSection />}
          {section === "audit" && <AuditLog />}
          {section === "preferences" && <Preferences />}
        </section>
      </div>
    </>
  );
}

function Preferences() {
  const { state, dispatch } = useStore();
  const toast = useToast();
  return (
    <div className="card" style={{ padding: "4px 18px" }}>
      <Setting title="Ambient background" desc="A faint node web behind the app that follows the cursor, with a small spider. Off by default.">
        <Toggle on={state.ambient} onChange={(v) => dispatch({ type: "ambient", value: v })} label="Ambient web" />
      </Setting>
      <Setting title="Show code by default" desc="When off, configs, manifests and policy specs stay hidden until you open them.">
        <Toggle on={state.showCode} onChange={(v) => dispatch({ type: "showCode", value: v })} label="Show code by default" />
      </Setting>
      <Setting title="Reset prototype data" desc="Restores the sample namespaces, agents, policies and integrations.">
        <button className="btn danger" onClick={() => { if (confirm("Reset all prototype data?")) { dispatch({ type: "reset" }); toast("Prototype data reset", "info"); } }}>Reset</button>
      </Setting>
    </div>
  );
}

function AppearanceSection() {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const a = state.appearance;
  const set = (patch: Partial<Appearance>) => dispatch({ type: "appearance", patch });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div className="field">
        Theme
        <div className="grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
          {[...themes, { id: "custom" as const, label: "Custom", hint: "Your own colours", swatch: [a.bg, a.text, a.accent] as [string, string, string] }].map((t) => (
            <button key={t.id} className="tile" onClick={() => set({ theme: t.id })} style={{ borderColor: a.theme === t.id ? "var(--accent-hi)" : undefined }}>
              <span className="swatch">{t.swatch.map((c, i) => <span key={i} style={{ background: c, width: 12 }} />)}</span>
              <div>
                <div style={{ fontWeight: 500, color: "var(--text)" }}>{t.label}</div>
                <div className="faint small">{t.hint}</div>
              </div>
              <span className="spacer" />
              {a.theme === t.id && <Check size={15} color="var(--accent-hi)" />}
            </button>
          ))}
        </div>
      </div>

      {a.theme === "custom" && (
        <div className="field-row">
          <ColorField label="Background" value={a.bg} onChange={(bg) => set({ bg })} />
          <ColorField label="Text" value={a.text} onChange={(text) => set({ text })} />
        </div>
      )}
      {a.theme === "custom" && contrast(a.bg, a.text) < 4.5 && (
        <div className="small" style={{ marginTop: -12 }}>Text and background are too close in brightness to read comfortably. Aim for more contrast.</div>
      )}

      <div className="field">
        Accent
        <div className="row" style={{ flexWrap: "wrap" }}>
          {ACCENTS.map((c) => (
            <button
              key={c}
              title={c}
              aria-label={`Accent ${c}`}
              onClick={() => set({ accent: c })}
              style={{ width: 26, height: 26, borderRadius: 8, background: c, cursor: "pointer", border: 0, outline: a.accent.toLowerCase() === c ? "2px solid var(--text)" : "none", outlineOffset: 2 }}
            />
          ))}
          <ColorInput value={a.accent} onChange={(accent) => set({ accent })} />
        </div>
      </div>

      <div className="field-row">
        <label className="field">
          Font
          <select className="select" value={a.font.startsWith("system:") ? "system" : a.font} onChange={(e) => set({ font: e.target.value === "system" ? "system:system-ui" : e.target.value })}>
            {FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            <option value="system">Another font on this computer</option>
          </select>
        </label>
        {a.font.startsWith("system:") ? (
          <label className="field">
            Font name
            <input className="input" value={a.font.slice(7)} onChange={(e) => set({ font: `system:${e.target.value}` })} placeholder="e.g. SF Pro Text, Segoe UI, Ubuntu" />
          </label>
        ) : (
          <div className="field">
            Size
            <div className="segmented" style={{ alignSelf: "flex-start" }}>
              {(["compact", "default", "large"] as const).map((s) => (
                <button key={s} className={a.size === s ? "active" : ""} onClick={() => set({ size: s })}>{s[0].toUpperCase() + s.slice(1)}</button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="field">
        Preview
        <div className="card" style={{ fontFamily: `${fontFamily(a.font)}, system-ui`, color: "var(--text)" }}>
          <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-0.01em" }}>coder opened PR #482</div>
          <div className="dim" style={{ marginTop: 2 }}>Retry webhooks with exponential backoff. 3 files changed, 0123456789.</div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn primary sm">Approve</button>
            <button className="btn sm">Request changes</button>
          </div>
        </div>
      </div>

      <div className="row">
        <button className="btn ghost sm" style={{ marginLeft: -9 }} onClick={() => { set(DEFAULT_APPEARANCE); toast("Appearance reset", "info"); }}>Reset to black, white and purple</button>
      </div>
    </div>
  );
}

function Account() {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const user = state.session!;
  const all: AuthProvider[] = ["google", "github", "gitlab"];
  return (
    <>
      <div className="card">
        <div className="row">
          <span className="avatar" style={{ width: 36, height: 36, fontSize: 13 }}>{user.name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase()}</span>
          <div>
            <div style={{ fontWeight: 500 }}>{user.name}</div>
            <div className="faint small">{user.email}, signed in with {providerLabel(user.provider)}</div>
          </div>
          <span className="spacer" />
          <button className="btn" onClick={() => dispatch({ type: "logout" })}>Sign out</button>
        </div>
        <div style={{ marginTop: 14 }}>
          {all.map((p) => {
            const linked = user.linked.includes(p);
            return (
              <div key={p} className="list-row">
                <BrandIcon icon={providerIcon(p)!} />
                <span>{providerLabel(p)}</span>
                <span className="spacer" />
                {linked ? (
                  <span className="faint small">Connected</span>
                ) : (
                  <button className="btn sm" onClick={() => { dispatch({ type: "linkProvider", provider: p }); toast(`${providerLabel(p)} connected`); }}>Connect</button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="field">
      {label}
      <ColorInput value={value} onChange={onChange} />
    </div>
  );
}

// Native picker plus a hex box; the hex box only commits valid colours.
function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="row" style={{ gap: 6 }}>
      <input type="color" value={value} onChange={(e) => { onChange(e.target.value); setDraft(e.target.value); }} style={{ width: 32, height: 32, padding: 0, border: "1px solid var(--border-strong)", borderRadius: 6, background: "none", cursor: "pointer" }} />
      <input
        className="input mono"
        style={{ width: 96 }}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          if (HEX.test(e.target.value)) onChange(e.target.value.toLowerCase());
        }}
        onBlur={() => setDraft(value)}
      />
    </div>
  );
}

function Setting({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="list-row" style={{ padding: "14px 0" }}>
      <div>
        <div>{title}</div>
        <div className="faint small">{desc}</div>
      </div>
      <span className="spacer" />
      {children}
    </div>
  );
}

const KINDS = [
  { id: "", label: "Everything" },
  { id: "secret.", label: "Secrets" },
  { id: "sandbox.", label: "Sandboxes" },
  { id: "namespace.", label: "Namespaces" },
];

// Security-relevant actions recorded by the core (src-tauri/src/store). Newest first.
function AuditLog() {
  const { state } = useStore();
  const toast = useToast();
  const [kind, setKind] = useState("");
  const [thisNs, setThisNs] = useState(true);
  const [rows, setRows] = useState<AuditEntry[] | null>(null);

  const load = useCallback(() => {
    if (!isLive()) return;
    api.auditList(thisNs ? state.ns : null, kind || null, 200).then(setRows).catch((e) => toast(errorMessage(e), "err"));
  }, [thisNs, kind, state.ns, toast]);
  useEffect(load, [load]);

  return (
    <>
      <div className="row" style={{ marginBottom: 12, flexWrap: "wrap" }}>
        {isLive() && (
          <>
            <div className="segmented">
              {KINDS.map((k) => <button key={k.id} className={kind === k.id ? "active" : ""} onClick={() => setKind(k.id)}>{k.label}</button>)}
            </div>
            <div className="segmented">
              <button className={thisNs ? "active" : ""} onClick={() => setThisNs(true)}>{state.ns}</button>
              <button className={!thisNs ? "active" : ""} onClick={() => setThisNs(false)}>All</button>
            </div>
            <button className="btn ghost sm icon" title="Refresh" onClick={load}><RefreshCw size={13} /></button>
          </>
        )}
      </div>
      <div className="card flush">
        {!isLive() ? (
          <div className="faint" style={{ padding: 16 }}>The audit log is recorded by the desktop app.</div>
        ) : rows === null ? (
          <div className="faint" style={{ padding: 16 }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div className="faint" style={{ padding: 16 }}>Nothing recorded yet.</div>
        ) : (
          <div style={{ maxHeight: 320, overflow: "auto" }}>
            <table className="table">
              <thead><tr><th>When (UTC)</th><th>Namespace</th><th>Action</th><th>Target</th><th>By</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono faint small">{r.ts}</td>
                    <td className="dim">{r.ns ?? "None"}</td>
                    <td className="mono small">{r.action}</td>
                    <td className="clip" style={{ maxWidth: 220 }} title={r.target}>{r.target}</td>
                    <td className="dim">{r.actor}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
