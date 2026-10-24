import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api, formatDate, mediaUrl } from '../api';
import ArticleCard from '../components/ArticleCard';
import Markdown from '../components/Markdown';
import type { Article, ArticleCard as Card } from '../types';

export default function ArticlePage() {
  const { slug } = useParams();
  const [article, setArticle] = useState<Article>();
  const [related, setRelated] = useState<Card[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setArticle(undefined);
    setError(undefined);
    window.scrollTo({ top: 0 });
    api<{ article: Article; related: Card[] }>(`/api/articles/${slug}`)
      .then((res) => {
        setArticle(res.article);
        setRelated(res.related);
        document.title = `${res.article.title} · inck`;
      })
      .catch((err) => setError(err instanceof ApiError && err.status === 404 ? 'This article does not exist.' : err.message));
    return () => {
      document.title = 'inck';
    };
  }, [slug]);

  if (error) {
    return (
      <main className="article-page">
        <div className="empty">
          <p className="empty-title">{error}</p>
          <Link to="/" className="btn">
            Back to the front page
          </Link>
        </div>
      </main>
    );
  }
  if (!article) return <main className="article-page" aria-busy="true" />;

  const img = mediaUrl(article.hero_image);

  return (
    <main className="article-page">
      <article>
        <header className="article-head">
          <p className="card-meta">
            {article.topic_name && (
              <Link to={`/?topic=${article.topic_id}`} className="topic">
                {article.topic_name}
              </Link>
            )}
            <span>{formatDate(article.published_at)}</span>
            <span>{article.read_minutes} min read</span>
          </p>
          <h1 className="article-title">{article.title}</h1>
          <p className="article-dek">{article.dek}</p>
        </header>

        {img && (
          <figure className="article-hero">
            <img src={img} alt={article.hero_alt ?? ''} />
          </figure>
        )}

        <Markdown markdown={article.body_md} charts={article.charts} images={article.images} />

        <footer className="article-foot">
          {article.tags.length > 0 && (
            <p className="tags">
              {article.tags.map((t) => (
                <Link key={t} to={`/?q=${encodeURIComponent(t)}`} className="tag">
                  #{t}
                </Link>
              ))}
            </p>
          )}
          {article.sources.length > 0 && (
            <div className="sources">
              <h3>Sources</h3>
              <ol>
                {article.sources.map((s, i) => (
                  <li key={i}>
                    <a href={s.url} target="_blank" rel="noreferrer noopener">
                      {s.title || s.url}
                    </a>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <p className="disclosure">
            Written and illustrated by AI{article.model ? ` (${article.model})` : ''}, published automatically. Facts are checked
            against sources where possible, but treat numbers as a starting point, not a citation.
          </p>
        </footer>
      </article>

      {related.length > 0 && (
        <aside className="related">
          <h2 className="section-title">Keep reading</h2>
          <div className="grid">
            {related.map((a) => (
              <ArticleCard key={a.id} article={a} />
            ))}
          </div>
        </aside>
      )}
    </main>
  );
}
