import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { IconPause, IconPlay } from '../components/icons';
import { ErrorBox, Segmented, Skeleton, useVisibleInterval } from '../components/ui';
import { dateOnly, timeOnly } from '../format';
import { navigate, useLocation } from '../router';
import type { LogRow } from '../types';
import './logs.css';

const MAX_ROWS = 1000;
type Level = '' | 'info' | 'warn' | 'error';
type View = 'all' | 'orders';

/** Log events about deciding, placing, filling and cancelling orders (and manual "move everything" switches). */
export const isOrderEvent = (event: string) =>
  event === 'decision' || event.startsWith('order_') || event.startsWith('manual_') || event === 'strategy_started' ||
  event === 'stop_triggered' || event.startsWith('fallback_') || event === 'stray_orders' || event === 'daily_loss_limit';

export default function LogsPage() {
  const { query } = useLocation();
  const [view, setViewState] = useState<View>(query.get('view') === 'orders' ? 'orders' : 'all');
  const setView = (v: View) => {
    setViewState(v);
    navigate(v === 'orders' ? '/logs?view=orders' : '/logs', { replace: true });
  };
  const [level, setLevel] = useState<Level>(() => {
    const l = query.get('level');
    return l === 'info' || l === 'warn' || l === 'error' ? l : '';
  });
  const [paused, setPaused] = useState(false);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const [error, setError] = useState<Error | null>(null);
  const [loaded, setLoaded] = useState(false);
  const lastId = useRef(0);
  const busy = useRef(false);

  const merge = (got: LogRow[], markNew: boolean) => {
    if (!got.length) return;
    lastId.current = Math.max(lastId.current, ...got.map((l) => l.id));
    setRows((r) => {
      const seen = new Set(r.map((l) => l.id));
      const add = got.filter((l) => !seen.has(l.id));
      return [...r, ...add].sort((a, b) => b.id - a.id).slice(0, MAX_ROWS);
    });
    if (markNew) setFresh(new Set(got.map((l) => l.id)));
  };

  const initial = useCallback(async () => {
    lastId.current = 0;
    setRows([]);
    setLoaded(false);
    try {
      const { logs } = await api.logs({ level: level || undefined, limit: 200 });
      merge(logs, false);
      setError(null);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoaded(true);
    }
  }, [level]);

  useEffect(() => {
    initial();
  }, [initial]);

  useVisibleInterval(
    async () => {
      if (busy.current || !loaded) return;
      busy.current = true;
      try {
        const { logs } = await api.logs({ level: level || undefined, after: lastId.current, limit: 200 });
        merge(logs, true);
        setError(null);
      } catch (e) {
        setError(e as Error);
      } finally {
        busy.current = false;
      }
    },
    3000,
    !paused,
  );

  const shown = view === 'orders' ? rows.filter((l) => isOrderEvent(l.event)) : rows;
  let lastDay = '';
  return (
    <div className="stack logs-page">
      <div className="page-head">
        <div>
          <span className="eyebrow">Logs</span>
          <h1>The bot’s diary</h1>
          <p className="lede">Everything it notices and does, as it happens. New lines appear every few seconds while this page is open. “Orders only” shows each decision and what happened to every order it placed.</p>
        </div>
      </div>
      <div className="logs-filters">
        <Segmented<View>
          label="Show"
          value={view}
          onChange={setView}
          options={[
            { value: 'all', label: 'All activity' },
            { value: 'orders', label: 'Orders only' },
          ]}
        />
        <Segmented<Level>
          label="Level"
          value={level}
          onChange={setLevel}
          options={[
            { value: '', label: 'Everything' },
            { value: 'info', label: 'Info & up' },
            { value: 'warn', label: 'Warnings' },
            { value: 'error', label: 'Errors' },
          ]}
        />
        <div className="logs-tail">
          <span className={`chip ${paused ? '' : 'gain pulse'}`}>
            <span className="dot" />
            {paused ? 'Paused' : 'Live tail'}
          </span>
          <button className="btn small" onClick={() => setPaused((p) => !p)}>
            {paused ? <IconPlay width={15} /> : <IconPause width={15} />}
            {paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      </div>
      {error && <ErrorBox error={error} onRetry={initial} />}
      <section className="card logs-card">
        {!loaded && (
          <div className="stack" style={{ padding: 20, gap: 10 }}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} h={16} />
            ))}
          </div>
        )}
        {loaded && shown.length === 0 && (
          <p className="soft small logs-empty">
            {view === 'orders' ? 'No order activity in the latest lines yet.' : `Nothing logged yet${level ? ' at this level' : ''}.`}
          </p>
        )}
        <div className="log-list">
          {shown.map((l) => {
            const day = dateOnly(l.ts);
            const header = day !== lastDay;
            lastDay = day;
            const hasData = l.data !== null && l.data !== undefined && !(typeof l.data === 'object' && Object.keys(l.data as object).length === 0);
            return (
              <div key={l.id}>
                {header && (
                  <div className="eyebrow log-day">{day}</div>
                )}
                <div className={`log-row lv-${l.level}${fresh.has(l.id) ? ' new' : ''}`}>
                  <span className="ts">{timeOnly(l.ts)}</span>
                  <span className={`lvl ${l.level}`}>{l.level}</span>
                  <span className="event" title={l.event}>
                    {l.event}
                  </span>
                  <div className="msg">
                    {l.message}
                    {hasData && (
                      <details>
                        <summary>data</summary>
                        <pre>{JSON.stringify(l.data, null, 2)}</pre>
                      </details>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
