import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, api, timeUntil } from '../api';
import Art, { CategoryIcon, Flame } from '../components/Art';
import StoryCard, { storyPath } from '../components/StoryCard';
import { useSwipePager } from '../swipe';
import type { FeedPage, Site, Story } from '../types';

type State = 'loading' | 'ready' | 'empty' | 'error';

/**
 * The feed: one story per screen, scroll-snapped. Latest mode (default) runs newest to oldest across all topics;
 * topic mode (?t=slug) follows one topic's curriculum. The URL always names the story on screen.
 */
export default function Feed({ site }: { site: Site | null }) {
  const { slug } = useParams();
  const [params] = useSearchParams();
  const topicSlug = params.get('t');
  const navigate = useNavigate();

  const scroller = useRef<HTMLDivElement>(null);
  const [stories, setStories] = useState<Story[]>([]);
  const [page, setPage] = useState<Pick<FeedPage, 'has_more' | 'has_before' | 'topic'>>({ has_more: false, has_before: false, topic: null });
  const [state, setState] = useState<State>('loading');
  const [error, setError] = useState<string>();
  const [active, setActive] = useState(0);
  const [, tick] = useState(0);

  // The URL we set ourselves while scrolling must not reload the feed.
  const selfKey = useRef<string | null>(null);
  const loadingMore = useRef(false);
  const viewed = useRef(new Set<number>());
  const routeKey = `${topicSlug ?? ''}|${slug ?? ''}`;

  useEffect(() => {
    if (routeKey === selfKey.current) return;
    selfKey.current = null;
    let cancelled = false;
    setState('loading');
    setError(undefined);
    setStories([]);
    setActive(0);
    const q = new URLSearchParams();
    if (slug) q.set('from', slug);
    if (topicSlug) q.set('t', topicSlug);
    api<FeedPage>(`/api/feed?${q}`)
      .then((res) => {
        if (cancelled) return;
        setStories(res.stories);
        setPage({ has_more: res.has_more, has_before: res.has_before, topic: res.topic });
        setState(res.stories.length ? 'ready' : 'empty');
        scroller.current?.scrollTo({ top: 0 });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError && err.status === 404 ? 'This story does not exist (or is not part of this topic).' : err.message);
        setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [routeKey, slug, topicSlug]);

  const loadMore = useCallback(async () => {
    if (loadingMore.current || !page.has_more || !stories.length) return;
    loadingMore.current = true;
    try {
      const q = new URLSearchParams({ after: stories[stories.length - 1].slug });
      if (topicSlug) q.set('t', topicSlug);
      const res = await api<FeedPage>(`/api/feed?${q}`);
      setStories((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        return [...prev, ...res.stories.filter((s) => !seen.has(s.id))];
      });
      setPage((p) => ({ ...p, has_more: res.has_more }));
    } catch {
      // Try again on the next scroll.
    } finally {
      loadingMore.current = false;
    }
  }, [page.has_more, stories, topicSlug]);

  // Fetch the next page a few stories before the end.
  useEffect(() => {
    if (state === 'ready' && page.has_more && active >= stories.length - 3) loadMore();
  }, [active, stories.length, page.has_more, state, loadMore]);

  // Which card is on screen: the one covering the point 40% down the viewport. (An intersection ratio would fail
  // for stories taller than a phone screen, which never reach a high ratio.)
  useEffect(() => {
    const root = scroller.current;
    if (!root || state !== 'ready') return;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      pending = undefined;
      const probe = root.getBoundingClientRect().top + root.clientHeight * 0.4;
      let best = 0;
      let bestDistance = Infinity;
      root.querySelectorAll<HTMLElement>('.story').forEach((el) => {
        const r = el.getBoundingClientRect();
        const distance = r.top <= probe && r.bottom > probe ? 0 : Math.min(Math.abs(r.top - probe), Math.abs(r.bottom - probe));
        if (distance < bestDistance) {
          bestDistance = distance;
          best = Number(el.dataset.index);
        }
      });
      setActive(best);
    };
    const onScroll = () => {
      pending ??= setTimeout(update, 80);
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    update();
    return () => {
      root.removeEventListener('scroll', onScroll);
      clearTimeout(pending);
    };
  }, [stories, state]);

  useSwipePager(scroller, state === 'ready');

  // Keep the URL and title on the story being read, and count a view after a short dwell.
  const current = stories[active];
  useEffect(() => {
    if (!current) return;
    const key = `${topicSlug ?? ''}|${current.slug}`;
    if (key !== routeKey) {
      selfKey.current = key;
      navigate(storyPath(current.slug, topicSlug), { replace: true });
    }
    document.title = `${current.title} · ${site?.site_name ?? 'inck'}`;
    const timer = setTimeout(() => {
      if (viewed.current.has(current.id)) return;
      viewed.current.add(current.id);
      fetch(`/api/stories/${current.id}/view`, { method: 'POST', keepalive: true }).catch(() => {});
    }, 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  useEffect(() => {
    return () => {
      document.title = site?.site_name ?? 'inck';
    };
  }, [site?.site_name]);

  useEffect(() => {
    const clock = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(clock);
  }, []);

  // Where a keyboard jump is heading: a second press during the smooth scroll moves on from there, not from the story
  // that is still marked active.
  const jumpTarget = useRef<number | null>(null);
  const jumpTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(jumpTimer.current), []);

  const go = useCallback(
    (delta: number) => {
      const root = scroller.current;
      if (!root) return;
      const cards = root.querySelectorAll<HTMLElement>('.story, .feed-end');
      const next = Math.min(cards.length - 1, Math.max(0, (jumpTarget.current ?? active) + delta));
      jumpTarget.current = next;
      clearTimeout(jumpTimer.current);
      jumpTimer.current = setTimeout(() => (jumpTarget.current = null), 900);
      cards[next]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    [active],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (['ArrowDown', 'PageDown', 'j', ' '].includes(e.key)) e.preventDefault(), go(1);
      else if (['ArrowUp', 'PageUp', 'k'].includes(e.key)) e.preventDefault(), go(-1);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [go]);

  const topic = page.topic;
  const first = stories[0];
  const trending = !topic && site?.trending.length ? site.trending : [];

  return (
    <div className={`feed-shell ${topic ? 'feed-topic-mode' : ''} ${trending.length ? 'feed-has-strip' : ''} ${page.has_before && first ? 'feed-has-before' : ''}`}>
      {trending.length > 0 && (
        <div className="trend-strip" aria-label="Trending now">
          <span className="trend-label mono">
            <Flame /> trending
          </span>
          {trending.map((t) => (
            <Link key={t.slug} to={t.latest_slug ? storyPath(t.latest_slug, t.slug) : `/t/${t.slug}`} className={`trend-chip heat-${t.heat}`} title={t.heat_reason}>
              {t.name}
            </Link>
          ))}
        </div>
      )}
      {topic && (
        <div className="mode-bar">
          <CategoryIcon category={topic.category} />
          <span className="mode-label">
            Following <Link to={`/t/${topic.slug}`}>{topic.name}</Link>
            {current && (
              <span className="mode-pos mono">
                {' '}
                {current.position + 1}/{current.topic.stories}
              </span>
            )}
          </span>
          <Link to={current ? `/s/${current.slug}` : '/'} className="mode-exit">
            All stories
          </Link>
        </div>
      )}

      {page.has_before && first && (
        <Link to={topic ? `/s/${first.slug}?t=${topic.slug}` : '/'} className={`before-pill ${active > 0 ? 'is-hidden' : ''}`} onClick={() => (selfKey.current = null)}>
          ↑ {topic ? 'start of this topic' : 'newer stories'}
        </Link>
      )}

      <div className="feed" ref={scroller}>
        {state === 'loading' && (
          <div className="feed-state">
            <Art name="loading" className="empty-art" />
            <p className="empty-title">Setting the type…</p>
          </div>
        )}
        {state === 'error' && (
          <div className="feed-state">
            <Art name="notfound" className="empty-art" />
            <p className="empty-title">{error}</p>
            <Link to="/" className="btn">
              Latest stories
            </Link>
          </div>
        )}
        {state === 'empty' && (
          <div className="feed-state">
            <Art name="empty" className="empty-art" />
            <p className="empty-title">Nothing here yet.</p>
            <p className="muted">
              {topic ? 'This topic has no stories yet.' : 'The first story is being written. Check back in a few minutes.'}
            </p>
            <Link to="/topics" className="btn">
              Browse topics
            </Link>
          </div>
        )}

        {stories.map((s, i) => (
          <StoryCard key={s.id} story={s} index={i} active={i === active} topicMode={Boolean(topic)} />
        ))}

        {state === 'ready' && page.has_more && (
          <div className="feed-loading mono" aria-live="polite">
            <span className="spinner" /> loading more
          </div>
        )}
        {state === 'ready' && !page.has_more && (
          <div className="feed-end">
            <div className="feed-end-inner">
              <Art name="footer" className="feed-end-art" />
              <h2>{topic ? `That is every story in ${topic.name} so far.` : 'You are all caught up.'}</h2>
              <p className="muted">
                {site?.next_story_at
                  ? `A new story is written every ${site.interval_minutes} minutes; the next one lands ${timeUntil(site.next_story_at)}.`
                  : 'New stories arrive throughout the day.'}
              </p>
              <div className="feed-end-actions">
                {topic && current ? (
                  <Link to={`/s/${current.slug}`} className="btn btn-primary">
                    Continue with the latest stories
                  </Link>
                ) : (
                  <Link to="/topics" className="btn btn-primary">
                    Browse topics
                  </Link>
                )}
                {topic && (
                  <Link to={`/t/${topic.slug}`} className="btn">
                    Topic overview
                  </Link>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Desktop: the active story's topic, progress and the keyboard hint sit in a slim bar along the bottom. */}
      {current && (
        <div className="feed-bar" aria-label="About this story">
          <Link to={`/t/${current.topic.slug}`} className="feed-bar-topic" title={current.topic.heat > 0 ? current.topic.heat_reason : undefined}>
            <CategoryIcon category={current.topic.category} />
            <strong>{current.topic.name}</strong>
            {current.topic.heat > 0 && <Flame className={`flame heat-${current.topic.heat}`} />}
          </Link>
          <span className="feed-bar-progress">
            <span className="rail-progress-bar">
              <span style={{ width: `${((current.position + 1) / Math.max(1, current.topic.stories)) * 100}%` }} />
            </span>
            <span className="mono">
              {current.position + 1}/{current.topic.stories}
            </span>
          </span>
          {topic ? (
            <Link to={`/s/${current.slug}`} className="feed-bar-action">
              ← All stories
            </Link>
          ) : (
            <Link to={storyPath(current.slug, current.topic.slug)} className="feed-bar-action">
              Follow this topic →
            </Link>
          )}
          <span className="feed-bar-hint mono">↑ ↓ or J K to move · space for next</span>
        </div>
      )}
    </div>
  );
}
