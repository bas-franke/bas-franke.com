import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, compact, formatDate, mediaUrl } from '../../api';
import type { AdminArticle } from '../../types';
import { useAdminCall } from './AdminApp';

export default function Articles({ onLoggedOut }: { onLoggedOut: () => void }) {
  const call = useAdminCall(onLoggedOut);
  const [articles, setArticles] = useState<AdminArticle[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string>();
  const [busyId, setBusyId] = useState<number>();

  const load = useCallback(
    () =>
      call(() => api<{ articles: AdminArticle[]; total: number }>(`/api/admin/articles?page=${page}&limit=30`))
        .then((d) => {
          if (!d) return;
          setArticles(d.articles);
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

  const toggle = (a: AdminArticle) =>
    act(a.id, () => api(`/api/admin/articles/${a.id}`, { method: 'PATCH', json: { status: a.status === 'published' ? 'hidden' : 'published' } }));
  const regenerate = (a: AdminArticle) => act(a.id, () => api(`/api/admin/articles/${a.id}/regenerate-images`, { method: 'POST' }));
  const remove = (a: AdminArticle) => {
    if (!confirm(`Delete “${a.title}” permanently?`)) return;
    act(a.id, () => api(`/api/admin/articles/${a.id}`, { method: 'DELETE' }));
  };

  const pages = Math.max(1, Math.ceil(total / 30));

  return (
    <div className="admin-page">
      <header className="admin-head">
        <div>
          <h1>Articles</h1>
          <p className="muted">{total} in total. Hidden articles stay in the database but are not shown on the site.</p>
        </div>
      </header>

      {error && <p className="form-error">{error}</p>}

      <div className="article-list">
        {articles.map((a) => {
          const img = mediaUrl(a.hero_image);
          const busy = busyId === a.id;
          return (
            <div key={a.id} className={`panel article-row ${a.status === 'hidden' ? 'article-hidden' : ''}`}>
              <div className="thumb">{img ? <img src={img} alt="" /> : <div className="card-placeholder" />}</div>
              <div className="article-info">
                <Link to={`/a/${a.slug}`} className="article-row-title">
                  {a.title}
                </Link>
                <p className="muted small">
                  {a.kind === 'trending' ? 'Right now' : (a.topic_name ?? 'No topic')} · {formatDate(a.published_at, true)} · {a.read_minutes} min · {compact(a.views)} views · {a.charts}{' '}
                  {a.charts === 1 ? 'chart' : 'charts'} · {a.images} {a.images === 1 ? 'image' : 'images'}
                  {a.usage.input_tokens ? ` · ${compact((a.usage.input_tokens ?? 0) + (a.usage.output_tokens ?? 0))} tokens` : ''}
                </p>
              </div>
              <div className="article-actions">
                <span className={`status-pill ${a.status}`}>{a.status}</span>
                <button className="btn" onClick={() => toggle(a)} disabled={busy}>
                  {a.status === 'published' ? 'Hide' : 'Publish'}
                </button>
                <button className="btn" onClick={() => regenerate(a)} disabled={busy} title="Re-render all illustrations">
                  {busy ? 'Working…' : 'New images'}
                </button>
                <button className="btn btn-ghost danger" onClick={() => remove(a)} disabled={busy}>
                  Delete
                </button>
              </div>
            </div>
          );
        })}
        {articles.length === 0 && <p className="muted">No articles yet.</p>}
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
