import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import { EmptyState } from '../components/art';
import { LineChart, Spark, type LineSeries } from '../components/charts';
import { IconCheck } from '../components/icons';
import { ErrorBox, ModeBadge, Modal, Skeleton, Tip, useAsync, useToast } from '../components/ui';
import { ago, dateOnly, eur, familyLabel, lossLimitText, pct, toDate } from '../format';
import { navigate, setHandoff, useLocation } from '../router';
import { BUCKET_NAMES, type Benchmark, type BucketName, type HallEntry, type Overview, type ResearchBucket, type ResearchEntry, type ResearchPayload, type Series } from '../types';

const RANK_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)'];
const BENCH_STYLE = [
  { color: 'var(--ink-2)', dash: '7 5' },
  { color: 'var(--ink-3)', dash: '1 5' },
  { color: 'var(--ink-3)', dash: '12 4 2 4' },
];

/** Tab titles for the timeframe buckets (SPEC §8). */
export const BUCKET_TITLES: Record<BucketName, string> = { minute: 'Minute', hourly: 'Hourly', daily: 'Daily', weekly: 'Weekly', mixed: 'Mixed', custom: 'Custom' };
const bucketTitle = (b: string) => BUCKET_TITLES[b as BucketName] ?? b;
const TAB_KEY = 'stonks-research-bucket';

const isBucket = (v: unknown): v is BucketName => BUCKET_NAMES.includes(v as BucketName);
const savedTab = (): BucketName | null => {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return isBucket(v) ? v : null;
  } catch {
    return null;
  }
};
const saveTab = (b: BucketName) => {
  try {
    localStorage.setItem(TAB_KEY, b);
  } catch {
    /* private window: just don't remember */
  }
};

const toPts = (s: Series | undefined): [number, number][] =>
  (s ?? []).map(([t, v]) => [toDate(t)?.getTime() ?? 0, Number(v)] as [number, number]).filter(([t]) => t > 0);

const euroAxis = (v: number) => `€${Math.round(v).toLocaleString('en-US')}`;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Formats a number that may be missing from an older or partial payload. */
const fx = (v: unknown, f: (n: number) => string) => (isNum(v) ? f(v) : '–');
const score = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));

export default function ResearchPage() {
  const r = useAsync(() => api.research(), []);
  const ov = useAsync(() => api.overview(), []);
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
            The research lab on the home PC hasn’t uploaded its findings. Once it has run a few rounds of backtests, the best strategies for each
            timeframe show up here with plain explanations of how they work.
          </EmptyState>
        </section>
      </div>
    );
  }
  return <Research data={r.data as ResearchPayload} overview={ov.data} onActivated={ov.reload} onReload={r.reload} />;
}

const Head = ({ data }: { data?: ResearchPayload }) => (
  <div className="page-head">
    <div>
      <span className="eyebrow">Research</span>
      <h1>What the lab found</h1>
      <p className="lede">
        Thousands of strategies were tested on years of past prices, each starting with €1,000. These are the ones that held up best on data they had
        never seen, ranked separately for minute, hourly, daily and weekly trading and for strategies that mix candle sizes, and explained in plain words.
      </p>
    </div>
    {data && <span className="chip outline">updated {ago(data.generatedAt)}</span>}
  </div>
);

/** v1 payloads have no buckets: their `top` is the daily list. */
function bucketsOf(data: ResearchPayload): Partial<Record<BucketName, ResearchBucket>> {
  if (data.buckets && Object.keys(data.buckets).length) return data.buckets;
  return { daily: { label: 'Daily trading', intervals: [], benchmark: data.benchmark, notes: '', top: data.top } };
}

