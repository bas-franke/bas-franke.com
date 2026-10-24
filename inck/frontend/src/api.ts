export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(path, {
    ...rest,
    headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? `Request failed (HTTP ${res.status})`);
  return body as T;
}

export const mediaUrl = (file: string | null | undefined) => (file ? `/api/media/${file}` : null);

export function formatDate(iso: string, withTime = false) {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

export function timeAgo(iso: string) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)} d ago`;
  return formatDate(iso);
}

export function timeUntil(iso: string) {
  const s = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (s <= 0) return 'any moment';
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  return `in ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

/** "45 sec" / "1 min" / "2 min" */
export function readLabel(seconds: number) {
  if (seconds < 55) return `${Math.max(10, Math.round(seconds / 5) * 5)} sec`;
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

export const compact = (n: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
