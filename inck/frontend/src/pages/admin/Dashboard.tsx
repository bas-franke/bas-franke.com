import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, compact, formatDate, timeAgo, timeUntil } from '../../api';
import type { AdminTopic, Overview, Run } from '../../types';
import { useAdminCall } from './AdminApp';

export default function Dashboard({ onLoggedOut }: { onLoggedOut: () => void }) {
  const call = useAdminCall(onLoggedOut);
  const [data, setData] = useState<Overview>();
  const [topics, setTopics] = useState<AdminTopic[]>([]);
  const [choice, setChoice] = useState('');
  const [error, setError] = useState<string>();
  const [, tick] = useState(0);

  const load = useCallback(() => call(() => api<Overview>('/api/admin/overview')).then((d) => d && setData(d)).catch((e) => setError(e.message)), [call]);

  useEffect(() => {
    load();
    call(() => api<AdminTopic[]>('/api/admin/topics')).then((t) => t && setTopics(t)).catch(() => {});
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
    const body = choice === 'trending' ? { mode: 'trending' } : choice === 'planned' ? { mode: 'planned' } : choice ? { topic_id: Number(choice) } : { mode: 'auto' };
    try {
      await call(() => api('/api/admin/generate', { method: 'POST', json: body }));
      setTimeout(load, 500);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const [scanning, setScanning] = useState(false);
  async function scanNow() {
    setError(undefined);
    setScanning(true);
    try {
      await call(() => api('/api/admin/radar', { method: 'POST' }));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanning(false);
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
            {data.counts.published} stories in {data.counts.topics} topics · {compact(data.counts.views)} views · {data.published_24h}/{data.settings.max_per_day} in the last 24 h
          </p>
        </div>
        <div className="generate">
          <select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="What to write next">
            <option value="">Auto (curriculum or right now)</option>
            <option value="trending">Right now (what is happening)</option>
            <option value="planned">Curriculum (any topic)</option>
            {topics
              .filter((t) => t.enabled)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  Next in: {t.name}
                </option>
              ))}
          </select>
          <button className="btn btn-primary" onClick={generateNow} disabled={data.generating || !data.env.openai || !data.env.database}>
            {data.generating ? 'Writing…' : 'Write now'}
          </button>
        </div>
      </header>

      {error && <p className="form-error">{error}</p>}

      <section className="panel">
        <div className="panel-head">
          <h2>Trending now</h2>
          <span className="muted small">
            {data.settings.radar_at ? `radar ran ${timeAgo(data.settings.radar_at)}` : 'radar has not run yet'} · rescans every {data.settings.radar_hours} h before a “right now” story
          </span>
          <button className="btn" onClick={scanNow} disabled={scanning || !data.env.openai || !data.env.database}>
            {scanning ? 'Scanning…' : 'Scan now'}
          </button>
        </div>
        {data.trending.length === 0 ? (
          <p className="muted">Nothing marked hot yet. The radar discovers trending subjects by itself from news headlines, Google Trends, Wikipedia, Hacker News and web search, and creates topics for them.</p>
        ) : (
          <ul className="trend-list">
            {data.trending.map((t) => (
              <li key={t.id}>
                <span className="mono trend-heat">{t.heat}/5</span>
                <span>
                  <Link to={`/t/${t.slug}`}>
                    <strong>{t.name}</strong>
                  </Link>{' '}
                  <span className="muted small">
                    {t.kind} · {t.stories} {t.stories === 1 ? 'story' : 'stories'}
                  </span>
                  <br />
                  <span className="small">{t.heat_reason}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel-grid">
        <div className="panel">
          <h2>Scheduler</h2>
          {running ? (
            <p className="big">
              <span className="spinner" /> Working: <em>{running.step}</em>
            </p>
          ) : data.next_run_at ? (
            <p className="big">
              Next story {timeUntil(data.next_run_at)}
              <span className="muted small"> ({formatDate(data.next_run_at, true)})</span>
            </p>
          ) : (
            <p className="big muted">Paused</p>
          )}
          <p className="muted small">
            Every {data.settings.interval_minutes} min, max {data.settings.max_per_day}/24 h, {data.settings.trending_share}% right now
            {data.settings.active_hours_start !== null && data.settings.active_hours_end !== null
              ? `, ${data.settings.active_hours_start}:00–${data.settings.active_hours_end}:00 ${data.settings.timezone}`
              : ''}
            . <Link to="/sudo/settings">Change</Link>
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
          <p className="muted small mono">pictures: {data.env.data_dir}/images</p>
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
              <dt>Pictures</dt>
              <dd>{data.tokens.images}</dd>
            </div>
            <div>
              <dt>Searches</dt>
              <dd>{data.tokens.searches}</dd>
            </div>
            <div>
              <dt>Failed runs</dt>
              <dd>{data.tokens.failed_runs}</dd>
            </div>
          </dl>
          <p className="cost">
            ≈ ${data.cost.last_24h_usd.toFixed(2)} <span className="muted small">last 24 h</span>
            <span className="muted small">
              {' '}
              · ${data.cost.per_story_usd.toFixed(3)} per story · ${data.cost.total_usd.toFixed(2)} all time
            </span>
          </p>
          <p className="muted small">
            Estimate from list prices. Models: {data.settings.text_model} · {data.settings.image_model} ({data.settings.image_quality}, max {data.settings.images_max} per story)
          </p>
        </div>
      </section>

      <section className="panel">
        <h2>Recent runs</h2>
        {data.recent_runs.length === 0 ? (
          <p className="muted">No runs yet. Press “Write now” for the first story.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Trigger</th>
                <th>What</th>
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
      <td>
        {run.kind === 'trending' && (
          <span title={run.detail ?? ''}>
            <span className="now-dot" /> {run.topic_name ?? 'Right now'}
            {run.detail ? `: ${run.detail}` : ''}
          </span>
        )}
        {run.kind === 'planned' && (
          <span>
            {run.topic_name ?? '—'}
            {run.detail ? <span className="muted"> · {run.detail}</span> : ''}
          </span>
        )}
        {run.kind === 'plan' && <span>Curriculum: {run.topic_name ?? run.detail ?? '—'}</span>}
        {run.kind === 'radar' && <span title={run.detail ?? ''}>Trend radar</span>}
        {run.kind === 'rewrite' && (
          <span>
            Rewrite: {run.topic_name ?? '—'}
            {run.detail ? <span className="muted"> · {run.detail}</span> : ''}
          </span>
        )}
      </td>
      <td>
        {run.status === 'running' && (
          <span className="status status-running">
            <span className="spinner" /> {run.step}
          </span>
        )}
        {run.status === 'succeeded' && run.story_slug && (
          <Link to={`/s/${run.story_slug}`} className="status status-ok">
            {run.story_title}
          </Link>
        )}
        {run.status === 'succeeded' && !run.story_slug && <span className="status status-ok">{run.detail ?? 'done'}</span>}
        {run.status === 'failed' && (
          <span className="status status-fail" title={run.error ?? ''}>
            {run.error}
          </span>
        )}
      </td>
      <td className="mono small">
        {run.usage.input_tokens ? `${compact(run.usage.input_tokens)} / ${compact(run.usage.output_tokens ?? 0)}` : '—'}
        {run.usage.images ? ` +${run.usage.images} img` : ''}
        {run.usage.searches ? ` +${run.usage.searches} search` : ''}
      </td>
    </tr>
  );
}
