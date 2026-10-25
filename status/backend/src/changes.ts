import { config, statusEnvFile } from './config.js';
import { db, dbEnabled, query } from './db.js';
import { projects } from './projects.js';
import { errorMessage } from './util.js';

/**
 * Change history per project, stored in the status database (migration 004_changes in db.ts). A sync copies the
 * commits on the deploy branch that touched each project's folder from the GitHub API into the table: the full
 * history the first time, then only what is new, every 10 minutes. The page reads the table, never GitHub, so the
 * history survives GitHub outages and rate limits.
 */

export const SYNC_INTERVAL_MS = 10 * 60_000;
const PER_PAGE = 100;
/** Pages fetched per project and sync: 3000 commits is the most a first backfill copies. */
const MAX_PAGES = 30;
const LIST_LIMIT = 300;

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

type ChangeRow = { sha: string; summary: string; body: string; author: string; committed_at: Date; url: string };

const toChange = (r: ChangeRow): Change => ({
  sha: r.sha,
  summary: r.summary,
  body: r.body,
  author: r.author,
  date: r.committed_at.toISOString(),
  url: r.url,
});

/** The outcome of the latest sync per project, for the page and the health check. */
const syncState = new Map<string, { at: string; added: number; error?: string }>();

export const lastSync = (site: string) => syncState.get(site);

const TRAILER = /^(co-authored-by|signed-off-by|reviewed-by|change-id):/i;

function parseCommit(site: string, c: any) {
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

async function githubCommits(site: string, since?: Date) {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'bas-franke-status',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;
  const commits: any[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = new URLSearchParams({ sha: config.githubBranch, path: site, per_page: String(PER_PAGE), page: String(page) });
    if (since) query.set('since', since.toISOString());
    const res = await fetch(`https://api.github.com/repos/${config.githubRepo}/commits?${query}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (res.status === 403 || res.status === 429) throw new Error('GitHub API rate limit reached; set GITHUB_TOKEN to raise it.');
    if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}.`);
    const batch = (await res.json()) as any[];
    commits.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  return commits;
}

async function syncProject(site: string) {
  const { rows } = await query<{ latest: Date | null }>('SELECT max(committed_at) AS latest FROM changes WHERE project = $1', [site]);
  // Overlap by a day: commit dates can be older than the push that brought them to the branch.
  const since = rows[0].latest ? new Date(rows[0].latest.getTime() - 86_400_000) : undefined;
  const commits = await githubCommits(site, since);
  // All or nothing: the next sync starts from the newest stored commit, so a half-stored batch would leave a gap.
  const client = await db().connect();
  let added = 0;
  try {
    await client.query('BEGIN');
    for (const c of commits) {
      // Merge commits repeat what the branch already contains; keep the actual changes.
      if ((c.parents?.length ?? 0) > 1) continue;
      const ch = parseCommit(site, c);
      const res = await client.query(
        `INSERT INTO changes (project, sha, summary, body, author, committed_at, url) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (project, sha) DO NOTHING`,
        [site, ch.sha, ch.summary, ch.body, ch.author, ch.date, ch.url],
      );
      added += res.rowCount ?? 0;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return added;
}

let syncing: Promise<void> | undefined;

/** Copy new commits of every project into the database. Errors are kept per project, never thrown. */
export function syncChanges() {
  syncing ??= (async () => {
    for (const p of projects) {
      const at = new Date().toISOString();
      try {
        const added = await syncProject(p.name);
        syncState.set(p.name, { at, added });
        if (added) console.log(`changes: stored ${added} new commit(s) for ${p.name}`);
      } catch (err) {
        syncState.set(p.name, { at, added: 0, error: errorMessage(err) });
      }
    }
  })().finally(() => (syncing = undefined));
  return syncing;
}

export const isProject = (site: string) => projects.some((p) => p.name === site);

const disabled = { enabled: false as const, detail: `DATABASE_URL is not set in ${statusEnvFile}; the change history is stored in the "status" database.` };

const historyUrl = (site: string) => `https://github.com/${config.githubRepo}/commits/${config.githubBranch}/${site}`;

/** The stored history of one project, newest first. */
export async function projectChanges(site: string) {
  if (!dbEnabled()) return { site, changes: [], total: 0, historyUrl: historyUrl(site), ...disabled };
  const [list, count] = await Promise.all([
    query<ChangeRow>(
      'SELECT sha, summary, body, author, committed_at, url FROM changes WHERE project = $1 ORDER BY committed_at DESC, sha LIMIT $2',
      [site, LIST_LIMIT],
    ),
    query<{ total: string }>('SELECT count(*) AS total FROM changes WHERE project = $1', [site]),
  ]);
  const sync = lastSync(site);
  return {
    site,
    enabled: true as const,
    changes: list.rows.map(toChange),
    total: Number(count.rows[0].total),
    historyUrl: historyUrl(site),
    syncedAt: sync?.at,
    error: sync?.error,
  };
}

/** The latest stored change of every project, for the overview cards. */
export async function latestChanges() {
  if (!dbEnabled()) return { sites: {}, ...disabled };
  const { rows } = await query<ChangeRow & { project: string }>(
    `SELECT DISTINCT ON (project) project, sha, summary, body, author, committed_at, url
     FROM changes ORDER BY project, committed_at DESC, sha`,
  );
  return {
    enabled: true as const,
    sites: Object.fromEntries(rows.map((r) => [r.project, { latest: toChange(r) }])),
  };
}
