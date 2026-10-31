import { useSyncExternalStore } from 'react';

// Theme: 'light' | 'dark' | 'auto' (follow the system). Stored per device; applied as data-theme on <html>.
type Pref = 'light' | 'dark' | 'auto';
const KEY = 'pulse-theme';
const mq = matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

function read(): Pref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    // storage blocked
  }
  return 'auto';
}
let pref = read();
const isDark = () => (pref === 'auto' ? mq.matches : pref === 'dark');

function apply() {
  document.documentElement.dataset.theme = isDark() ? 'dark' : 'light';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', isDark() ? '#1d1815' : '#fbf3e6');
  listeners.forEach((l) => l());
}
mq.addEventListener('change', apply);
apply();

export function cycleTheme() {
  pref = pref === 'auto' ? 'light' : pref === 'light' ? 'dark' : 'auto';
  try {
    pref === 'auto' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, pref);
  } catch {
    // storage blocked
  }
  apply();
}

const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
export const useIsDark = () => useSyncExternalStore(subscribe, isDark);
export const useThemePref = () => useSyncExternalStore(subscribe, () => pref);
