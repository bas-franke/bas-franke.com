import { Link } from 'react-router-dom';
import { formatDate, mediaUrl } from '../api';
import type { ArticleCard as Card } from '../types';

export default function ArticleCard({ article, featured = false }: { article: Card; featured?: boolean }) {
  const img = mediaUrl(article.hero_image);
  return (
    <Link to={`/a/${article.slug}`} className={`card ${featured ? 'card-featured' : ''}`}>
      <div className="card-media">
        {img ? <img src={img} alt={article.hero_alt ?? ''} loading={featured ? 'eager' : 'lazy'} /> : <div className="card-placeholder" aria-hidden="true" />}
      </div>
      <div className="card-body">
        <p className="card-meta">
          {article.kind === 'trending' ? (
            <span className="topic topic-now">
              <span className="now-dot" />
              Right now
            </span>
          ) : (
            article.topic_name && <span className="topic">{article.topic_name}</span>
          )}
          <span>{formatDate(article.published_at)}</span>
          <span>{article.read_minutes} min read</span>
        </p>
        <h2 className="card-title">{article.title}</h2>
        <p className="card-dek">{article.dek}</p>
      </div>
    </Link>
  );
}
