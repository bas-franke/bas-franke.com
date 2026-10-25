import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export const POLL_MS = 60_000;

/** Called by any request that gets a 401, so the app can swap to the login screen. */
export const UnauthorizedContext = createContext<() => void>(() => {});

export interface Polled<T> {
  data?: T;
  /** The URL `data` was loaded from; differs from the requested one while a new range or site is loading. */
  dataUrl?: string;
  error?: string;
  loading: boolean;
  /** Load again now; `query` is appended once (e.g. 'refresh=1'). */
  reload: (query?: string) => Promise<void>;
}

/** GET `url` as JSON now and every minute; keeps the last good data while reloading. */
export function usePoll<T>(url: string | null, what = 'API'): Polled<T> {
  const onUnauthorized = useContext(UnauthorizedContext);
  const [state, setState] = useState<{ data?: T; dataUrl?: string; error?: string; loading: boolean }>({ loading: !!url });
  const latest = useRef(0);

  const reload = useCallback(
    async (query?: string) => {
      if (!url) return;
      const id = ++latest.current;
      setState((s) => ({ ...s, loading: true }));
      try {
        const res = await fetch(query ? `${url}${url.includes('?') ? '&' : '?'}${query}` : url);
        if (res.status === 401) return onUnauthorized();
        if (!res.ok) throw new Error(`The ${what} returned HTTP ${res.status}.`);
        const data = (await res.json()) as T;
        if (id === latest.current) setState({ data, dataUrl: url, loading: false });
      } catch (err) {
        if (id === latest.current) {
          setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err), loading: false }));
        }
      }
    },
    [url, what, onUnauthorized],
  );

  useEffect(() => {
    if (!url) return;
    setState((s) => ({ ...s, error: undefined }));
    reload();
    const poll = setInterval(() => reload(), POLL_MS);
    return () => clearInterval(poll);
  }, [url, reload]);

  return { ...state, reload };
}

/** Re-render every `ms`, for "checked 12s ago" labels. */
export function useTicker(ms = 10_000) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}
