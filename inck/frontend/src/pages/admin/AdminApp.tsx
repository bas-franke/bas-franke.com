import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes } from 'react-router-dom';
import { ApiError, api } from '../../api';
import Articles from './Articles';
import Dashboard from './Dashboard';
import Login from './Login';
import Settings from './Settings';
import Topics from './Topics';

type Auth = { state: 'checking' } | { state: 'login'; notice?: string } | { state: 'in'; user: string };

export default function AdminApp() {
  const [auth, setAuth] = useState<Auth>({ state: 'checking' });

  const onLoggedOut = useCallback(() => setAuth({ state: 'login' }), []);

  useEffect(() => {
    api<{ user: string }>('/api/admin/me')
      .then((r) => setAuth({ state: 'in', user: r.user }))
      .catch((err) =>
        setAuth({ state: 'login', notice: err instanceof ApiError && err.status !== 401 ? err.message : undefined }),
      );
  }, []);

  if (auth.state === 'checking') return null;
  if (auth.state === 'login') return <Login notice={auth.notice} onLogin={(user) => setAuth({ state: 'in', user })} />;

  const logout = async () => {
    await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
    onLoggedOut();
  };

  return (
    <div className="admin">
      <aside className="admin-side">
        <Link to="/" className="brand">
          inck<span className="dot">.</span>
        </Link>
        <nav>
          <NavLink to="/admin" end>
            Dashboard
          </NavLink>
          <NavLink to="/admin/articles">Articles</NavLink>
          <NavLink to="/admin/topics">Topics</NavLink>
          <NavLink to="/admin/settings">Settings</NavLink>
        </nav>
        <div className="admin-side-foot">
          <span className="muted small">Signed in as {auth.user}</span>
          <button className="btn btn-ghost" onClick={logout}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="admin-main">
        <Routes>
          <Route path="/admin" element={<Dashboard onLoggedOut={onLoggedOut} />} />
          <Route path="/admin/articles" element={<Articles onLoggedOut={onLoggedOut} />} />
          <Route path="/admin/topics" element={<Topics onLoggedOut={onLoggedOut} />} />
          <Route path="/admin/settings" element={<Settings onLoggedOut={onLoggedOut} />} />
        </Routes>
      </main>
    </div>
  );
}

/** Shared helper: run an admin API call, bouncing to the login page on 401. */
export function useAdminCall(onLoggedOut: () => void) {
  return useCallback(
    async <T,>(call: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await call();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) onLoggedOut();
        throw err;
      }
    },
    [onLoggedOut],
  );
}
