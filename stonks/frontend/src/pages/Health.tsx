import { useState, type ReactNode } from 'react';
import { api } from '../api';
import { ModeBadge, Skeleton, Tip } from '../components/ui';
import { ago, dateTime, eur, lossAction, lossLimitText, timeOnly } from '../format';
import { refreshHealth, useHealth, useHealthFeed, type HealthFeed } from '../health';
import { navigate } from '../router';
import type { HealthComponent, HealthDetail, HealthLevel, HealthPart, LossLimit } from '../types';
import './health.css';

const REFRESH_MS = 15_000;
/** Older than this without a failed refresh means the page slept: don't show that answer as current. */
const STALE_MS = 60_000;

const GROUPS: { title: string; parts: { key: HealthPart; title: string }[] }[] = [
  {
    title: 'Trading',
    parts: [
      { key: 'engine', title: 'Trading loop' },
      { key: 'decision', title: 'Latest decision' },
      { key: 'candles', title: 'Price candles' },
      { key: 'orders', title: 'Open orders' },
      { key: 'stuckOrders', title: 'Stuck orders' },
      { key: 'lossGuard', title: 'Loss guard' },
    ],
  },
  {
    title: 'Connections',
    parts: [
      { key: 'bitvavo', title: 'Bitvavo' },
      { key: 'clock', title: 'Clock' },
      { key: 'database', title: 'Database' },
      { key: 'lab', title: 'Strategy lab' },
    ],
  },
  {
    title: 'Watching',
    parts: [
      { key: 'alerts', title: 'Alert mails' },
      { key: 'shadow', title: 'Expected vs actual' },
      { key: 'process', title: 'Server process' },
    ],
  },
];
const TITLE = Object.fromEntries(GROUPS.flatMap((g) => g.parts.map((p) => [p.key, p.title]))) as Record<HealthPart, string>;

const LEVEL: Record<HealthLevel, { label: string; chip: string; mark: string }> = {
  ok: { label: 'OK', chip: 'gain', mark: '✓' },
  warn: { label: 'Look at this', chip: 'brass', mark: '!' },
  fail: { label: 'Failing', chip: 'loss', mark: '×' },
  unknown: { label: 'Unknown', chip: '', mark: '?' },
};

const span = (sec: number) => (sec < 90 ? `${sec} s` : sec < 5400 ? `${Math.round(sec / 60)} min` : sec < 129_600 ? `${Math.round(sec / 3600)} h` : `${Math.round(sec / 86_400)} days`);

/** One fact the detail sentence doesn't already give, mostly how old the thing is. */
function factLine(key: HealthPart, c: HealthComponent): string {
  const d = c.data as Record<string, any>;
  const n = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const parts: (string | false | null | undefined)[] = [];
  switch (key) {
    case 'engine':
      parts.push(n(d.ageSec) && `tick ${span(d.ageSec)} ago`);
      break;
    case 'database':
      parts.push(n(d.ms) && `${d.ms} ms`);
      break;
    case 'bitvavo':
      parts.push(d.lastOkAt ? `last private call ${ago(d.lastOkAt)}` : d.hasKeys === false ? 'no API key' : 'no private call yet');
      break;
    case 'clock':
      parts.push(d.lastSyncAt && `synced ${ago(d.lastSyncAt)}`);
      break;
    case 'decision':
      parts.push(d.interval, n(d.ageSec) && `decided ${span(d.ageSec)} ago`, n(d.barsBehind) && d.barsBehind > 0 && `${d.barsBehind} bars behind`);
      break;
    case 'candles':
      parts.push(d.interval, Array.isArray(d.markets) && `${d.markets.length} market${d.markets.length === 1 ? '' : 's'}`);
      break;
    case 'lab':
      parts.push(n(d.catalogFamilies) && `${d.catalogFamilies} families`, d.lastCall && `${d.lastCall.cmd} ${ago(d.lastCall.at)}`);
      break;
    case 'alerts':
      parts.push(d.configured && (d.lastSentAt ? `last mail ${ago(d.lastSentAt)}` : 'no mail yet'));
      break;
    case 'lossGuard':
      parts.push(d.limit !== undefined && `${lossLimitText({ unit: d.unit, value: d.limit } as LossLimit)} in 24 h`, d.action && lossAction(d.action).label.toLowerCase(), n(d.limitEur) && eur(d.limitEur, true));
      break;
    case 'orders':
      parts.push(n(d.oldestAgeSec) && `oldest ${span(d.oldestAgeSec)}`);
      break;
    case 'stuckOrders':
      parts.push(n(d.rejected24h) && `${d.rejected24h} refused`, n(d.failed24h) && `${d.failed24h} failed in 24 h`);
      break;
    case 'shadow':
      parts.push(n(d.lastPointAgeSec) && `point ${span(d.lastPointAgeSec)} ago`, n(d.avgBps) && `${d.avgBps.toFixed(1)} bps`, n(d.fills) && `${d.fills} fills`);
      break;
    case 'process':
      parts.push(n(d.rssMb) && `${d.rssMb} MB`, n(d.uptimeSec) && `up ${span(d.uptimeSec)}`, d.deployedAt && `deployed ${ago(d.deployedAt)}`);
      break;
  }
  return parts.filter(Boolean).join(' · ') || `checked ${ago(c.checkedAt)}`;
}

