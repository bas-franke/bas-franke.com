import { useEffect, useState } from 'react';
import { api } from './api';
import { Art } from './art/Art';
import { Link, usePath } from './router';
import { startStore, useStore } from './store';
import { cycleTheme, useThemePref } from './theme';
import Board from './pages/Board';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';
import Notes from './pages/Notes';
import { SaveStatus } from './components/SaveStatus';

const NAV = [
  { to: '/', label: 'Home', icon: 'M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z' },
  { to: '/board', label: 'Board', icon: 'M4 4h5v16H4zM10 4h5v10h-5zM16 4h4v13h-4z' },
  { to: '/notes', label: 'Notes', icon: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5' },
];

const THEME_LABEL = { auto: 'Auto', light: 'Light', dark: 'Dark' } as const;

function Shell({ path, onLogout }: { path: string; onLogout: () => void }) {
  const ready = useStore((s) => s.ready);
  const pref = useThemePref();
  const section = path === '/' ? '/' : '/' + path.split('/')[1];
  const known = NAV.some((n) => n.to === section);

  return (
    <div className="shell">
      <aside className="side">
        <Link to="/" className="brand">
          <Art slot="icon" className="brand-icon" />
          <span>pulse</span>
        </Link>
        <nav>
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} className={`nav-link${section === n.to ? ' on' : ''}`}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round">
                <path d={n.icon} />
              </svg>
              <span>{n.label}</span>
            </Link>
          ))}
        </nav>
        <div className="side-foot">
          <SaveStatus />
          <button className="chip" onClick={cycleTheme} title="Switch theme">{THEME_LABEL[pref]} theme</button>
          <button className="chip quiet" onClick={onLogout}>Log out</button>
        </div>
      </aside>
      <main className="main">
        {!ready ? (
          <div className="loading"><Art slot="loading" className="loading-art" /><p>Putting the kettle on…</p></div>
        ) : !known ? (
          <div className="empty"><Art slot="notfound" className="empty-art" /><h2>Lost in the fog</h2><p>That page does not exist.</p><Link to="/" className="btn">Back home</Link></div>
        ) : section === '/' ? (
          <Dashboard />
        ) : section === '/board' ? (
          <Board />
        ) : (
          <Notes path={path} />
        )}
      </main>
      <div className="tabbar-save"><SaveStatus compact /></div>
    </div>
  );
}

export default function App() {
  const path = usePath();
  const [authed, setAuthed] = useState<boolean | undefined>();

  useEffect(() => {
    api<{ authed: boolean }>('/me').then((r) => setAuthed(r.authed)).catch(() => setAuthed(false));
  }, []);
  useEffect(() => {
    if (authed) startStore();
  }, [authed]);

  if (authed === undefined) return <div className="loading full"><Art slot="loading" className="loading-art" /></div>;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return <Shell path={path} onLogout={() => api('/logout', { method: 'POST' }).finally(() => location.assign('/'))} />;
}
