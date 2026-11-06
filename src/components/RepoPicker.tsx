import { useEffect, useState } from "react";
import { GitBranch, Loader2, Lock, Search, X } from "lucide-react";
import { api, errorMessage } from "../backend";
import type { Repo } from "../bindings/Repo";
import { useStore } from "../store";

// Pick a GitHub repository for an agent (#100), searching every account the namespace may use,
// organisation repositories included.

export type RepoChoice = { repo: string; account: string; accountLabel?: string } | null;

export function RepoPicker({ value, onChange }: { value: RepoChoice; onChange: (v: RepoChoice) => void }) {
  const { state, dispatch } = useStore();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Repo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<number | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api.ghAccounts().then((all) => setAccounts(all.filter((a) => a.namespaces.includes(state.ns)).length)).catch(() => setAccounts(0));
  }, [state.ns]);
  useEffect(() => {
    if (!open || !accounts) return;
    setResults(null); setError(null);
    const t = setTimeout(() => {
      api.ghRepos(state.ns, query).then((r) => setResults(r.slice(0, 30))).catch((e) => setError(errorMessage(e)));
    }, 250);
    return () => clearTimeout(t);
  }, [query, open, accounts, state.ns]);

  if (value) {
    return (
      <div className="repo-picked">
        <GitBranch size={14} />
        <span className="mono">{value.repo}</span>
        {value.accountLabel && <span className="faint small">via {value.accountLabel}</span>}
        <span className="spacer" />
        <button type="button" className="btn ghost sm" onClick={() => { onChange(null); setOpen(true); }}>Change</button>
        <button type="button" className="btn ghost sm icon" aria-label="No repository" title="No repository" onClick={() => onChange(null)}><X size={13} /></button>
      </div>
    );
  }
  if (accounts === 0) {
    return (
      <p className="faint small" style={{ margin: 0 }}>
        No GitHub account may be used in {state.ns} yet.{" "}
        <button type="button" className="link-btn" onClick={() => dispatch({ type: "view", view: "settings" })}>Connect one in Settings</button>, and allow it here.
      </p>
    );
  }
  if (!open) {
    return <button type="button" className="btn sm" onClick={() => setOpen(true)}><GitBranch size={13} /> Link a repository</button>;
  }
  return (
    <div className="repo-picker">
      <div className="repo-search">
        <Search size={13} />
        <input className="input" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search repositories" aria-label="Search repositories" />
      </div>
      <div className="repo-results" role="listbox" aria-label="Repositories">
        {results === null && !error && <div className="faint small repo-row"><Loader2 size={13} className="spin" /> Searching…</div>}
        {error && <div className="small repo-row" role="alert">{error}</div>}
        {results?.length === 0 && <div className="faint small repo-row">No repository matches “{query}”.</div>}
        {results?.map((r) => (
          <button type="button" role="option" aria-selected={false} key={`${r.account_id}:${r.full_name}`} className="repo-row" onClick={() => { onChange({ repo: r.full_name, account: r.account_id, accountLabel: r.account_label }); setOpen(false); }}>
            <span className="mono">{r.full_name}</span>
            {r.private && <Lock size={11} className="faint" aria-label="private" />}
            <span className="spacer" />
            <span className="faint small">{r.account_label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
