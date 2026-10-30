import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

type Theme = 'light' | 'dark';

interface ThemeApi {
  theme: Theme;
  toggle: (lamp: Element) => void;
}

const ThemeContext = createContext<ThemeApi>({ theme: 'light', toggle: () => {} });

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function savedTheme(): Theme | null {
  try {
    const saved = localStorage.getItem('theme');
    return saved === 'light' || saved === 'dark' ? saved : null;
  } catch {
    return null;
  }
}

/** Aims the theme change: it spreads from the middle of the lamp until it has passed the far corner (see base.css). */
function aimAt(lamp: Element) {
  const { left, top, width, height } = lamp.getBoundingClientRect();
  const x = left + width / 2;
  const y = top + height / 2;
  const far = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  const { style } = document.documentElement;
  style.setProperty('--lamp-x', `${x}px`);
  style.setProperty('--lamp-y', `${y}px`);
  style.setProperty('--lamp-far', `${far}px`);
}

/** Runs a change that alters the page's height (the morning band is shorter at night) and scrolls the difference away, so the words at the top of the view stay put. */
function holdPlace(change: () => void) {
  const top = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop);
  const words = Array.from(document.querySelectorAll('main :is(h1, h2, h3, p, li)'));
  const anchor = words.find((el) => el.getBoundingClientRect().bottom > top);
  const before = anchor?.getBoundingClientRect().top ?? 0;
  change();
  if (anchor?.isConnected) window.scrollBy({ top: anchor.getBoundingClientRect().top - before, behavior: 'instant' });
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => savedTheme() ?? systemTheme());
  const apply = (next: Theme) => holdPlace(() => flushSync(() => setTheme(next)));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Follow the system setting until the visitor picks a theme themselves.
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (!savedTheme()) apply(systemTheme());
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  function toggle(lamp: Element) {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem('theme', next);
    } catch {
      /* private mode: the choice just does not persist */
    }
    if (document.startViewTransition && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      aimAt(lamp);
      document.startViewTransition(() => apply(next));
    } else {
      apply(next);
    }
  }

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeApi {
  return useContext(ThemeContext);
}
