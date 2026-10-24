// Optional player account. Guests keep their progress on the device (cookies + localStorage, see save.ts). With an
// account the same save also lives on the server: it is uploaded a few seconds after every change and on every
// login, and the server answers with the merged save (best of every device), which is adopted here. So progress
// follows the player to any device, and two devices playing at once never wipe each other's stars.

import { adopt, resetProgress, save, setPersistHook, type SaveData } from './save';

export interface AccountUser {
  username: string;
  displayName: string;
}

export interface AccountState {
  /** False when the server has no database: accounts are hidden and the game stays in guest mode. */
  enabled: boolean;
  user: AccountUser | null;
  /** 'idle' after a successful upload, 'error' when the last one failed (it is retried on the next change). */
  sync: 'idle' | 'pending' | 'error';
}

let state: AccountState = { enabled: false, user: null, sync: 'idle' };
const listeners = new Set<(s: AccountState) => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

function set(next: Partial<AccountState>) {
  state = { ...state, ...next };
  for (const fn of listeners) fn(state);
}

export const accountState = () => state;

export function onAccount(fn: (s: AccountState) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/account${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new AccountError(body.error ?? `Request failed (${res.status})`, body.field);
  return body as T;
}

export class AccountError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

/** Upload the save soon; called after every local save write while logged in. */
function scheduleUpload() {
  if (!state.user) return;
  clearTimeout(timer);
  set({ sync: 'pending' });
  timer = setTimeout(upload, 3000);
}

async function upload() {
  if (!state.user) return;
  try {
    const { save: merged } = await api<{ save: SaveData }>('/save', { method: 'PUT', body: JSON.stringify({ save: save() }) });
    adopt(merged);
    set({ sync: 'idle' });
  } catch (err) {
    if (err instanceof AccountError && err.message === 'Not logged in') set({ user: null, sync: 'idle' });
    else set({ sync: 'error' });
  }
}

/** Ask the server who we are; adopt the account's save if logged in. Safe to call when the backend is down. */
export async function initAccount() {
  setPersistHook(scheduleUpload);
  try {
    const res = await api<{ enabled: boolean; user: AccountUser | null; save?: SaveData }>('/');
    set({ enabled: res.enabled, user: res.user });
    if (res.user && res.save) {
      adopt(res.save);
      scheduleUpload();
    }
  } catch {
    set({ enabled: false, user: null });
  }
}

/** Sign up or log in; this device's progress is sent along and merged into the account. */
export async function authenticate(mode: 'login' | 'register', username: string, password: string) {
  const res = await api<{ user: AccountUser; save: SaveData }>(`/${mode}`, {
    method: 'POST',
    body: JSON.stringify({ username, password, save: save() }),
  });
  adopt(res.save);
  set({ user: res.user, sync: 'idle' });
}

/** Log out and clear this device's progress (it is safe on the server), so the next player starts fresh. */
export async function logout() {
  clearTimeout(timer);
  if (state.sync !== 'idle') await upload();
  await api('/logout', { method: 'POST' }).catch(() => {});
  resetProgress();
  set({ user: null, sync: 'idle' });
}

export async function deleteAccount(password: string) {
  await api('/delete', { method: 'POST', body: JSON.stringify({ password }) });
  resetProgress();
  set({ user: null, sync: 'idle' });
}
