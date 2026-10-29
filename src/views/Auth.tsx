import { useEffect, useState } from "react";
import { siGithub, siGitlab, siGoogle, type SimpleIcon } from "simple-icons";
import { useStore } from "../store";
import { Logo } from "../components/Logo";
import type { AuthProvider } from "../types";

const PROVIDERS: { id: Exclude<AuthProvider, "email">; label: string; icon: SimpleIcon }[] = [
  { id: "google", label: "Google", icon: siGoogle },
  { id: "github", label: "GitHub", icon: siGithub },
  { id: "gitlab", label: "GitLab", icon: siGitlab },
];

export function BrandIcon({ icon, size = 16 }: { icon: SimpleIcon; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" role="img" aria-label={icon.title} style={{ flex: "none" }}>
      <path d={icon.path} />
    </svg>
  );
}

export const providerIcon = (id: AuthProvider) => PROVIDERS.find((p) => p.id === id)?.icon;
export const providerLabel = (id: AuthProvider) => PROVIDERS.find((p) => p.id === id)?.label ?? "Email";

// Prototype sign-in. The desktop build opens the provider in the system
// browser and finishes OAuth (PKCE) on a loopback redirect; see ARCHITECTURE.md §4.16.
export function Auth() {
  const { dispatch } = useStore();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [waiting, setWaiting] = useState<Exclude<AuthProvider, "email"> | null>(null);

  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => {
      dispatch({
        type: "login",
        session: { name: "Noor Haddad", email: "noor@example.com", provider: waiting, linked: [waiting], since: new Date().toISOString().slice(0, 10) },
      });
    }, 1400);
    return () => clearTimeout(t);
  }, [waiting, dispatch]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === "signup" && !name.trim()) return setError("Enter your name.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return setError("Enter a valid email address.");
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    dispatch({
      type: "login",
      session: { name: name.trim() || email.split("@")[0], email, provider: "email", linked: ["email"], since: new Date().toISOString().slice(0, 10) },
    });
  };

  const switchMode = () => {
    setMode(mode === "signin" ? "signup" : "signin");
    setError("");
  };

  if (waiting) {
    const p = PROVIDERS.find((x) => x.id === waiting)!;
    return (
      <div className="auth">
        <div className="auth-card" style={{ alignItems: "center", textAlign: "center" }}>
          <span className="logo" style={{ width: 44, height: 44 }}><BrandIcon icon={p.icon} size={20} /></span>
          <h1>Continue in your browser</h1>
          <p className="dim" style={{ margin: 0 }}>We opened {p.label} in your browser. KALYPSO will finish signing you in when you approve.</p>
          <button className="btn ghost" onClick={() => setWaiting(null)}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth">
      <div className="auth-card">
        <div style={{ marginBottom: 6 }}><Logo size={64} /></div>
        <div>
          <h1>{mode === "signin" ? "Sign in to KALYPSO" : "Create your KALYPSO account"}</h1>
          <p className="dim" style={{ margin: "4px 0 0" }}>{mode === "signin" ? "Welcome back." : "One account for every namespace and machine."}</p>
        </div>

        {PROVIDERS.map((p) => (
          <button key={p.id} className="btn provider" onClick={() => setWaiting(p.id)}>
            <BrandIcon icon={p.icon} /> Continue with {p.label}
          </button>
        ))}

        <div className="divider">or</div>

        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }} noValidate>
          {mode === "signup" && (
            <label className="field">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>
          )}
          <label className="field">Email<input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
          <label className="field">
            <span className="row">Password<span className="spacer" />{mode === "signin" && <button type="button" className="link small">Forgot password?</button>}</span>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "signin" ? "current-password" : "new-password"} />
          </label>
          {error && <div className="field-error" role="alert">{error}</div>}
          <button className="btn primary">{mode === "signin" ? "Sign in" : "Create account"}</button>
        </form>

        <div className="dim small" style={{ textAlign: "center" }}>
          {mode === "signin" ? "New to KALYPSO? " : "Already have an account? "}
          <button className="link" onClick={switchMode}>{mode === "signin" ? "Create an account" : "Sign in"}</button>
        </div>
      </div>
    </div>
  );
}
