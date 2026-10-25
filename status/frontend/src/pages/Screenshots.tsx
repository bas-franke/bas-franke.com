import { useContext, useEffect, useRef, useState, type MouseEvent, type TouchEvent } from 'react';
import { UnauthorizedContext, usePoll, useTicker } from '../api';
import { timeAgo } from '../format';
import { Link } from '../router';
import { Skeleton, StateCard } from '../ui';
import '../screenshots.css';

export interface Screenshot {
  id: string;
  project: string;
  title: string;
  note: string | null;
  source: string | null;
  contentType: string;
  width: number | null;
  height: number | null;
  bytes: number;
  createdAt: string;
  url: string;
}

export interface ScreenshotsReport {
  /** How many screenshots are kept per project; older ones are pruned on upload. */
  perProject: number;
  /** False while SCREENSHOT_TOKEN is missing on the server, so nothing can be uploaded. */
  uploadsEnabled: boolean;
  /** Newest first, across every project. */
  screenshots: Screenshot[];
}

export const screenshotsPath = (project?: string) => (project ? `/screenshots/${encodeURIComponent(project)}` : '/screenshots');

const UPLOAD_COMMAND = 'node status/tools/upload-screenshot.mjs --project <name> --title "..." <file>';

export default function Screenshots({ project }: { project?: string }) {
  const feed = usePoll<ScreenshotsReport>('/api/screenshots', 'screenshots API');
  const [openId, setOpenId] = useState<string | null>(null);
  useTicker(60_000);

  useEffect(() => {
    document.title = project ? `${project} screenshots · Status` : 'Screenshots · Status';
  }, [project]);

  const data = feed.data;
  const all = data?.screenshots ?? [];
  const shown = project ? all.filter((s) => s.project === project) : all;
  const counts = new Map<string, number>();
  for (const s of all) counts.set(s.project, (counts.get(s.project) ?? 0) + 1);
  const projects = [...counts.keys()].sort((a, b) => a.localeCompare(b));
  const openIndex = openId ? shown.findIndex((s) => s.id === openId) : -1;

  return (
    <>
      <header className="shots-head">
        <h1>Screenshots</h1>
        <p className="muted">
          Design changes from every project, newest first.
          {data && <> The latest {data.perProject} per project are kept.</>}
        </p>
      </header>

      {projects.length > 0 && (
        <nav className="shots-filter" aria-label="Filter by project">
          <Link to={screenshotsPath()} className="shots-chip" aria-current={!project ? 'page' : undefined}>
            All <span className="shots-chip-count">{all.length}</span>
          </Link>
          {projects.map((p) => (
            <Link key={p} to={screenshotsPath(p)} className="shots-chip" aria-current={project === p ? 'page' : undefined}>
              {p}{' '}
              <span className="shots-chip-count">
                {counts.get(p)}/{data?.perProject}
              </span>
            </Link>
          ))}
        </nav>
      )}

      {!data && feed.error ? (
        <StateCard art="state-offline" title="Can't load the screenshots">
          <p className="muted">{feed.error}</p>
          <p>
            <button type="button" className="btn" onClick={() => feed.reload()}>
              Try again
            </button>
          </p>
        </StateCard>
      ) : !data ? (
        <FeedSkeleton />
      ) : all.length === 0 ? (
        <EmptyState uploadsEnabled={data.uploadsEnabled} />
      ) : shown.length === 0 ? (
        <StateCard art="state-warn" title={`No screenshots for “${project}”`}>
          <p className="muted">
            Nothing has been uploaded for this project, or it has been pruned. <Link to={screenshotsPath()}>See all screenshots</Link>.
          </p>
        </StateCard>
      ) : (
        <>
          {feed.error && <p className="muted small">Showing earlier screenshots; the last refresh failed: {feed.error}</p>}
          {!data.uploadsEnabled && (
            <p className="notice">
              Uploads are off: <code>SCREENSHOT_TOKEN</code> is missing on the server (see “Screenshots” in status/README.md).
            </p>
          )}
          <Feed shots={shown} showProject={!project} onOpen={setOpenId} />
        </>
      )}

      {openIndex >= 0 && (
        <Lightbox
          shots={shown}
          index={openIndex}
          onIndex={(i) => setOpenId(shown[i]?.id ?? null)}
          onClose={() => setOpenId(null)}
          onDeleted={(next) => {
            setOpenId(next);
            feed.reload();
          }}
        />
      )}
    </>
  );
}

