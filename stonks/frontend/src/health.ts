import { useEffect, useSyncExternalStore } from 'react';
import { api, ApiError } from './api';
import { useVisibleInterval } from './components/ui';
import type { HealthDetail, LossAction } from './types';

// One shared view of GET /api/health/detail: the nav dot, the Overview's guard notice and the Health page all read it.
// A failed refresh keeps the last answer but sets `error`, so nothing may show that answer as if it were current.

export interface HealthFeed {
  data?: HealthDetail;
  error?: { message: string; status?: number };
  lastOkAt: number | null;
  checking: boolean;
}

/** A backend that hangs is as down as one that refuses. */
const TIMEOUT_MS = 12_000;

let state: HealthFeed = { lastOkAt: null, checking: false };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const set = (patch: Partial<HealthFeed>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function fetchDetail() {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`No answer within ${TIMEOUT_MS / 1000} s.`)), TIMEOUT_MS);
  });
  return Promise.race([api.healthDetail(), timeout]).finally(() => clearTimeout(timer));
}

export function refreshHealth(): Promise<void> {
  if (inflight) return inflight;
  set({ checking: true });
  inflight = fetchDetail()
    .then((data) => {
      // A proxy can answer 200 with a web page while the backend is gone.
      if (!data?.components || !data.status) throw new Error('The server did not answer with a health report.');
      set({ data, error: undefined, lastOkAt: Date.now(), checking: false });
    })
    .catch((e: Error) => {
      // A 401 sends the app to the login screen; that is not the bot being down.
      if (e instanceof ApiError && e.status === 401) return set({ checking: false });
      set({ error: { message: e.message, status: e instanceof ApiError ? e.status : undefined }, checking: false });
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export const useHealth = () => useSyncExternalStore(subscribe, () => state);

/** Keeps the feed fresh at this pace while the tab is visible; the fastest mounted caller sets the real pace. */
export function useHealthFeed(ms: number, enabled = true) {
  useEffect(() => {
    if (enabled) void refreshHealth();
  }, [enabled]);
  useVisibleInterval(() => void refreshHealth(), ms, enabled);
}

/** What the nav dot shows: the worst when the report can't be fetched, else the report's own status. */
export const feedLevel = (f: HealthFeed): 'ok' | 'warn' | 'fail' | null => (f.error ? 'fail' : (f.data?.status ?? null));

export interface GuardNow {
  active: boolean;
  action?: LossAction;
  lossEur: number | null;
  limitEur: number;
}
export const guardOf = (f: HealthFeed) => f.data?.components.lossGuard?.data as Partial<GuardNow> | undefined;
