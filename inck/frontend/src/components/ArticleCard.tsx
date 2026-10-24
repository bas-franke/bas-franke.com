import { Link } from 'react-router-dom';
import { formatDate, mediaUrl } from '../api';
import type { ArticleCard as Card } from '../types';
import Art, { artSlug } from './Art';

export default function ArticleCard({
  article,
  featured = false,
  wide = false,
  index,
}: {
  article: Card;
  featured?: boolean;
  wide?: boolean;
  index?: number;
}) {
  const img = mediaUrl(article.hero_image);
  const trending = article.kind === 'trending';
  const topicName = trending ? 'Right now' : article.topic_name;
  return (
    <Link to={`/a/${article.slug}`} className={`card ${featured ? 'card-featured' : ''} ${wide ? 'card-wide' : ''} ${trending ? 'card-now' : ''}`}>
      <div className="card-media">
        {img ? <img src={img} alt={article.hero_alt ?? ''} loading={featured ? 'eager' : 'lazy'} /> : <div className="card-placeholder" aria-hidden="true" />}
        {index !== undefined && <span className="card-no mono">№ {String(index).padStart(2, '0')}</span>}
      </div>
      <div className="card-body">
        <p className="card-meta">
          {topicName && (
            <span className={`topic ${trending ? 'topic-now' : ''}`}>
              {trending ? <span className="now-dot" /> : <Art name={`topic-${artSlug(topicName)}`} fallback="topic-default" className="topic-icon" />}
              {topicName}
            </span>
          )}
          <span>{formatDate(article.published_at)}</span>
          <span>{article.read_minutes} min</span>
        </p>
        <h2 className="card-title">{article.title}</h2>
        <p className="card-dek">{trending && article.why_now ? article.why_now : article.dek}</p>
        {featured && <span className="card-cta mono">Read the story →</span>}
      </div>
    </Link>
  );
}
