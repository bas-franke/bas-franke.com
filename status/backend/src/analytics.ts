import { createHash } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { channelFor } from './channel.js';
import { databaseFix } from './checks/database.js';
import { config, statusEnvFile } from './config.js';
import { dbEnabled, query } from './db.js';
import { projects } from './projects.js';
import { countryForTimeZone } from './tzcountry.js';
import type { AnalyticsPoint, AnalyticsReport, Breakdown, Channel, PageRow, Project, SiteReport, SiteSummary, Totals, TotalsWithPrevious } from './types.js';
import { parseUserAgent } from './ua.js';

/**
 * First-party visitor analytics. Every site's frontend posts its page views to POST /api/page (see the
 * `trackPageViews` snippet in each frontend's src/analytics.ts). Per page view we store the path, a visitor hash that
 * changes daily (salt + day + IP + user agent, never the IP itself), the external referrer, the device class, the
 * browser and OS family, the country guessed from the browser's time zone, the primary language, the traffic channel
 * and utm_source. When the page view ends the snippet sends how long the page was visible ("engaged time"), matched
 * by a random per-page-view id that only lives in the page's memory. No cookies, no storage, nothing identifying, and
 * nothing is accepted from hosts that are not one of our sites.
 *
 * A "visit" is one visitor hash on one day (the hash changes daily anyway), so visits = daily unique visitors.
 */

export const RANGES = [7, 30, 90, 365];
const MAX_PATH = 512;
const MAX_ENGAGED_MS = 30 * 60_000;
const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|pingdom|uptime|monitor|facebookexternalhit|preview|curl|wget|python|java\/|go-http|okhttp|node-fetch|axios/i;
const VIEW_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const CHANNELS: Channel[] = ['direct', 'search', 'social', 'referral', 'email', 'campaign'];
const ENGAGEMENT_BUCKETS = ['<10s', '10-30s', '30s-1m', '1-3m', '3-10m', '10m+'];

// Per-IP caps, so a stuck tab or a script cannot flood the table. Engagement pings have their own (larger) budget
// so they never eat into the page views: a page view can send a few (hidden, visible again, hidden, unload).
const RATE_WINDOW_MS = 60_000;
const viewRate = { limit: 120, hits: new Map<string, { count: number; since: number }>() };
const engagementRate = { limit: 360, hits: new Map<string, { count: number; since: number }>() };

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

function withinRateLimit(bucket: typeof viewRate, ip: string) {
  const now = Date.now();
  const entry = bucket.hits.get(ip);
  if (!entry || now - entry.since > RATE_WINDOW_MS) {
    if (bucket.hits.size > 10_000) bucket.hits.clear();
    bucket.hits.set(ip, { count: 1, since: now });
    return true;
  }
  entry.count++;
  return entry.count <= bucket.limit;
}

/** "/about/?x=1#top" → "/about"; anything that is not a path → undefined. */
function cleanPath(value: unknown) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > MAX_PATH) return undefined;
  const path = value.split(/[?#]/)[0];
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/** The referrer's hostname, or null when it is empty or one of the site's own domains. */
function externalReferrer(value: unknown, site: Project) {
  if (typeof value !== 'string' || !value || value.length > 2048) return null;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return !host || site.domains.includes(host) ? null : host.slice(0, 200);
  } catch {
    return null;
  }
}

const deviceFor = (width: unknown) => (typeof width !== 'number' ? 'desktop' : width < 768 ? 'mobile' : width < 1024 ? 'tablet' : 'desktop');

const viewId = (value: unknown) => (typeof value === 'string' && VIEW_ID.test(value) ? value.toLowerCase() : null);

/** 'nl-NL' → 'nl'; anything that does not start with a 2-3 letter language subtag → null. */
const language = (value: unknown) => (typeof value === 'string' && value.length <= 35 ? (/^([a-z]{2,3})(?:[-_]|$)/i.exec(value)?.[1].toLowerCase() ?? null) : null);

/** A time zone name as the browser reports it, e.g. 'America/Argentina/Buenos_Aires'. */
const timeZone = (value: unknown) => (typeof value === 'string' && /^[A-Za-z0-9_+\-/]{1,64}$/.test(value) ? value : undefined);

/** A utm value, lower case, at most 64 plain characters. */
const utm = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const clean = value.trim().toLowerCase().slice(0, 64);
  return /^[\p{L}\p{N} ._\-+@:/]+$/u.test(clean) ? clean : null;
};

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