/* ---------- Feed ---------- */

function Feed({ shots, showProject, onOpen }: { shots: Screenshot[]; showProject: boolean; onOpen: (id: string) => void }) {
  const days: { key: string; label: string; shots: Screenshot[] }[] = [];
  for (const s of shots) {
    const key = localDay(s.createdAt);
    const last = days[days.length - 1];
    if (last?.key === key) last.shots.push(s);
    else days.push({ key, label: dayHeading(s.createdAt), shots: [s] });
  }
  return (
    <div className="shots-feed">
      {days.map((day) => (
        <section key={day.key} className="shots-day" aria-label={day.label}>
          <h2 className="shots-day-title">
            {day.label} <span className="muted">· {day.shots.length}</span>
          </h2>
          <ul className="shots-grid">
            {day.shots.map((s) => (
              <li key={s.id}>
                <ShotCard shot={s} showProject={showProject} onOpen={() => onOpen(s.id)} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ShotCard({ shot, showProject, onOpen }: { shot: Screenshot; showProject: boolean; onOpen: () => void }) {
  const [broken, setBroken] = useState(false);
  // A real link to the image, so ctrl/middle-click and a phone's long-press "Open in new tab" work; a plain click opens the lightbox.
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onOpen();
  };
  return (
    <a href={shot.url} target="_blank" rel="noreferrer" className="shot-card" onClick={onClick} aria-label={`${shot.title}, ${shot.project}, ${relativeTime(shot.createdAt)}`}>
      <span className="shot-thumb" style={{ aspectRatio: ratio(shot) }}>
        {broken ? (
          <span className="shot-broken muted small">Image unavailable</span>
        ) : (
          <img src={shot.url} alt="" loading="lazy" decoding="async" width={shot.width ?? undefined} height={shot.height ?? undefined} onError={() => setBroken(true)} />
        )}
      </span>
      <span className="shot-body">
        <span className="shot-meta">
          {showProject && <span className="shot-project">{shot.project}</span>}
          <time className="muted" dateTime={shot.createdAt} title={fullTime(shot.createdAt)}>
            {relativeTime(shot.createdAt)}
          </time>
          {shot.source && <span className="shot-source mono">{shot.source}</span>}
        </span>
        <span className="shot-title">{shot.title}</span>
        {shot.note && <span className="shot-note muted">{shot.note}</span>}
      </span>
    </a>
  );
}

function FeedSkeleton() {
  return (
    <div className="shots-feed" aria-busy="true" aria-label="Loading screenshots">
      <Skeleton width={120} height={16} />
      <ul className="shots-grid">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <li key={i} className="shot-card shot-skeleton">
            <Skeleton height={170} />
            <span className="shot-body">
              <Skeleton width="40%" height={12} />
              <Skeleton width="80%" height={16} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EmptyState({ uploadsEnabled }: { uploadsEnabled: boolean }) {
  if (!uploadsEnabled) {
    return (
      <StateCard art="state-warn" title="Screenshot uploads aren't set up yet">
        <p className="muted">
          <code>SCREENSHOT_TOKEN</code> is missing on the server, so nothing can be uploaded. See “Screenshots” in <code>status/README.md</code>.
        </p>
        <p className="muted small">Once it is set, Claude uploads screenshots with:</p>
        <pre className="shots-cmd">{UPLOAD_COMMAND}</pre>
      </StateCard>
    );
  }
  return (
    <StateCard art="state-ok" title="No screenshots yet">
      <p className="muted">When Claude changes a design, it uploads a screenshot of the result with:</p>
      <pre className="shots-cmd">{UPLOAD_COMMAND}</pre>
      <p className="muted small">They show up here within a minute, newest first.</p>
    </StateCard>
  );
}

/* ---------- Lightbox ---------- */

function Lightbox({
  shots,
  index,
  onIndex,
  onClose,
  onDeleted,
}: {
  shots: Screenshot[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  /** Called after a delete with the screenshot to show next, or null to close. */
  onDeleted: (nextId: string | null) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const onUnauthorized = useContext(UnauthorizedContext);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();
  const shot = shots[index];
  const hasPrev = index > 0;
  const hasNext = index < shots.length - 1;

  useEffect(() => {
    const el = dialog.current;
    // No close() in a cleanup: StrictMode would fire `close` and shut the dialog straight away. Unmounting removes it.
    if (el && !el.open) el.showModal();
  }, []);

  useEffect(() => setError(undefined), [shot.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea')) return;
      if (e.key === 'ArrowLeft' && hasPrev) {
        e.preventDefault();
        onIndex(index - 1);
      } else if (e.key === 'ArrowRight' && hasNext) {
        e.preventDefault();
        onIndex(index + 1);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [index, hasPrev, hasNext, onIndex]);

  async function remove() {
    if (!confirm(`Delete “${shot.title}” (${shot.project})? This can't be undone.`)) return;
    setDeleting(true);
    setError(undefined);
    try {
      const res = await fetch(`/api/screenshots/${encodeURIComponent(shot.id)}`, { method: 'DELETE' });
      if (res.status === 401) return onUnauthorized();
      if (!res.ok && res.status !== 404) throw new Error(`The screenshots API returned HTTP ${res.status}.`);
      onDeleted((shots[index + 1] ?? shots[index - 1])?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }

  // Swipe left/right on the image to step through the feed on a phone.
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    swipeStart.current = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
  };
  const onTouchEnd = (e: TouchEvent) => {
    const start = swipeStart.current;
    const t = e.changedTouches[0];
    swipeStart.current = null;
    if (!start || !t) return;
    const dx = t.clientX - start.x;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(t.clientY - start.y) * 1.5) return;
    if (dx > 0 && hasPrev) onIndex(index - 1);
    else if (dx < 0 && hasNext) onIndex(index + 1);
  };
  // A click on the backdrop lands on the <dialog> itself; clicks inside land on its children.
  const onBackdrop = (e: MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <dialog ref={dialog} className="shot-dialog" aria-labelledby="shot-dialog-title" onClose={onClose} onClick={onBackdrop}>
      <div className="sd-inner">
        <header className="sd-head">
          <div className="sd-title">
            <h2 id="shot-dialog-title">{shot.title}</h2>
            <p className="muted small">
              <Link to={screenshotsPath(shot.project)} className="shot-project" onClick={onClose}>
                {shot.project}
              </Link>{' '}
              · <time dateTime={shot.createdAt}>{fullTime(shot.createdAt)}</time> · {relativeTime(shot.createdAt)}
            </p>
          </div>
          <button type="button" className="btn btn-ghost sd-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="sd-stage" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          <a className="sd-zoom" href={shot.url} target="_blank" rel="noreferrer" title="Open full size in a new tab to zoom in">
            <img key={shot.id} src={shot.url} alt={shot.title} width={shot.width ?? undefined} height={shot.height ?? undefined} />
          </a>
          {hasPrev && (
            <button type="button" className="sd-nav sd-prev" onClick={() => onIndex(index - 1)} aria-label="Previous screenshot" title="Previous (←)">
              ‹
            </button>
          )}
          {hasNext && (
            <button type="button" className="sd-nav sd-next" onClick={() => onIndex(index + 1)} aria-label="Next screenshot" title="Next (→)">
              ›
            </button>
          )}
        </div>

        {shot.note && <p className="sd-note">{shot.note}</p>}
        {error && <p className="sd-error small">{error}</p>}

        <footer className="sd-foot">
          <span className="muted small mono">
            {[shot.width && shot.height ? `${shot.width}×${shot.height}` : null, fileSize(shot.bytes), shot.source, `${index + 1} of ${shots.length}`]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <span className="sd-actions">
            <a className="btn btn-sm" href={shot.url} target="_blank" rel="noreferrer">
              Open in new tab <span aria-hidden="true">↗</span>
            </a>
            <button type="button" className="btn btn-sm sd-delete" onClick={remove} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </span>
        </footer>
      </div>
    </dialog>
  );
}

/* ---------- Helpers ---------- */

const ratio = (s: Screenshot) => (s.width && s.height ? `${s.width} / ${s.height}` : '16 / 10');

export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "12 min ago" and "3 h ago" from timeAgo for today, then days, then a date. */
function relativeTime(iso: string) {
  const hours = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (hours < 24) return timeAgo(iso);
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} d ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const fullTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** The calendar day in the viewer's zone, as YYYY-MM-DD. */
function localDay(iso: string | Date) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayHeading(iso: string) {
  const key = localDay(iso);
  const now = new Date();
  if (key === localDay(now)) return 'Today';
  if (key === localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return 'Yesterday';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) });
}
