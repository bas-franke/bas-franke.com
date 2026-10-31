import { useEffect } from 'react';
import { articleBySlug } from '../articles';
import { Art, coverSlot } from '../components/art';
import { dateOnly, whenPosted } from '../format';
import { navigate, useLocation } from '../router';
import './reading.css';

// One long read from articles.tsx: /article?slug=<slug>.

export default function ArticlePage() {
  const { query } = useLocation();
  const a = articleBySlug(query.get('slug') ?? '');

  useEffect(() => {
    if (a) document.title = `${a.title} · Stonks`;
  }, [a]);

  const home = (
    <span className="eyebrow">
      <a href="/" onClick={(e) => (e.preventDefault(), navigate('/'))}>
        ← Overview
      </a>
    </span>
  );

  if (!a)
    return (
      <div className="stack article-page">
        {home}
        <div className="card">
          <h1>Article not found</h1>
          <p className="soft">This article doesn’t exist (anymore).</p>
        </div>
      </div>
    );

  return (
    <div className="stack article-page">
      {home}
      <article className="card article-sheet">
        <Art slot={coverSlot(a.slug)} className="article-hero" />
        <header className="article-head">
          <h1>{a.title}</h1>
          <div className="row small soft article-meta">
            <span className="chip outline">{a.tag}</span>
            <span title={dateOnly(a.date)}>{whenPosted(a.date)}</span>
            <span>· {a.minutes} min read</span>
          </div>
        </header>
        <div className="article-body">{a.body()}</div>
      </article>
    </div>
  );
}
