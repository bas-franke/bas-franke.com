/** Number, time and name formatting shared by every page. */

export const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(n);

export const full = (n: number) => n.toLocaleString('en');

/** "1m 23s", "45s", "1h 5m"; an em dash when there is nothing to show. */
export function duration(ms: number | null | undefined) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const percent = (share: number | null | undefined) =>
  share === null || share === undefined ? '—' : `${Math.round(share * 100)}%`;

export const decimal = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toFixed(n >= 10 ? 0 : 1));

export interface Delta {
  text: string;
  dir: 'up' | 'down' | 'flat';
  /** Whether the change is good news: drives the colour, independent of the arrow direction. */
  tone: 'good' | 'bad' | 'neutral';
}

/**
 * Change against the previous period. `points` compares shares (bounce rate) in percentage points instead of
 * relative percent; `lowerIsBetter` flips the colour for metrics where down is good.
 */
export function delta(
  current: number | null | undefined,
  previous: number | null | undefined,
  { points = false, lowerIsBetter = false } = {},
): Delta | undefined {
  if (current === null || current === undefined) return undefined;
  if (previous === null || previous === undefined || (!points && previous === 0)) {
    return current && !points ? { text: 'new', dir: 'up', tone: lowerIsBetter ? 'neutral' : 'good' } : undefined;
  }
  let change: number;
  let text: string;
  if (points) {
    change = Math.round((current - previous) * 1000) / 10;
    text = `${change > 0 ? '+' : change < 0 ? '−' : ''}${Math.abs(change)} pp`;
  } else {
    change = Math.round(((current - previous) / previous) * 100);
    text = `${change > 0 ? '+' : change < 0 ? '−' : ''}${Math.abs(change)}%`;
  }
  const dir = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
  const good = lowerIsBetter ? dir === 'down' : dir === 'up';
  return { text, dir, tone: dir === 'flat' ? 'neutral' : good ? 'good' : 'bad' };
}

export function timeAgo(iso: string) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

// Days and months arrive as plain ISO dates; format them in UTC so the browser's zone never shifts them.
const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);
export const dayLabel = (day: string) => utc(day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
export const dayTitle = (day: string) =>
  utc(day).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
export const monthLabel = (month: string) => utc(`${month}-01`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
export const monthTitle = (month: string) => utc(`${month}-01`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export const rangeText = (days: number) => (days === 365 ? 'last 12 months' : `last ${days} days`);
export const previousText = (days: number) => (days === 365 ? 'the 12 months before' : `the ${days} days before`);

function displayNames(type: 'region' | 'language') {
  try {
    return new Intl.DisplayNames(['en'], { type });
  } catch {
    return undefined;
  }
}
const regions = displayNames('region');
const languages = displayNames('language');

/** Flag emoji from an ISO 3166-1 alpha-2 code, via regional indicator symbols. */
export function flag(code: string) {
  if (!/^[A-Z]{2}$/.test(code) || code === 'ZZ') return '🌐';
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export function countryName(code: string) {
  if (code === 'ZZ' || !code) return 'Unknown';
  try {
    return regions?.of(code) ?? code;
  } catch {
    return code;
  }
}

export function languageName(code: string) {
  if (!code || code === 'und') return 'Unknown';
  try {
    return languages?.of(code) ?? code;
  } catch {
    return code;
  }
}

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const hourText = (h: number) => `${String(h).padStart(2, '0')}:00`;
