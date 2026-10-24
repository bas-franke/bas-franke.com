import { useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api';
import { Flame } from './components/Art';
import { storyPath } from './components/StoryCard';
import AdminApp from './pages/admin/AdminApp';
import Feed from './pages/Feed';
import TopicHub from './pages/TopicHub';
import Topics from './pages/Topics';
import type { Site } from './types';

export default function App() {
  const [site, setSite] = useState<Site | null>(null);
  const location = useLocation();
  // The admin lives at /sudo and is deliberately not linked from the public site.
  const isAdmin = location.pathname.startsWith('/sudo');
  const inFeed = location.pathname === '/' || location.pathname.startsWith('/s/');

  useEffect(() => {
    api<Site>('/api/site')
      .then(setSite)
      .catch(() => {});
    const refresh = setInterval(() => api<Site>('/api/site').then(setSite).catch(() => {}), 120_000);
    return () => clearInterval(refresh);
  }, []);

  useEffect(() => {
    document.body.classList.toggle('in-feed', inFeed && !isAdmin);
    return () => document.body.classList.remove('in-feed');
  }, [inFeed, isAdmin]);

  if (isAdmin) return <AdminApp />;

  const name = site?.site_name ?? 'inck';
  return (
    <div className={`site ${inFeed ? 'site-feed' : 'site-page'}`}>
      <nav className="nav" aria-label="Main">
        <Link to="/" className="brand">
          {name}
          <span className="dot">.</span>
        </Link>
        <div className="nav-links">
          <NavLink to="/" end className={({ isActive }) => (isActive || location.pathname.startsWith('/s/') ? 'active' : '')}>
            Latest
          </NavLink>
          <NavLink to="/topics" className={({ isActive }) => (isActive || location.pathname.startsWith('/t/') ? 'active' : '')}>
            Topics
          </NavLink>
        </div>
        <p className="nav-blurb">{site?.tagline ?? 'Big ideas, one short story at a time.'}</p>
        {site && site.trending.length > 0 && (
          <div className="nav-trending">
            <span className="rail-label mono">trending now</span>
            {site.trending.slice(0, 6).map((t) => (
              <Link key={t.slug} to={t.latest_slug ? storyPath(t.latest_slug, t.slug) : `/t/${t.slug}`} className="nav-trend" title={t.heat_reason}>
                <Flame className={`flame heat-${t.heat}`} />
                <span>{t.name}</span>
              </Link>
            ))}
          </div>
        )}
        <p className="nav-foot mono">
          {site ? `${site.stories} stories · ${site.topics} topics` : ''}
          <br />
          <a href="https://bas-franke.com">by Bas Franke</a>
          <br />
          <a href="https://db-ip.com">IP geolocation by DB-IP</a>
        </p>
      </nav>

      <Routes>
        <Route path="/" element={<Feed site={site} />} />
        <Route path="/s/:slug" element={<Feed site={site} />} />
        <Route path="/topics" element={<Topics site={site} />} />
        <Route path="/t/:slug" element={<TopicHub />} />
        <Route path="*" element={<Feed site={site} />} />
      </Routes>
    </div>
  );
}
