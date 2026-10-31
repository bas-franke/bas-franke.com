import { useEffect, useState, useSyncExternalStore } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'stonks-theme';

const read = (): ThemeChoice => {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    // storage blocked: follow the system
  }
  return 'system';
};

const apply = (t: ThemeChoice) => {
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
};

// Apply before React renders so there is no flash.
apply(read());

export const systemDark = () => matchMedia('(prefers-color-scheme: dark)').matches;

const darkNow = () => {
  const t = document.documentElement.getAttribute('data-theme');
  return t ? t === 'dark' : systemDark();
};
const watchDark = (changed: () => void) => {
  const seen = new MutationObserver(changed);
  seen.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const mq = matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', changed);
  return () => {
    seen.disconnect();
    mq.removeEventListener('change', changed);
  };
};

/** Whether the dark theme is showing right now, for anything that isn't CSS. */
export const useIsDark = () => useSyncExternalStore(watchDark, darkNow);

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(read);
  const [sysDark, setSysDark] = useState(systemDark);
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setSysDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const isDark = choice === 'dark' || (choice === 'system' && sysDark);
  const toggle = () => {
    // A click flips what you see; flipping back to what the system wants returns to "follow the system".
    const next: ThemeChoice = isDark ? (sysDark ? 'light' : 'system') : sysDark ? 'system' : 'dark';
    setChoice(next);
    apply(next);
    try {
      if (next === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      // ignore
    }
  };
  return { isDark, toggle };
}
