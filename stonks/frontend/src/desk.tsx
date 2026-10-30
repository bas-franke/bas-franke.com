import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { api } from './api';
import type { Mood } from './components/art';
import { useAsync, useVisibleInterval } from './components/ui';
import type { CompareData, Overview } from './types';

// What the rail and the ticker show on every page: the portfolio, BTC and ETH today, and the bot's state.

const DeskCtx = createContext<{ overview?: Overview; day?: CompareData }>({});
export const useDesk = () => useContext(DeskCtx);

/** Call after anything that changes the bot, so the rail and the ticker don't wait for their next poll. */
export const refreshDesk = () => window.dispatchEvent(new Event('stonks:desk'));

export function DeskProvider({ children }: { children: ReactNode }) {
  const ov = useAsync(() => api.overview(), []);
  useVisibleInterval(() => ov.reload(), 30_000);
  const day = useAsync(() => api.compare('day'), [ov.data?.bot.mode]);
  useVisibleInterval(() => day.reload(), 60_000);
  useEffect(() => {
    const again = () => ov.reload();
    window.addEventListener('stonks:desk', again);
    return () => window.removeEventListener('stonks:desk', again);
  }, [ov.reload]);
  return <DeskCtx.Provider value={{ overview: ov.data, day: day.data }}>{children}</DeskCtx.Provider>;
}

/** % change of a price line since local midnight (or since the line starts, if later). */
export function sinceMidnight(pts: [number, number][]): number | null {
  const midnight = new Date().setHours(0, 0, 0, 0);
  const first = pts.find((p) => p[0] >= midnight);
  const last = pts[pts.length - 1];
  return first && last && first !== last ? (last[1] / first[1] - 1) * 100 : null;
}

export const todayPct = (o: Overview) => (o.todayPnlEur !== null && o.equityEur - o.todayPnlEur > 0 ? (o.todayPnlEur / (o.equityEur - o.todayPnlEur)) * 100 : null);

export const botLine = (o: Overview) => (o.bot.enabled && o.lastTickError ? 'Bot hit an error' : o.running ? 'Bot is awake' : o.bot.enabled ? 'Bot is waking up' : 'Bot is resting');

export const botMood = (o: Overview): Mood => (o.bot.enabled && o.lastTickError ? 'trouble' : o.bot.enabled ? 'awake' : 'asleep');
