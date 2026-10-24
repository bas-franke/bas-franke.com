import { useState } from 'react';
import { Link } from 'react-router-dom';
import { countryName, mediaUrl, readLabel, timeAgo } from '../api';
import type { Story } from '../types';
import { CategoryIcon, Flame } from './Art';
import Markdown from './Markdown';

/** A link into a story's topic path: the reader dives into that subject and keeps scrolling along its curriculum. */
export const storyPath = (slug: string, topicSlug?: string | null) => (topicSlug ? `/s/${slug}?t=${encodeURIComponent(topicSlug)}` : `/s/${slug}`);

export default function StoryCard({ story, index, active, topicMode }: { story: Story; index: number; active: boolean; topicMode: boolean }) {
  const [copied, setCopied] = useState(false);
  const [image, second] = story.images;
  const eager = index < 2;

  async function share() {
    const url = `${location.origin}/s/${story.slug}`;
    try {
      if (navigator.share) return await navigator.share({ title: story.title, text: story.hook, url });
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Cancelled share sheet or clipboard blocked: nothing to do.
    }
  }

  return (
    <article className={`story ${active ? 'is-active' : ''}`} data-index={index} data-slug={story.slug} aria-current={active ? 'true' : undefined}>
      <div className="story-inner">
        <header className="story-head">
          <Link to={`/t/${story.topic.slug}`} className="chip chip-topic">
            <CategoryIcon category={story.topic.category} />
            {story.topic.name}
          </Link>
          {story.section_name && <span className="chip chip-section">{story.section_name}</span>}
          {story.topic.country && (
            <span className="chip chip-section" title="National news, shown in the feed to readers in this country">
              {countryName(story.topic.country)}
            </span>
          )}
          {story.topic.heat >= 3 && (
            <span className={`chip chip-hot heat-${story.topic.heat}`} title={story.topic.heat_reason}>
              <Flame />
              trending
            </span>
          )}
          {story.kind === 'trending' && (
            <span className="chip chip-now">
              <span className="now-dot" />
              Right now
            </span>
          )}
        </header>

        {image && (
          <figure className="story-figure">
            <img src={mediaUrl(image.file) ?? ''} alt={image.alt} loading={eager ? 'eager' : 'lazy'} decoding="async" />
            {image.caption && <figcaption>{image.caption}</figcaption>}
          </figure>
        )}

        <h1 className="story-title">{story.title}</h1>
        <p className="story-hook">{story.hook}</p>
        {story.why_now && (
          <p className="story-why">
            <span className="now-dot" />
            {story.why_now}
          </p>
        )}

        <Markdown markdown={story.body_md} className="prose story-body" />

        {second && (
          <figure className="story-figure story-figure-second">
            <img src={mediaUrl(second.file) ?? ''} alt={second.alt} loading="lazy" decoding="async" />
            {second.caption && <figcaption>{second.caption}</figcaption>}
          </figure>
        )}

        {story.takeaway && (
          <p className="story-takeaway">
            <span className="takeaway-label mono">takeaway</span>
            {story.takeaway}
          </p>
        )}

        <footer className="story-foot">
          {story.related.length > 0 && (
            <div className="deeper">
              <span className="deeper-label mono">go deeper</span>
              <div className="deeper-row">
                {story.related.map((r) => (
                  <Link key={r.slug} to={storyPath(r.slug, r.topic_slug)} className={`deeper-link ${r.same_topic ? 'deeper-same' : ''}`}>
                    <span className="deeper-title">{r.title}</span>
                    <small>{r.same_topic ? `${story.topic.name} · ${readLabel(r.read_seconds)}` : r.topic_name}</small>
                  </Link>
                ))}
              </div>
            </div>
          )}
          <div className="story-meta mono">
            <span>{readLabel(story.read_seconds)} read</span>
            <span className="sep">·</span>
            <span title={new Date(story.published_at).toLocaleString()}>{timeAgo(story.published_at)}</span>
            {topicMode && (
              <>
                <span className="sep">·</span>
                <span>
                  {story.position + 1}/{story.topic.stories} in topic
                </span>
              </>
            )}
            <span className="grow" />
            {story.sources.length > 0 && (
              <details className="sources">
                <summary>sources</summary>
                <ol>
                  {story.sources.map((s, i) => (
                    <li key={i}>
                      <a href={s.url} target="_blank" rel="noreferrer noopener">
                        {s.title || s.url}
                      </a>
                    </li>
                  ))}
                </ol>
              </details>
            )}
            <button className="link-btn" onClick={share} type="button">
              {copied ? 'link copied' : 'share'}
            </button>
          </div>
        </footer>
      </div>
    </article>
  );
}