function PartCard({ title, c, part, extra }: { title: string; c: HealthComponent | undefined; part: HealthPart; extra?: ReactNode }) {
  // A newer backend part this build doesn't know, or an older backend without one: neutral, never a crash.
  const v = c ?? { status: 'unknown' as const, detail: 'The server did not report this.', checkedAt: '', data: {} };
  const l = LEVEL[v.status] ?? LEVEL.unknown;
  const detail = v.detail.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, (iso) => dateTime(iso));
  return (
    <article className={`health-part ${v.status}`}>
      <div className="health-part-head">
        <h3>{title}</h3>
        <span className={`chip ${l.chip}`}>
          <span className="health-mark" aria-hidden="true">
            {l.mark}
          </span>
          {l.label}
        </span>
      </div>
      <p className="health-detail" title={detail}>
        {detail}
      </p>
      <p className="tiny muted health-fact">{factLine(part, v as HealthComponent)}</p>
      {extra}
    </article>
  );
}

function TestAlert({ disabled }: { disabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'gain' | 'loss' | 'brass'; text: string } | null>(null);
  const send = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.testAlert();
      if (r.ok) setResult({ tone: 'gain', text: 'Sent. Check your inbox.' });
      else if (!r.configured) setResult({ tone: 'brass', text: r.error ?? 'Not sent: alert mails are not set up on the server.' });
      else setResult({ tone: 'loss', text: `Not sent: ${r.error ?? 'the mail service refused it.'}` });
    } catch (e) {
      setResult({ tone: 'loss', text: `Not sent: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="health-test">
      <button className="btn ghost small" disabled={busy || disabled} onClick={() => void send()}>
        {busy ? 'Sending…' : 'Send test mail'}
      </button>
      {result && (
        <span className={`small ${result.tone === 'gain' ? 'gain' : result.tone === 'loss' ? 'loss' : 'soft'}`} role="status">
          {result.text}
        </span>
      )}
    </div>
  );
}

const headline = (d: HealthDetail) =>
  d.status === 'fail' ? 'Something needs you' : d.status === 'warn' ? 'Working, with something to look at' : d.bot.enabled ? 'Everything is working' : 'Everything is fine; the bot is switched off';

function Verdict({ feed }: { feed: HealthFeed }) {
  const { data, error, lastOkAt, checking } = feed;
  if (error) {
    return (
      <section className="health-verdict down" role="alert">
        <div className="health-verdict-mark" aria-hidden="true">
          ×
        </div>
        <div style={{ minWidth: 0 }}>
          <h2>{error.status ? 'The bot’s server is answering with errors' : 'Can’t reach the bot’s server'}</h2>
          <p>
            The bot may still be trading, or it may be down: this page can’t tell, so nothing here is current. {lastOkAt ? `Last good answer at ${timeOnly(lastOkAt)}, ${ago(lastOkAt)}.` : 'There has been no good answer since this page opened.'}
          </p>
          <p className="health-why">
            {error.status ? `${error.status}: ` : ''}
            {error.message}
          </p>
          <div className="row" style={{ gap: 12 }}>
            <button className="btn small" disabled={checking} onClick={() => void refreshHealth()}>
              {checking ? 'Trying…' : 'Try again'}
            </button>
            <a href="https://status.bas-franke.com" target="_blank" rel="noreferrer">
              Status page
            </a>
          </div>
        </div>
      </section>
    );
  }
  if (!data)
    return (
      <section className="health-verdict" aria-busy="true">
        <Skeleton h={64} />
      </section>
    );
  const stale = lastOkAt !== null && Date.now() - lastOkAt > STALE_MS;
  if (stale)
    return (
      <section className="health-verdict unknown">
        <div className="health-verdict-mark" aria-hidden="true">
          ?
        </div>
        <div>
          <h2>Checking…</h2>
          <p>The last answer is {ago(lastOkAt)} old, so it doesn’t count any more.</p>
        </div>
      </section>
    );
  const bad = (Object.keys(data.components) as HealthPart[]).filter((k) => data.components[k].status === 'fail' || data.components[k].status === 'warn');
  // Failing parts first: those are what the headline is about.
  const ordered = [...bad].sort((a, b) => Number(data.components[b].status === 'fail') - Number(data.components[a].status === 'fail'));
  return (
    <section className={`health-verdict ${data.status}`}>
      <div className="health-verdict-mark" aria-hidden="true">
        {LEVEL[data.status].mark}
      </div>
      <div style={{ minWidth: 0 }}>
        <h2>{headline(data)}</h2>
        {ordered.length > 0 && <p>{ordered.map((k) => TITLE[k] ?? k).join(', ')}.</p>}
        <div className="row health-bot">
          <ModeBadge mode={data.bot.mode} />
          <span className="chip">{data.bot.enabled ? 'Bot on' : 'Bot off'}</span>
          <span className="tiny soft health-strategy">{data.bot.strategyId}</span>
        </div>
      </div>
      <p className="tiny soft health-checked">Checked {timeOnly(data.checkedAt)}, refreshes every {REFRESH_MS / 1000} s</p>
    </section>
  );
}

function Events({ events }: { events: HealthDetail['events'] }) {
  const logs = '/logs?level=warn';
  return (
    <section className="card" aria-labelledby="events-h">
      <div className="card-head">
        <h2 id="events-h">Recent warnings and errors</h2>
        <span className="spacer" />
        <a
          className="small"
          href={logs}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            navigate(logs);
          }}
        >
          All in Logs →
        </a>
      </div>
      {events.length === 0 ? (
        <p className="small soft">No warnings or errors logged.</p>
      ) : (
        <ul className="health-events">
          {events.map((e) => (
            <li key={e.id} className={e.level}>
              <span className={`chip ${e.level === 'error' ? 'loss' : 'brass'}`}>{e.level}</span>
              <span className="health-event-text">
                <span>{e.message}</span>
                <span className="tiny muted">
                  {dateTime(e.ts)} · <code>{e.event}</code>
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function HealthPage() {
  useHealthFeed(REFRESH_MS);
  const feed = useHealth();
  const { data, error, lastOkAt } = feed;
  const old = !!error;
  const hasUnknown = !!data && Object.values(data.components).some((c) => c.status === 'unknown');

  return (
    <div className="stack health-page">
      <div className="page-head">
        <div>
          <span className="eyebrow">Health</span>
          <h1>Is the bot all right?</h1>
          <p className="lede">Every part of the bot, checked on the server. The page refreshes itself while you look at it.</p>
        </div>
      </div>

      <Verdict feed={feed} />

      {data ? (
        <div className={`health-parts${old ? ' old' : ''}`}>
          {old && (
            <p className="small health-old" role="note">
              Last known state, from {lastOkAt ? ago(lastOkAt) : 'earlier'}. Not current.
            </p>
          )}
          {GROUPS.map((g) => (
            <section key={g.title} aria-label={g.title}>
              <h2 className="eyebrow">{g.title}</h2>
              <div className="health-grid">
                {g.parts.map((p) => (
                  <PartCard
                    key={p.key}
                    part={p.key}
                    title={p.title}
                    c={data.components[p.key]}
                    extra={p.key === 'alerts' ? <TestAlert disabled={old} /> : undefined}
                  />
                ))}
              </div>
            </section>
          ))}
          {hasUnknown && (
            <p className="small soft health-note">
              <b>Unknown</b> means this page can’t tell yet: nothing of the kind has happened since the last restart, or that part could not be read. It doesn’t
              count toward the overall state.
              <Tip>A bot that has just restarted shows several of these until its first decision and its first lab call. They clear by themselves.</Tip>
            </p>
          )}
        </div>
      ) : (
        !error && (
          <div className="health-grid" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} h={118} r={14} />
            ))}
          </div>
        )
      )}

      {data && !old && <Events events={data.events} />}
    </div>
  );
}
