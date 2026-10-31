// Dates are plain YYYY-MM-DD strings in the user's local calendar (the same as the database's `date` column).
const pad = (n: number) => String(n).padStart(2, '0');

export const toDateStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayStr = () => toDateStr(new Date());
const parse = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const addDays = (s: string, n: number) => {
  const d = parse(s);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
};
/** Whole days from today to `s` (negative = in the past). */
export const daysFromToday = (s: string) => Math.round((parse(s).getTime() - parse(todayStr()).getTime()) / 86_400_000);

export type DueState = 'none' | 'overdue' | 'today' | 'soon' | 'later';
/** `soon` = within the next 3 days. */
export function dueState(due: string | null, done = false): DueState {
  if (!due) return 'none';
  if (done) return 'later';
  const n = daysFromToday(due);
  return n < 0 ? 'overdue' : n === 0 ? 'today' : n <= 3 ? 'soon' : 'later';
}

export function dueLabel(due: string | null): string {
  if (!due) return '';
  const n = daysFromToday(due);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  if (n < 0) return `${-n} days ago`;
  if (n < 7) return parse(due).toLocaleDateString(undefined, { weekday: 'long' });
  return parse(due).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function greeting(hour = new Date().getHours()) {
  return hour < 5 ? 'Still up' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

export const longDate = () => new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
