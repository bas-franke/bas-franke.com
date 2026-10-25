// Mirrors status/backend/src/types.ts (projects never share code, so this is a copy).
export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface FixStep {
  text: string;
  code?: string;
}

export interface Fix {
  summary: string;
  steps: FixStep[];
  doc?: string;
}

export interface CheckResult {
  id: string;
  title: string;
  provider: string;
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

/** GET /api/status */
export interface Report {
  generatedAt: string;
  durationMs: number;
  summary: Record<CheckStatus, number>;
  groups: CheckGroup[];
}

// Visitor analytics. "visitors" are unique per day: the visitor hash changes every day,
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
  /** ISO 3166-1 alpha-2 country codes (upper case) or 'ZZ' for unknown. Top 30. */
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

// Change history (see backend/src/changes.ts): commits on the deploy branch that touched the project's folder,
// copied from GitHub into the status database.
export interface Change {
  sha: string;
  summary: string;
  body: string;
  author: string;
  date: string;
  url: string;
}

export interface ChangeList {
  site: string;
  /** False while the status backend has no database; `detail` says why. */
  enabled: boolean;
  detail?: string;
  changes: Change[];
  /** Stored changes in all; `changes` holds the newest few hundred. */
  total: number;
  historyUrl: string;
  syncedAt?: string;
  /** The latest sync from GitHub failed; the stored history is still shown. */
  error?: string;
}

export interface LatestChanges {
  enabled: boolean;
  sites: Record<string, { latest: Change }>;
}
