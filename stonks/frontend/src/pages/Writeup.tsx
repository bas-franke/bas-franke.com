import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { api } from '../api';
import { PageBanner } from '../components/art';
import { LineChart, type LineSeries } from '../components/charts';
import { ErrorBox, Fold, Skeleton, useAsync } from '../components/ui';
import { eur } from '../format';
import { navigate, useLocation } from '../router';
import './reading.css';
import type { Writeup, WriteupChart, WriteupCoin, WriteupSection } from '../types';

// A long-form explanation of one strategy (SPEC §8b): /writeup?spec=<spec id>. The content is stored in the database.

const COLORS: Record<string, string> = {
  ink: 'var(--ink)', ink2: 'var(--ink-2)', ink3: 'var(--ink-3)', brass: 'var(--brass)', s2: 'var(--s2)', loss: 'var(--loss)', gain: 'var(--gain)',
};
const color = (c?: string) => (c ? (COLORS[c] ?? c) : 'var(--ink)');
const FORMATS: Record<string, (v: number) => string> = {
  eur: (v) => `€${Math.round(v).toLocaleString('en-US')}`,
  num3: (v) => v.toFixed(3),
  pct: (v) => `${Math.round(v)}%`,
  idx: (v) => Math.round(v).toLocaleString('en-US'),
  px: (v) => {
    const a = Math.abs(v);
    if (a >= 20) return `€${Math.round(v).toLocaleString('en-US')}`;
    if (a >= 1) return v.toFixed(3);
    if (a >= 0.01) return v.toFixed(4);
    return v.toPrecision(3);
  },
};

function fromStart(points: [number, number][], to: number): [number, number][] {
  const base = points[0]?.[1];
  if (!base) return points;
  return points.map(([t, v]) => [t, Math.round((v / base) * to * 1e6) / 1e6]);
}

export default function WriteupPage() {
  const { query } = useLocation();
  const id = query.get('spec') ?? '';
  const asked = query.get('bucket') ?? '';
  const back = /^session\d+$/.test(asked) || asked === 'hall' ? asked : '';
  const w = useAsync(() => api.writeup(id), [id]);
  return (
    <div className="stack writeup" style={{ gap: 12 }}>
      <PageBanner
        art="banner-research"
        eyebrow={
          <a href={back ? `/research?bucket=${encodeURIComponent(back)}` : '/research'} onClick={(e) => (e.preventDefault(), navigate(back ? `/research?bucket=${encodeURIComponent(back)}` : '/research'))}>
            ← Research
          </a>
        }
        title={w.data?.title ?? 'Strategy write-up'}
        lede={w.data?.subtitle}
      />
      {w.error && <ErrorBox error={w.error} onRetry={w.reload} />}
      {!w.data && !w.error && <Skeleton h={400} />}
      {w.data && <Toc doc={w.data} />}
      {w.data?.sections.map((s, i) =>
        hasCoinBoard(w.data!) && s.key?.startsWith('coin-') ? null : <Section key={i} s={s} n={i} />,
      )}
      {w.data && <ToTop />}
    </div>
  );
}

const hasCoinBoard = (doc: Writeup) => doc.sections.some((s) => (s.coins?.length ?? 0) > 0);

function Toc({ doc }: { doc: Writeup }) {
  const board = hasCoinBoard(doc);
  const examples = doc.sections.filter((s) => s.type === 'example' && !(board && s.key?.startsWith('coin-')));
  // Open on wide screens; on a phone the list would fill the first screen, so it starts folded.
  const [open] = useState(() => !window.matchMedia('(max-width: 760px)').matches);
  if (!examples.length && !board) return null;
  const jump = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    history.replaceState(history.state, '', `#${id}`);
  };
  return (
    <nav className="card quiet writeup-toc" id="writeup-toc" aria-label="Examples">
      <details open={open}>
        <summary>
          <span className="eyebrow">Examples in this write-up</span>
          <span className="count">{examples.length + (board ? 1 : 0)}</span>
        </summary>
        <ol>
          {examples.map((s) => (
            <li key={s.key}>
              <a href={`#ex-${s.key}`} onClick={(e) => jump(e, `ex-${s.key}`)}>
                {s.title}
              </a>
              <span className={`chip ${s.trades ? 'brass' : 'outline'}`}>{s.trades ? 'trades' : 'no trade'}</span>
            </li>
          ))}
          {board && (
            <li>
              <a href="#coin-board" onClick={(e) => jump(e, 'coin-board')}>
                Every coin, strategy against holding
              </a>
            </li>
          )}
        </ol>
      </details>
    </nav>
  );
}

