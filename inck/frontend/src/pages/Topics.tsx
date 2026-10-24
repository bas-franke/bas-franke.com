import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, readLabel, timeAgo } from '../api';
import Art, { CategoryIcon } from '../components/Art';
import { storyPath } from '../components/StoryCard';
import { CATEGORY_LABEL, CATEGORY_ORDER, type CompactStory, type Site, type TopicSummary } from '../types';

/** The condensed overview: every topic, grouped by category, plus search. */
export default function Topics({ site }: { site: Site | null }) {
  const [topics, setTopics] = useState<TopicSummary[]>();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CompactStory[]>();

  useEffect(() => {
    document.title = `Topics · ${site?.site_name ?? 'inck'}`;
    api<{ topics: TopicSummary[] }>('/api/topics')
      .then((r) => setTopics(r.topics))
      .catch(() => setTopics([]));
    window.scrollTo({ top: 0 });
  }, [site?.site_name]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return setResults(undefined);
    const timer = setTimeout(() => {
      api<{ stories: CompactStory[] }>(`/api/search?q=${encodeURIComponent(term)}`)
        .then((r) => setResults(r.stories))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);

  const live = (topics ?? []).filter((t) => t.stories > 0);
  const upcoming = (topics ?? []).filter((t) => t.stories === 0);

  return (
    <main className="page">
      <header className="page-head">
        <h1>Topics</h1>
        <p className="page-lede">
          Complicated things, explained in stories you can read in a minute. Each topic starts from zero and goes deeper step by step; every
          story also stands on its own.
        </p>
        <label className="search-box">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search stories, e.g. inflation, qubit, ceasefire" aria-label="Search stories" />
        </label>
      </header>

      {results && (
        <section className="results">
          <h2 className="section-label mono">— {results.length ? `${results.length} ${results.length === 1 ? 'story' : 'stories'}` : 'no stories'} matching “{q.trim()}”</h2>
          <ul className="story-list">
            {results.map((r) => (
              <li key={r.slug}>
                <Link to={storyPath(r.slug, r.topic_slug)} className="story-row">
                  <span className="story-row-title">{r.title}</span>
                  <span className="story-row-hook">{r.hook}</span>
                  <span className="story-row-meta mono">
                    {r.topic_name} · {readLabel(r.read_seconds)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!results && topics === undefined && (
        <div className="empty">
          <Art name="loading" className="empty-art" />
        </div>
      )}

      {!results && topics && live.length === 0 && (
        <div className="empty">
          <Art name="empty" className="empty-art" />
          <p className="empty-title">No stories yet.</p>
          <p className="muted">The first ones are being written.</p>
        </div>
      )}

      {!results &&
        CATEGORY_ORDER.map((category) => {
          const group = live.filter((t) => t.category === category);
          if (!group.length) return null;
          return (
            <section key={category} className="topic-group">
              <h2 className="section-label mono">— {CATEGORY_LABEL[category]}</h2>
              <div className="tgrid">
                {group.map((t) => (
                  <Link key={t.id} to={`/t/${t.slug}`} className={`tcard ${t.kind === 'event' ? 'tcard-event' : ''}`}>
                    <div className="tcard-head">
                      <CategoryIcon category={t.category} className="tcard-icon" />
                      {t.kind === 'event' && <span className="chip chip-now chip-tiny">event</span>}
                    </div>
                    <h3 className="tcard-title">{t.name}</h3>
                    <p className="tcard-intro">{t.intro || t.description}</p>
                    {t.latest && (
                      <p className="tcard-latest">
                        <span className="mono">latest</span> {t.latest.title}
                      </p>
                    )}
                    <p className="tcard-meta mono">
                      {t.stories} {t.stories === 1 ? 'story' : 'stories'}
                      {t.updated_at ? ` · ${timeAgo(t.updated_at)}` : ''}
                    </p>
                  </Link>
                ))}
              </div>
            </section>
          );
        })}

      {!results && upcoming.length > 0 && (
        <section className="topic-group">
          <h2 className="section-label mono">— warming up</h2>
          <p className="muted small">Topics that are planned but have no stories yet.</p>
          <div className="chip-row">
            {upcoming.map((t) => (
              <span key={t.id} className="chip">
                <CategoryIcon category={t.category} />
                {t.name}
              </span>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
