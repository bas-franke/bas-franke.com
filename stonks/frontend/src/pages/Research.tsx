import { useMemo } from 'react';
import { api } from '../api';
import { EmptyState } from '../components/art';
import { LineChart, Spark, type LineSeries } from '../components/charts';
import { IconCheck } from '../components/icons';
import { ErrorBox, Skeleton, Tip, useAsync } from '../components/ui';
import { ago, dateOnly, eur, familyLabel, pct, toDate } from '../format';
import { navigate, setHandoff } from '../router';
import type { Benchmark, ResearchEntry, ResearchPayload, Series } from '../types';

const RANK_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)'];
const BENCH_STYLE = [
  { color: 'var(--ink-2)', dash: '7 5' },
  { color: 'var(--ink-3)', dash: '1 5' },
  { color: 'var(--ink-3)', dash: '12 4 2 4' },
];

const toPts = (s: Series | undefined): [number, number][] =>
  (s ?? []).map(([t, v]) => [toDate(t)?.getTime() ?? 0, Number(v)] as [number, number]).filter(([t]) => t > 0);

const euroAxis = (v: number) => `€${Math.round(v).toLocaleString('en-US')}`;

export default function ResearchPage() {
  const r = useAsync(() => api.research(), []);
  if (r.error) return <ErrorBox error={r.error} onRetry={r.reload} />;
  if (!r.data)
    return (
      <div className="stack">
        <Skeleton h={60} w="45%" />
        <div className="card">
          <Skeleton h={90} />
        </div>
        <div className="card">
          <Skeleton h={340} />
        </div>
      </div>
    );
  if ('empty' in r.data && r.data.empty) {
    return (
      <div className="stack">
        <Head />
        <section className="card">
          <EmptyState title="No research yet">
            The research lab on the home PC hasn’t uploaded its findings. Once it has run a few rounds of backtests, the five best strategies show up
            here with plain explanations of how they work.
          </EmptyState>
        </section>
      </div>
    );
  }
  return <Research data={r.data as ResearchPayload} />;
}

const Head = ({ data }: { data?: ResearchPayload }) => (
  <div className="page-head">
    <div>
      <span className="eyebrow">Research</span>
      <h1>What the lab found</h1>
      <p className="lede">
        Thousands of strategies were tested on years of past prices, each starting with €1,000. These are the five that held up best on data they
        had never seen, explained in plain words.
      </p>
    </div>
    {data && <span className="chip outline">updated {ago(data.generatedAt)}</span>}
  </div>
);

