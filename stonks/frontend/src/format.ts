import type { LossAction } from './types';

const eurFmt = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eurWhole = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

export const num = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
};

export const eur = (v: unknown, whole = false) => {
  const n = num(v);
  if (!Number.isFinite(n)) return '–';
  return (whole ? eurWhole : eurFmt).format(n);
};

export const signedEur = (v: unknown) => {
  const n = num(v);
  if (!Number.isFinite(n)) return '–';
  return (n > 0 ? '+' : n < 0 ? '−' : '') + eurFmt.format(Math.abs(n));
};

/** "10%" or "€ 100"; a % limit with its euro amount: "10% (€ 118)". */
export const lossLimitText = (limit: { unit: 'pct' | 'eur'; value: number } | undefined, eurNow?: number) => {
  if (!limit) return eurNow === undefined ? '–' : eur(eurNow, true);
  if (limit.unit === 'eur') return eur(limit.value, true);
  const p = `${limit.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
  return eurNow === undefined ? p : `${p} (${eur(eurNow, true)})`;
};

/** The loss guard's actions in plain words (SPEC §5). A limit without an action acts like the default. */
export const LOSS_ACTIONS: { value: LossAction; label: string; explain: string; then: string }[] = [
  {
    value: 'no_buys',
    label: 'Stop buying',
    explain: 'The bot stays on, cancels its open buys and places no new ones. Sells, stops and exits go on. It ends by itself once the loss is back under the limit.',
    then: 'it stops buying until the loss is back under that',
  },
  {
    value: 'alert',
    label: 'Only tell me',
    explain: 'The bot reports it and keeps trading as usual. Nothing is held back.',
    then: 'it tells you and keeps trading',
  },
  {
    value: 'stop',
    label: 'Switch off',
    explain: 'The bot cancels its orders and switches itself off until you turn it on again.',
    then: 'it switches itself off',
  },
];
export const lossAction = (a: LossAction | undefined) => LOSS_ACTIONS.find((x) => x.value === a) ?? LOSS_ACTIONS[0];

export const pct = (v: unknown, digits = 1, signed = false) => {
  const n = num(v);
  if (!Number.isFinite(n)) return '–';
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const sign = n < 0 ? '−' : signed && n > 0 ? '+' : '';
  return `${sign}${s}%`;
};

/** Crypto amounts: up to 8 decimals, trailing zeros trimmed. */
export const amount = (v: unknown) => {
  const n = num(v);
  if (!Number.isFinite(n)) return '–';
  if (n === 0) return '0';
  const digits = Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 1 ? 4 : 8;
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
};

export const price = (v: unknown) => {
  const n = num(v);
  if (!Number.isFinite(n)) return '–';
  const digits = n >= 1000 ? 2 : n >= 1 ? 4 : 6;
  return '€ ' + n.toLocaleString('nl-NL', { maximumFractionDigits: digits, minimumFractionDigits: n >= 1000 ? 2 : 0 });
};

export const toDate = (v: unknown): Date | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

export const dateTime = (v: unknown) => {
  const d = toDate(v);
  if (!d) return '–';
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

export const dateOnly = (v: unknown) => {
  const d = toDate(v);
  if (!d) return '–';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

/** Reading cards: how long ago a piece was posted, and the date once it is more than two months old. */
export const whenPosted = (v: unknown) => {
  const d = toDate(v);
  if (!d) return '–';
  const secs = Math.max(1, Math.floor((Date.now() - d.getTime()) / 1000));
  if (secs < 60) return `${secs} s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return mins % 60 ? `${hours} h ${mins % 60} min ago` : `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days > 61) return dateOnly(d);
  if (days < 14) return hours % 24 ? `${days} ${days === 1 ? 'day' : 'days'} ${hours % 24} h ago` : `${days} ${days === 1 ? 'day' : 'days'} ago`;
  return `${Math.floor(days / 7)} weeks ago`;
};

export const timeOnly = (v: unknown) => {
  const d = toDate(v);
  if (!d) return '–';
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

export const ago = (v: unknown) => {
  const d = toDate(v);
  if (!d) return 'never';
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const days = Math.round(s / 86400);
  return days === 1 ? '1 day ago' : `${days} days ago`;
};

export const familyLabel = (f: string) =>
  ({
    ema_cross: 'EMA crossover',
    macd_trend: 'MACD trend',
    donchian_breakout: 'Donchian breakout',
    rsi_dip: 'RSI dip',
    bollinger_reversion: 'Bollinger reversion',
    dca_dip: 'DCA + dips',
    rotation_momentum: 'Momentum rotation',
  })[f] ?? f.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export const humanize = (k: string) =>
  k
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
