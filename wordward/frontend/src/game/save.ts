// The player's save: settings, best scores, level stars and per-word learning progress. It is kept in first-party
// cookies (so it survives the way players expect from "saved in cookies") and mirrored in full to localStorage.
//
// Cookies are sent with every request to wordward.bas-franke.com and Nginx rejects a Cookie header over 8 KB, so the
// cookie copy is budgeted: words are stored as 5-character hashes with a mastery digit, and when the budget runs out
// the least-learned words are left to localStorage only. Levels, bests and settings always fit.

import type { Direction } from '../vocab';

export interface SaveData {
  /** Settings exactly as the menu keeps them. */
  settings?: Record<string, unknown>;
  /** Best score per `direction:difficulty` (free play) or `direction:level` (adventure). */
  best: Record<string, number>;
  /** Stars (1–3) per `direction:levelId`. */
  levels: Record<string, number>;
  /** Per direction: word hash → clean wins (0 = seen, 2+ = mastered, capped at 3). */
  words: Record<Direction, Record<string, number>>;
  /** Last change, to pick the newer of the cookie and localStorage copies. */
  t: number;
}

const STORAGE_KEY = 'wordward:save';
const COOKIE = 'ww';
/** Characters of cookie value we allow in total (well under Nginx's 8 KB header line, with room for the names). */
const COOKIE_BUDGET = 6000;
const CHUNK = 3500;
const MAX_AGE = 60 * 60 * 24 * 365 * 2;

const empty = (): SaveData => ({ best: {}, levels: {}, words: { 'en-ro': {}, 'ro-en': {} }, t: 0 });

/** Stable 5-character id for an entry: FNV-1a, base 36. Collisions are possible but harmless (60 million slots). */
export function wordHash(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % 60466176).toString(36).padStart(5, '0');
}

// ---- encoding ------------------------------------------------------------------------------------------------------

/** Words as "hashN.hashN…", best-learned first, cut to fit `room` characters. */
function packWords(map: Record<string, number>, room: number): string {
  const items = Object.entries(map).sort((a, b) => b[1] - a[1]);
  let out = '';
  for (const [h, n] of items) {
    const piece = `${out ? '.' : ''}${h}${n}`;
    if (out.length + piece.length > room) break;
    out += piece;
  }
  return out;
}

function unpackWords(s: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!s) return out;
  for (const item of s.split('.')) if (item.length === 6) out[item.slice(0, 5)] = Number(item[5]) || 0;
  return out;
}

function toCookieText(d: SaveData): string {
  const head = { s: d.settings, b: d.best, l: d.levels, t: d.t, w: { er: '', re: '' } };
  const base = encodeURIComponent(JSON.stringify(head)).length;
  // Share what is left of the budget between the two directions, in proportion to how much each has.
  const left = Math.max(0, COOKIE_BUDGET - base - 40);
  const n1 = Object.keys(d.words['en-ro']).length;
  const n2 = Object.keys(d.words['ro-en']).length;
  const share = n1 + n2 ? n1 / (n1 + n2) : 0.5;
  head.w.er = packWords(d.words['en-ro'], Math.floor(left * share));
  head.w.re = packWords(d.words['ro-en'], Math.floor(left * (1 - share)));
  return encodeURIComponent(JSON.stringify(head));
}

function fromCookieText(text: string): SaveData | null {
  try {
    const o = JSON.parse(decodeURIComponent(text));
    return {
      settings: o.s,
      best: o.b ?? {},
      levels: o.l ?? {},
      words: { 'en-ro': unpackWords(o.w?.er), 'ro-en': unpackWords(o.w?.re) },
      t: o.t ?? 0,
    };
  } catch {
    return null;
  }
}

// ---- cookies -------------------------------------------------------------------------------------------------------

function readCookies(): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof document === 'undefined') return out;
  for (const part of document.cookie.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function setCookie(name: string, value: string, maxAge = MAX_AGE) {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${name}=${value}; Max-Age=${maxAge}; Path=/; SameSite=Lax${secure}`;
}

function loadCookie(): SaveData | null {
  const c = readCookies();
  const n = Number(c[`${COOKIE}n`]);
  if (!n) return null;
  let text = '';
  for (let i = 0; i < n; i++) text += c[`${COOKIE}${i}`] ?? '';
  return fromCookieText(text);
}

function writeCookie(d: SaveData) {
  try {
    const text = toCookieText(d);
    const old = Number(readCookies()[`${COOKIE}n`]) || 0;
    const chunks = Math.max(1, Math.ceil(text.length / CHUNK));
    for (let i = 0; i < chunks; i++) setCookie(`${COOKIE}${i}`, text.slice(i * CHUNK, (i + 1) * CHUNK));
    for (let i = chunks; i < old; i++) setCookie(`${COOKIE}${i}`, '', 0);
    setCookie(`${COOKIE}n`, String(chunks));
  } catch {
    // Cookies blocked: localStorage still has everything.
  }
}

// ---- localStorage --------------------------------------------------------------------------------------------------

function loadStorage(): SaveData | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...empty(), ...JSON.parse(raw) };
    return migrateOld();
  } catch {
    return null;
  }
}

/** The first versions kept settings, bests and progress under separate localStorage keys. */
function migrateOld(): SaveData | null {
  const settings = localStorage.getItem('wordward:settings');
  const best = localStorage.getItem('wordward:best');
  const progress = localStorage.getItem('wordward:progress');
  if (!settings && !best && !progress) return null;
  const d = empty();
  if (settings) d.settings = JSON.parse(settings);
  if (best) d.best = JSON.parse(best);
  if (progress) {
    const p = JSON.parse(progress) as Record<string, [number, number]>;
    for (const [key, [clean]] of Object.entries(p)) {
      const [dir, ...rest] = key.split('|');
      const words = d.words[dir as Direction];
      if (words) words[wordHash(rest.join('|'))] = Math.min(3, clean);
    }
  }
  d.t = 1;
  return d;
}

// ---- the save ------------------------------------------------------------------------------------------------------

/** Combine two saves: settings from the newer one, the best of everything else. */
function merge(a: SaveData | null, b: SaveData | null): SaveData {
  const x = a ?? empty();
  const y = b ?? empty();
  const out = empty();
  out.settings = (x.t >= y.t ? x.settings : y.settings) ?? x.settings ?? y.settings;
  out.t = Math.max(x.t, y.t);
  for (const k of new Set([...Object.keys(x.best), ...Object.keys(y.best)])) out.best[k] = Math.max(x.best[k] ?? 0, y.best[k] ?? 0);
  for (const k of new Set([...Object.keys(x.levels), ...Object.keys(y.levels)])) out.levels[k] = Math.max(x.levels[k] ?? 0, y.levels[k] ?? 0);
  for (const dir of ['en-ro', 'ro-en'] as const) {
    const xs = x.words[dir] ?? {};
    const ys = y.words[dir] ?? {};
    for (const k of new Set([...Object.keys(xs), ...Object.keys(ys)])) out.words[dir][k] = Math.max(xs[k] ?? 0, ys[k] ?? 0);
  }
  return out;
}

let data: SaveData | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

export function save(): SaveData {
  if (!data) data = merge(loadCookie(), loadStorage());
  return data;
}

/** Change the save and write it out shortly after (several changes in one frame cost one write). */
export function update(fn: (d: SaveData) => void) {
  const d = save();
  fn(d);
  d.t = Date.now();
  clearTimeout(timer);
  timer = setTimeout(persist, 250);
}

export function persist() {
  clearTimeout(timer);
  const d = save();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(d));
  } catch {
    // Private mode or storage full.
  }
  writeCookie(d);
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => data && persist());
}
