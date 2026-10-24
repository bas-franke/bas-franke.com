import { useEffect, useState, type FormEvent } from 'react';
import { Link, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, timeUntil } from './api';
import Art from './components/Art';
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
      <Topbar siteName={site?.site_name ?? 'inck'} />

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
          <Art name="footer" className="foot-art" />
        </div>
        <div className="foot-meta mono">
          <span className="foot-next">
            <span className="now-dot" />
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

function Topbar({ siteName }: { siteName: string }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(params.get('q') ?? '');

  useEffect(() => {
    setQ(params.get('q') ?? '');
    setOpen(Boolean(params.get('q')) && location.pathname === '/');
  }, [params, location.pathname]);

  function submit(e: FormEvent) {
    e.preventDefault();
    navigate(q.trim() ? `/?q=${encodeURIComponent(q.trim())}` : '/');
  }

  return (
    <header className={`topbar ${open ? 'topbar-search-open' : ''}`}>
      <div className="topbar-row">
        <Link to="/" className="brand">
          {siteName}
          <span className="dot">.</span>
        </Link>
        <nav className="topbar-nav">
          <Link to="/">Latest</Link>
          <button className="icon-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? 'Close search' : 'Search'}>
            {open ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
            )}
          </button>
        </nav>
      </div>
      {open && (
        <form className="search" onSubmit={submit}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search stories" aria-label="Search" autoFocus />
          <button className="btn btn-primary btn-small" type="submit">
            Search
          </button>
        </form>
      )}
    </header>
  );
}
