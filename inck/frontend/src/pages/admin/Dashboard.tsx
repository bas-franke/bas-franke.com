import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, compact, formatDate, timeAgo, timeUntil } from '../../api';
import type { Overview, Run, Topic } from '../../types';
import { useAdminCall } from './AdminApp';

export default function Dashboard({ onLoggedOut }: { onLoggedOut: () => void }) {
  const call = useAdminCall(onLoggedOut);
  const [data, setData] = useState<Overview>();
  const [topics, setTopics] = useState<Topic[]>([]);
  const [topicId, setTopicId] = useState('');
  const [error, setError] = useState<string>();
  const [, tick] = useState(0);

  const load = useCallback(() => call(() => api<Overview>('/api/admin/overview')).then((d) => d && setData(d)).catch((e) => setError(e.message)), [call]);

  useEffect(() => {
    load();
    call(() => api<Topic[]>('/api/admin/topics')).then((t) => t && setTopics(t)).catch(() => {});
  }, [load, call]);

  // Poll faster while a run is in progress so the step updates live.
  useEffect(() => {
    const id = setInterval(load, data?.generating ? 3000 : 20000);
    const clock = setInterval(() => tick((n) => n + 1), 10000);
    return () => {
      clearInterval(id);
      clearInterval(clock);
    };
  }, [load, data?.generating]);

  async function generateNow() {
    setError(undefined);
    try {
      await call(() => api('/api/admin/generate', { method: 'POST', json: { topic_id: topicId || undefined } }));
      setTimeout(load, 500);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!data) return <div className="admin-page">{error ? <p className="form-error">{error}</p> : null}</div>;

  const running = data.recent_runs.find((r) => r.status === 'running');

  return (
    <div className="admin-page">
      <header className="admin-head">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">
            {data.counts.published} published · {compact(data.counts.views)} views · {data.published_24h}/{data.settings.max_per_day} in the last 24 h
          </p>
        </div>
        <div className="generate">
          <select value={topicId} onChange={(e) => setTopicId(e.target.value)} aria-label="Topic for the next article">
            <option value="">Random topic</option>
            {topics
              .filter((t) => t.enabled)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
          <button className="btn btn-primary" onClick={generateNow} disabled={data.generating || !data.env.openai || !data.env.database}>
            {data.generating ? 'Generating…' : 'Generate now'}
          </button>
        </div>
      </header>

      {error && <p className="form-error">{error}</p>}

      <section className="panel-grid">
        <div className="panel">
          <h2>Scheduler</h2>
          {running ? (
            <p className="big">
              <span className="spinner" /> Writing now: <em>{running.step}</em>
            </p>
          ) : data.next_run_at ? (
            <p className="big">
              Next article {timeUntil(data.next_run_at)}
              <span className="muted small"> ({formatDate(data.next_run_at, true)})</span>
            </p>
          ) : (
            <p className="big muted">Paused</p>
          )}
          <p className="muted small">
            Every {data.settings.interval_minutes} min, max {data.settings.max_per_day}/24 h
            {data.settings.active_hours_start !== null && data.settings.active_hours_end !== null
              ? `, ${data.settings.active_hours_start}:00–${data.settings.active_hours_end}:00 ${data.settings.timezone}`
              : ''}
            . <Link to="/admin/settings">Change</Link>
          </p>
          {data.blockers.length > 0 && (
            <ul className="blockers">
              {data.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="panel">
          <h2>Server</h2>
          <ul className="checklist">
            <Check ok={data.env.database} label="Database connected" fix="Set DATABASE_URL in /srv/apps/inck/.env" />
            <Check ok={data.env.openai} label="OpenAI key configured" fix="Set OPENAI_API_KEY in /srv/apps/inck/.env" />
            <Check ok={data.env.admin_password} label="Admin password set" />
          </ul>
          <p className="muted small mono">images: {data.env.data_dir}/images</p>
        </div>

        <div className="panel">
          <h2>Usage</h2>
          <dl className="stats">
            <div>
              <dt>Input tokens</dt>
              <dd>{compact(data.tokens.input)}</dd>
            </div>
            <div>
              <dt>Output tokens</dt>
              <dd>{compact(data.tokens.output)}</dd>
            </div>
            <div>
              <dt>Images</dt>
              <dd>{data.tokens.images}</dd>
            </div>
            <div>
              <dt>Failed runs</dt>
              <dd>{data.tokens.failed_runs}</dd>
            </div>
          </dl>
          <p className="muted small">
            Models: {data.settings.text_model} · {data.settings.image_model} ({data.settings.image_quality})
          </p>
        </div>
      </section>

      <section className="panel">
        <h2>Recent runs</h2>
        {data.recent_runs.length === 0 ? (
          <p className="muted">No runs yet. Press “Generate now” to write the first article.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Trigger</th>
                <th>Topic</th>
                <th>Result</th>
                <th>Tokens</th>
              </tr>
            </thead>
            <tbody>
              {data.recent_runs.map((r) => (
                <RunRow key={r.id} run={r} />
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Check({ ok, label, fix }: { ok: boolean; label: string; fix?: string }) {
  return (
    <li className={ok ? 'check-ok' : 'check-bad'}>
      <span className="check-dot" />
      <span>
        {label}
        {!ok && fix && <span className="muted small"> · {fix}</span>}
      </span>
    </li>
  );
}

function RunRow({ run }: { run: Run }) {
  return (
    <tr>
      <td title={formatDate(run.started_at, true)}>{timeAgo(run.started_at)}</td>
      <td>{run.trigger}</td>
      <td>{run.topic_name ?? '—'}</td>
      <td>
        {run.status === 'running' && (
          <span className="status status-running">
            <span className="spinner" /> {run.step}
          </span>
        )}
        {run.status === 'succeeded' && (
          <Link to={`/a/${run.article_slug}`} className="status status-ok">
            {run.article_title}
          </Link>
        )}
        {run.status === 'failed' && (
          <span className="status status-fail" title={run.error ?? ''}>
            {run.error}
          </span>
        )}
      </td>
      <td className="mono small">
        {run.usage.input_tokens ? `${compact(run.usage.input_tokens)} / ${compact(run.usage.output_tokens ?? 0)}` : '—'}
        {run.usage.images ? ' +img' : ''}
      </td>
    </tr>
  );
}
