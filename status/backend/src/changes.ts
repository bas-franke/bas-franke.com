import { config } from './config.js';
import { projects } from './projects.js';
import { errorMessage } from './util.js';

/**
 * Change history per project: the commits on the deploy branch that touched the project's folder, read from the
 * GitHub API. Each project's list is cached for 10 minutes; when GitHub fails the last good list is kept and the
 * error is passed along, so the page never goes blank because of a rate limit.
 */

const TTL_MS = 10 * 60_000;
const PER_PAGE = 100;

export interface Change {
  sha: string;
  /** First line of the commit message, without the "<project>: " prefix. */
  summary: string;
  /** The rest of the message, without trailer lines such as Co-Authored-By. */
  body: string;
  author: string;
  date: string;
  url: string;
}

export interface ChangeList {
  site: string;
  changes: Change[];
  /** All commits for the folder on GitHub, beyond the latest PER_PAGE shown here. */
  historyUrl: string;
  fetchedAt?: string;
  error?: string;
}

const cache = new Map<string, { at: number; list: ChangeList; pending?: Promise<ChangeList> }>();

const TRAILER = /^(co-authored-by|signed-off-by|reviewed-by|change-id):/i;

function toChange(site: string, c: any): Change {
  const [first = '', ...rest] = String(c.commit?.message ?? '').split('\n');
  const prefix = new RegExp(`^${site}\\s*:\\s*`, 'i');
  const body = rest
    .filter((line) => !TRAILER.test(line.trim()) && !/^🤖 Generated with/.test(line.trim()))
    .join('\n')
    .trim()
    // Unwrap hard-wrapped lines inside a paragraph, keeping blank lines and list items.
    .replace(/([^\n])\n(?!\n|\s*([-*•]|\d+[.)])\s)/g, '$1 ');
  const summary = first.replace(prefix, '').trim() || first.trim();
  return {
    sha: String(c.sha),
    summary: summary.charAt(0).toUpperCase() + summary.slice(1),
    body,
    author: c.commit?.author?.name ?? c.author?.login ?? 'unknown',
    date: c.commit?.committer?.date ?? c.commit?.author?.date,
    url: c.html_url,
  };
}

async function fetchChanges(site: string, previous?: ChangeList): Promise<ChangeList> {
  const historyUrl = `https://github.com/${config.githubRepo}/commits/${config.githubBranch}/${site}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'bas-franke-status',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;
  const query = new URLSearchParams({ sha: config.githubBranch, path: site, per_page: String(PER_PAGE) });
  try {
    const res = await fetch(`https://api.github.com/repos/${config.githubRepo}/commits?${query}`, { headers, signal: AbortSignal.timeout(8000) });
    if (res.status === 403 || res.status === 429) throw new Error('GitHub API rate limit reached; set GITHUB_TOKEN to raise it.');
    if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}.`);
    const body = (await res.json()) as any[];
    // Merge commits repeat what the branch already contains; keep the actual changes.
    const changes = body.filter((c) => (c.parents?.length ?? 0) <= 1).map((c) => toChange(site, c));
    return { site, changes, historyUrl, fetchedAt: new Date().toISOString() };
  } catch (err) {
    return { site, changes: previous?.changes ?? [], historyUrl, fetchedAt: previous?.fetchedAt, error: errorMessage(err) };
  }
}

export const isProject = (site: string) => projects.some((p) => p.name === site);

export function projectChanges(site: string): Promise<ChangeList> {
  const hit = cache.get(site);
  if (hit?.pending) return hit.pending;
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.list);
  const pending = fetchChanges(site, hit?.list).then((list) => {
    // A failed fetch is retried after a minute instead of the full TTL.
    cache.set(site, { at: list.error ? Date.now() - TTL_MS + 60_000 : Date.now(), list });
    return list;
  });
  cache.set(site, { at: hit?.at ?? 0, list: hit?.list ?? { site, changes: [], historyUrl: '' }, pending });
  return pending;
}

/** The latest change of every project, for the overview cards. */
export async function latestChanges() {
  const lists = await Promise.all(projects.map((p) => projectChanges(p.name)));
  return {
    sites: Object.fromEntries(lists.map((l) => [l.site, { latest: l.changes[0] ?? null, error: l.error }])),
  };
}
