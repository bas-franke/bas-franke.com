import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, compact, formatDate, mediaUrl, readLabel } from '../../api';
import type { AdminStory } from '../../types';
import { useAdminCall } from './AdminApp';

const PAGE = 30;

export default function Stories({ onLoggedOut }: { onLoggedOut: () => void }) {
  const call = useAdminCall(onLoggedOut);
  const [stories, setStories] = useState<AdminStory[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string>();
  const [busyId, setBusyId] = useState<number>();

  const load = useCallback(
    () =>
      call(() => api<{ stories: AdminStory[]; total: number }>(`/api/admin/stories?page=${page}&limit=${PAGE}`))
        .then((d) => {
          if (!d) return;
          setStories(d.stories);
          setTotal(d.total);
        })
        .catch((e) => setError(e.message)),
    [call, page],
  );
  useEffect(() => {
    load();
  }, [load]);

  const act = async (id: number, fn: () => Promise<unknown>) => {
    setBusyId(id);
    setError(undefined);
    try {
      await call(fn);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(undefined);
    }
  };

  const toggle = (s: AdminStory) => act(s.id, () => api(`/api/admin/stories/${s.id}`, { method: 'PATCH', json: { status: s.status === 'published' ? 'hidden' : 'published' } }));
  const regenerate = (s: AdminStory) => act(s.id, () => api(`/api/admin/stories/${s.id}/regenerate-images`, { method: 'POST' }));
  const remove = (s: AdminStory) => {
    if (!confirm(`Delete “${s.title}” permanently?`)) return;
    act(s.id, () => api(`/api/admin/stories/${s.id}`, { method: 'DELETE' }));
  };

  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="admin-page">
      <header className="admin-head">
        <div>
          <h1>Stories</h1>
          <p className="muted">{total} in total. Hidden stories stay in the database but are not shown on the site.</p>
        </div>
      </header>

      {error && <p className="form-error">{error}</p>}

      <div className="article-list">
        {stories.map((s) => {
          const img = mediaUrl(s.image);
          const busy = busyId === s.id;
          return (
            <div key={s.id} className={`panel article-row ${s.status === 'hidden' ? 'article-hidden' : ''}`}>
              <div className="thumb">{img ? <img src={img} alt="" /> : <div className="card-placeholder" />}</div>
              <div className="article-info">
                <Link to={`/s/${s.slug}`} className="article-row-title">
                  {s.kind === 'trending' && <span className="now-dot" />}
                  {s.title}
                </Link>
                <p className="muted small">
                  {s.topic_name} · {s.section_name || '—'} · {formatDate(s.published_at, true)} · {readLabel(s.read_seconds)} · {compact(s.views)} views · {s.images}{' '}
                  {s.images === 1 ? 'picture' : 'pictures'}
                  {s.usage.input_tokens ? ` · ${compact((s.usage.input_tokens ?? 0) + (s.usage.output_tokens ?? 0))} tokens` : ''}
                </p>
                <p className="muted small">{s.hook}</p>
              </div>
              <div className="article-actions">
                <span className={`status-pill ${s.status}`}>{s.status}</span>
                <button className="btn" onClick={() => toggle(s)} disabled={busy}>
                  {s.status === 'published' ? 'Hide' : 'Publish'}
                </button>
                {s.images > 0 && (
                  <button className="btn" onClick={() => regenerate(s)} disabled={busy} title="Re-render the pictures">
                    {busy ? 'Working…' : 'New pictures'}
                  </button>
                )}
                <button className="btn btn-ghost danger" onClick={() => remove(s)} disabled={busy}>
                  Delete
                </button>
              </div>
            </div>
          );
        })}
        {stories.length === 0 && <p className="muted">No stories yet.</p>}
      </div>

      {pages > 1 && (
        <div className="pager">
          <button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span className="muted small">
            Page {page} of {pages}
          </span>
          <button className="btn" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}
