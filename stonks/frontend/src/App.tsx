import { useEffect, useState, type ReactNode } from 'react';
import { api, setUnauthorizedHandler } from './api';
import { Art } from './components/art';
import { logout, NAV, Rail, TabBar, Ticker, TopBar } from './components/shell';
import { ToastProvider } from './components/ui';
import { DeskProvider } from './desk';
import { useHealthFeed } from './health';
import { useLocation } from './router';
import './shell.css';
import Login from './pages/Login';
import OverviewPage from './pages/Overview';
import TradesPage from './pages/Trades';
import LogsPage from './pages/Logs';
import HealthPage from './pages/Health';
import SettingsPage from './pages/Settings';
import ResearchPage from './pages/Research';
import NotesPage from './pages/Notes';
import WriteupPage from './pages/Writeup';
import ArticlePage from './pages/Article';

const PAGES: Record<string, () => ReactNode> = {
  '/': () => <OverviewPage />,
  '/trades': () => <TradesPage />,
  '/logs': () => <LogsPage />,
  '/health': () => <HealthPage />,
  '/research': () => <ResearchPage />,
  '/notes': () => <NotesPage />,
  '/settings': () => <SettingsPage />,
  '/writeup': () => <WriteupPage />,
  '/article': () => <ArticlePage />,
};

export default function App() {
  const [auth, setAuth] = useState<'checking' | 'in' | 'out'>('checking');
  const { path } = useLocation();
  useHealthFeed(60_000, auth === 'in');

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
  const out = () => logout(() => setAuth('out'));
  return (
    <ToastProvider>
      <DeskProvider>
        <div className="shell">
          <Rail onLogout={out} />
          <div className="stage">
            <TopBar onLogout={out} />
            <Ticker />
            <main key={path}>{Page()}</main>
            <Art slot="footer-ridge" className="ridge" fallback={null} />
          </div>
        </div>
        <TabBar />
      </DeskProvider>
    </ToastProvider>
  );
}
