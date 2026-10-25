import { createElement, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

/**
 * Tiny path router: history.pushState plus a custom event, no library. Nginx serves index.html for every path.
 *   /                    overview
 *   /p/<site>            project analytics
 *   /p/<site>/health     project health checks
 *   /p/<site>/changes    project change history
 *   /screenshots         screenshots of design changes, all projects (/screenshots/<site> for one)
 * The visitor range rides along as ?range=7d|30d|90d|1y and is remembered in localStorage.
 */

export const RANGES = [
  { days: 7, label: '7d', long: '7 days' },
  { days: 30, label: '30d', long: '30 days' },
  { days: 90, label: '90d', long: '90 days' },
  { days: 365, label: '1y', long: '12 months' },
] as const;

const DEFAULT_DAYS = 30;
const STORE_KEY = 'status.range';
const EVENT = 'status:navigate';

export type Tab = 'analytics' | 'health' | 'changes';
export type Route =
  | { page: 'overview' }
  | { page: 'project'; site: string; tab: Tab }
  | { page: 'screenshots'; site?: string }
  | { page: 'missing' };

export function parseRoute(pathname: string): Route {
  let parts: string[];
  try {
    parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return { page: 'missing' };
  }
  if (parts.length === 0) return { page: 'overview' };
  if (parts[0] === 'screenshots' && parts.length <= 2) return { page: 'screenshots', site: parts[1] };
  if (parts[0] === 'p' && parts[1] && parts.length <= 3) {
    if (parts.length === 2) return { page: 'project', site: parts[1], tab: 'analytics' };
    if (parts[2] === 'health') return { page: 'project', site: parts[1], tab: 'health' };
    if (parts[2] === 'changes') return { page: 'project', site: parts[1], tab: 'changes' };
  }
  return { page: 'missing' };
}

export const projectPath = (site: string, tab: Tab = 'analytics') =>
  `/p/${encodeURIComponent(site)}${tab === 'analytics' ? '' : `/${tab}`}`;

function storedDays() {
  try {
    const days = Number(localStorage.getItem(STORE_KEY));
    return RANGES.some((r) => r.days === days) ? days : undefined;
  } catch {
    return undefined;
  }
}

function daysFrom(search: string) {
  const label = new URLSearchParams(search).get('range');
  return RANGES.find((r) => r.label === label)?.days ?? storedDays() ?? DEFAULT_DAYS;
}

const subscribe = (onChange: () => void) => {
  addEventListener('popstate', onChange);
  addEventListener(EVENT, onChange);
  return () => {
    removeEventListener('popstate', onChange);
    removeEventListener(EVENT, onChange);
  };
};

const snapshot = () => location.pathname + location.search;

export function useLocation() {
  const current = useSyncExternalStore(subscribe, snapshot);
  const url = new URL(current, location.origin);
  return { route: parseRoute(url.pathname), days: daysFrom(url.search) };
}

/** The URL for a path, carrying the selected range when it is not the default. */
export function href(path: string, days = daysFrom(location.search)) {
  const label = RANGES.find((r) => r.days === days)?.label;
  return days === DEFAULT_DAYS || !label ? path : `${path}?range=${label}`;
}

export function navigate(to: string, { replace = false } = {}) {
  if (to === snapshot()) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', to);
  dispatchEvent(new Event(EVENT));
  if (!replace) scrollTo({ top: 0 });
}

export function setDays(days: number) {
  try {
    localStorage.setItem(STORE_KEY, String(days));
  } catch {
    // Private mode or blocked storage: the URL still carries the range.
  }
  navigate(href(location.pathname, days), { replace: true });
}

/** An <a> that navigates in-app on a plain click and behaves like a normal link otherwise (new tab etc.). */
export function Link({ to, onClick, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  useLocation(); // re-render when the range changes, so the href keeps carrying it
  const target = href(to);
  return createElement('a', {
    ...rest,
    href: target,
    onClick: (e: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(e);
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(target);
    },
  });
}
