import { useCallback, useEffect, useState } from 'react';
import Art from './Art';
import Login from './Login';
import { UnauthorizedContext, usePoll } from './api';
import { Link, useLocation } from './router';
import { StateCard } from './ui';
import Overview from './pages/Overview';
import Project from './pages/Project';
import type { Report } from './types';

type Auth = { state: 'checking' } | { state: 'login' } | { state: 'in'; user: string | null };

export default function App() {
  const [auth, setAuth] = useState<Auth>({ state: 'checking' });
  const loggedOut = useCallback(() => setAuth({ state: 'login' }), []);

  useEffect(() => {
    fetch('/api/me')
      .then(async (res) => {
        if (res.status === 401) return setAuth({ state: 'login' });
        const body = await res.json();
        setAuth({ state: 'in', user: body.user ?? null });
      })
      // Backend unreachable: show the dashboard, which explains the error.
      .catch(() => setAuth({ state: 'in', user: null }));
  }, []);

  if (auth.state === 'checking') return null;
  if (auth.state === 'login') return <Login onLogin={(user) => setAuth({ state: 'in', user })} />;
  return (
    <UnauthorizedContext.Provider value={loggedOut}>
      <Dashboard user={auth.user} onLoggedOut={loggedOut} />
    </UnauthorizedContext.Provider>
  );
}

function Dashboard({ user, onLoggedOut }: { user: string | null; onLoggedOut: () => void }) {
  const { route, days } = useLocation();
  // Health checks are shared by every page (overview strip, project header badge, health tab).
  const status = usePoll<Report>('/api/status', 'status API');

  useEffect(() => {
    if (route.page === 'missing') document.title = 'Not found · Status';
  }, [route.page]);

  async function logout() {
    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    onLoggedOut();
  }

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <nav className="topbar" aria-label="Main">
        <Link to="/" className="brand" aria-label="status.bas-franke.com, all projects">
          <Art name="mascot" className="brand-mascot" />
          <span className="mono">
            <span className="accent">status</span>.bas-franke.com
          </span>
        </Link>
        <div className="actions">
          {user && (
            <button type="button" className="btn btn-ghost" onClick={logout} title={`Signed in as ${user}`}>
              Sign out
            </button>
          )}
        </div>
      </nav>

      <main className="page" id="main">
        {route.page === 'overview' && <Overview status={status} days={days} />}
        {route.page === 'project' && <Project key={route.site} site={route.site} tab={route.tab} status={status} days={days} />}
        {route.page === 'missing' && (
          <StateCard art="state-warn" title="There's nothing at this address">
            <p className="muted">
              <Link to="/">Back to all projects</Link>
            </p>
          </StateCard>
        )}
      </main>

      <footer className="footer">
        <Art name="footer-cat" className="footer-cat" />
        <p className="mono muted">checks run every 60s · 200 OK is a lifestyle</p>
      </footer>
    </div>
  );
}
