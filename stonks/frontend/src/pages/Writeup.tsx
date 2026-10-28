import { useMemo, useState } from 'react';
import { api } from '../api';
import { LineChart, type LineSeries } from '../components/charts';
import { ErrorBox, Fold, Skeleton, useAsync } from '../components/ui';
import { eur } from '../format';
import { navigate, useLocation } from '../router';
import { BUCKET_NAMES, type Writeup, type WriteupChart, type WriteupCoin, type WriteupSection } from '../types';

// A long-form explanation of one strategy (SPEC §8b): /writeup?spec=<spec id>. The content is stored in the database.

const COLORS: Record<string, string> = {
  ink: 'var(--ink)', ink2: 'var(--ink-2)', ink3: 'var(--ink-3)', brass: 'var(--brass)', s2: 'var(--s2)', loss: 'var(--loss)', gain: 'var(--gain)',
};
const color = (c?: string) => (c ? (COLORS[c] ?? c) : 'var(--ink)');
const FORMATS: Record<string, (v: number) => string> = {
  eur: (v) => `€${Math.round(v).toLocaleString('en-US')}`,
  num3: (v) => v.toFixed(3),
  pct: (v) => `${Math.round(v)}%`,
};

const BACK_BUCKETS = new Set<string>([...BUCKET_NAMES, 'hall']);

export default function WriteupPage() {
  const { query } = useLocation();
  const id = query.get('spec') ?? '';
  const asked = query.get('bucket') ?? '';
  const back = BACK_BUCKETS.has(asked) ? asked : 'mixed';
  const w = useAsync(() => api.writeup(id), [id]);
  return (
    <div className="stack writeup" style={{ gap: 12 }}>
      <div className="page-head">
        <div>
          <span className="eyebrow">
            <a href={`/research?bucket=${encodeURIComponent(back)}`} onClick={(e) => (e.preventDefault(), navigate(`/research?bucket=${encodeURIComponent(back)}`))}>
              ← Research
            </a>
          </span>
          <h1>{w.data?.title ?? 'Strategy write-up'}</h1>
          {w.data?.subtitle && <p className="lede">{w.data.subtitle}</p>}
        </div>
      </div>
      {w.error && <ErrorBox error={w.error} onRetry={w.reload} />}
      {!w.data && !w.error && <Skeleton h={400} />}
      {w.data && <Toc doc={w.data} />}
      {w.data?.sections.map((s, i) =>
        hasCoinBoard(w.data!) && s.key?.startsWith('coin-') ? null : <Section key={i} s={s} n={i} />,
      )}
    </div>
  );
}

const hasCoinBoard = (doc: Writeup) => doc.sections.some((s) => (s.coins?.length ?? 0) > 0);

function Toc({ doc }: { doc: Writeup }) {
  const board = hasCoinBoard(doc);
  const examples = doc.sections.filter((s) => s.type === 'example' && !(board && s.key?.startsWith('coin-')));
  if (!examples.length && !board) return null;
  return (
    <nav className="card quiet writeup-toc" aria-label="Examples">
      <div className="eyebrow">Examples in this write-up</div>
      <ol>
        {examples.map((s) => (
          <li key={s.key}>
            <a href={`#ex-${s.key}`}>{s.title}</a> <span className={`chip ${s.trades ? 'brass' : 'outline'}`}>{s.trades ? 'trades' : 'no trade'}</span>
          </li>
        ))}
        {board && (
          <li>
            <a href="#coin-board">Every coin, strategy against holding</a>
          </li>
        )}
      </ol>
    </nav>
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
  const pick = (id: string) => {
    setCoinId(id);
    document.getElementById('coin-board')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  return (
    <section className="card" id={coins.length ? 'coin-board' : undefined}>
      <h2>{s.title}</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>{(s.head ?? []).map((h) => <th key={h}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {(s.rows ?? []).map((r, i) => (
              <tr key={i} className={coins.length && r[0] === coin?.id ? 'is-picked' : undefined}>
                {r.map((c, j) => (
                  <td key={j}>
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
    if (range.price?.length) {
      const cheap = Math.max(...range.price.map(([, v]) => Math.abs(v))) < 20;
      out.push({
        title: `${coin.id} price, ${range.label.toLowerCase()}`,
        yFormat: cheap ? 'num3' : 'eur',
        height: 220,
        series: [{ name: `${coin.id} price`, color: 'ink', points: range.price }],
        band: range.band ? { name: `Share of the portfolio in ${coin.id}`, points: range.band } : undefined,
      });
    }
    out.push(
      {
        title: `€1,000, ${range.label.toLowerCase()}: strategy and holding`,
        yFormat: 'eur',
        height: 240,
        baseline: 1000,
        baselineLabel: '€1,000 start',
        series: [
          { name: 'This strategy', color: 'brass', points: range.equity },
          { name: `Holding ${coin.id}`, color: 'ink2', dash: '7 5', points: range.holdEquity },
        ],
      },
      {
        title: 'Strategy minus holding, at every hour',
        yFormat: 'eur',
        height: 170,
        baseline: 0,
        baselineLabel: 'level',
        series: [{ name: 'Ahead of holding', color: 'brass', points: gap }],
      },
    );
    return out;
  }, [coin, range]);
  const gap = range.strategy - range.hold;
  return (
    <div className="writeup-board">
      <div className="writeup-picks" role="tablist" aria-label="Coin">
        {coins.map((c) => (
          <button key={c.id} type="button" className={`chip ${c.id === coin.id ? 'brass' : 'outline'}`} aria-pressed={c.id === coin.id} onClick={() => onCoin(c.id)}>
            {c.id}
          </button>
        ))}
      </div>
      <div className="writeup-picks" role="tablist" aria-label="Stretch">
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
          Move along either line and both values are for that hour. The lower chart is the strategy minus holding at every hour.
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
            <svg viewBox={`0 0 80 ${H}`} width="80" height={H} role="img" aria-label={`${c.label}: ${c.note}`}>
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
        <p className="small">
          Strategy <b className={r.strategy >= r.hold ? 'gain' : 'loss'}>{eur(r.strategy)}</b> · holding {s.holdName ?? 'ETH'} <b>{eur(r.hold)}</b>
        </p>
      )}
      <div className="writeup-charts">{(s.charts ?? []).map((c, i) => <Chart key={`${n}-${i}`} c={c} />)}</div>
      <Fold title="What happened">
        {s.eli5 && <p className="notes">“{s.eli5}”</p>}
        <Paragraphs text={s.story} />
        <div>
          <div className="eyebrow">What the bot does here</div>
          {s.events && s.events.length ? (
            <ul>
              {s.events.map((e) => (
                <li key={e.ts}>
                  <span className="mono small soft">{new Date(e.ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC</span>{' '}
                  {e.text}
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
