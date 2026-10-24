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

export interface Report {
  generatedAt: string;
  durationMs: number;
  summary: Record<CheckStatus, number>;
  groups: CheckGroup[];
}

// Visitor analytics (mirrors the backend). "visitors" are unique per day: the visitor hash changes daily.
export interface AnalyticsPoint {
  views: number;
  visitors: number;
}

export interface SiteAnalytics {
  site: string;
  domain: string;
  totals: AnalyticsPoint & { previousViews: number; previousVisitors: number };
  daily: (AnalyticsPoint & { day: string })[];
  monthly: (AnalyticsPoint & { month: string })[];
  pages: (AnalyticsPoint & { path: string })[];
  referrers: (AnalyticsPoint & { referrer: string })[];
  devices: (AnalyticsPoint & { device: string })[];
}

export interface AnalyticsReport {
  enabled: boolean;
  generatedAt: string;
  days: number;
  timezone: string;
  sites: SiteAnalytics[];
  detail?: string;
  fix?: Fix;
}
