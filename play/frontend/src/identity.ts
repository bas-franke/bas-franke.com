/**
 * Who is playing: the device id and nickname cookies every visitor gets, the optional account, and the sync that
 * copies this browser's localStorage (settings, progress) to the account so it follows the player to other devices.
 *
 * Guests never need an account: their nickname lives in the `play_name` cookie (mirrored to localStorage `play.name`)
 * and everything else stays in this browser. All storage and cookie access is wrapped, because private windows and
 * blocked site data make it throw; these are conveniences and must never break a page.
 */
import { useSyncExternalStore } from 'react';

export interface User {
  id: string;
  email: string;
  nickname: string;
}
export type Save = Record<string, string>;

export const NICKNAME_MAX = 16;
export const PASSWORD_MIN = 8;

const NAME_COOKIE = 'play_name';
const ID_COOKIE = 'play_id';
const NAME_KEY = 'play.name';
/** The account this browser last synced with and per-key hashes of what it confirmed. Never synced itself. */
const SYNC_KEY = 'play.sync';
/** Where to send someone after they follow an activation or reset mail. */
const RETURN_KEY = 'play.returnTo';
// The nickname follows the account's own nickname field, not the save.
const NOT_SYNCED = new Set([SYNC_KEY, RETURN_KEY, NAME_KEY]);
const TWO_YEARS = 60 * 60 * 24 * 365 * 2;
const SAVE_MAX = 128 * 1024;
const KEY_MAX = 100;
const SYNC_EVERY = 15_000;

// ---- cookies and storage ----------------------------------------------------------------------------------

