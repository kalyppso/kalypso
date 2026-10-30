import { useState } from "react";
import { siGithub, siGitlab } from "simple-icons";
import { CheckCircle2, CircleDashed, GitBranch, GitPullRequest, MessageSquareWarning, XCircle } from "lucide-react";
import { useNamespaced, useStore } from "../store";
import { CodeReveal, PageHead, initials } from "../components/ui";
import { BrandIcon } from "./Auth";
import type { Commit, PullRequest } from "../types";
import "../styles/git.css";

const DAYS = 14;
const SHOWN = 30;

const dayTitle = (d: number) => {
  if (d === 0) return "Today";
  if (d === 1) return "Yesterday";
  return new Date(Date.now() - d * 86400000).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
};

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

  // Timeline: commits are already sorted newest first, so grouping keeps order.
  const shown = commits.slice(0, SHOWN);
  const groups: { day: number; list: Commit[] }[] = [];
  for (const c of shown) {
    const last = groups[groups.length - 1];
    if (last?.day === c.day) last.list.push(c);
    else groups.push({ day: c.day, list: [c] });
  }
  const maxChurn = Math.max(1, ...shown.map((c) => c.additions + c.deletions));

  const subtitle = "Commits, merge and pull requests, and CI across the GitHub and GitLab repositories this namespace works on.";
  if (repos.length === 0) {
    return (
      <>
        <PageHead title="Git tracker" subtitle={subtitle} />
        <div className="empty">No repositories in this namespace. Connect GitHub or GitLab in Integrations.</div>
      </>
    );
  }

  return (
    <>
      <PageHead title="Git tracker" subtitle={subtitle}>
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

      <div className="card git-chart">
        <div className="card-head">
          <span className="card-title">Commits per day</span>
          <span className="spacer" />
          <span className="legend" style={{ marginTop: 0 }}>
            <span><i style={{ background: "var(--accent-hi)" }} />Agents</span>
            <span><i style={{ background: "var(--text-3)" }} />People</span>
          </span>
        </div>
        <div style={{ position: "relative" }} onMouseLeave={() => setHover(null)}>
          <div className="git-bars">
            {perDay.map((d, i) => (
              <div key={d.day} className={`git-bar ${hover !== null && hover !== i ? "dim" : ""}`} onMouseEnter={() => setHover(i)}>
                <div className="git-bar-stack" style={{ height: `${((d.agents + d.people) / max) * 100}%` }}>
                  {d.people > 0 && <span style={{ flex: d.people, background: "var(--text-3)" }} />}
                  {d.agents > 0 && <span style={{ flex: d.agents, background: "var(--accent-hi)" }} />}
                </div>
              </div>
            ))}
          </div>
          {hover !== null && (
            <div className="tip" style={{ top: -6, left: `${((hover + 0.5) / DAYS) * 100}%` }}>
              <span className="faint">{dayTitle(perDay[hover].day)}</span> {perDay[hover].agents} by agents, {perDay[hover].people} by people
            </div>
          )}
          <div className="row faint mono" style={{ fontSize: 10, marginTop: 8 }}><span>14 days ago</span><span className="spacer" /><span>Today</span></div>
        </div>
      </div>

      <div className="git-cols">
        <section>
          <h2 className="section-title">Recent commits</h2>
          {groups.length === 0 && <div className="empty">No commits match these filters.</div>}
          <div className="git-timeline">
            {groups.map((g) => (
              <div key={g.day} className="git-day">
                <div className="git-day-title">{dayTitle(g.day)}<span className="faint"> · {g.list.length} commit{g.list.length === 1 ? "" : "s"}</span></div>
                {g.list.map((c) => (
                  <CommitItem
                    key={c.sha}
                    c={c}
                    author={author(c)}
                    repo={state.repos.find((r) => r.id === c.repoId)!}
                    churnMax={maxChurn}
                    open={open === c.sha}
                    onToggle={() => setOpen(open === c.sha ? null : c.sha)}
                  />
                ))}
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="section-title">Open pull and merge requests</h2>
          {prs.length === 0 && <div className="empty">No open pull requests.</div>}
          <div className="git-prs">
            {prs.map((p) => <PrItem key={p.id} p={p} repo={repoName(p.repoId)} author={author(p)} />)}
          </div>
        </section>
      </div>
    </>
  );
}

function CommitItem({ c, author, repo, churnMax, open, onToggle }: { c: Commit; author: string; repo: { name: string; host: string }; churnMax: number; open: boolean; onToggle: () => void }) {
  const total = c.additions + c.deletions;
  return (
    <div className={`git-commit ${c.isAgent ? "agent" : ""} ${open ? "open" : ""}`}>
      <span className="git-node" aria-hidden />
      <button className="git-commit-main" onClick={onToggle} aria-expanded={open}>
        <span className="avatar">{initials(author)}</span>
        <span className="git-commit-text">
          <span className="git-commit-msg clip">{c.message}</span>
          <span className="git-commit-meta">
            <BrandIcon icon={repo.host === "gitlab" ? siGitlab : siGithub} size={11} />
            <span className="clip">{repo.name}</span>
            <GitBranch size={11} />
            <span className="clip">{c.branch}</span>
            <span>· {author}{c.isAgent ? " (agent)" : ""}</span>
          </span>
        </span>
        <span className="git-churn" title={`+${c.additions} -${c.deletions}`}>
          <span className="git-churn-nums mono"><span>+{c.additions}</span> <span className="faint">-{c.deletions}</span></span>
          <span className="git-churn-bar" style={{ width: `${Math.max(8, (total / churnMax) * 64)}px` }}>
            <span style={{ flex: c.additions, background: "var(--accent-hi)" }} />
            <span style={{ flex: c.deletions, background: "var(--text-3)" }} />
          </span>
        </span>
        <span className="mono faint small git-sha">{c.sha}</span>
        <span className="mono faint small git-time">{c.at}</span>
      </button>
      {open && <div className="git-diff"><CodeReveal code={c.diff} label="diff" /></div>}
    </div>
  );
}

const CI = {
  passing: { cls: "ok", icon: <CheckCircle2 size={12} />, label: "CI passing" },
  failing: { cls: "err", icon: <XCircle size={12} />, label: "CI failing" },
  pending: { cls: "", icon: <CircleDashed size={12} className="git-spin" />, label: "CI running" },
} as const;

const REVIEW = {
  approved: { cls: "ok", icon: <CheckCircle2 size={12} />, label: "Approved" },
  changes: { cls: "warn", icon: <MessageSquareWarning size={12} />, label: "Changes requested" },
  waiting: { cls: "", icon: <CircleDashed size={12} />, label: "Waiting for review" },
} as const;

function PrItem({ p, repo, author }: { p: PullRequest; repo: string; author: string }) {
  const ci = CI[p.ci];
  const review = REVIEW[p.review];
  return (
    <div className={`git-pr ${p.isAgent ? "agent" : ""}`}>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <span className="git-pr-icon"><GitPullRequest size={14} /></span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="git-pr-title">{p.title}</div>
          <div className="faint small">
            <span className="mono">#{p.number}</span> in {repo} by {author}{p.isAgent ? " (agent)" : ""}
          </div>
        </div>
        <span className="mono faint small">{p.updated}</span>
      </div>
      <div className="row" style={{ marginTop: 10, paddingLeft: 32, flexWrap: "wrap", gap: 6 }}>
        <span className={`badge ${ci.cls}`}>{ci.icon}{ci.label}</span>
        <span className={`badge ${review.cls}`}>{review.icon}{review.label}</span>
      </div>
    </div>
  );
}
