import { usePoll, useTicker } from '../api';
import { Skeleton, StateCard } from '../ui';
import type { Change, ChangeList } from '../types';

/** "just now", "12 min ago", "5 h ago", "yesterday", "3 days ago", then a date. */
export function changeAgo(iso: string) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  const days = Math.round(s / 86_400);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const exact = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const dayKey = (iso: string) => new Date(iso).toLocaleDateString('en-CA');
const dayHeading = (iso: string) => {
  const key = dayKey(iso);
  if (key === dayKey(new Date().toISOString())) return 'Today';
  if (key === dayKey(new Date(Date.now() - 86_400_000).toISOString())) return 'Yesterday';
  return new Date(iso).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
};

/** The latest change on an overview card: when, plus its one-line summary. */
export function LatestChange({ change, pending }: { change?: Change | null; pending: boolean }) {
  useTicker(60_000);
  if (pending) return <Skeleton height={30} />;
  if (!change) return null;
  return (
    <div className="pcard-change" title={`${change.summary}\n${exact(change.date)} · ${change.author}`}>
      <span className="kv-label">
        Last change <time dateTime={change.date}>{changeAgo(change.date)}</time>
      </span>
      <span className="pcard-change-text">{change.summary}</span>
    </div>
  );
}

/** The Changes tab: every commit that touched the project's folder, newest first, grouped by day. */
export default function Changes({ site }: { site: string }) {
  useTicker(60_000);
  const changes = usePoll<ChangeList>(`/api/changes/${encodeURIComponent(site)}`, 'changes API');
  const data = changes.data;

  if (!data && changes.error) {
    return (
      <StateCard art="state-offline" title="Can't load the change history">
        <p className="muted">{changes.error}</p>
        <p>
          <button type="button" className="btn" onClick={() => changes.reload()}>
            Try again
          </button>
        </p>
      </StateCard>
    );
  }
  if (!data) {
    return (
      <div className="panel" aria-busy="true" aria-label="Loading changes">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} height={44} />
        ))}
      </div>
    );
  }
  if (!data.changes.length) {
    return (
      <StateCard art="state-warn" title="No changes found">
        <p className="muted">{data.error ?? `GitHub has no commits that touch the ${site}/ folder.`}</p>
      </StateCard>
    );
  }

  const days: { key: string; heading: string; items: Change[] }[] = [];
  for (const c of data.changes) {
    const key = dayKey(c.date);
    if (days.at(-1)?.key !== key) days.push({ key, heading: dayHeading(c.date), items: [] });
    days.at(-1)!.items.push(c);
  }

  return (
    <div className="changes">
      {data.error && <p className="muted small">Showing earlier history; the last refresh failed: {data.error}</p>}
      {days.map((day) => (
        <section className="panel change-day" key={day.key} aria-label={day.heading}>
          <h2 className="change-day-title">
            {day.heading}
            <span className="muted small">
              {day.items.length} change{day.items.length === 1 ? '' : 's'}
            </span>
          </h2>
          <ol className="change-list">
            {day.items.map((c) => (
              <ChangeRow key={c.sha} change={c} />
            ))}
          </ol>
        </section>
      ))}
      <p className="muted small analytics-note">
        The latest {data.changes.length} commits on GitHub that touched <code>{site}/</code>, merge commits left out.{' '}
        <a href={data.historyUrl} target="_blank" rel="noreferrer">
          Full history on GitHub ↗
        </a>
      </p>
    </div>
  );
}

function ChangeRow({ change }: { change: Change }) {
  const meta = (
    <span className="change-meta muted small">
      <time dateTime={change.date} title={exact(change.date)}>
        {new Date(change.date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
      </time>
      {' · '}
      {change.author}
      {' · '}
      <a className="mono" href={change.url} target="_blank" rel="noreferrer" title="Open the commit on GitHub">
        {change.sha.slice(0, 7)}
      </a>
    </span>
  );
  return (
    <li className="change">
      {change.body ? (
        <details>
          <summary>
            <span className="change-summary">{change.summary}</span>
            {meta}
          </summary>
          <p className="change-body">{change.body}</p>
        </details>
      ) : (
        <div>
          <span className="change-summary">{change.summary}</span>
          {meta}
        </div>
      )}
    </li>
  );
}