function readCookie(name: string): string | null {
  try {
    for (const part of document.cookie.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  } catch {
    /* cookies unavailable */
  }
  return null;
}

function writeCookie(name: string, value: string) {
  try {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${TWO_YEARS}; SameSite=Lax${secure}`;
  } catch {
    /* cookies unavailable */
  }
}

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}
function removeLocal(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

// ---- device id --------------------------------------------------------------------------------------------

function randomId() {
  const bytes = new Uint8Array(16);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** This browser's guest id (`play_id` cookie, 22 chars). The server uses it to put a reconnecting player back in. */
export function deviceId(): string {
  const existing = readCookie(ID_COOKIE);
  if (existing && /^[A-Za-z0-9_-]{16,64}$/.test(existing)) return existing;
  const id = randomId();
  writeCookie(ID_COOKIE, id);
  return id;
}

// ---- nickname ---------------------------------------------------------------------------------------------

export const cleanNickname = (raw: string) => raw.replace(/\s+/g, ' ').trim().slice(0, NICKNAME_MAX);

/** The nickname from the cookie, or localStorage when only that survived; mirrors whichever was missing. */
export function savedName(): string {
  const cookie = readCookie(NAME_COOKIE)?.trim() || '';
  const local = readLocal(NAME_KEY)?.trim() || '';
  if (cookie && local !== cookie) writeLocal(NAME_KEY, cookie);
  else if (!cookie && local) writeCookie(NAME_COOKIE, local);
  return cookie || local;
}

let patchTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Remember the nickname in the cookie and localStorage. When logged in, the account's nickname follows (debounced,
 * since some name fields save on every keystroke).
 */
export function saveName(raw: string) {
  const name = cleanNickname(raw);
  if (!name) return;
  writeCookie(NAME_COOKIE, name);
  writeLocal(NAME_KEY, name);
  set({ name });
  const { user } = state;
  if (user && user.nickname !== name) {
    clearTimeout(patchTimer);
    patchTimer = setTimeout(() => {
      if (state.user && state.user.nickname !== name) void updateNickname(name).catch(() => undefined);
    }, 1200);
  }
}

// ---- account store ----------------------------------------------------------------------------------------

export interface AccountState {
  /** The first `GET /api/account` has answered (or failed). */
  loaded: boolean;
  /** Accounts exist on this server; false means everybody is a guest. */
  enabled: boolean;
  /** The server can send mail (activation, reset). */
  mail: boolean;
  user: User | null;
  name: string;
}

let state: AccountState = {
  loaded: false,
  enabled: false,
  mail: false,
  user: null,
  name: savedName(),
};
const listeners = new Set<() => void>();

function set(patch: Partial<AccountState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const accountState = () => state;

/** The account store as React state: re-renders when the user, the nickname or `enabled` changes. */
export function useAccount(): AccountState {
  return useSyncExternalStore(subscribe, accountState, accountState);
}

/** An API error with the form field it belongs to (`field`) and the login refusal for unverified accounts. */
export class AccountError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly field?: string,
    readonly unverified?: boolean,
  ) {
    super(message);
  }
}

async function call<T>(path: string, method = 'GET', body?: unknown, extra?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...extra,
    });
  } catch {
    throw new AccountError('Could not reach the server. Check your connection and try again.', 0);
  }
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    field?: string;
    unverified?: boolean;
  };
  if (!res.ok) throw new AccountError(data.error || `Something went wrong (HTTP ${res.status}).`, res.status, data.field, data.unverified);
  return data as T;
}

let loading: Promise<void> | null = null;

interface AccountReply {
  enabled?: boolean;
  mail?: boolean;
  user?: User | null;
  save?: Save | null;
}

async function fetchAccount(timeout: number) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res: AccountReply;
  try {
    res = await call<AccountReply>('/api/account', 'GET', undefined, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  const user = res.enabled && res.user ? res.user : null;
  set({ loaded: true, enabled: !!res.enabled, mail: !!res.mail, user });
  if (user) await resume(user, res.save ?? null);
}

/**
 * Fetch the account once per page load. A failure (no backend, no database) leaves everybody a guest; a slow or
 * dropped answer is retried once in the background, and the store updates when it arrives.
 */
export function loadAccount(): Promise<void> {
  loading ??= (async () => {
    try {
      await fetchAccount(4000);
    } catch (err) {
      if (!state.loaded) set({ loaded: true, enabled: false, mail: false, user: null });
      if (err instanceof AccountError && err.status === 0) void fetchAccount(20_000).catch(() => undefined);
    }
  })();
  return loading;
}

/** Logged-in nickname = account nickname. */
function adoptNickname(user: User) {
  writeCookie(NAME_COOKIE, user.nickname);
  writeLocal(NAME_KEY, user.nickname);
  set({ name: user.nickname });
}

type Arrival = 'login' | 'activate' | 'reset' | 'resume';

/**
 * A session starts (or resumes on load): merge this browser's storage with the account's, then reload once if
 * settings already held in memory went stale. Returns true when the page is reloading (or going to `next`).
 */
async function signedIn(user: User, save: Save | null, how: Arrival, next?: string) {
  set({ user, enabled: true });
  adoptNickname(user);
  const stale = await reconcile(user, save, how);
  startSync();
  return stale && reloadOnce(next);
}

/** Log in. `reloading` is true when the page is reloading to pick up the account's settings. */
export async function login(email: string, password: string) {
  const res = await call<{ user: User; save: Save | null }>('/api/account/login', 'POST', { email, password });
  const reloading = await signedIn(res.user, res.save, 'login');
  return { user: res.user, reloading };
}

export function register(email: string, password: string, nickname: string) {
  // The account starts empty; this browser's storage goes up when the activation link is used here.
  return call<{ pending: true; email: string; devLink?: string }>('/api/account/register', 'POST', { email, password, nickname });
}

/** Activate from the mail link. `next` is where to go afterwards; when `reloading`, the page is already going there. */
export async function activate(token: string, next: string) {
  const res = await call<{ user: User; save: Save | null }>('/api/account/activate', 'POST', { token });
  const reloading = await signedIn(res.user, res.save, 'activate', next);
  return { user: res.user, reloading };
}

export const resend = (email: string) => call<{ ok: true }>('/api/account/resend', 'POST', { email });
export const forgot = (email: string) => call<{ ok: true; devLink?: string }>('/api/account/forgot', 'POST', { email });

export async function resetPassword(token: string, password: string, next: string) {
  const res = await call<{ user: User; save: Save | null }>('/api/account/reset', 'POST', { token, password });
  const reloading = await signedIn(res.user, res.save, 'reset', next);
  return { user: res.user, reloading };
}

export async function updateNickname(nickname: string) {
  const res = await call<{ user: User }>('/api/account', 'PATCH', { nickname: cleanNickname(nickname) });
  set({ user: res.user });
  adoptNickname(res.user);
  return res.user;
}

export const changePassword = (current: string, password: string) => call<{ ok: true }>('/api/account/password', 'POST', { current, password });

/**
 * Log out: the nickname and everything in this browser stay, so they carry on as a guest. The sync record keeps the
 * account id, so if someone else logs in here next, this account's data is not uploaded into theirs.
 */
export async function logout() {
  await flushSave();
  await call<{ ok: true }>('/api/account/logout', 'POST', {});
  signedOut();
}

/** Delete the account. What's in this browser becomes plain guest data again. */
export async function deleteAccount(password: string) {
  await call<{ ok: true }>('/api/account/delete', 'POST', { password });
  signedOut();
  removeLocal(SYNC_KEY);
}

function signedOut() {
  stopSync();
  set({ user: null });
}

/** Remember the page to come back to after following a mail link (activation, reset) in a new tab. */
export function rememberReturn(path: string) {
  if (path.startsWith('/') && !path.startsWith('/account')) writeLocal(RETURN_KEY, path);
}
export function takeReturn(): string {
  const path = readLocal(RETURN_KEY);
  removeLocal(RETURN_KEY);
  return path && path.startsWith('/') && !path.startsWith('//') ? path : '/';
}

// ---- localStorage sync ------------------------------------------------------------------------------------

/** FNV-1a, enough to notice that a value changed. */
function hash(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s).length;

/** This origin's localStorage as a save, without bookkeeping keys, trimmed to the server's 128 KB (UTF-8) cap. */
function snapshot(): Save {
  const entries: [string, string, number][] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || key.length > KEY_MAX || NOT_SYNCED.has(key)) continue;
      const value = localStorage.getItem(key);
      if (value !== null) entries.push([key, value, bytes(JSON.stringify(key)) + bytes(JSON.stringify(value)) + 2]);
    }
  } catch {
    return {};
  }
  // Small keys (settings, names) first; a huge blob is what gets left out when the cap is reached.
  entries.sort((a, b) => a[2] - b[2]);
  const save: Save = {};
  let size = 2;
  for (const [key, value, cost] of entries) {
    if (size + cost > SAVE_MAX) break;
    save[key] = value;
    size += cost;
  }
  return save;
}

/** `play.sync`: the account this browser last synced with, and per-key hashes of what that account confirmed. */
interface SyncRecord {
  uid?: string;
  h: Record<string, string>;
}

function readSync(): SyncRecord {
  try {
    const parsed = JSON.parse(readLocal(SYNC_KEY) || '{}') as { uid?: unknown; h?: unknown } | null;
    if (!parsed || typeof parsed !== 'object') return { h: {} };
    if (parsed.h && typeof parsed.h === 'object') return { uid: typeof parsed.uid === 'string' ? parsed.uid : undefined, h: parsed.h as Record<string, string> };
    // The first release stored the bare hash map.
    return { h: parsed as Record<string, string> };
  } catch {
    return { h: {} };
  }
}
const writeSync = (r: SyncRecord) => writeLocal(SYNC_KEY, JSON.stringify(r));

/** Keys whose value differs from what the account last confirmed. */
function changedKeys(): Save {
  const { h } = readSync();
  const out: Save = {};
  for (const [k, v] of Object.entries(snapshot())) if (h[k] !== hash(v)) out[k] = v;
  return out;
}

/** The racer career (racer/core/career.ts): the copy with more progress wins, whichever side it is on. */
const CAREER_KEY = 'racer.career.v1';
function careerProgress(raw: string): [number, number] {
  try {
    const stats = (JSON.parse(raw) as { stats?: { races?: unknown; earnings?: unknown } } | null)?.stats;
    return [Number(stats?.races) || 0, Number(stats?.earnings) || 0];
  } catch {
    return [0, 0];
  }
}
function localCareerWins(local: string, remote: string) {
  const [lr, le] = careerProgress(local);
  const [rr, re] = careerProgress(remote);
  return lr > rr || (lr === rr && le > re);
}

/**
 * Merge this browser's storage with the account's `server` save and write the result locally. Returns true when a
 * key that already had a value here changed (modules that read their settings at load now hold stale copies).
 *
 * - Another account synced here before (shared browser): nothing local is uploaded; the account's save is applied.
 * - Otherwise local-only keys go up, and so do keys changed here since the last sync (after an activation or reset
 *   link: everything this browser has, since the account was made from it). On a plain login the account wins.
 * - The racer career keeps whichever copy has more progress.
 * - If the upload fails, the local values it carried stay and remain unsynced, so the next poll retries them.
 */
async function reconcile(user: User, server: Save | null, how: Arrival): Promise<boolean> {
  const remote: Save = { ...(server ?? {}) };
  for (const k of NOT_SYNCED) delete remote[k];
  const sync = readSync();
  const foreign = !!sync.uid && sync.uid !== user.id;
  const own = sync.uid === user.id || (!sync.uid && Object.keys(sync.h).length > 0);
  const local = snapshot();
  const up: Save = {};

  if (!foreign) {
    const changed = own || how === 'activate' || how === 'reset' ? changedKeys() : {};
    for (const [k, v] of Object.entries(local)) {
      if (!(k in remote) || (k in changed && remote[k] !== v)) up[k] = v;
    }
    const lc = local[CAREER_KEY];
    const rc = remote[CAREER_KEY];
    if (lc !== undefined && rc !== undefined && lc !== rc) {
      if (localCareerWins(lc, rc)) up[CAREER_KEY] = lc;
      else delete up[CAREER_KEY];
    }
  }

  let result = remote;
  if (Object.keys(up).length > 0) {
    try {
      const res = await call<{ save: Save }>('/api/account/save', 'PUT', { save: up });
      result = { ...(res.save ?? {}) };
      for (const k of NOT_SYNCED) delete result[k];
    } catch {
      result = { ...remote };
      for (const k of Object.keys(up)) delete result[k];
    }
  }

  let stale = false;
  for (const [k, v] of Object.entries(result)) {
    if (typeof v !== 'string') continue;
    const current = readLocal(k);
    if (current === v) continue;
    if (current !== null) stale = true;
    writeLocal(k, v);
  }

  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(result)) if (readLocal(k) === v) h[k] = hash(v);
  // A previous account's leftovers stay in this browser but never count as changes to upload.
  if (foreign) for (const [k, v] of Object.entries(snapshot())) if (!(k in result)) h[k] = hash(v);
  writeSync({ uid: user.id, h });
  return stale;
}

// One reload per sync: a page that was itself reloaded for fresh settings never reloads again.
const RELOAD_FLAG = 'play.syncReload';
const reloadedForSync = (() => {
  try {
    const flag = sessionStorage.getItem(RELOAD_FLAG);
    sessionStorage.removeItem(RELOAD_FLAG);
    return !!flag;
  } catch {
    return true;
  }
})();

/** Reload (or go to `next`) so settings read at module load pick up the account's values. False when refused. */
function reloadOnce(next?: string) {
  if (reloadedForSync) return false;
  try {
    sessionStorage.setItem(RELOAD_FLAG, '1');
  } catch {
    return false;
  }
  if (next) location.replace(next);
  else location.reload();
  return true;
}

let syncTimer: ReturnType<typeof setInterval> | undefined;
let pushing: Promise<void> | null = null;
/** A change set the server refused (too big, invalid) or only partly kept: not retried until the data changes. */
let blocked: string | null = null;
/** The change set last sent with keepalive, so tab switches don't resend it. */
let keepaliveSent: string | null = null;

async function push(keepalive = false) {
  const user = state.user;
  if (!user) return;
  const changes = changedKeys();
  if (Object.keys(changes).length === 0) return;
  const body = JSON.stringify({ save: changes });
  const sig = hash(body);
  if (sig === blocked) return;
  // keepalive requests (page closing) are capped at 64 KB by browsers; the next visit sends the rest.
  if (keepalive) {
    if (sig === keepaliveSent || bytes(body) > 60_000) return;
    keepaliveSent = sig;
    try {
      void fetch('/api/account/save', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => undefined);
    } catch {
      /* best effort */
    }
    return;
  }
  try {
    const res = await call<{ save: Save }>('/api/account/save', 'PUT', { save: changes });
    const sync = readSync();
    let partial = false;
    for (const k of Object.keys(changes)) {
      const kept = res.save?.[k];
      if (typeof kept === 'string') sync.h[k] = hash(kept);
      else partial = true;
    }
    writeSync({ uid: sync.uid ?? user.id, h: sync.h });
    if (partial) blocked = sig;
  } catch (err) {
    if (!(err instanceof AccountError)) return;
    if (err.status === 401) signedOut();
    else if (err.status === 413 || err.status === 400) blocked = sig;
  }
}

function pushNow() {
  pushing ??= push().finally(() => {
    pushing = null;
  });
  return pushing;
}

/** Send pending changes right away (before logging out). */
export function flushSave() {
  return pushNow();
}

function onHide() {
  if (document.visibilityState === 'hidden') void push(true);
}
function onPageHide() {
  void push(true);
}

function startSync() {
  if (syncTimer !== undefined) return;
  syncTimer = setInterval(() => void pushNow(), SYNC_EVERY);
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onPageHide);
}

function stopSync() {
  clearInterval(syncTimer);
  syncTimer = undefined;
  document.removeEventListener('visibilitychange', onHide);
  window.removeEventListener('pagehide', onPageHide);
}

/**
 * An existing session on page load: changes made here since the last sync go up, the account's copy (which may carry
 * progress from another device) comes down, and the page reloads once if that changed settings already in memory.
 */
async function resume(user: User, save: Save | null) {
  await signedIn(user, save, 'resume');
}

// Mint the device id as early as possible so the first WebSocket already carries it.
deviceId();
