import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api, mediaUrl, readLabel, timeAgo } from '../api';
import Art, { CategoryIcon, Flame, HeatMeter } from '../components/Art';
import { storyPath } from '../components/StoryCard';
import { CATEGORY_LABEL, type Hub, type HubStory } from '../types';

/** A topic's main page: intro, then every story organised by curriculum section, with what is still to come. */
export default function TopicHub() {
  const { slug } = useParams();
  const [hub, setHub] = useState<Hub>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    setHub(undefined);
    setError(undefined);
    window.scrollTo({ top: 0 });
    api<Hub>(`/api/topics/${slug}`)
      .then((h) => {
        setHub(h);
        document.title = `${h.topic.name} · inck`;
      })
      .catch((err) => setError(err instanceof ApiError && err.status === 404 ? 'This topic does not exist.' : err.message));
  }, [slug]);

  if (error) {
    return (
      <main className="page">
        <div className="empty">
          <Art name="notfound" className="empty-art" />
          <p className="empty-title">{error}</p>
          <Link to="/topics" className="btn">
            All topics
          </Link>
        </div>
      </main>
    );
  }
  if (!hub) return <main className="page" aria-busy="true" />;

  const { topic, sections, stories } = hub;
  const byPath = [...stories];
  const first = byPath[0];
  const latest = [...stories].sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
  const planned = sections.reduce((n, s) => n + s.planned.length, 0);
  const written = stories.filter((s) => s.kind === 'planned').length;

  return (
    <main className="page hub">
      <header className="hub-head">
        <p className="crumbs mono">
          <Link to="/topics">Topics</Link> / {CATEGORY_LABEL[topic.category]}
        </p>
        <div className="hub-title-row">
          <CategoryIcon category={topic.category} className="hub-icon" />
          <h1>{topic.name}</h1>
          {topic.kind === 'event' && (
            <span className="chip chip-now">
              <span className="now-dot" />
              world event
            </span>
          )}
        </div>
        {topic.heat > 0 && (
          <p className={`hot-banner heat-${topic.heat}`}>
            <Flame />
            <span>
              <strong>Trending now</strong> <HeatMeter heat={topic.heat} /> {topic.heat_reason}
            </span>
          </p>
        )}
        <p className="hub-intro">{topic.intro}</p>
        <div className="hub-actions">
          {first && (
            <Link to={storyPath(first.slug, topic.slug)} className="btn btn-primary">
              Start from the beginning
            </Link>
          )}
          {latest && latest.slug !== first?.slug && (
            <Link to={storyPath(latest.slug, topic.slug)} className="btn">
              Newest in this topic
            </Link>
          )}
          <span className="hub-stats mono muted">
            {stories.length} {stories.length === 1 ? 'story' : 'stories'}
            {planned ? ` · ${written}/${planned} of the plan written` : ''}
          </span>
        </div>
      </header>

      {stories.length === 0 && (
        <div className="empty">
          <Art name="empty" className="empty-art" />
          <p className="empty-title">No stories yet.</p>
          <p className="muted">The first stories for this topic are being written.</p>
        </div>
      )}

      {sections.map((section) => {
        const own = stories.filter((s) => s.section_index === section.index);
        const coming = section.planned.filter((_, i) => !own.some((s) => s.kind === 'planned' && s.plan_index === i));
        if (!own.length && (!coming.length || section.live)) return null;
        return (
          <section key={section.index} className="hub-section">
            <header className="hub-section-head">
              <h2>
                {section.live && <span className="now-dot" />}
                {section.name}
              </h2>
              {section.blurb && <p className="muted">{section.blurb}</p>}
            </header>
            {own.length > 0 && (
              <ol className="story-list">
                {own.map((s) => (
                  <li key={s.slug}>
                    <StoryRow story={s} topicSlug={topic.slug} />
                  </li>
                ))}
              </ol>
            )}
            {coming.length > 0 && (
              <details className="coming">
                <summary className="mono">
                  {coming.length} more {coming.length === 1 ? 'story' : 'stories'} planned
                </summary>
                <ul>
                  {coming.map((title) => (
                    <li key={title}>{title}</li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        );
      })}
    </main>
  );
}

function StoryRow({ story, topicSlug }: { story: HubStory; topicSlug: string }) {
  const img = mediaUrl(story.image);
  return (
    <Link to={storyPath(story.slug, topicSlug)} className={`story-row ${img ? 'story-row-img' : ''}`}>
      {img && <img src={img} alt="" loading="lazy" className="story-row-thumb" />}
      <span className="story-row-title">
        {story.kind === 'trending' && <span className="now-dot" />}
        {story.title}
      </span>
      <span className="story-row-hook">{story.hook}</span>
      <span className="story-row-meta mono">
        {readLabel(story.read_seconds)} · {timeAgo(story.published_at)}
      </span>
    </Link>
  );
}
