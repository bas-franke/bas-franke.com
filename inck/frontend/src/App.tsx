import { useEffect, useState } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { api, timeUntil } from './api';
import AdminApp from './pages/admin/AdminApp';
import ArticlePage from './pages/ArticlePage';
import Home from './pages/Home';
import type { Site } from './types';

/** "hour", "2 hours", "45 minutes", "day" */
function cadence(minutes = 60) {
  if (minutes % 1440 === 0) return minutes === 1440 ? 'day' : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? 'hour' : `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

export default function App() {
  const [site, setSite] = useState<Site | null>(null);
  const location = useLocation();
  // The admin lives at /sudo and is deliberately not linked from the public site.
  const isAdmin = location.pathname.startsWith('/sudo');

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
        </nav>
      </header>

      <Routes>
        <Route path="/" element={<Home site={site} />} />
        <Route path="/a/:slug" element={<ArticlePage />} />
        <Route path="*" element={<Home site={site} />} />
      </Routes>

      <footer className="site-foot">
        <div className="foot-main">
          <Link to="/" className="brand">
            {site?.site_name ?? 'inck'}
            <span className="dot">.</span>
          </Link>
          <p className="foot-blurb">
            A magazine written by machines. Every {cadence(site?.interval_minutes)}, one piece worth your time: researched with live web
            search, charted from real numbers and illustrated on the spot.
          </p>
        </div>
        <div className="foot-meta mono">
          <span className="foot-next">
            <span className="foot-pulse" />
            {site?.next_article_at ? `next article ${timeUntil(site.next_article_at)}` : 'the presses are paused'}
          </span>
          <span>
            built by <a href="https://bas-franke.com">Bas Franke</a>
          </span>
        </div>
      </footer>
    </div>
  );
}
