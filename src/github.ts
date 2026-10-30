// Finding skills in public GitHub repositories, for the Add from GitHub flow.
// Unauthenticated GitHub API: 60 requests an hour per IP, plenty for browsing.
// Installing a skill's files into sandboxes is the skills registry's job (#24).

export interface RepoRef {
  owner: string;
  repo: string;
  /** Folder inside the repo to look in, without leading or trailing slashes. */
  path: string;
  ref?: string;
}

export interface FoundSkill {
  /** Folder holding SKILL.md, "" for the repo root. */
  path: string;
  name: string;
  description: string;
}

export interface SkillLookup {
  owner: string;
  repo: string;
  /** Tag or branch the skills were read from. */
  ref: string;
  /** Exact commit, so an install never changes under you. */
  sha: string;
  skills: FoundSkill[];
}

const NAME = /^[A-Za-z0-9_.-]+$/;

/** `owner/repo`, `owner/repo/sub/folder`, or a github.com URL (tree or blob links included). */
export function parseRepo(input: string, ref?: string): RepoRef | null {
  let s = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  s = s.replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2 || !NAME.test(parts[0]) || !NAME.test(parts[1])) return null;
  const [owner, repo, ...rest] = parts;
  let path = rest;
  let linkRef: string | undefined;
  // github.com/o/r/tree/<ref>/<path> or /blob/<ref>/<path>/SKILL.md
  if ((rest[0] === "tree" || rest[0] === "blob") && rest.length >= 2) {
    linkRef = rest[1];
    path = rest.slice(2);
    if (path[path.length - 1]?.toLowerCase() === "skill.md") path = path.slice(0, -1);
  }
  return { owner, repo, path: path.join("/"), ref: ref?.trim() || linkRef };
}

async function api<T>(url: string): Promise<T> {
  const res = await fetch(`https://api.github.com${url}`, { headers: { Accept: "application/vnd.github+json" } });
  if (res.status === 404) throw new Error("Not found. Check the name, or the repository may be private.");
  if (res.status === 403 || res.status === 429) throw new Error("GitHub's rate limit was hit. Try again in a few minutes.");
  if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
  return res.json() as Promise<T>;
}

/** The `name` and `description` from SKILL.md's front matter, falling back to its first heading and paragraph. */
export function readSkillMd(text: string, fallbackName: string): { name: string; description: string } {
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(text);
  const field = (k: string) => {
    if (!fm) return "";
    const lines = fm[1].split("\n");
    const i = lines.findIndex((l) => new RegExp(`^${k}:`).test(l));
    if (i < 0) return "";
    const first = lines[i].slice(k.length + 1).trim();
    // YAML block scalars (">", "|", ">-") and plain values wrapped onto indented lines.
    const more: string[] = [];
    for (const l of lines.slice(i + 1)) {
      if (!/^\s+\S/.test(l)) break;
      more.push(l.trim());
    }
    const value = /^[>|][-+]?$/.test(first) ? more.join(" ") : [first, ...more].join(" ");
    return value.trim().replace(/^["']|["']$/g, "");
  };
  const body = fm ? text.slice(fm[0].length) : text;
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const para = body.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith("#"));
  return { name: field("name") || heading || fallbackName, description: field("description") || para?.slice(0, 200) || "" };
}

/** Every SKILL.md under `ref.path`, read at one pinned commit. */
export async function lookupSkills(ref: RepoRef): Promise<SkillLookup> {
  const repo = await api<{ default_branch: string }>(`/repos/${ref.owner}/${ref.repo}`);
  let use = ref.ref;
  if (!use) {
    // Latest release when there is one, otherwise the default branch.
    use = await api<{ tag_name: string }>(`/repos/${ref.owner}/${ref.repo}/releases/latest`).then((r) => r.tag_name).catch(() => repo.default_branch);
  }
  const commit = await api<{ sha: string }>(`/repos/${ref.owner}/${ref.repo}/commits/${encodeURIComponent(use)}`);
  const tree = await api<{ tree: { path: string; type: string }[]; truncated: boolean }>(
    `/repos/${ref.owner}/${ref.repo}/git/trees/${commit.sha}?recursive=1`,
  );
  const prefix = ref.path ? `${ref.path}/` : "";
  const files = tree.tree
    .filter((t) => t.type === "blob" && /(^|\/)SKILL\.md$/i.test(t.path) && (t.path.startsWith(prefix) || !prefix))
    .slice(0, 50);
  const skills = await Promise.all(
    files.map(async (f) => {
      const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
      const raw = await fetch(`https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${commit.sha}/${f.path}`);
      const text = raw.ok ? await raw.text() : "";
      return { path: dir, ...readSkillMd(text, dir.split("/").pop() || ref.repo) };
    }),
  );
  return { owner: ref.owner, repo: ref.repo, ref: use, sha: commit.sha, skills: skills.sort((a, b) => a.path.localeCompare(b.path)) };
}