/** Floating button back to the list of examples, shown once the reader has scrolled past it. */
function ToTop() {
  const [shown, setShown] = useState(false);
  const frame = useRef(0);
  useEffect(() => {
    const check = () => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        const toc = document.getElementById('writeup-toc');
        setShown(toc ? toc.getBoundingClientRect().bottom < 0 : window.scrollY > 900);
      });
    };
    check();
    window.addEventListener('scroll', check, { passive: true });
    return () => (window.removeEventListener('scroll', check), cancelAnimationFrame(frame.current));
  }, []);
  const go = () => {
    const toc = document.getElementById('writeup-toc');
    toc?.querySelector('details')?.setAttribute('open', '');
    toc?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <button type="button" className={`writeup-totop${shown ? ' is-shown' : ''}`} onClick={go} aria-hidden={!shown} tabIndex={shown ? 0 : -1}>
      ↑ Examples
    </button>
  );
}

function Paragraphs({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <>
      {text.split(/\n\n+/).map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </>
  );
}

function CoinTable({ s }: { s: WriteupSection }) {
  const coins = s.coins ?? [];
  const [coinId, setCoinId] = useState(coins[0]?.id ?? '');
  const coin = coins.find((c) => c.id === coinId) ?? coins[0];
  const [rangeId, setRangeId] = useState(coin?.ranges[0]?.id ?? 'year');
  const range = coin?.ranges.find((r) => r.id === rangeId) ?? coin?.ranges[0];
  // `compact` lists the columns shown at first; the rest appear behind "Show all columns".
  const [all, setAll] = useState(false);
  const cols = (s.head ?? []).map((_, j) => j).filter((j) => all || !s.compact || s.compact.includes(j));
  const pick = (id: string) => {
    setCoinId(id);
    document.getElementById('coin-charts')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <section className="card" id={coins.length ? 'coin-board' : undefined}>
      <h2>{s.title}</h2>
      {coins.length > 0 && <p className="small soft writeup-hint">Tap a coin to see its charts below.</p>}
      {s.compact && s.compact.length < (s.head ?? []).length && (
        <button type="button" className="chip outline writeup-cols" aria-pressed={all} onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer columns' : 'Show all columns'}
        </button>
      )}
      <div className="table-wrap writeup-table">
        <table className="data">
          <thead>
            <tr>
              {cols.map((j) => (
                <th key={j} className={j ? 'r' : undefined}>
                  {s.head![j]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(s.rows ?? []).map((r, i) => (
              <tr key={i} className={coins.length && r[0] === coin?.id ? 'is-picked' : undefined}>
                {cols.map((j) => [r[j] ?? '', j] as const).map(([c, j]) => (
                  <td key={j} className={j ? 'r' : undefined}>
                    {j === 0 && coins.some((x) => x.id === c) ? (
                      <button type="button" className="writeup-coin" aria-pressed={c === coin?.id} onClick={() => pick(c)}>
                        {c}
                      </button>
                    ) : (
                      c
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {s.body && <p className="tiny muted writeup-hint">{s.body}</p>}
      {coin && range && <CoinCharts coins={coins} coin={coin} rangeId={range.id} onCoin={setCoinId} onRange={setRangeId} />}
    </section>
  );
}

function CoinCharts({
  coins,
  coin,
  rangeId,
  onCoin,
  onRange,
}: {
  coins: WriteupCoin[];
  coin: WriteupCoin;
  rangeId: string;
  onCoin: (id: string) => void;
  onRange: (id: string) => void;
}) {
  const range = coin.ranges.find((r) => r.id === rangeId) ?? coin.ranges[0];
  const charts = useMemo(() => {
    const gap = range.equity.map(([t, v], i) => [t, Math.round((v - (range.holdEquity[i]?.[1] ?? v)) * 100) / 100] as [number, number]);
    const out: WriteupChart[] = [];
    const label = range.label.toLowerCase();
    if (range.equity.length && range.holdEquity.length) {
      out.push({
        title: `Indexed at 100, ${label}`,
        yFormat: 'idx',
        height: 220,
        baseline: 100,
        baselineLabel: '100 at the start',
        series: [
          { name: 'This strategy', color: 'brass', points: fromStart(range.equity, 100) },
          { name: `Holding ${coin.id}`, color: 'ink2', dash: '7 5', points: fromStart(range.holdEquity, 100) },
        ],
      });
    }
    if (range.price?.length && range.equity.length && range.holdEquity.length) {
      const first = range.price[0][1];
      out.push({
        title: `${coin.id} price, from its first close`,
        yFormat: Math.abs(first) < 20 ? 'px' : 'eur',
        height: 220,
        series: [
          { name: 'This strategy', color: 'brass', points: fromStart(range.equity, first) },
          { name: `Holding ${coin.id}`, color: 'ink2', dash: '7 5', points: fromStart(range.holdEquity, first) },
        ],
        band: range.band ? { name: `Share of the portfolio in ${coin.id}`, points: range.band } : undefined,
      });
    }
    out.push({
      title: 'Strategy minus holding',
      yFormat: 'eur',
      height: 170,
      baseline: 0,
      baselineLabel: 'level',
      series: [{ name: 'Ahead of holding', color: 'brass', points: gap }],
    });
    return out;
  }, [coin, range]);
  const gap = range.strategy - range.hold;
  return (
    <div className="writeup-board" id="coin-charts">
      <div className="writeup-picks" role="group" aria-label="Coin">
        {coins.map((c) => (
          <button key={c.id} type="button" className={`chip ${c.id === coin.id ? 'brass' : 'outline'}`} aria-pressed={c.id === coin.id} onClick={() => onCoin(c.id)}>
            {c.id}
          </button>
        ))}
      </div>
      <div className="writeup-picks" role="group" aria-label="Stretch">
        {coin.ranges.map((r) => (
          <button key={r.id} type="button" className={`chip ${r.id === range.id ? 'brass' : 'outline'}`} aria-pressed={r.id === range.id} onClick={() => onRange(r.id)}>
            {r.label}
          </button>
        ))}
      </div>
      <div className="writeup-compare">
        <div>
          <div className="eyebrow">This strategy</div>
          <b className={range.strategy >= range.hold ? 'gain' : 'loss'}>{eur(range.strategy)}</b>
        </div>
        <div>
          <div className="eyebrow">Holding {coin.id}</div>
          <b>{eur(range.hold)}</b>
        </div>
        <div>
          <div className="eyebrow">{gap >= 0 ? 'Ahead of holding' : 'Behind holding'}</div>
          <b className={gap >= 0 ? 'gain' : 'loss'}>{eur(Math.abs(gap))}</b>
        </div>
      </div>
      <Fold title="How to read the lines">
        <p className="small soft">
          The first chart starts both lines at 100, so coins can be compared. The price chart starts both lines at this coin’s first close, so holding tracks the coin. The lower chart is the strategy minus holding, in euros.
          {range.fees !== undefined ? ` Fees in this stretch ${eur(range.fees)}.` : ''}
          {range.trips !== undefined ? ` ${range.trips} full exits.` : ''}
          {range.exposure !== undefined && range.exposure !== null ? ` In the market ${Math.round(range.exposure)}% of the time.` : ''}
        </p>
      </Fold>
      <div className="writeup-charts">
        {charts.map((c, i) => (
          <Chart key={`${coin.id}-${range.id}-${i}`} c={c} />
        ))}
      </div>
    </div>
  );
}

function Section({ s, n }: { s: WriteupSection; n: number }) {
  switch (s.type) {
    case 'heading':
      return s.body ? (
        <section className="card quiet writeup-fold">
          <Fold title={s.title || 'Note'}>
            <Paragraphs text={s.body} />
          </Fold>
        </section>
      ) : (
        <h2 className="writeup-h">{s.title}</h2>
      );
    case 'text':
      return (
        <section className="card quiet writeup-fold">
          <Fold title={s.title || 'Notes'}>
            <div className="writeup-text">
              <Paragraphs text={s.body} />
            </div>
          </Fold>
        </section>
      );
    case 'callout':
      return (
        <section className="card quiet writeup-fold">
          <Fold title={s.title || 'Note'}>
            <div className={`callout ${s.tone === 'gain' ? 'gain' : s.tone === 'warn' ? 'loss' : 'brass'}`}>
              <Paragraphs text={s.body} />
            </div>
          </Fold>
        </section>
      );
    case 'rules':
      return (
        <section className="card quiet writeup-fold">
          <Fold title={s.title || 'The rules'}>
            <dl className="writeup-rules">
              {(s.items ?? []).map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </Fold>
        </section>
      );
    case 'table':
      return <CoinTable s={s} />;
    case 'code':
      // The exact algorithm: the strategy's own source, folded so it doesn't push the charts down.
      return (
        <section className="card quiet writeup-fold">
          <Fold title={s.title || 'Exact algorithm'}>
            {s.story && <Paragraphs text={s.story} />}
            <pre className="writeup-code">
              <code>{s.body}</code>
            </pre>
          </Fold>
        </section>
      );
    case 'candles':
      return (
        <section className="card">
          <h2>{s.title}</h2>
          <Candles candles={s.candles ?? []} />
          {s.body && (
            <Fold title="What the candles show">
              <Paragraphs text={s.body} />
            </Fold>
          )}
        </section>
      );
    case 'example':
      return <Example s={s} n={n} />;
    default:
      return null;
  }
}

/** Three hand-drawn daily candles with their wicks labelled. */
function Candles({ candles }: { candles: NonNullable<WriteupSection['candles']> }) {
  const lo = Math.min(...candles.map((c) => c.l));
  const hi = Math.max(...candles.map((c) => c.h));
  const H = 180;
  const y = (v: number) => 12 + ((hi - v) / (hi - lo || 1)) * (H - 24);
  return (
    <div className="writeup-candles">
      {candles.map((c) => {
        const up = c.c >= c.o;
        const col = up ? 'var(--gain)' : 'var(--loss)';
        return (
          <figure key={c.label}>
            <svg viewBox={`0 0 80 ${H}`} role="img" aria-label={`${c.label}: ${c.note}`}>
              <line x1="40" x2="40" y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth="2" />
              <rect x="25" width="30" y={y(Math.max(c.o, c.c))} height={Math.max(2, Math.abs(y(c.o) - y(c.c)))} fill={col} rx="2" />
            </svg>
            <figcaption>
              <b>{c.label}</b>
              <span className="small soft">{c.note}</span>
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}

/** Position change points -> a step line (each level held until the next change). */
function stepPoints(points: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  points.forEach(([t, v], i) => {
    if (i > 0) out.push([t, points[i - 1][1]]);
    out.push([t, v]);
  });
  return out;
}

function Chart({ c }: { c: WriteupChart }) {
  const series: LineSeries[] = useMemo(
    () => c.series.map((s) => ({ name: s.name, color: color(s.color), dash: s.dash, points: s.points, width: 1.8 })),
    [c],
  );
  return (
    <div className="writeup-chart">
      <div className="eyebrow">{c.title}</div>
      <LineChart
        series={series}
        height={Math.min(c.height ?? 160, 160)}
        ariaLabel={c.title}
        yFormat={FORMATS[c.yFormat ?? 'eur'] ?? FORMATS.eur}
        legend={series.length > 1}
        baseline={c.baseline}
        baselineLabel={c.baselineLabel}
      />
      {c.band && (
        <>
          <div className="tiny soft" style={{ marginTop: 6 }}>{c.band.name || 'Share of the portfolio in ETH'}</div>
          <LineChart
            series={[{ name: c.band.name || 'in the coin', color: 'var(--brass)', area: true, points: stepPoints(c.band.points), width: 2 }]}
            height={80}
            legend={false}
            baseline={0}
            ariaLabel={c.band.name || 'Share of the portfolio in ETH'}
            yFormat={(v) => (v > 100.5 || v < -0.5 ? '' : `${Math.round(v)}%`)}
          />
        </>
      )}
    </div>
  );
}

function Example({ s, n }: { s: WriteupSection; n: number }) {
  const r = s.result;
  return (
    <section className="card writeup-example" id={`ex-${s.key}`}>
      <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <h2 style={{ marginRight: 'auto' }}>{s.title}</h2>
        <span className={`chip ${s.trades ? 'brass' : 'outline'}`}>{s.trades ? 'trades' : 'no trade'}</span>
      </div>
      {r && (
        <div className="writeup-compare">
          <div>
            <div className="eyebrow">This strategy</div>
            <b className={r.strategy >= r.hold ? 'gain' : 'loss'}>{eur(r.strategy)}</b>
          </div>
          <div>
            <div className="eyebrow">Holding {s.holdName ?? 'ETH'}</div>
            <b>{eur(r.hold)}</b>
          </div>
        </div>
      )}
      <div className="writeup-charts">{(s.charts ?? []).map((c, i) => <Chart key={`${n}-${i}`} c={c} />)}</div>
      <Fold title="What happened">
        {s.eli5 && <p className="notes">“{s.eli5}”</p>}
        <Paragraphs text={s.story} />
        <div>
          <div className="eyebrow">What the bot does here</div>
          {s.events && s.events.length ? (
            <ul className="writeup-events">
              {s.events.map((e) => (
                <li key={e.ts}>
                  <span className="mono small soft">{new Date(e.ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC</span>
                  <span>{e.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small">Nothing: no orders in this stretch (it {s.startPosition ? 'keeps holding ETH' : 'stays in euros'}).</p>
          )}
        </div>
        {s.verdict && <div className="callout brass">{s.verdict}</div>}
      </Fold>
    </section>
  );
}