function Research({ data }: { data: ResearchPayload }) {
  const top = [...data.top].sort((a, b) => a.rank - b.rank).slice(0, 5);
  const benches = [data.benchmark, ...(data.benchmarks ?? [])].filter(Boolean);
  const s = data.summary;
  return (
    <div className="stack" style={{ gap: 26 }}>
      <Head data={data} />

      <section className="card summary-strip" aria-label="Research summary">
        <div>
          <div className="eyebrow">Experiments</div>
          <div className="mid-num">{s.experiments.toLocaleString('en-US')}</div>
        </div>
        <div>
          <div className="eyebrow">Families tried</div>
          <div className="mid-num">{s.families}</div>
        </div>
        <div>
          <div className="eyebrow">Rounds</div>
          <div className="mid-num">{s.rounds}</div>
        </div>
        <div>
          <div className="eyebrow">Price history</div>
          <div className="mid-num" style={{ fontSize: '1.05rem', paddingTop: 6 }}>
            {dateOnly(s.dataRange[0])} – {dateOnly(s.dataRange[1])}
          </div>
        </div>
        <div>
          <div className="eyebrow">Last update</div>
          <div className="mid-num" style={{ fontSize: '1.05rem', paddingTop: 6 }}>
            {new Date(data.generatedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      </section>

      {s.notes && (
        <section className="card quiet">
          <div className="eyebrow" style={{ marginBottom: 8 }}>
            Notes from the lab
          </div>
          <p className="notes">“{s.notes}”</p>
        </section>
      )}

      {top.map((e, i) => (
        <RankCard key={e.spec.id} e={e} color={RANK_COLORS[i]} />
      ))}

      <Compare top={top} benches={benches} />

      <p className="footnote">
        <b>An honest note.</b> These results come from backtests: simulations on past prices, with Bitvavo’s fees and a careful fill model. They are
        not a forecast, and a strategy that did well before can do badly next month. Simply buying and holding is shown everywhere as the yardstick to
        beat, not as a candidate. The numbers are from the test period, which the strategies were not tuned on.
      </p>
    </div>
  );
}

const METRIC_TIPS: Record<string, string> = {
  final: 'What €1,000 would have grown (or shrunk) to by the end of the test period, after all fees.',
  ret: 'The total gain or loss over the test period, in percent.',
  vs: 'How many percentage points better (+) or worse (−) than simply buying the same coin(s) on day one and holding them.',
  dd: 'The biggest fall from a high point to a later low. A gut-check: how much would you have watched disappear at the worst moment?',
  win: 'The share of trades that closed with a profit. Trend strategies often win less than half the time but win bigger.',
  trades: 'How many buys and sells it made. More trades means more fees and more chances to be wrong.',
  fees: 'Total fees paid to Bitvavo over the test period (0.15% for orders that wait, 0.25% for orders that fill at once).',
  sharpe: 'Return per unit of bumpiness. Above 1 is good, above 2 is excellent; it rewards smooth growth over wild swings.',
};

function Metric({ label, tip, value, cls }: { label: string; tip: string; value: string; cls?: string }) {
  return (
    <div className="metric">
      <div className="m-label">
        {label}
        <Tip>{tip}</Tip>
      </div>
      <div className={`m-value ${cls ?? ''}`}>{value}</div>
    </div>
  );
}

function RankCard({ e, color }: { e: ResearchEntry; color: string }) {
  const m = e.metrics;
  const s = e.spec;
  const series: LineSeries[] = useMemo(
    () => [
      { name: 'This strategy', color, points: toPts(e.equity), area: true, width: 2.25 },
      { name: `Buy & hold ${s.markets.length > 1 ? 'the same coins' : s.markets[0]?.split('-')[0]}`, color: 'var(--ink-3)', dash: '6 5', points: toPts(e.buyHoldEquity) },
    ],
    [e, color, s.markets],
  );
  const markets = s.markets.length > 3 ? `${s.markets.length} markets` : s.markets.join(', ');
  return (
    <article className="card rank-card" style={{ ['--rank-color' as string]: color }}>
      <header className="rank-head">
        <div className="rank-badge" aria-label={`Rank ${e.rank}`}>
          {e.rank}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2>{s.name}</h2>
          <div className="row" style={{ marginTop: 8, gap: 6 }}>
            <span className="chip brass">{familyLabel(s.family)}</span>
            <span className="chip">every {s.interval}</span>
            <span className="chip outline" title={s.markets.join(', ')}>
              {markets}
            </span>
            {e.botReady ? (
              <span className="chip gain">
                <IconCheck width={13} /> bot-ready
              </span>
            ) : (
              <span className="chip outline muted">not yet runnable</span>
            )}
          </div>
        </div>
      </header>

      <p className="notes" style={{ fontStyle: 'normal', color: 'var(--ink)', fontSize: '1.12rem' }}>
        {e.explanation.summary}
      </p>

      <div className="rank-body">
        <div className="stack" style={{ gap: 18 }}>
          <div className="metrics">
            <Metric label="€1,000 became" tip={METRIC_TIPS.final} value={eur(m.finalEur, true)} />
            <Metric label="Return" tip={METRIC_TIPS.ret} value={pct(m.returnPct, 1, true)} cls={m.returnPct >= 0 ? 'gain' : 'loss'} />
            <Metric label="vs buy & hold" tip={METRIC_TIPS.vs} value={`${pct(m.vsBuyHoldPct, 1, true)}`} cls={m.vsBuyHoldPct >= 0 ? 'gain' : 'loss'} />
            <Metric label="Worst drop" tip={METRIC_TIPS.dd} value={pct(-Math.abs(m.maxDrawdownPct), 1)} />
            <Metric label="Win rate" tip={METRIC_TIPS.win} value={pct(m.winRatePct, 0)} />
            <Metric label="Trades" tip={METRIC_TIPS.trades} value={m.trades.toLocaleString('en-US')} />
            <Metric label="Fees paid" tip={METRIC_TIPS.fees} value={eur(m.feesEur, true)} />
            <Metric label="Sharpe" tip={METRIC_TIPS.sharpe} value={m.sharpe.toFixed(2)} />
          </div>
          <LineChart
            series={series}
            height={220}
            ariaLabel={`Value of €1,000 with ${s.name} versus buy and hold`}
            yFormat={euroAxis}
            tipFormat={(v) => eur(v)}
            baseline={1000}
            baselineLabel="€1,000 start"
          />
          <p className="tiny muted">
            Test period {m.testPeriod ? `${dateOnly(m.testPeriod[0])} – ${dateOnly(m.testPeriod[1])}` : ''}
            {m.trainReturnPct !== undefined ? ` · on the tuning period it made ${pct(m.trainReturnPct, 0, true)}` : ''}
            {m.exposurePct !== undefined ? ` · in the market ${pct(m.exposurePct, 0)} of the time` : ''}
          </p>
        </div>

        <div className="stack" style={{ gap: 18 }}>
          <div>
            <div className="eyebrow" style={{ marginBottom: 10 }}>
              How it works
            </div>
            <ol className="steps">
              {e.explanation.howItWorks.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </div>
          <div className="wl">
            <div className="win">
              <h4>When it wins</h4>
              {e.explanation.whenItWins}
            </div>
            <div className="lose">
              <h4>When it loses</h4>
              {e.explanation.whenItLoses}
            </div>
          </div>
          <div className="vs-bh">
            <div className="eyebrow" style={{ marginBottom: 4 }}>
              Compared with just holding
            </div>
            {e.explanation.vsBuyHold}
          </div>
        </div>
      </div>

      <footer className="row" style={{ borderTop: '1px solid var(--line)', paddingTop: 16 }}>
        {e.lineage && (
          <span className="tiny muted mono">
            {e.lineage.experimentId}
            {e.lineage.agent ? ` · ${e.lineage.agent}` : ''}
            {e.lineage.round !== undefined ? ` · round ${e.lineage.round}` : ''}
          </span>
        )}
        <span className="spacer" />
        {e.botReady ? (
          <button
            className="btn brass"
            onClick={() => {
              setHandoff({ spec: e.spec, rank: e.rank });
              navigate('/settings');
            }}
          >
            Use this strategy
          </button>
        ) : (
          <span className="small muted">The bot can’t run this family yet.</span>
        )}
      </footer>
    </article>
  );
}

function Compare({ top, benches }: { top: ResearchEntry[]; benches: Benchmark[] }) {
  const series: LineSeries[] = useMemo(
    () => [
      ...top.map((e, i) => ({ name: `#${e.rank} ${familyLabel(e.spec.family)}`, color: RANK_COLORS[i], points: toPts(e.equity) })),
      ...benches.map((b, i) => ({ name: b.name, ...BENCH_STYLE[i % BENCH_STYLE.length], width: 1.6, points: toPts(b.equity) })),
    ],
    [top, benches],
  );
  const maxDd = (s: Series) => {
    let peak = -Infinity;
    let dd = 0;
    for (const [, v] of s) {
      peak = Math.max(peak, Number(v));
      dd = Math.max(dd, (peak - Number(v)) / peak);
    }
    return dd * 100;
  };
  return (
    <section className="card">
      <div className="card-head">
        <h2 style={{ marginRight: 'auto' }}>All five side by side</h2>
      </div>
      <p className="small soft" style={{ marginBottom: 16, maxWidth: '70ch' }}>
        €1,000 in each, over the test period. The dashed and dotted lines are the yardsticks: simply buying and holding.
      </p>
      <LineChart series={series} height={300} ariaLabel="All five strategies and the buy-and-hold benchmarks" yFormat={euroAxis} tipFormat={(v) => eur(v, true)} baseline={1000} />
      <div className="table-wrap" style={{ marginTop: 18 }}>
        <table className="data cards">
          <thead>
            <tr>
              <th>Strategy</th>
              <th className="r">€1,000 became</th>
              <th className="r">Return</th>
              <th className="r">Worst drop</th>
              <th className="r">Sharpe</th>
              <th className="r">Trades</th>
              <th className="hide-sm">Shape</th>
            </tr>
          </thead>
          <tbody>
            {top.map((e, i) => (
              <tr key={e.spec.id}>
                <td className="full">
                  <span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                    <span className="swatch" style={{ color: RANK_COLORS[i] }} />
                    <b>#{e.rank}</b> <span style={{ minWidth: 0 }}>{e.spec.name}</span>
                  </span>
                </td>
                <td data-label="€1,000 became" className="r">
                  {eur(e.metrics.finalEur, true)}
                </td>
                <td data-label="Return" className={`r ${e.metrics.returnPct >= 0 ? 'gain' : 'loss'}`}>
                  {pct(e.metrics.returnPct, 1, true)}
                </td>
                <td data-label="Worst drop" className="r">
                  {pct(-Math.abs(e.metrics.maxDrawdownPct), 1)}
                </td>
                <td data-label="Sharpe" className="r">
                  {e.metrics.sharpe.toFixed(2)}
                </td>
                <td data-label="Trades" className="r">
                  {e.metrics.trades}
                </td>
                <td className="hide-sm">
                  <Spark points={toPts(e.equity)} color={RANK_COLORS[i]} />
                </td>
              </tr>
            ))}
            {benches.map((b, i) => {
              const pts = toPts(b.equity);
              const final = pts.length ? pts[pts.length - 1][1] : 1000 * (1 + b.returnPct / 100);
              return (
                <tr key={b.name} style={{ background: 'var(--surface-2)' }}>
                  <td className="full">
                    <span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                      <span className={`swatch ${BENCH_STYLE[i % 3].dash.startsWith('1 ') ? 'dotted' : 'dashed'}`} style={{ color: BENCH_STYLE[i % 3].color }} />
                      <span className="soft">{b.name}</span>
                      <span className="chip" style={{ padding: '0 8px' }}>
                        yardstick
                      </span>
                    </span>
                  </td>
                  <td data-label="€1,000 became" className="r">
                    {eur(final, true)}
                  </td>
                  <td data-label="Return" className={`r ${b.returnPct >= 0 ? 'gain' : 'loss'}`}>
                    {pct(b.returnPct, 1, true)}
                  </td>
                  <td data-label="Worst drop" className="r">
                    {pct(-Math.abs(b.maxDrawdownPct ?? maxDd(b.equity)), 1)}
                  </td>
                  <td data-label="Sharpe" className="r muted">
                    –
                  </td>
                  <td data-label="Trades" className="r muted">
                    1
                  </td>
                  <td className="hide-sm">
                    <Spark points={pts} color={BENCH_STYLE[i % 3].color} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
