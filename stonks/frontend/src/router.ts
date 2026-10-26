import { useSyncExternalStore } from 'react';

// A tiny history router: the app has six flat pages, no params beyond the query string.
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
addEventListener('popstate', emit);

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => location.pathname + location.search;

export function useLocation() {
  const href = useSyncExternalStore(subscribe, snapshot);
  const url = new URL(href, location.origin);
  return { path: url.pathname.replace(/\/+$/, '') || '/', query: url.searchParams };
}

export function navigate(to: string, opts: { replace?: boolean; state?: unknown } = {}) {
  if (to === snapshot() && !opts.state) return;
  history[opts.replace ? 'replaceState' : 'pushState'](opts.state ?? null, '', to);
  emit();
  if (!opts.replace) scrollTo({ top: 0 });
}

/** One-shot hand-over between pages (e.g. Research → Settings "use this strategy"), survives nothing but a navigate. */
let handoff: unknown = null;
export const setHandoff = (v: unknown) => {
  handoff = v;
};
export const takeHandoff = <T>(): T | null => {
  const v = handoff as T | null;
  handoff = null;
  return v;
};
