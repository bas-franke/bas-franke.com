import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { holdPlace, spreadFrom } from './themeChange';

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

function saveTheme(theme: Theme) {
  try {
    localStorage.setItem('theme', theme);
  } catch {
    /* private mode: the choice just does not persist */
  }
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
    saveTheme(next);
    spreadFrom(lamp, () => apply(next));
  }

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeApi {
  return useContext(ThemeContext);
}
