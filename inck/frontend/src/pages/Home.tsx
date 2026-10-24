import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
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
  const [search, setSearch] = useState(q);

  useEffect(() => {
    setPage(1);
    setArticles([]);
  }, [topic, q]);

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

  const [featured, ...rest] = articles;
  const filtered = Boolean(topic || q);
  const topicName = site?.topics.find((t) => String(t.id) === topic)?.name;

  return (
    <main className="home">
      {!filtered && (
        <header className="masthead">
          <h1 className="masthead-title">
            {site?.site_name ?? 'inck'}
            <span className="dot">.</span>
          </h1>
          <p className="masthead-tagline">{site?.tagline}</p>
        </header>
      )}

      <nav className="topics">
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            const next = new URLSearchParams(params);
            search.trim() ? next.set('q', search.trim()) : next.delete('q');
            setParams(next);
          }}
        >
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search articles" aria-label="Search" />
        </form>
        <button className={`pill ${!topic ? 'pill-active' : ''}`} onClick={() => setParams(q ? { q } : {})}>
          All
        </button>
        {site?.topics
          .filter((t) => t.articles > 0 || String(t.id) === topic)
          .map((t) => (
            <button
              key={t.id}
              className={`pill ${String(t.id) === topic ? 'pill-active' : ''}`}
              onClick={() => setParams({ ...(q ? { q } : {}), topic: String(t.id) })}
            >
              {t.name} <span className="pill-count">{t.articles}</span>
            </button>
          ))}
      </nav>

      {filtered && (
        <p className="results-line">
          {total} {total === 1 ? 'article' : 'articles'}
          {topicName && <> in <strong>{topicName}</strong></>}
          {q && <> matching <strong>“{q}”</strong></>}
        </p>
      )}

      {!loading && articles.length === 0 && (
        <div className="empty">
          <p className="empty-title">Nothing here yet.</p>
          <p>{filtered ? 'Try another topic or search.' : 'The first article is being written. Check back in a bit.'}</p>
        </div>
      )}

      {featured && !filtered && <ArticleCard article={featured} featured />}

      <section className="grid">
        {(filtered ? articles : rest).map((a) => (
          <ArticleCard key={a.id} article={a} />
        ))}
      </section>

      {articles.length < total && (
        <div className="more">
          <button className="btn" onClick={() => setPage((p) => p + 1)} disabled={loading}>
            {loading ? 'Loading…' : 'More articles'}
          </button>
        </div>
      )}
    </main>
  );
}
