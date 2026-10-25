export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export type Provider = 'name.com' | 'AWS' | 'GitHub' | 'Server' | "Let's Encrypt" | 'Status';

export interface FixStep {
  text: string;
  code?: string;
}

/** Instructions shown on the status page when a check is not ok. */
export interface Fix {
  summary: string;
  steps: FixStep[];
  doc?: string;
}

export interface Outcome {
  status: CheckStatus;
  detail: string;
  /** Overrides the check's default fix for this particular outcome. */
  fix?: Fix;
}

export interface CheckDef {
  id: string;
  title: string;
  provider: Provider;
  fix?: Fix;
  run: () => Promise<Outcome>;
}

export interface CheckResult {
  id: string;
  title: string;
  provider: Provider;
  status: CheckStatus;
  detail: string;
  fix?: Fix;
  durationMs: number;
}

export interface CheckGroup {
  id: string;
  title: string;
  subtitle?: string;
  checks: CheckResult[];
}

export interface Report {
  generatedAt: string;
  durationMs: number;
  summary: Record<CheckStatus, number>;
  groups: CheckGroup[];
}

export interface Project {
  /** Folder name = PM2 process = Nginx site = database name. */
  name: string;
  /** First domain is the primary one; the TLS certificate is named after it. */
  domains: string[];
  port: number;
  database: boolean;
  /** Where the domain's DNS is managed; used in fix instructions. Defaults to name.com. */
  registrar?: string;
  /** Path of a WebSocket endpoint Nginx must upgrade (e.g. '/api/ws'); checked through the public domain. */
  websocket?: string;
}

export const ok = (detail: string): Outcome => ({ status: 'ok', detail });
export const warn = (detail: string, fix?: Fix): Outcome => ({ status: 'warn', detail, fix });
export const fail = (detail: string, fix?: Fix): Outcome => ({ status: 'fail', detail, fix });
export const skip = (detail: string, fix?: Fix): Outcome => ({ status: 'skip', detail, fix });

// Visitor analytics (see analytics.ts). "visitors" are unique per day: the visitor hash changes every day,
// so a "visit" below is one visitor on one day.
export interface AnalyticsPoint {
  views: number;
  visitors: number;
}

/** A named breakdown row: a page path, referrer host, country code, browser, ... */
export interface Breakdown extends AnalyticsPoint {
  key: string;
}

export interface Totals extends AnalyticsPoint {
  /** Average visible time per page view in ms, over views that reported engagement; null when none did. */
  avgEngagedMs: number | null;
  /** Share (0..1) of visits that saw exactly one page; null without visits. */
  bounceRate: number | null;
  /** Page views per visit; null without visits. */
  viewsPerVisit: number | null;
}

/** The same totals for the range before the selected one, so the page can show trends. */
export interface TotalsWithPrevious extends Totals {
  previous: Totals;
}

/** One project on the overview: headline numbers plus a sparkline. */
export interface SiteSummary {
  site: string;
  domain: string;
  totals: TotalsWithPrevious;
  /** Distinct visitors in the last 5 minutes. */
  live: number;
  /** One entry per day in the range (oldest first), zero-filled. */
  daily: (AnalyticsPoint & { day: string })[];
}

/** GET /api/analytics?days=N */
export interface AnalyticsReport {
  /** False when the status backend has no database; `detail` and `fix` then say what to do. */
  enabled: boolean;
  generatedAt: string;
  days: number;
  timezone: string;
  sites: SiteSummary[];
  detail?: string;
  fix?: Fix;
}

export type Channel = 'direct' | 'search' | 'social' | 'referral' | 'email' | 'campaign';

/** Page row with engagement: average visible time and how many visits started on it. */
export interface PageRow extends Breakdown {
  avgEngagedMs: number | null;
  entries: number;
}

/** GET /api/analytics/:site?days=N, everything for one project's analytics page. */
export interface SiteReport extends SiteSummary {
  enabled: boolean;
  generatedAt: string;
  days: number;
  timezone: string;
  /** Per day, also with average engaged ms. */
  daily: (AnalyticsPoint & { day: string; avgEngagedMs: number | null })[];
  /** The last 12 calendar months (oldest first), zero-filled. */
  monthly: (AnalyticsPoint & { month: string })[];
  /** Page views by weekday (0 = Monday) and hour (0..23) in `timezone`: heatmap[weekday][hour]. */
  heatmap: number[][];
  /** Top 25 pages by visitors. */
  pages: PageRow[];
  /** Pages visits started on (top 10 by visits). */
  entryPages: Breakdown[];
  /** Pages visits ended on (top 10 by visits). */
  exitPages: Breakdown[];
  /** Traffic channel, all six present (zero-filled), sorted by visitors. */
  channels: (AnalyticsPoint & { key: Channel })[];
  /** External referrer hosts, top 15. */
  referrers: Breakdown[];
  /** utm_source values, top 10. */
  campaigns: Breakdown[];
  /** ISO 3166-1 alpha-2 country codes (upper case) or 'ZZ' for unknown, derived from the browser time zone. Top 30. */
  countries: Breakdown[];
  /** BCP 47 primary language subtag ('en', 'nl', 'ro'), top 10. */
  languages: Breakdown[];
  /** 'desktop' | 'tablet' | 'mobile'. */
  devices: Breakdown[];
  /** 'Chrome', 'Safari', 'Firefox', 'Edge', 'Samsung Internet', 'Opera', 'Other'. */
  browsers: Breakdown[];
  /** 'Windows', 'macOS', 'iOS', 'Android', 'Linux', 'ChromeOS', 'Other'. */
  os: Breakdown[];
  /** Views per engagement bucket, always these six in order: '<10s', '10-30s', '30s-1m', '1-3m', '3-10m', '10m+'. */
  engagement: { key: string; views: number }[];
  detail?: string;
  fix?: Fix;
}
