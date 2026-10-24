import { createHash } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { databaseFix } from './checks/database.js';
import { config, statusEnvFile } from './config.js';
import { dbEnabled, query } from './db.js';
import { projects } from './projects.js';
import type { AnalyticsPoint, AnalyticsReport, Project, SiteAnalytics } from './types.js';

/**
 * First-party visitor analytics. Every site's frontend posts a page view to POST /api/page (see the
 * `trackPageViews` snippet in each frontend's src/analytics.ts). We store the path, a visitor hash that
 * changes daily (salt + day + IP + user agent, never the IP itself), the external referrer and the device
 * class. No cookies, nothing identifying, and nothing is accepted from hosts that are not one of our sites.
 */

export const RANGES = [7, 30, 90, 365];
const MAX_PATH = 512;
const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|pingdom|uptime|monitor|facebookexternalhit|preview|curl|wget|python|java\/|go-http|okhttp|node-fetch|axios/i;

// Per-IP cap on page views, so a stuck tab or a script cannot flood the table.
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;
const rate = new Map<string, { count: number; since: number }>();

const siteByHost = new Map(projects.flatMap((p) => p.domains.map((d) => [d, p] as const)));
const statusProject = projects.find((p) => p.name === 'status')!;

/** Calendar day in the given time zone, as YYYY-MM-DD. */
export const dayIn = (tz: string, date = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

function originHost(req: Request) {
  const source = req.headers.origin ?? req.headers.referer;
  if (!source) return undefined;
  try {
    return new URL(source).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function visitorHash(ip: string, userAgent: string) {
  const salt = config.analyticsSalt ?? config.statusPassword ?? 'status';
  return createHash('sha256').update(`${salt}|${dayIn(config.timezone)}|${ip}|${userAgent}`).digest('hex').slice(0, 16);
}

function withinRateLimit(ip: string) {
  const now = Date.now();
  const entry = rate.get(ip);
  if (!entry || now - entry.since > RATE_WINDOW_MS) {
    if (rate.size > 10_000) rate.clear();
    rate.set(ip, { count: 1, since: now });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

/** "/about/?x=1#top" → "/about"; anything that is not a path → undefined. */
function cleanPath(value: unknown) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > MAX_PATH) return undefined;
  const path = value.split(/[?#]/)[0];
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/** The referrer's hostname, or null when it is empty or one of the site's own domains. */
function externalReferrer(value: unknown, site: Project) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return site.domains.includes(host) ? null : host.slice(0, 200);
  } catch {
    return null;
  }
}

const deviceFor = (width: unknown) => (typeof width !== 'number' ? 'desktop' : width < 768 ? 'mobile' : width < 1024 ? 'tablet' : 'desktop');

/** CORS for the collector: only our own sites, and an answer to the (rare) preflight. */
export const cors: RequestHandler = (req, res, next) => {
  const host = originHost(req);
  if (req.headers.origin && host && siteByHost.has(host)) {
    res.set('Access-Control-Allow-Origin', req.headers.origin);
    res.set('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '86400');
    return res.sendStatus(204);
  }
  next();
};

/** POST /api/page. Always answers 204 at once; the browser never needs to know whether we kept the view. */
export const collect: RequestHandler = (req, res) => {
  res.sendStatus(204);
  const host = originHost(req);
  const site = host ? siteByHost.get(host) : undefined;
  if (!site || !dbEnabled()) return;
  const userAgent = req.headers['user-agent'] ?? '';
  if (!userAgent || BOT_UA.test(userAgent)) return;
  const ip = req.ip ?? 'unknown';
  if (!withinRateLimit(ip)) return;

  let body: Record<string, unknown>;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {});
  } catch {
    return;
  }
  const path = cleanPath(body.p);
  if (!path) return;

  query('INSERT INTO page_views (site, path, visitor, referrer, device) VALUES ($1, $2, $3, $4, $5)', [
    site.name,
    path,
    visitorHash(ip, userAgent),
    externalReferrer(body.r, site),
    deviceFor(body.w),
  ]).catch((err) => console.error('page view not stored', err));
};

type Row = AnalyticsPoint & { site: string; key: string };

/** YYYY-MM-DD for the n days ending today, oldest first. Date-only arithmetic in UTC, so DST cannot shift a day. */
function lastDays(today: string, n: number) {
  const end = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(end - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

/** YYYY-MM for the n months ending this month, oldest first. */
function lastMonths(today: string, n: number) {
  const [year, month] = today.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(year, month - 1 - (n - 1 - i), 1)).toISOString().slice(0, 7));
}

const byKey = (rows: Row[], site: string) => new Map(rows.filter((r) => r.site === site).map((r) => [r.key, r]));

const top = (rows: Row[], site: string, n: number) =>
  rows
    .filter((r) => r.site === site)
    .sort((a, b) => b.visitors - a.visitors || b.views - a.views)
    .slice(0, n);

const point = (row: AnalyticsPoint | undefined): AnalyticsPoint => ({ views: row?.views ?? 0, visitors: row?.visitors ?? 0 });

// A day is a calendar day in the configured time zone. $1 = time zone, $2 = range in days, $3 = today's date.
// The `ts >=` clauses are coarse index-friendly prefilters; the AT TIME ZONE expression does the exact cut.
const IN_RANGE = `ts >= now() - make_interval(days => $2::int + 1) AND (ts AT TIME ZONE $1)::date > $3::date - $2::int`;
const IN_PREVIOUS_RANGE = `ts >= now() - make_interval(days => 2 * $2::int + 2) AND (ts AT TIME ZONE $1)::date BETWEEN $3::date - 2 * $2::int + 1 AND $3::date - $2::int`;
const COUNTS = `count(*)::int AS views, count(DISTINCT visitor)::int AS visitors`;

export async function analyticsReport(days: number): Promise<AnalyticsReport> {
  const generatedAt = new Date().toISOString();
  const timezone = config.timezone;
  if (!dbEnabled()) {
    return {
      enabled: false,
      generatedAt,
      days,
      timezone,
      sites: [],
      detail: `DATABASE_URL is not set in ${statusEnvFile}, so page views are dropped.`,
      fix: databaseFix(statusProject),
    };
  }

  const today = dayIn(timezone);
  const params = [timezone, days, today];
  const [daily, previous, monthly, pages, referrers, devices] = await Promise.all([
    query<Row>(`SELECT site, to_char(ts AT TIME ZONE $1, 'YYYY-MM-DD') AS key, ${COUNTS} FROM page_views WHERE ${IN_RANGE} GROUP BY 1, 2`, params),
    query<Row>(`SELECT site, 'previous' AS key, ${COUNTS} FROM page_views WHERE ${IN_PREVIOUS_RANGE} GROUP BY 1`, params),
    query<Row>(
      `SELECT site, to_char(ts AT TIME ZONE $1, 'YYYY-MM') AS key, ${COUNTS} FROM page_views
       WHERE ts >= now() - interval '13 months' AND (ts AT TIME ZONE $1)::date >= date_trunc('month', $2::date) - interval '11 months'
       GROUP BY 1, 2`,
      [timezone, today],
    ),
    query<Row>(`SELECT site, path AS key, ${COUNTS} FROM page_views WHERE ${IN_RANGE} GROUP BY 1, 2`, params),
    query<Row>(`SELECT site, referrer AS key, ${COUNTS} FROM page_views WHERE referrer IS NOT NULL AND ${IN_RANGE} GROUP BY 1, 2`, params),
    query<Row>(`SELECT site, device AS key, ${COUNTS} FROM page_views WHERE ${IN_RANGE} GROUP BY 1, 2`, params),
  ]);

  const sites: SiteAnalytics[] = projects.map((p) => {
    const dayRows = byKey(daily.rows, p.name);
    const monthRows = byKey(monthly.rows, p.name);
    const dailySeries = lastDays(today, days).map((day) => ({ day, ...point(dayRows.get(day)) }));
    const prev = point(previous.rows.find((r) => r.site === p.name));
    return {
      site: p.name,
      domain: p.domains[0],
      totals: {
        views: dailySeries.reduce((sum, d) => sum + d.views, 0),
        visitors: dailySeries.reduce((sum, d) => sum + d.visitors, 0),
        previousViews: prev.views,
        previousVisitors: prev.visitors,
      },
      daily: dailySeries,
      monthly: lastMonths(today, 12).map((month) => ({ month, ...point(monthRows.get(month)) })),
      pages: top(pages.rows, p.name, 8).map((r) => ({ path: r.key, ...point(r) })),
      referrers: top(referrers.rows, p.name, 6).map((r) => ({ referrer: r.key, ...point(r) })),
      devices: top(devices.rows, p.name, 3).map((r) => ({ device: r.key, ...point(r) })),
    };
  });

  return { enabled: true, generatedAt, days, timezone, sites };
}
