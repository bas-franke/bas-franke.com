import type {
  ActivateResult,
  AllocateResult,
  CompareData,
  CompareRange,
  BotSettings,
  EquityPoint,
  FamilyInfo,
  HallEntry,
  Fill,
  LogRow,
  ManualTarget,
  Writeup,
  MarketInfo,
  Order,
  Overview,
  ResearchResponse,
} from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: unknown,
  ) {
    super(message);
  }
  /** Field-level validation errors, if the backend sent any: `{ errors: {field: msg} }` or `[{path, message}]`. */
  get fieldErrors(): Record<string, string> {
    const b = this.body as { errors?: unknown; details?: unknown } | null;
    const raw = b?.errors ?? b?.details;
    const out: Record<string, string> = {};
    if (Array.isArray(raw)) {
      for (const e of raw as { path?: string | (string | number)[]; field?: string; message?: string }[]) {
        const path = Array.isArray(e.path) ? e.path.join('.') : (e.path ?? e.field ?? '');
        if (path) out[path] = e.message ?? 'Invalid';
        else if (e.message) out._ = e.message;
      }
    } else if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) out[k] = String(v);
    }
    return out;
  }
}

/** Called on any 401 from an authenticated endpoint, so the app can fall back to the login screen. */
let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

async function request<T>(method: string, path: string, body?: unknown, opts: { quiet401?: boolean } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    if (res.status === 401 && !opts.quiet401) onUnauthorized();
    const d = (data && typeof data === 'object' ? data : {}) as { error?: unknown; message?: unknown };
    const msg = String(d.error ?? d.message ?? `${res.status} ${res.statusText}`);
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

const qs = (q: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export interface ListQuery {
  mode?: string;
  market?: string;
  limit?: number;
  before?: string | number;
}

export const api = {
  me: () => request<{ loggedIn: boolean }>('GET', '/auth/me', undefined, { quiet401: true }),
  login: (password: string) => request<{ ok: true }>('POST', '/auth/login', { password }, { quiet401: true }),
  logout: () => request<{ ok: true }>('POST', '/auth/logout'),
  overview: () => request<Overview>('GET', '/overview'),
  updateBot: (patch: Partial<BotSettings> & { confirmLive?: boolean }) => request<BotSettings>('PUT', '/bot', patch),
  start: () => request<BotSettings>('POST', '/bot/start'),
  stop: () => request<BotSettings>('POST', '/bot/stop'),
  orders: (q: ListQuery) => request<{ orders: Order[] }>('GET', `/orders${qs({ ...q })}`),
  fills: (q: ListQuery) => request<{ fills: Fill[] }>('GET', `/fills${qs({ ...q })}`),
  equity: (q: { mode?: string; days?: number }) => request<{ points: EquityPoint[] }>('GET', `/equity${qs(q)}`),
  logs: (q: { level?: string; after?: number; limit?: number }) => request<{ logs: LogRow[] }>('GET', `/logs${qs(q)}`),
  families: () => request<FamilyInfo[] | { families: FamilyInfo[] }>('GET', '/strategies/families'),
  markets: () => request<MarketInfo[] | { markets: MarketInfo[] } | string[]>('GET', '/markets'),
  research: () => request<ResearchResponse>('GET', '/research'),
  activate: (body: ({ researchId: number; bucket: string; rank: number } | { hallOfFameId: number }) & { start: boolean; confirmLive?: boolean }) =>
    request<ActivateResult>('POST', '/bot/activate', body),
  compare: (range: CompareRange) => request<CompareData>('GET', `/compare${qs({ range })}`),
  clearPortfolioHistory: () => request<{ ok: true; removed: number }>('POST', '/portfolio-history/clear', { confirm: 'CLEAR' }),
  writeups: () => request<{ writeups: { specId: string; title: string; updatedAt: string }[] }>('GET', '/writeups'),
  writeup: (specId: string) => request<Writeup>('GET', `/writeups/${encodeURIComponent(specId)}`),
  hallOfFame: () => request<{ entries: HallEntry[] }>('GET', '/hall-of-fame'),
  addToHall: (body: { researchId: number; bucket: string; rank: number }) => request<{ ok: true; id: number }>('POST', '/hall-of-fame', body),
  removeFromHall: (id: number) => request<{ ok: true }>('DELETE', `/hall-of-fame/${id}`, {}),
  allocate: (body: { target: ManualTarget | null; confirmLive?: boolean }) => request<AllocateResult>('POST', '/bot/allocate', body),
  notes: () => request<{ text: string; updatedAt: string | null }>('GET', '/notes'),
  saveNotes: (text: string) => request<{ ok: true }>('PUT', '/notes', { text }),
};

export const unwrapFamilies = (r: FamilyInfo[] | { families: FamilyInfo[] }) => (Array.isArray(r) ? r : (r.families ?? []));
/** The biggest EUR markets first (roughly by market cap), then the rest alphabetically. */
export const POPULAR = ['BTC', 'ETH', 'XRP', 'SOL', 'BNB', 'DOGE', 'ADA', 'TRX', 'LINK', 'AVAX', 'XLM', 'SUI', 'DOT', 'LTC', 'BCH', 'SHIB', 'TON', 'UNI', 'NEAR', 'AAVE'];
export const unwrapMarkets = (r: MarketInfo[] | { markets: MarketInfo[] } | string[]): MarketInfo[] => {
  const arr = Array.isArray(r) ? r : (r.markets ?? []);
  const rank = (m: string) => {
    const i = POPULAR.indexOf(m.split('-')[0]);
    return i < 0 ? POPULAR.length : i;
  };
  return (arr as (MarketInfo | string)[])
    .map((m) => (typeof m === 'string' ? { market: m } : m))
    .sort((a, b) => rank(a.market) - rank(b.market) || a.market.localeCompare(b.market));
};
