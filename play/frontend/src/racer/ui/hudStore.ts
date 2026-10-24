// HUD helpers: a selector hook so each HUD widget re-renders only when its own slice of the per-frame HUD store
// changes, and the time / ordinal formatters the widgets share.

import { useCallback, useSyncExternalStore } from 'react';
import type { HudState, RaceView } from '../RaceView';

/** Subscribe to one slice of the HUD store. The selector must return a primitive or a stable reference. */
export function useHud<T>(view: RaceView, select: (s: HudState) => T): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const get = useCallback(() => select(view.hud.get()), [view]);
  return useSyncExternalStore(view.hud.subscribe, get, get);
}

/** 84.306 -> "01:24.306" (or "1:24.30" with short). */
export function fmtTime(t: number | null, short = false) {
  if (t === null || !Number.isFinite(t)) return short ? '-:--.--' : '--:--.---';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  if (short) return `${m}:${s.toFixed(2).padStart(5, '0')}`;
  return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

export function ordinal(n: number) {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** Touch UI: phones / tablets, or ?touch to preview it with a mouse. */
export function wantsTouch() {
  return !!window.matchMedia?.('(pointer: coarse)').matches || new URLSearchParams(location.search).has('touch');
}
