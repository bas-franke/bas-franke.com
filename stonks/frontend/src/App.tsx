import { useEffect, useState, type ReactNode } from 'react';
import { api, setUnauthorizedHandler } from './api';
import { IconHome, IconLogout, IconLogs, IconMoon, IconResearch, IconSettings, IconSun, IconTrades } from './components/icons';
import { ToastProvider } from './components/ui';
import { navigate, useLocation } from './router';
import { useTheme } from './theme';
import Login from './pages/Login';
import OverviewPage from './pages/Overview';
import TradesPage from './pages/Trades';
import LogsPage from './pages/Logs';
import SettingsPage from './pages/Settings';
import ResearchPage from './pages/Research';

const NAV = [
  { path: '/', label: 'Overview', icon: IconHome },
  { path: '/trades', label: 'Trades', icon: IconTrades },
  { path: '/logs', label: 'Logs', icon: IconLogs },
  { path: '/research', label: 'Research', icon: IconResearch },
  { path: '/settings', label: 'Settings', icon: IconSettings },
];

const PAGES: Record<string, () => ReactNode> = {
  '/': () => <OverviewPage />,
  '/trades': () => <TradesPage />,
  '/logs': () => <LogsPage />,
  '/research': () => <ResearchPage />,
  '/settings': () => <SettingsPage />,
};

function NavLink({ path, children, className }: { path: string; children: ReactNode; className?: string }) {
  const { path: here } = useLocation();
  return (
    <a
      href={path}
      className={className}
      aria-current={here === path ? 'page' : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(path);
      }}
    >
      {children}
    </a>
  );
}

export default function App() {
  const [auth, setAuth] = useState<'checking' | 'in' | 'out'>('checking');
  const { path } = useLocation();
  const theme = useTheme();

  useEffect(() => {
    setUnauthorizedHandler(() => setAuth('out'));
    api.me().then(
      () => setAuth('in'),
      () => setAuth('out'),
    );
  }, []);

  useEffect(() => {
    const label = NAV.find((n) => n.path === path)?.label;
    document.title = auth === 'in' && label ? `${label} · Stonks` : 'Stonks';
  }, [path, auth]);

  if (auth === 'checking') return <div className="login" aria-busy="true" />;
  if (auth === 'out') return <Login onIn={() => setAuth('in')} />;

  const Page = PAGES[path] ?? PAGES['/'];
  return (
    <ToastProvider>
      <div className="shell">
        <header className="topbar">
          <NavLink path="/" className="brand">
            <img src="/icon-64.png" alt="" width={34} height={34} />
            Stonks
          </NavLink>
          <nav className="nav" aria-label="Main">
            {NAV.map(({ path: p, label, icon: Icon }) => (
              <NavLink key={p} path={p}>
                <Icon />
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="top-actions">
            <button className="icon-btn" onClick={theme.toggle} aria-label={theme.isDark ? 'Switch to light mode' : 'Switch to dark mode'} title={theme.isDark ? 'Light mode' : 'Dark mode'}>
              {theme.isDark ? <IconSun width={18} /> : <IconMoon width={18} />}
            </button>
            <button
              className="icon-btn"
              aria-label="Log out"
              title="Log out"
              onClick={() => api.logout().finally(() => setAuth('out'))}
            >
              <IconLogout width={18} />
            </button>
          </div>
        </header>
        <main key={path}>{Page()}</main>
      </div>
      <nav className="tabbar" aria-label="Main">
        {NAV.map(({ path: p, label, icon: Icon }) => (
          <NavLink key={p} path={p}>
            <Icon />
            {label}
          </NavLink>
        ))}
      </nav>
    </ToastProvider>
  );
}
