import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, timeUntil } from '../api';
import Art, { artSlug } from '../components/Art';
import ArticleCard from '../components/ArticleCard';
import type { ArticleCard as Card, Site } from '../types';

const PAGE_SIZE = 12;

export default function Home({ site }: { site: Site | null }) {
  const [params, setParams] = useSearchParams();
  const topic = params.get('topic');
  const q = params.get('q') ?? '';
  const [articles, setArticles] = useState<Card[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [, tick] = useState(0);

  useEffect(() => {
    setPage(1);
    setArticles([]);
  }, [topic, q]);

  useEffect(() => {
    const clock = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(clock);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const query = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (topic) query.set('topic', topic);
    if (q) query.set('q', q);
    api<{ articles: Card[]; total: number }>(`/api/articles?${query}`)
      .then((res) => {
        if (cancelled) return;
        setArticles((prev) => (page === 1 ? res.articles : [...prev, ...res.articles]));
        setTotal(res.total);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [page, topic, q]);

  const filtered = Boolean(topic || q);
  const featured = filtered ? undefined : articles[0];
  const rest = filtered ? articles : articles.slice(1);
  const topicName = site?.topics.find((t) => String(t.id) === topic)?.name;
  const published = site?.topics.reduce((n, t) => n + t.articles, 0) ?? 0;
  const nowCount = site?.topics.find((t) => t.name === 'Right now')?.articles ?? 0;

  return (
    <main className="home">
      {!filtered && (
        <header className="masthead">
          <div className="masthead-row">
            <h1 className="masthead-title">
              {site?.site_name ?? 'inck'}
              <span className="dot">.</span>
            </h1>
            <Art name="masthead" className="masthead-art" />
          </div>
          <p className="masthead-tagline">{site?.tagline}</p>
          <p className="ticker mono">
            <span className="now-dot" />
            {site?.next_article_at ? `next article ${timeUntil(site.next_article_at)}` : 'presses paused'}
            <span className="ticker-sep">·</span>
            {published} {published === 1 ? 'story' : 'stories'}
            {nowCount > 0 && (
              <>
                <span className="ticker-sep">·</span>
                {nowCount} right now
              </>
            )}
          </p>
        </header>
      )}

      <nav className="topics" aria-label="Topics">
        <button className={`pill ${!topic ? 'pill-active' : ''}`} onClick={() => setParams(q ? { q } : {})}>
          All
        </button>
        {site?.topics
          .filter((t) => t.articles > 0 || String(t.id) === topic)
          .map((t) => {
            const now = t.name === 'Right now';
            return (
              <button
                key={t.id}
                className={`pill ${String(t.id) === topic ? 'pill-active' : ''} ${now ? 'pill-now' : ''}`}
                onClick={() => setParams({ ...(q ? { q } : {}), topic: String(t.id) })}
              >
                {now ? <span className="now-dot" /> : <Art name={`topic-${artSlug(t.name)}`} fallback="topic-default" className="topic-icon" />}
                {t.name} <span className="pill-count">{t.articles}</span>
              </button>
            );
          })}
      </nav>

      {filtered && (
        <p className="results-line">
          {total} {total === 1 ? 'story' : 'stories'}
          {topicName && (
            <>
              {' '}
              in <strong>{topicName}</strong>
            </>
          )}
          {q && (
            <>
              {' '}
              matching <strong>“{q}”</strong>
            </>
          )}
          <button className="btn btn-small" onClick={() => setParams({})}>
            Clear
          </button>
        </p>
      )}

      {loading && articles.length === 0 && (
        <div className="empty">
          <Art name="loading" className="empty-art" />
          <p className="empty-title">Setting the type…</p>
        </div>
      )}

      {!loading && articles.length === 0 && (
        <div className="empty">
          <Art name="empty" className="empty-art" />
          <p className="empty-title">Nothing here yet.</p>
          <p>{filtered ? 'Try another topic or search.' : 'The first article is being written. Check back in a bit.'}</p>
        </div>
      )}

      {featured && <ArticleCard article={featured} featured index={1} />}

      {rest.length > 0 && !filtered && <h2 className="section-label mono">— more stories</h2>}

      <section className="grid">
        {rest.map((a, i) => (
          <ArticleCard key={a.id} article={a} index={i + (filtered ? 1 : 2)} wide={!filtered && i % 5 === 2} />
        ))}
      </section>

      {articles.length < total && (
        <div className="more">
          <button className="btn" onClick={() => setPage((p) => p + 1)} disabled={loading}>
            {loading ? 'Loading…' : 'More stories'}
          </button>
        </div>
      )}
    </main>
  );
}