function Research({
  data,
  overview,
  onActivated,
  onReload,
}: {
  data: ResearchPayload;
  overview?: Overview;
  onActivated: () => void;
  onReload: () => void;
}) {
  const { query } = useLocation();
  const buckets = bucketsOf(data);
  const names = BUCKET_NAMES.filter((b) => buckets[b]);
  const [tab, setTab] = useState<BucketName>(() => {
    const q = query.get('bucket');
    const pick = isBucket(q) ? q : savedTab();
    if (pick && buckets[pick]) return pick;
    return names.find((b) => buckets[b]!.top.length) ?? names[0] ?? 'daily';
  });
  const [pick, setPick] = useState<{ e: ResearchEntry; bucket: BucketName | 'hall'; hallId?: number } | null>(null);
  const hall = useAsync(() => api.hallOfFame().then((r) => r.entries), []);
  const writeups = useAsync(() => api.writeups().then((r) => new Set(r.writeups.map((w) => w.specId))), []);
  const [hallView, setHallView] = useState(() => query.get('bucket') === 'hall');
  const hallKeys = useMemo(() => new Set((hall.data ?? []).map((h) => JSON.stringify(h.entry.spec))), [hall.data]);
  const toast = useToast();
  const addToHall = async (e: ResearchEntry) => {
    if (data.id === undefined) return;
    try {
      await api.addToHall({ researchId: data.id, bucket: tab, rank: e.rank });
      toast(`“${e.spec.name}” is in the hall of fame. New research will never replace it.`);
    } catch (err) {
      toast((err as Error).message);
    }
    hall.reload();
  };
  const bucket = buckets[tab] ?? buckets[names[0]]!;
  const top = [...bucket.top].sort((a, b) => a.rank - b.rank).slice(0, 5);
  const benches = [bucket.benchmark ?? (data.buckets ? null : data.benchmark), ...(tab === 'daily' || !data.buckets ? (data.benchmarks ?? []) : [])].filter(
    (b): b is Benchmark => !!b,
  );
  const active = overview ? (overview.activeResearch ?? overview.bot.activeResearch ?? null) : null;
  const s = data.summary;

  // Deep link from the Overview: /research?bucket=hourly&rank=2 scrolls to that card.
  useEffect(() => {
    const rank = query.get('rank');
    if (!rank) return;
    const t = setTimeout(() => document.getElementById(`card-${tab}-${rank}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choose = (b: BucketName) => {
    setTab(b);
    saveTab(b);
    setHallView(false);
  };

  return (
    <div className="stack" style={{ gap: 26 }}>
      <Head data={data} />

      <section className="card summary-strip" aria-label="Research summary">
        <div>
          <div className="eyebrow">Experiments</div>
          <div className="mid-num">{fx(s.experiments, (n) => n.toLocaleString('en-US'))}</div>
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

      {data.buckets && (
        <div className="bucket-tabs" role="tablist" aria-label="Timeframe">
          {names.map((b) => (
            <button
              key={b}
              type="button"
              role="tab"
              id={`tab-${b}`}
              aria-selected={b === tab}
              aria-controls="bucket-panel"
              onClick={() => choose(b)}
            >
              {BUCKET_TITLES[b]}
              <span className="count">{buckets[b]!.top.length}</span>
            </button>
          ))}
          <button type="button" role="tab" id="tab-hall" aria-selected={hallView} aria-controls="bucket-panel" onClick={() => setHallView(true)}>
            ★ Hall of fame
            <span className="count">{hall.data?.length ?? 0}</span>
          </button>
        </div>
      )}

      {hallView && <HallOfFame hall={hall} active={active} onActivate={(h) => setPick({ e: h.entry, bucket: 'hall', hallId: h.id })} />}


      {!hallView && (
      <div id="bucket-panel" role={data.buckets ? 'tabpanel' : undefined} aria-labelledby={data.buckets ? `tab-${tab}` : undefined} className="stack" style={{ gap: 26 }}>
        {data.buckets && <BucketIntro name={tab} b={bucket} />}

        {top.length === 0 ? (
          <section className="card">
            <EmptyState title={`Nothing made the cut for ${bucketTitle(tab).toLowerCase()} trading yet`}>
              {bucket.notes || 'No strategy in this timeframe beat buying and holding after fees, so there is nothing worth running here yet.'}
            </EmptyState>
          </section>
        ) : (
          top.map((e, i) => (
            <RankCard
              key={e.spec.id}
              e={e}
              color={RANK_COLORS[i]}
              anchor={`card-${tab}-${e.rank}`}
              active={!!active && active.researchId === data.id && active.bucket === tab && active.rank === e.rank}
              onActivate={data.id !== undefined ? () => setPick({ e, bucket: tab }) : undefined}
              inHall={hallKeys.has(JSON.stringify(e.spec))}
              hasWriteup={!!writeups.data?.has(e.spec.id)}
              onAddToHall={data.id !== undefined && hall.data ? () => void addToHall(e) : undefined}
            />
          ))
        )}

        {top.length > 0 && <Compare top={top} benches={benches} />}
      </div>
      )}

      <p className="footnote">
        <b>An honest note.</b> These results come from backtests: simulations on past prices, with Bitvavo’s fees and a careful fill model. They are
        not a forecast, and a strategy that did well before can do badly next month. Simply buying and holding is shown everywhere as the yardstick to
        beat, not as a candidate. Scores only compare within one timeframe: each is judged on a test period that fits how long its trades last.
      </p>

      {pick && data.id !== undefined && (
        <ActivateDialog
          key={`${pick.bucket}-${pick.hallId ?? pick.e.rank}`}
          researchId={data.id}
          hallId={pick.hallId}
          bucket={pick.bucket}
          e={pick.e}
          overview={overview}
          onClose={() => setPick(null)}
          onDone={() => {
            setPick(null);
            onActivated();
          }}
          onStale={() => {
            setPick(null);
            onReload();
          }}
        />
      )}
    </div>
  );
}

function BucketIntro({ name, b }: { name: BucketName; b: ResearchBucket }) {
  const p = b.profile;
  const luck = b.luckLine;
  return (
    <section className="card quiet bucket-intro" aria-label={`${bucketTitle(name)} trading`}>
      <div className="row" style={{ gap: 8 }}>
        <h2 style={{ marginRight: 'auto' }}>{b.label || `${bucketTitle(name)} trading`}</h2>
        {b.intervals.map((iv) => (
          <span className="chip" key={iv}>
            {name === 'mixed' ? 'trades' : 'every'} {iv}
          </span>
        ))}
      </div>
      {name === 'custom' && (
        <p>
          Hand-made variants of strategies from the other tabs, each fixing one weakness. Their charts and numbers show the <b>last 30 days</b>
          {' '}on their own candles; the score is still the usual multi-year one.
        </p>
      )}
      {name === 'mixed' && (
        <p>
          Each strategy here looks at two candle sizes at once: a slow one (daily or weekly) for the long-term decision, and a fast one that watches for
          sudden drops and sells early, or the other way round.
        </p>
      )}
      {b.notes && <p className="notes">“{b.notes}”</p>}
      <div className="bucket-lines">
        <div>
          <div className="eyebrow">Yardstick</div>
          <p>
            Simply buying and holding scores <b>{fx(b.holdScore, score)}</b> here.
          </p>
        </div>
        <div>
          <div className="eyebrow">
            Luck line
            <Tip>
              The lab also runs strategies that buy and sell at random moments. Their scores show how far pure luck gets you on this timeframe; a real
              strategy should clearly beat them.
            </Tip>
          </div>
          <p>
            {isNum(luck?.best) ? (
              <>
                Random timing scores up to <b>{score(luck!.best!)}</b> here
                {isNum(luck?.median) ? <>, usually around {score(luck!.median!)}</> : null}.
              </>
            ) : (
              'No luck line for this timeframe yet.'
            )}
          </p>
        </div>
        {p && (isNum(p.holdoutDays) || isNum(p.folds)) && (
          <div>
            <div className="eyebrow">How it was judged</div>
            <p>
              {isNum(p.folds) ? `${p.folds} practice windows${isNum(p.foldSpanDays) ? ` of ${p.foldSpanDays} days` : ''}` : 'Practice windows'}
              {isNum(p.holdoutDays) ? `, then a final test on the last ${p.holdoutDays} days it never saw` : ''}.
            </p>
          </div>
        )}
      </div>
      <p className="tiny muted">Scores only compare within this timeframe. A strategy is worth a look when it beats both lines above.</p>
    </section>
  );
}

function ActivateDialog({
  researchId,
  hallId,
  bucket,
  e,
  overview,
  onClose,
  onDone,
  onStale,
}: {
  researchId: number;
  /** Set when activating a hall of fame strategy (its stored copy). */
  hallId?: number;
  bucket: BucketName | 'hall';
  e: ResearchEntry;
  overview?: Overview;
  onClose: () => void;
  onDone: () => void;
  onStale: () => void;
}) {
  const toast = useToast();
  const [start, setStart] = useState(false);
  const [liveText, setLiveText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ msg: string; stale: boolean } | null>(null);
  const bot = overview?.bot;
  const live = bot?.mode === 'live';
  const on = !!bot?.enabled;
  const current = bot?.strategy;
  const same = current?.id === e.spec.id;
  const orders = overview?.openOrders ?? 0;
  const ready = !!bot && (!live || liveText.trim().toUpperCase() === 'LIVE');

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const which = hallId !== undefined ? { hallOfFameId: hallId } : { researchId, bucket, rank: e.rank };
      const res = await api.activate({ ...which, start: !on && start, ...(live ? { confirmLive: true } : {}) });
      toast(
        res.started
          ? `Activated. The bot is awake and running ${e.spec.name}.`
          : res.startError
            ? `Activated, but the bot didn’t start: ${res.startError}`
            : on
              ? 'Activated. The bot switches to it at its next check.'
              : 'Activated. The bot is still resting; start it from the Overview whenever you like.',
      );
      onDone();
    } catch (err) {
      setError({ msg: (err as Error).message, stale: err instanceof ApiError && err.status === 409 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Activate this strategy?"
      actions={
        <>
          <button className="btn ghost" onClick={onClose}>
            Not now
          </button>
          {error?.stale ? (
            <button className="btn primary" onClick={onStale}>
              Reload the research
            </button>
          ) : (
            <button className={`btn ${live ? 'danger' : 'brass'}`} disabled={busy || !ready} onClick={submit}>
              {busy ? 'Activating…' : live ? 'Activate with real money' : !on && start ? 'Activate and start' : 'Activate'}
            </button>
          )}
        </>
      }
    >
      <div className="activate-pick">
        <div className="rank-badge small" aria-hidden="true" style={{ ['--rank-color' as string]: RANK_COLORS[(e.rank - 1) % 5] }}>
          {e.rank}
        </div>
        <div style={{ minWidth: 0 }}>
          <b>{e.spec.name}</b>
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            <span className="chip brass">{bucket === 'hall' ? '★ Hall of fame' : `${bucketTitle(bucket)} trading`}</span>
            <span className="chip">every {e.spec.interval}</span>
            {bot && <ModeBadge mode={bot.mode} />}
          </div>
        </div>
      </div>
      {!bot ? (
        <div className="callout">Loading the bot’s current state…</div>
      ) : (
        <dl className="kv">
          <dt>Mode</dt>
          <dd>{live ? 'Live: real orders with real euros' : 'Paper: simulated orders on live prices, no real money'}</dd>
          <dt>Replaces</dt>
          <dd>{same ? 'nothing, it is already the bot’s strategy' : current?.name}</dd>
          <dt>Open orders</dt>
          <dd>
            {orders === 0
              ? 'none, so nothing to cancel'
              : same
                ? `${orders} open, they stay`
                : `${orders} open order${orders === 1 ? '' : 's'} from the old strategy will be cancelled first`}
          </dd>
        </dl>
      )}
      {bot &&
        (on ? (
          <div className="callout brass">The bot is already on. It switches to this strategy at its next look at the market.</div>
        ) : (
          <label className="check">
            <input type="checkbox" checked={start} onChange={(ev) => setStart(ev.target.checked)} />
            Start the bot now
          </label>
        ))}
      {bot && !on && !start && <p className="small soft">Leave this off to set the strategy while the bot keeps resting.</p>}
      {live && (
        <>
          <div className="callout loss">
            <b>Live mode.</b> The bot will trade this strategy on your Bitvavo account with real euros. It can lose money, up to{' '}
            {lossLimitText(overview!.dailyLossLimit, overview!.dailyLossLimitEur)} in 24 hours before it stops itself.
          </div>
          <div className="field">
            <label htmlFor="activate-live">
              Type <b>LIVE</b> to confirm
            </label>
            <input id="activate-live" className="input" autoComplete="off" value={liveText} onChange={(ev) => setLiveText(ev.target.value)} />
          </div>
        </>
      )}
      {error && <div className="callout loss">{error.msg}</div>}
    </Modal>
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

function RankCard({
  e,
  color,
  anchor,
  active,
  onActivate,
  inHall,
  onAddToHall,
  origin,
  onRemove,
  hasWriteup,
}: {
  e: ResearchEntry;
  color: string;
  anchor: string;
  active: boolean;
  onActivate?: () => void;
  inHall?: boolean;
  onAddToHall?: () => void;
  /** Hall of fame cards: where and when it was kept. */
  origin?: string;
  onRemove?: () => void;
  /** A long-form write-up exists for this spec: show a button to it. */
  hasWriteup?: boolean;
}) {
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
    <article id={anchor} className={`card rank-card${active ? ' is-active' : ''}`} style={{ ['--rank-color' as string]: color }}>
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
            {isNum(m.score) && (
              <span className="chip outline" title="The lab's ranking score; only comparable within this timeframe">
                score {score(m.score)}
              </span>
            )}
            {active && (
              <span className="chip gain">
                <span className="dot" /> running in the bot
              </span>
            )}
            {origin && <span className="chip outline">{origin}</span>}
          </div>
        </div>
        {inHall ? (
          <span className="chip brass hall-star" title="In the hall of fame: kept forever">
            ★ hall of fame
          </span>
        ) : (
          onAddToHall && (
            <button className="btn ghost small hall-star" onClick={onAddToHall} title="Keep this strategy forever, whatever new research finds">
              ☆ Keep in hall of fame
            </button>
          )
        )}
      </header>

      <p className="notes" style={{ fontStyle: 'normal', color: 'var(--ink)', fontSize: '1.12rem' }}>
        {e.explanation.summary}
      </p>

      <div className="rank-body">
        <div className="stack" style={{ gap: 18 }}>
          <div className="metrics">
            <Metric label="€1,000 became" tip={METRIC_TIPS.final} value={fx(m.finalEur, (v) => eur(v, true))} />
            <Metric label="Return" tip={METRIC_TIPS.ret} value={fx(m.returnPct, (v) => pct(v, 1, true))} cls={m.returnPct >= 0 ? 'gain' : 'loss'} />
            <Metric label="vs buy & hold" tip={METRIC_TIPS.vs} value={fx(m.vsBuyHoldPct, (v) => pct(v, 1, true))} cls={m.vsBuyHoldPct >= 0 ? 'gain' : 'loss'} />
            <Metric label="Worst drop" tip={METRIC_TIPS.dd} value={fx(m.maxDrawdownPct, (v) => pct(-Math.abs(v), 1))} />
            <Metric label="Win rate" tip={METRIC_TIPS.win} value={fx(m.winRatePct, (v) => pct(v, 0))} />
            <Metric label="Trades" tip={METRIC_TIPS.trades} value={fx(m.trades, (v) => v.toLocaleString('en-US'))} />
            <Metric label="Fees paid" tip={METRIC_TIPS.fees} value={fx(m.feesEur, (v) => eur(v, true))} />
            <Metric label="Sharpe" tip={METRIC_TIPS.sharpe} value={fx(m.sharpe, (v) => v.toFixed(2))} />
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
        {hasWriteup && (
          <button className="btn small" onClick={() => navigate(`/writeup?spec=${encodeURIComponent(s.id)}`)}>
            Read the full write-up
          </button>
        )}
        {onRemove && <RemoveButton onRemove={onRemove} />}
        {e.botReady ? (
          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn ghost small"
              onClick={() => {
                setHandoff({ spec: e.spec, rank: e.rank });
                navigate('/settings');
              }}
            >
              Tweak in settings
            </button>
            {active ? (
              <span className="chip gain">
                <IconCheck width={13} /> active in the bot
              </span>
            ) : (
              onActivate && (
                <button className="btn brass" onClick={onActivate}>
                  Activate in bot
                </button>
              )
            )}
          </div>
        ) : (
          <span className="small muted">Waiting to be ported to the bot</span>
        )}
      </footer>
    </article>
  );
}

function RemoveButton({ onRemove }: { onRemove: () => void }) {
  const [sure, setSure] = useState(false);
  useEffect(() => {
    if (!sure) return;
    const t = setTimeout(() => setSure(false), 4000);
    return () => clearTimeout(t);
  }, [sure]);
  return (
    <button className={`btn small ${sure ? 'danger' : 'ghost'}`} onClick={() => (sure ? onRemove() : setSure(true))}>
      {sure ? 'Yes, remove it' : 'Remove from hall of fame'}
    </button>
  );
}

/** The strategies the owner keeps forever, newest first; they never change when new research arrives. */
function HallOfFame({
  hall,
  active,
  onActivate,
}: {
  hall: { data?: HallEntry[] | null; error?: Error | null; reload: () => void };
  active: Overview['activeResearch'] | null;
  onActivate: (h: HallEntry) => void;
}) {
  const toast = useToast();
  if (hall.error) return <ErrorBox error={hall.error} onRetry={hall.reload} />;
  if (!hall.data) return <Skeleton h={200} />;
  const remove = async (h: HallEntry) => {
    try {
      await api.removeFromHall(h.id);
      toast(`Removed “${h.entry.spec.name}” from the hall of fame.`);
    } catch (err) {
      toast((err as Error).message);
    }
    hall.reload();
  };
  return (
    <div id="bucket-panel" role="tabpanel" aria-labelledby="tab-hall" className="stack" style={{ gap: 26 }}>
      <section className="card quiet bucket-intro">
        <h2>Hall of fame</h2>
        <p className="notes" style={{ marginTop: 8 }}>
          Strategies you chose to keep. Each one is stored as it was when you kept it (results, charts and settings), so new research never replaces
          or deletes it. Only you can remove one.
        </p>
      </section>
      {hall.data.length === 0 ? (
        <section className="card">
          <EmptyState title="Nothing kept yet">Use “☆ Keep in hall of fame” on any strategy in the timeframe tabs to keep it here for good.</EmptyState>
        </section>
      ) : (
        hall.data.map((h, i) => (
          <RankCard
            key={h.id}
            e={{ ...h.entry, rank: i + 1 }}
            color={RANK_COLORS[i % RANK_COLORS.length]}
            anchor={`card-hall-${h.id}`}
            active={!!active && active.bucket === 'hall' && active.researchId === h.id}
            onActivate={() => onActivate(h)}
            origin={`kept ${dateOnly(h.addedAt)} · was ${bucketTitle(h.bucket)} #${h.rank}`}
            onRemove={() => void remove(h)}
          />
        ))
      )}
    </div>
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
        <h2 style={{ marginRight: 'auto' }}>{top.length > 1 ? `All ${top.length} side by side` : 'Next to buy and hold'}</h2>
      </div>
      <p className="small soft" style={{ marginBottom: 16, maxWidth: '70ch' }}>
        €1,000 in each, over the test period. The dashed and dotted lines are the yardsticks: simply buying and holding.
      </p>
      <LineChart series={series} height={300} ariaLabel="These strategies and the buy-and-hold benchmarks" yFormat={euroAxis} tipFormat={(v) => eur(v, true)} baseline={1000} />
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
                  {fx(e.metrics.finalEur, (v) => eur(v, true))}
                </td>
                <td data-label="Return" className={`r ${e.metrics.returnPct >= 0 ? 'gain' : 'loss'}`}>
                  {fx(e.metrics.returnPct, (v) => pct(v, 1, true))}
                </td>
                <td data-label="Worst drop" className="r">
                  {fx(e.metrics.maxDrawdownPct, (v) => pct(-Math.abs(v), 1))}
                </td>
                <td data-label="Sharpe" className="r">
                  {fx(e.metrics.sharpe, (v) => v.toFixed(2))}
                </td>
                <td data-label="Trades" className="r">
                  {fx(e.metrics.trades, String)}
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
