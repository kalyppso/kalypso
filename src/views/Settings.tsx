import { useCallback, useEffect, useState } from "react";
import { api, errorMessage, isLive } from "../backend";
import type { AuditEntry } from "../bindings/AuditEntry";
import { Check, Palette, RefreshCw, ScrollText, SlidersHorizontal, User } from "lucide-react";
import "../styles/pages.css";
import { DEFAULT_APPEARANCE, useStore, useToast } from "../store";
import { themePatch, themes } from "../themes";
import { ACCENTS, FONTS, contrast, fontFamily } from "../appearance";
import { Field, PageHead, Toggle, useErrors } from "../components/ui";
import { NAV } from "../components/Sidebar";
import { APPROVAL_TIMEOUTS, DEFAULT_PREFS, SCROLLBACK, TERM_FONT_SIZES, formatDateTime, formatTime, fromDb, timeZones, type Prefs } from "../prefs";
import { ColorPicker } from "../components/ColorPicker";
import { BrandIcon, providerIcon, providerLabel } from "./Auth";
import type { Appearance, AuthProvider } from "../types";

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
  const p = state.prefs;
  const set = (patch: Partial<Prefs>) => dispatch({ type: "prefs", patch });
  const live = isLive();
  return (
    <>
      <Group title="General">
        <Setting title="Start page" desc="The page KALYPSO opens on.">
          <select className="select" value={p.startView} onChange={(e) => set({ startView: e.target.value as Prefs["startView"] })} style={{ width: 200 }}>
            <option value="last">Where I left off</option>
            {NAV.flatMap((g) => g.items).map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
          </select>
        </Setting>
        <Setting title="Default namespace" desc="The namespace KALYPSO opens in.">
          <select className="select" value={p.defaultNs} onChange={(e) => set({ defaultNs: e.target.value })} style={{ width: 200 }}>
            <option value="last">The last one I used</option>
            {state.namespaces.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
          </select>
        </Setting>
        <Setting title="Reduce motion" desc="Turns off animations and transitions. Also follows your system setting.">
          <Toggle on={p.reduceMotion} onChange={(v) => set({ reduceMotion: v })} label="Reduce motion" />
        </Setting>
      </Group>

      <Group title="Notifications">
        <Setting title="Budget alerts" desc="A desktop notification when spend crosses an alert threshold or a cap pauses requests. In-app notices always show.">
          <Toggle on={p.notifyBudget} onChange={(v) => set({ notifyBudget: v })} label="Budget alert notifications" />
        </Setting>
        <Setting title="Approval requests" desc="A desktop notification when an agent's call waits for your approval.">
          <Toggle on={p.notifyApprovals} onChange={(v) => set({ notifyApprovals: v })} label="Approval notifications" />
        </Setting>
      </Group>

      <Group title="Agents and safety">
        <Setting title="Approval wait" desc="How long a call held by an Ask me policy waits for you. With no answer, it is denied.">
          <select className="select" value={p.approvalTimeoutMin} onChange={(e) => set({ approvalTimeoutMin: +e.target.value })} style={{ width: 200 }}>
            {APPROVAL_TIMEOUTS.map((m) => <option key={m} value={m}>{m === 1 ? "1 minute" : m === 60 ? "1 hour" : `${m} minutes`}</option>)}
          </select>
        </Setting>
        <Setting title="Show code by default" desc="When off, configs, manifests and policy specs stay hidden until you open them.">
          <Toggle on={state.showCode} onChange={(v) => dispatch({ type: "showCode", value: v })} label="Show code by default" />
        </Setting>
      </Group>

      <Group title="Terminal">
        <Setting title="Font size" desc="Applies to every pane right away.">
          <select className="select" value={p.termFontSize} onChange={(e) => set({ termFontSize: +e.target.value })} style={{ width: 200 }}>
            {TERM_FONT_SIZES.map((f) => <option key={f} value={f}>{f}px</option>)}
          </select>
        </Setting>
        <Setting title="Cursor" desc="The shape of the cursor in terminal panes.">
          <div className="segmented">
            {(["block", "bar", "underline"] as const).map((c) => (
              <button key={c} className={p.termCursor === c ? "active" : ""} onClick={() => set({ termCursor: c })}>{c[0].toUpperCase() + c.slice(1)}</button>
            ))}
          </div>
        </Setting>
        <Setting title="Scrollback" desc="Lines each pane keeps above the screen.">
          <select className="select" value={p.termScrollback} onChange={(e) => set({ termScrollback: +e.target.value })} style={{ width: 200 }}>
            {SCROLLBACK.map((n) => <option key={n} value={n}>{n.toLocaleString()} lines</option>)}
          </select>
        </Setting>
      </Group>

      <Group title="Display">
        <Setting title="Ambient background" desc="A faint node web behind the app that follows the cursor, with a small spider.">
          <Toggle on={state.ambient} onChange={(v) => dispatch({ type: "ambient", value: v })} label="Ambient web" />
        </Setting>
      </Group>

      <Group title="Reset">
        <Setting title="Default preferences" desc="Puts everything on this page back to how it started. Your account and appearance stay.">
          <button className="btn" onClick={() => { set(DEFAULT_PREFS); dispatch({ type: "showCode", value: false }); dispatch({ type: "ambient", value: false }); toast("Preferences reset", "info"); }}>Reset preferences</button>
        </Setting>
        {!live && (
          <Setting title="Sample data" desc="Restores the sample namespaces, agents, policies and integrations.">
            <button className="btn danger" onClick={() => { if (confirm("Reset all sample data?")) { dispatch({ type: "reset" }); toast("Sample data reset", "info"); } }}>Reset data</button>
          </Setting>
        )}
      </Group>
    </>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div className="section-title">{title}</div>
      <div className="card" style={{ padding: "4px 18px" }}>{children}</div>
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
        <div className="grid" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
          {[...themes, { id: "custom" as const, label: "Custom", hint: "Your own colours", swatch: [a.bg, a.text, a.accent] as [string, string, string] }].map((t) => (
            <button key={t.id} className="tile" onClick={() => set(t.id === "custom" ? { theme: "custom" } : themePatch(t.id))} style={{ borderColor: a.theme === t.id ? "var(--accent-hi)" : undefined }}>
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
          <ColorPicker value={a.accent} onChange={(accent) => set({ accent })} />
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
  const p = state.prefs;
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const { errors, check, clear } = useErrors();
  const all: AuthProvider[] = ["google", "github", "gitlab"];
  const zones = timeZones();
  const now = new Date();
  const dirty = name.trim() !== user.name || email.trim() !== user.email;

  const save = () => {
    const ok = check({
      name: !name.trim() ? "Enter your name." : name.trim().length > 60 ? "Keep it under 60 characters." : undefined,
      email: !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? "Enter a valid email address." : undefined,
    });
    if (!ok) return;
    dispatch({ type: "updateProfile", patch: { name: name.trim(), email: email.trim() } });
    toast("Profile saved");
  };

  return (
    <>
      <Group title="Profile">
        <div style={{ padding: "14px 0", display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="row" style={{ gap: 12 }}>
            <span className="avatar" style={{ width: 40, height: 40, fontSize: 14, borderRadius: "50%", background: "var(--accent-soft)", color: "var(--accent-hi)" }}>
              {(name.trim() || user.name).split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
            </span>
            <div className="faint small">Signed in with {providerLabel(user.provider)}{user.since ? ` since ${user.since}` : ""}.</div>
          </div>
          <div className="field-row">
            <Field label="Name" error={errors.name}>
              <input className="input" value={name} onChange={(e) => { setName(e.target.value); clear("name"); }} />
            </Field>
            <Field label="Email" error={errors.email}>
              <input className="input" type="email" value={email} onChange={(e) => { setEmail(e.target.value); clear("email"); }} />
            </Field>
          </div>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            {dirty && <button className="btn ghost" onClick={() => { setName(user.name); setEmail(user.email); check({}); }}>Discard</button>}
            <button className="btn primary" disabled={!dirty} onClick={save}>Save profile</button>
          </div>
        </div>
      </Group>

      <Group title="Time and region">
        <Setting title="Time zone" desc={`Times in logs and the tracker use this. Now: ${formatTime(now, p)}.`}>
          <select className="select" value={p.timeZone} onChange={(e) => dispatch({ type: "prefs", patch: { timeZone: e.target.value } })} style={{ width: 220 }}>
            <option value="auto">System ({Intl.DateTimeFormat().resolvedOptions().timeZone})</option>
            {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
          </select>
        </Setting>
        <Setting title="Clock" desc="12-hour or 24-hour times.">
          <div className="segmented">
            {([["auto", "System"], ["12h", "12-hour"], ["24h", "24-hour"]] as const).map(([v, l]) => (
              <button key={v} className={p.clock === v ? "active" : ""} onClick={() => dispatch({ type: "prefs", patch: { clock: v } })}>{l}</button>
            ))}
          </div>
        </Setting>
      </Group>

      <Group title="Linked accounts">
        {all.map((prov) => {
          const linked = user.linked.includes(prov);
          const primary = user.provider === prov;
          return (
            <div key={prov} className="list-row" style={{ padding: "12px 0" }}>
              <BrandIcon icon={providerIcon(prov)!} />
              <div>
                <div>{providerLabel(prov)}</div>
                <div className="faint small">{primary ? "You sign in with this" : linked ? "Connected" : "Not connected"}</div>
              </div>
              <span className="spacer" />
              {primary ? null : linked ? (
                <button className="btn sm" onClick={() => { dispatch({ type: "unlinkProvider", provider: prov }); toast(`${providerLabel(prov)} disconnected`, "warn"); }}>Disconnect</button>
              ) : (
                <button className="btn sm" onClick={() => { dispatch({ type: "linkProvider", provider: prov }); toast(`${providerLabel(prov)} connected`); }}>Connect</button>
              )}
            </div>
          );
        })}
      </Group>

      <Group title="Session">
        <Setting title="Sign out" desc="Your namespaces, secrets and sandboxes stay on this machine.">
          <button className="btn" onClick={() => dispatch({ type: "logout" })}>Sign out</button>
        </Setting>
      </Group>
    </>
  );
}

// Backgrounds and text want near-neutrals, not accents.
const SURFACES = ["#000000", "#0f0f12", "#17121f", "#3d1029", "#e5e5e5", "#f7f6f3", "#fdf1f5", "#ffffff"];

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="field">
      {label}
      <ColorPicker value={value} onChange={onChange} presets={SURFACES} />
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
  { id: "policy.", label: "Policies" },
  { id: "budget.", label: "Budgets" },
  { id: "gateway.", label: "Gateway keys" },
  { id: "terminal.", label: "Terminals" },
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
                    <td className="mono faint small">{formatDateTime(fromDb(r.ts), state.prefs)}</td>
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
