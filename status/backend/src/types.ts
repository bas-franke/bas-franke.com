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

// Visitor analytics (see analytics.ts). "visitors" are unique per day: the visitor hash changes every day.
export interface AnalyticsPoint {
  views: number;
  visitors: number;
}

export interface SiteAnalytics {
  site: string;
  domain: string;
  /** Totals for the selected range and for the range before it, so the page can show a trend. */
  totals: AnalyticsPoint & { previousViews: number; previousVisitors: number };
  /** One entry per day in the range (oldest first), zero-filled. */
  daily: (AnalyticsPoint & { day: string })[];
  /** The last 12 calendar months (oldest first), zero-filled. */
  monthly: (AnalyticsPoint & { month: string })[];
  pages: (AnalyticsPoint & { path: string })[];
  referrers: (AnalyticsPoint & { referrer: string })[];
  devices: (AnalyticsPoint & { device: string })[];
}

export interface AnalyticsReport {
  /** False when the status backend has no database; `detail` and `fix` then say what to do. */
  enabled: boolean;
  generatedAt: string;
  days: number;
  timezone: string;
  sites: SiteAnalytics[];
  detail?: string;
  fix?: Fix;
}
