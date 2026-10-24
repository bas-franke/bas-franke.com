import { useEffect, useState } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api';
import AdminApp from './pages/admin/AdminApp';
import ArticlePage from './pages/ArticlePage';
import Home from './pages/Home';
import type { Site } from './types';

export default function App() {
  const [site, setSite] = useState<Site | null>(null);
  const location = useLocation();
  const isAdmin = location.pathname.startsWith('/admin');

  useEffect(() => {
    api<Site>('/api/site')
      .then(setSite)
      .catch(() => {});
  }, [location.pathname]);

  if (isAdmin) return <AdminApp />;

  return (
    <div className="site">
      <header className="topbar">
        <Link to="/" className="brand">
          {site?.site_name ?? 'inck'}
          <span className="dot">.</span>
        </Link>
        <nav className="topbar-nav">
          <Link to="/">Latest</Link>
          <Link to="/admin" className="muted">
            Admin
          </Link>
        </nav>
      </header>

      <Routes>
        <Route path="/" element={<Home site={site} />} />
        <Route path="/a/:slug" element={<ArticlePage />} />
        <Route path="*" element={<Home site={site} />} />
      </Routes>

      <footer className="site-foot">
        <p>
          <strong>{site?.site_name ?? 'inck'}</strong> publishes one AI-written, AI-illustrated article at a time about things worth knowing.
        </p>
        <p className="muted">
          © {new Date().getFullYear()} · <a href="https://bas-franke.com">Bas Franke</a>
        </p>
      </footer>
    </div>
  );
}
