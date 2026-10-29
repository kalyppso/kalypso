import { useState } from "react";
import { siGithub, siGitlab } from "simple-icons";
import { useNamespaced, useStore } from "../store";
import { CodeReveal, PageHead, initials } from "../components/ui";
import { BrandIcon } from "./Auth";
import type { Commit } from "../types";

const DAYS = 14;

export function Git() {
  const { state } = useStore();
  const { repos } = useNamespaced();
  const [repo, setRepo] = useState("all");
  const [who, setWho] = useState<"all" | "agents" | "people">("all");
  const [hover, setHover] = useState<number | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const repoIds = new Set(repos.filter((r) => repo === "all" || r.id === repo).map((r) => r.id));
  const commits = state.commits.filter((c) => repoIds.has(c.repoId) && (who === "all" || (who === "agents") === c.isAgent));
  const prs = state.pullRequests.filter((p) => repoIds.has(p.repoId));
  const repoName = (id: string) => state.repos.find((r) => r.id === id)?.name ?? id;
  const author = (c: { author: string; isAgent: boolean }) => (c.isAgent ? state.agents.find((a) => a.id === c.author)?.name ?? c.author : c.author);

  const perDay = Array.from({ length: DAYS }, (_, i) => {
    const day = DAYS - 1 - i;
    const list = commits.filter((c) => c.day === day);
    return { day, agents: list.filter((c) => c.isAgent).length, people: list.filter((c) => !c.isAgent).length };
  });
  const max = Math.max(1, ...perDay.map((d) => d.agents + d.people));
  const agentShare = commits.length ? Math.round((commits.filter((c) => c.isAgent).length / commits.length) * 100) : 0;
  const dayLabel = (d: number) => (d === 0 ? "Today" : d === 1 ? "Yesterday" : `${d} days ago`);

  if (repos.length === 0) {
    return (
      <>
        <PageHead title="Git tracker" subtitle="Commits, merge and pull requests, and CI across the GitHub and GitLab repositories this namespace works on." />
        <div className="empty">No repositories in this namespace. Connect GitHub or GitLab in Integrations.</div>
      </>
    );
  }

  return (
    <>
      <PageHead title="Git tracker" subtitle="Commits, merge and pull requests, and CI across the GitHub and GitLab repositories this namespace works on.">
        <select className="select" value={repo} onChange={(e) => setRepo(e.target.value)}>
          <option value="all">All repositories</option>
          {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <div className="segmented">
          {(["all", "agents", "people"] as const).map((w) => (
            <button key={w} className={who === w ? "active" : ""} onClick={() => setWho(w)}>{w === "all" ? "Everyone" : w === "agents" ? "Agents" : "People"}</button>
          ))}
        </div>
      </PageHead>

      <div className="stats">
        <div className="stat"><div className="stat-label">Commits, last 14 days</div><div className="stat-value">{commits.length}</div><div className="stat-sub">{commits.reduce((s, c) => s + c.additions, 0).toLocaleString()} lines added</div></div>
        <div className="stat"><div className="stat-label">Written by agents</div><div className="stat-value">{agentShare}%</div><div className="stat-sub">of commits in view</div></div>
        <div className="stat"><div className="stat-label">Open pull requests</div><div className="stat-value">{prs.length}</div><div className="stat-sub">{prs.filter((p) => p.isAgent).length} opened by agents</div></div>
        <div className="stat"><div className="stat-label">Failing CI</div><div className="stat-value">{prs.filter((p) => p.ci === "failing").length}</div><div className="stat-sub">{prs.filter((p) => p.ci === "pending").length} pending</div></div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <span className="card-title">Commits per day</span>
          <span className="spacer" />
          <span className="legend" style={{ marginTop: 0 }}>
            <span><i style={{ background: "var(--accent-hi)" }} />Agents</span>
            <span><i style={{ background: "var(--text-3)" }} />People</span>
          </span>
        </div>
        <div style={{ position: "relative" }} onMouseLeave={() => setHover(null)}>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${DAYS}, 1fr)`, gap: 6, alignItems: "end", height: 120 }}>
            {perDay.map((d, i) => (
              <div key={d.day} onMouseEnter={() => setHover(i)} style={{ height: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 2, cursor: "default" }}>
                {d.people > 0 && <div style={{ height: `${(d.people / max) * 100}%`, background: "var(--text-3)", borderRadius: "3px 3px 0 0", opacity: hover === null || hover === i ? 1 : 0.5 }} />}
                {d.agents > 0 && <div style={{ height: `${(d.agents / max) * 100}%`, background: "var(--accent-hi)", borderRadius: d.people ? 0 : "3px 3px 0 0", opacity: hover === null || hover === i ? 1 : 0.5 }} />}
              </div>
            ))}
          </div>
          {hover !== null && (
            <div className="tip" style={{ top: -6, left: `${((hover + 0.5) / DAYS) * 100}%` }}>
              <span className="faint">{dayLabel(perDay[hover].day)}</span> {perDay[hover].agents} by agents, {perDay[hover].people} by people
            </div>
          )}
          <div className="row faint mono" style={{ fontSize: 10, marginTop: 6 }}><span>14 days ago</span><span className="spacer" /><span>Today</span></div>
        </div>
      </div>

      <div className="card flush" style={{ marginBottom: 16 }}>
        <div className="card-head" style={{ padding: "16px 16px 0" }}><span className="card-title">Open pull and merge requests</span></div>
        <table className="table">
          <thead><tr><th>Pull request</th><th>Author</th><th>CI</th><th>Review</th><th>Updated</th></tr></thead>
          <tbody>
            {prs.map((p) => (
              <tr key={p.id}>
                <td><span className="faint mono">#{p.number}</span> <span style={{ fontWeight: 500 }}>{p.title}</span><div className="faint small">{repoName(p.repoId)}</div></td>
                <td className="dim">{author(p)}{p.isAgent && <span className="faint"> (agent)</span>}</td>
                <td><span className={`badge ${p.ci === "passing" ? "ok" : p.ci === "failing" ? "err" : ""}`}>{p.ci}</span></td>
                <td className="dim">{p.review === "approved" ? "Approved" : p.review === "changes" ? "Changes requested" : "Waiting"}</td>
                <td className="mono faint">{p.updated}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {prs.length === 0 && <div className="empty" style={{ margin: 16 }}>No open pull requests.</div>}
      </div>

      <div className="card flush">
        <div className="card-head" style={{ padding: "16px 16px 0" }}><span className="card-title">Recent commits</span></div>
        <div style={{ padding: "0 16px" }}>
          {commits.slice(0, 20).map((c) => (
            <CommitRow key={c.sha} c={c} author={author(c)} repo={state.repos.find((r) => r.id === c.repoId)!} open={open === c.sha} onToggle={() => setOpen(open === c.sha ? null : c.sha)} />
          ))}
          {commits.length === 0 && <div className="empty" style={{ margin: "16px 0" }}>No commits match these filters.</div>}
        </div>
      </div>
    </>
  );
}

function CommitRow({ c, author, repo, open, onToggle }: { c: Commit; author: string; repo: { name: string; host: string }; open: boolean; onToggle: () => void }) {
  return (
    <div className="list-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
      <div className="row" style={{ cursor: "pointer" }} onClick={onToggle}>
        <span className="avatar" style={c.isAgent ? { borderColor: "var(--accent-hi)", color: "var(--accent-hi)" } : undefined}>{initials(author)}</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.message}</div>
          <div className="faint small row" style={{ gap: 6 }}>
            <BrandIcon icon={repo.host === "gitlab" ? siGitlab : siGithub} size={12} />
            {repo.name}, {c.branch}, {author}{c.isAgent ? " (agent)" : ""}
          </div>
        </div>
        <span className="spacer" />
        <span className="mono small" style={{ whiteSpace: "nowrap" }}>+{c.additions} <span className="faint">-{c.deletions}</span></span>
        <span className="mono faint small" style={{ width: 64, textAlign: "right" }}>{c.sha}</span>
        <span className="mono faint small" style={{ width: 70, textAlign: "right" }}>{c.day === 0 ? c.at : `${c.day}d ago`}</span>
      </div>
      {open && <CodeReveal code={c.diff} label="diff" />}
    </div>
  );
}