/**
 * POST /api/page. Two kinds of body, both JSON sent as text/plain:
 * - a page view `{ p: path, v: viewId, w: width, tz, l: language, r?: referrer, us?: utm_source, um?: utm_medium }`
 * - an engagement ping `{ e: 1, v: viewId, ms }` when that page view ends; we keep the largest ms per view.
 * Always answers 204 at once; the browser never needs to know whether we kept it.
 */
export const collect: RequestHandler = (req, res) => {
  res.sendStatus(204);
  const host = originHost(req);
  const site = host ? siteByHost.get(host) : undefined;
  if (!site || !dbEnabled()) return;
  const userAgent = req.headers['user-agent'] ?? '';
  if (!userAgent || BOT_UA.test(userAgent)) return;

  let body: Record<string, unknown>;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {});
  } catch {
    return;
  }
  if (!body || typeof body !== 'object') return;
  const ip = req.ip ?? 'unknown';

  if (body.e === 1) {
    const id = viewId(body.v);
    const ms = typeof body.ms === 'number' && Number.isFinite(body.ms) ? Math.round(Math.min(Math.max(body.ms, 0), MAX_ENGAGED_MS)) : undefined;
    if (!id || ms === undefined || !withinRateLimit(engagementRate, ip)) return;
    query(
      `UPDATE page_views SET engaged_ms = GREATEST(COALESCE(engaged_ms, 0), $3)
       WHERE view_id = $1 AND site = $2 AND ts > now() - interval '1 day'`,
      [id, site.name, ms],
    ).catch((err) => console.error('engagement not stored', err));
    return;
  }

  if (!withinRateLimit(viewRate, ip)) return;
  const path = cleanPath(body.p);
  if (!path) return;
  const referrer = externalReferrer(body.r, site);
  const source = utm(body.us);
  const { browser, os } = parseUserAgent(userAgent);

  query(
    `INSERT INTO page_views (site, path, visitor, referrer, device, view_id, country, lang, browser, os, channel, campaign)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      site.name,
      path,
      visitorHash(ip, userAgent),
      referrer,
      deviceFor(body.w),
      viewId(body.v),
      countryForTimeZone(timeZone(body.tz)),
      language(body.l),
      browser,
      os,
      channelFor(referrer, source, utm(body.um)),
      source,
    ],
  ).catch((err) => console.error('page view not stored', err));
};

// ---------------------------------------------------------------------------------------------------------------
// Reports

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

// A day is a calendar day in the configured time zone. $1 = time zone, $2 = range in days, $3 = today's date.
// The `ts >=` clauses are coarse index-friendly prefilters; the AT TIME ZONE expression does the exact cut.
const IN_RANGE = `ts >= now() - make_interval(days => $2::int + 1) AND (ts AT TIME ZONE $1)::date > $3::date - $2::int`;
const IN_RANGE_AND_PREVIOUS = `ts >= now() - make_interval(days => 2 * $2::int + 2) AND (ts AT TIME ZONE $1)::date > $3::date - 2 * $2::int`;
const COUNTS = `count(*)::int AS views, count(DISTINCT visitor)::int AS visitors`;
/** Old rows have no channel; without one, a referrer means referral and no referrer means direct. */
const CHANNEL = `COALESCE(channel, CASE WHEN referrer IS NULL THEN 'direct' ELSE 'referral' END)`;

/** Per site and day (selected range plus the one before it): views, visits, one-page visits and engagement sums. */
type DayRow = { site: string; day: string; views: number; visitors: number; bounces: number; eng_sum: number; eng_n: number };

const dayStats = (params: unknown[], siteFilter = '') =>
  query<DayRow>(
    `SELECT site, to_char(day, 'YYYY-MM-DD') AS day, sum(n)::int AS views, count(*)::int AS visitors,
            count(*) FILTER (WHERE n = 1)::int AS bounces, COALESCE(sum(eng_sum), 0)::float8 AS eng_sum, sum(eng_n)::int AS eng_n
     FROM (
       SELECT site, (ts AT TIME ZONE $1)::date AS day, visitor, count(*) AS n, sum(engaged_ms) AS eng_sum, count(engaged_ms) AS eng_n
       FROM page_views WHERE ${IN_RANGE_AND_PREVIOUS} ${siteFilter}
       GROUP BY 1, 2, 3
     ) visits
     GROUP BY 1, 2`,
    params,
  ).then((r) => r.rows);

type DayAgg = Pick<DayRow, 'views' | 'visitors' | 'bounces' | 'eng_sum' | 'eng_n'>;
const NO_DAY: DayAgg = { views: 0, visitors: 0, bounces: 0, eng_sum: 0, eng_n: 0 };

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const avgMs = (sum: number, n: number) => (n > 0 ? Math.round(sum / n) : null);

function totalsOf(days: DayAgg[]): Totals {
  const sum = days.reduce((s, d) => ({
    views: s.views + d.views,
    visitors: s.visitors + d.visitors,
    bounces: s.bounces + d.bounces,
    eng_sum: s.eng_sum + d.eng_sum,
    eng_n: s.eng_n + d.eng_n,
  }), NO_DAY);
  return {
    views: sum.views,
    visitors: sum.visitors,
    avgEngagedMs: avgMs(sum.eng_sum, sum.eng_n),
    bounceRate: ratio(sum.bounces, sum.visitors),
    viewsPerVisit: ratio(sum.views, sum.visitors),
  };
}

/** Totals for the range and the one before it, plus the zero-filled day series of the range. */
function summarize(rows: DayRow[], site: string, today: string, days: number) {
  const bySite = new Map(rows.filter((r) => r.site === site).map((r) => [r.day, r]));
  const all = lastDays(today, 2 * days).map((day) => ({ day, ...(bySite.get(day) ?? NO_DAY) }));
  const previous = all.slice(0, days);
  const current = all.slice(days);
  const totals: TotalsWithPrevious = { ...totalsOf(current), previous: totalsOf(previous) };
  return { totals, current };
}

const disabledInfo = () => ({
  detail: `DATABASE_URL is not set in ${statusEnvFile}, so page views are dropped.`,
  fix: databaseFix(statusProject),
});

/** GET /api/analytics?days=N: headline numbers and a sparkline per project. */
export async function analyticsReport(days: number): Promise<AnalyticsReport> {
  const generatedAt = new Date().toISOString();
  const timezone = config.timezone;
  if (!dbEnabled()) return { enabled: false, generatedAt, days, timezone, sites: [], ...disabledInfo() };

  const today = dayIn(timezone);
  const [rows, live] = await Promise.all([
    dayStats([timezone, days, today]),
    query<{ site: string; live: number }>(
      `SELECT site, count(DISTINCT visitor)::int AS live FROM page_views WHERE ts > now() - interval '5 minutes' GROUP BY 1`,
    ),
  ]);

  const sites: SiteSummary[] = projects.map((p) => {
    const { totals, current } = summarize(rows, p.name, today, days);
    return {
      site: p.name,
      domain: p.domains[0],
      totals,
      live: live.rows.find((r) => r.site === p.name)?.live ?? 0,
      daily: current.map(({ day, views, visitors }) => ({ day, views, visitors })),
    };
  });
  return { enabled: true, generatedAt, days, timezone, sites };
}

/** One breakdown list as a JSON column: `key`, views and visitors (= visits) from the annotated rows `a`. */
const breakdown = (name: string, key: string, limit: number, where = 'true') =>
  `(SELECT COALESCE(json_agg(x), '[]') FROM (
      SELECT ${key} AS key, ${COUNTS} FROM a WHERE ${where} GROUP BY 1 ORDER BY visitors DESC, views DESC, key LIMIT ${limit}
    ) x) AS ${name}`;

/** Entry or exit pages: visitors = visits that started (ended) there, views = page views in those visits. */
const edgePages = (name: string, where: string) =>
  `(SELECT COALESCE(json_agg(x), '[]') FROM (
      SELECT path AS key, sum(n)::int AS views, count(*)::int AS visitors FROM a WHERE ${where}
      GROUP BY 1 ORDER BY visitors DESC, views DESC, key LIMIT 10
    ) x) AS ${name}`;

type DetailRow = {
  pages: PageRow[];
  entry_pages: Breakdown[];
  exit_pages: Breakdown[];
  channels: Breakdown[];
  referrers: Breakdown[];
  campaigns: Breakdown[];
  countries: Breakdown[];
  languages: Breakdown[];
  devices: Breakdown[];
  browsers: Breakdown[];
  os: Breakdown[];
  engagement: { key: string; views: number }[];
  heatmap: { wd: number; h: number; views: number }[];
};

// Every breakdown of one site in one scan. `r` is the site's page views in the range; `a` adds per-visit facts:
// first/last view of the visit, its length, and the visit's channel/referrer/campaign (taken from its first view,
// because later views inside a single-page app never carry a referrer). $4 = site.
const DETAIL_SQL = `
  WITH r AS (
    SELECT id, ts AT TIME ZONE $1 AS lts, (ts AT TIME ZONE $1)::date AS day, visitor, path, engaged_ms, device,
           COALESCE(country, 'ZZ') AS country, lang, COALESCE(browser, 'Other') AS browser, COALESCE(os, 'Other') AS os,
           referrer, campaign, ${CHANNEL} AS channel
    FROM page_views WHERE site = $4 AND ${IN_RANGE}
  ),
  a AS (
    SELECT *,
           row_number() OVER first_w AS first_n,
           row_number() OVER (PARTITION BY visitor, day ORDER BY lts DESC, id DESC) AS last_n,
           count(*) OVER (PARTITION BY visitor, day) AS n,
           first_value(channel) OVER first_w AS v_channel,
           first_value(referrer) OVER first_w AS v_referrer,
           first_value(campaign) OVER first_w AS v_campaign
    FROM r
    WINDOW first_w AS (PARTITION BY visitor, day ORDER BY lts, id)
  )
  SELECT
    (SELECT COALESCE(json_agg(x), '[]') FROM (
      SELECT path AS key, ${COUNTS}, round(avg(engaged_ms))::int AS "avgEngagedMs", count(*) FILTER (WHERE first_n = 1)::int AS entries
      FROM a GROUP BY 1 ORDER BY visitors DESC, views DESC, key LIMIT 25
    ) x) AS pages,
    ${edgePages('entry_pages', 'first_n = 1')},
    ${edgePages('exit_pages', 'last_n = 1')},
    ${breakdown('channels', 'v_channel', 10)},
    ${breakdown('referrers', 'v_referrer', 15, 'v_referrer IS NOT NULL')},
    ${breakdown('campaigns', 'v_campaign', 10, 'v_campaign IS NOT NULL')},
    ${breakdown('countries', 'country', 30)},
    ${breakdown('languages', 'lang', 10, 'lang IS NOT NULL')},
    ${breakdown('devices', 'device', 3)},
    ${breakdown('browsers', 'browser', 10)},
    ${breakdown('os', 'os', 10)},
    (SELECT COALESCE(json_agg(x), '[]') FROM (
      SELECT CASE WHEN engaged_ms < 10000 THEN '<10s' WHEN engaged_ms < 30000 THEN '10-30s' WHEN engaged_ms < 60000 THEN '30s-1m'
                  WHEN engaged_ms < 180000 THEN '1-3m' WHEN engaged_ms < 600000 THEN '3-10m' ELSE '10m+' END AS key,
             count(*)::int AS views
      FROM a WHERE engaged_ms IS NOT NULL GROUP BY 1
    ) x) AS engagement,
    (SELECT COALESCE(json_agg(x), '[]') FROM (
      SELECT extract(isodow FROM lts)::int - 1 AS wd, extract(hour FROM lts)::int AS h, count(*)::int AS views FROM a GROUP BY 1, 2
    ) x) AS heatmap
`;

const emptyHeatmap = () => Array.from({ length: 7 }, () => Array<number>(24).fill(0));
const zeroTotals = (): Totals => ({ views: 0, visitors: 0, avgEngagedMs: null, bounceRate: null, viewsPerVisit: null });

/** GET /api/analytics/:site?days=N: everything for one project's analytics page. Undefined for an unknown site. */
export async function siteReport(name: string, days: number): Promise<SiteReport | undefined> {
  const project = projects.find((p) => p.name === name);
  if (!project) return undefined;
  const generatedAt = new Date().toISOString();
  const timezone = config.timezone;
  const today = dayIn(timezone);
  const base = { site: project.name, domain: project.domains[0], generatedAt, days, timezone };

  if (!dbEnabled()) {
    return {
      ...base,
      enabled: false,
      totals: { ...zeroTotals(), previous: zeroTotals() },
      live: 0,
      daily: lastDays(today, days).map((day) => ({ day, views: 0, visitors: 0, avgEngagedMs: null })),
      monthly: lastMonths(today, 12).map((month) => ({ month, views: 0, visitors: 0 })),
      heatmap: emptyHeatmap(),
      pages: [],
      entryPages: [],
      exitPages: [],
      channels: CHANNELS.map((key) => ({ key, views: 0, visitors: 0 })),
      referrers: [],
      campaigns: [],
      countries: [],
      languages: [],
      devices: [],
      browsers: [],
      os: [],
      engagement: ENGAGEMENT_BUCKETS.map((key) => ({ key, views: 0 })),
      ...disabledInfo(),
    };
  }

  const params = [timezone, days, today, project.name];
  const [rows, monthly, live, detail] = await Promise.all([
    dayStats(params, 'AND site = $4'),
    query<AnalyticsPoint & { key: string }>(
      `SELECT to_char(ts AT TIME ZONE $1, 'YYYY-MM') AS key, ${COUNTS} FROM page_views
       WHERE site = $3 AND ts >= now() - interval '13 months' AND (ts AT TIME ZONE $1)::date >= date_trunc('month', $2::date) - interval '11 months'
       GROUP BY 1`,
      [timezone, today, project.name],
    ),
    query<{ live: number }>(`SELECT count(DISTINCT visitor)::int AS live FROM page_views WHERE site = $1 AND ts > now() - interval '5 minutes'`, [
      project.name,
    ]),
    query<DetailRow>(DETAIL_SQL, params),
  ]);

  const { totals, current } = summarize(rows, project.name, today, days);
  const d = detail.rows[0];
  const months = new Map(monthly.rows.map((r) => [r.key, r]));
  const heatmap = emptyHeatmap();
  for (const cell of d.heatmap) heatmap[cell.wd][cell.h] = cell.views;
  const channelRows = new Map(d.channels.map((c) => [c.key, c]));
  const engagement = new Map(d.engagement.map((e) => [e.key, e.views]));

  return {
    ...base,
    enabled: true,
    totals,
    live: live.rows[0]?.live ?? 0,
    daily: current.map((day) => ({ day: day.day, views: day.views, visitors: day.visitors, avgEngagedMs: avgMs(day.eng_sum, day.eng_n) })),
    monthly: lastMonths(today, 12).map((month) => ({ month, views: months.get(month)?.views ?? 0, visitors: months.get(month)?.visitors ?? 0 })),
    heatmap,
    pages: d.pages,
    entryPages: d.entry_pages,
    exitPages: d.exit_pages,
    channels: CHANNELS.map((key) => ({ key, views: channelRows.get(key)?.views ?? 0, visitors: channelRows.get(key)?.visitors ?? 0 })).sort(
      (a, b) => b.visitors - a.visitors || b.views - a.views,
    ),
    referrers: d.referrers,
    campaigns: d.campaigns,
    countries: d.countries,
    languages: d.languages,
    devices: d.devices,
    browsers: d.browsers,
    os: d.os,
    engagement: ENGAGEMENT_BUCKETS.map((key) => ({ key, views: engagement.get(key) ?? 0 })),
  };
}
