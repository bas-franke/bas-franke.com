import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import { EmptyState } from '../components/art';
import { LineChart, Spark, type LineSeries } from '../components/charts';
import { IconCheck } from '../components/icons';
import { ErrorBox, Fold, ModeBadge, Modal, Skeleton, Tip, useAsync, useToast } from '../components/ui';
import { ago, dateOnly, eur, familyLabel, lossLimitText, pct, toDate } from '../format';
import { navigate, setHandoff, useLocation } from '../router';
import type { Benchmark, BucketName, HallEntry, Overview, ResearchBucket, ResearchEntry, ResearchPayload, Series } from '../types';

const RANK_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)'];
const BENCH_STYLE = [
  { color: 'var(--ink-2)', dash: '7 5' },
  { color: 'var(--ink-3)', dash: '1 5' },
  { color: 'var(--ink-3)', dash: '12 4 2 4' },
];

/** Labels for buckets that can still be named from the hall of fame (older research). */
const BUCKET_TITLES: Record<string, string> = { minute: 'Minute', hourly: 'Hourly', daily: 'Daily', weekly: 'Weekly', mixed: 'Mixed', custom: 'Custom', stoploss: 'Stoploss' };
const bucketTitle = (b: string) => {
  const session = /^session(\d+)$/.exec(b);
  if (session) return `Session ${Number(session[1])}`;
  return BUCKET_TITLES[b] ?? b;
};

/** Session tabs only, newest first (session 3 before session 1). */
function sessionTabs(buckets: Partial<Record<string, unknown>>): string[] {
  return Object.keys(buckets)
    .flatMap((name) => {
      const m = /^session(\d+)$/.exec(name);
      return m ? [{ name, n: Number(m[1]) }] : [];
    })
    .sort((a, b) => b.n - a.n)
    .map((s) => s.name);
}

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
  const sessions = sessionTabs(buckets);
  const [tab, setTab] = useState<string>(() => {
    const q = query.get('bucket');
    if (q && sessions.includes(q)) return q;
    return sessions[0] ?? '';
  });
  const [pick, setPick] = useState<{ e: ResearchEntry; bucket: string; hallId?: number } | null>(null);
  const hall = useAsync(() => api.hallOfFame().then((r) => r.entries), []);
  const writeups = useAsync(() => api.writeups().then((r) => new Set(r.writeups.map((w) => w.specId))), []);
  const [hallView, setHallView] = useState(() => query.get('bucket') === 'hall');
  // The menu's Research link always opens the newest session, also when you are already on this page.
  const newest = sessions[0] ?? '';
  const asked = query.get('bucket');
  useEffect(() => {
    if (asked === 'hall') return setHallView(true);
    setHallView(false);
    setTab(asked && sessions.includes(asked) ? asked : newest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, newest]);
  useEffect(() => {
    const reset = (ev: Event) => {
      if ((ev as CustomEvent).detail !== '/research') return;
      setHallView(false);
      setTab(newest);
    };
    window.addEventListener('stonks:reselect', reset);
    return () => window.removeEventListener('stonks:reselect', reset);
  }, [newest]);
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
  const bucket = tab ? buckets[tab as BucketName] : undefined;
  const top = bucket ? [...bucket.top].sort((a, b) => a.rank - b.rank).slice(0, 5) : [];
  const benches = bucket
    ? [bucket.benchmark ?? (data.buckets ? null : data.benchmark), ...(tab === 'daily' || !data.buckets ? (data.benchmarks ?? []) : [])].filter(
        (b): b is Benchmark => !!b,
      )
    : [];
  const active = overview ? (overview.activeResearch ?? overview.bot.activeResearch ?? null) : null;
  const s = data.summary;

  // Deep link from the Overview: /research?bucket=session3&rank=2 scrolls to that card.
  useEffect(() => {
    const rank = query.get('rank');
    if (!rank || query.get('bucket') !== tab) return;
    const t = setTimeout(() => document.getElementById(`card-${tab}-${rank}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choose = (b: string) => {
    setTab(b);
    setHallView(false);
  };

  // On a phone the tab row scrolls sideways: keep the chosen tab in view.
  useEffect(() => {
    const el = document.getElementById(hallView ? 'tab-hall' : `tab-${tab}`);
    const row = el?.parentElement;
    if (!el || !row || row.scrollWidth <= row.clientWidth) return;
    row.scrollTo({ left: el.offsetLeft - (row.clientWidth - el.offsetWidth) / 2, behavior: 'smooth' });
  }, [tab, hallView]);

  return (
    <div className="stack research-page" style={{ gap: 12 }}>
      <Head data={data} />

      <section className="card quiet research-about">
        <Fold title="About the lab">
          <p>
            Thousands of strategies were tested on years of past prices, each starting with €1,000. Each session is one of those searches. The newest
            session opens first.
          </p>
          <div className="summary-strip" aria-label="Research summary">
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
          </div>
          {s.notes && <p className="notes">“{s.notes}”</p>}
          <p>
            <b>An honest note.</b> These results come from backtests: simulations on past prices, with Bitvavo’s fees and a careful fill model. They are
            not a forecast, and a strategy that did well before can do badly next month. Simply buying and holding is shown everywhere as the yardstick to
            beat, not as a candidate. A session’s own score only compares within that session; the absolute score below compares across all of them.
          </p>
        </Fold>
      </section>

      <AbsoluteBoard
        buckets={buckets}
        onOpen={(b, rank) => {
          choose(b);
          setTimeout(() => document.getElementById(`card-${b}-${rank}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
        }}
      />

      <div className="bucket-tabs" role="tablist" aria-label="Sessions">
        {/* Hall of fame first; the page still opens on the newest session unless a link asks for the hall. */}
        <button type="button" role="tab" id="tab-hall" aria-selected={hallView} aria-controls="bucket-panel" onClick={() => setHallView(true)} title="Hall of fame">
          ★ HOF
          <span className="count">{hall.data?.length ?? 0}</span>
        </button>
        {sessions.map((b) => (
          <button
            key={b}
            type="button"
            role="tab"
            id={`tab-${b}`}
            aria-selected={!hallView && b === tab}
            aria-controls="bucket-panel"
            onClick={() => choose(b)}
          >
            {bucketTitle(b)}
            <span className="count">{buckets[b as BucketName]!.top.length}</span>
          </button>
        ))}
      </div>

      {hallView && (
        <HallOfFame
          hall={hall}
          writeups={writeups.data}
          active={active}
          onActivate={(h) => setPick({ e: h.entry, bucket: 'hall', hallId: h.id })}
        />
      )}


      {!hallView && bucket && (
      <div id="bucket-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="stack" style={{ gap: 12 }}>
        <BucketIntro name={tab} b={bucket} />

        {top.length === 0 ? (
          <section className="card">
            <EmptyState title={`Nothing made the cut for ${bucketTitle(tab).toLowerCase()} trading yet`}>
              {bucket.notes || 'No strategy in this session beat buying and holding after fees, so there is nothing worth running here yet.'}
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
              bucket={tab}
              onAddToHall={data.id !== undefined && hall.data ? () => void addToHall(e) : undefined}
            />
          ))
        )}

        {top.length > 0 && <Compare top={top} benches={benches} />}
      </div>
      )}

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

function BucketIntro({ name, b }: { name: string; b: ResearchBucket }) {
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
      <Fold title="About this tab">
        {name === 'stoploss' && (
          <p>
            Long-only rules with a stop that only moves up, and buys that are spread out once the coin looks up or steady again.
            Each card is ranked on every EUR coin, from that coin’s own first candle. The table’s euro numbers are the ether run.
          </p>
        )}
        {name === 'session1' && (
          <p>
            This session’s five. A sale scores by the percent it made or lost, a position built in steps scores higher than one all-in buy,
            and a long stretch in euros or in the coin loses points. Shown here are the five whose account also beat holding,
            on 18 markets, from each coin’s first candle. The table’s euro numbers are the ether run.
          </p>
        )}
        {name === 'session2' && (
          <p>
            This session’s five. They were aimed at the coins Session 1 lost to holding: bitcoin, ether, tron, chainlink and binance coin.
            A book is here only if it beat the profit ladder on that score and at least one of those five coins beat holding.
            The other thirteen coins still have to stay ahead. The table’s euro numbers are the ether run.
          </p>
        )}
        {name === 'session3' && (
          <p>
            This session’s five are all in or all out. Each coin is cut into 90-day sections, each section is compared with holding that same stretch,
            and each year counts the same, so one spike cannot carry the book. A high that then falls at least 8 percent scores extra when the book
            was in on the way up and out on the way down. Shown here are the five that also beat holding. The table’s euro numbers are the ether run.
          </p>
        )}
        {name === 'session4' && (
          <p>
            This session’s five ride the big rises, step aside in the big drops and trade the quiet stretches, on 15-minute candles with a 0.05 percent
            fee per trade. The whole chart is cut into overlapping windows of one, two and three months, starting on the 1st and the 15th of each month.
            A rising window scores the share of the rise the strategy kept, a falling one the share of the fall it avoided, and a quiet one what it made.
            Each card is ranked on its score with its settings nudged up and down, so a lucky setting does not win. The table’s euro numbers are the ether run.
          </p>
        )}
        {name === 'session5' && (
          <p>
            This session’s five were built from what made Session 4’s top three work: buying deep, sudden drops and selling the bounce, riding
            rare strong breakouts, and letting the trend set how deep a dip must be. They are scored exactly like Session 4, on the same windows,
            coins and 0.05 percent fee, so the two tabs compare directly. The table’s euro numbers are the ether run.
          </p>
        )}
        {name === 'session6' && (
          <p>
            This session’s five pay Bitvavo’s real fees: 0.15 percent for a limit order that rests in the book and 0.25 percent for a market order.
            They started from the best books of Sessions 5 and 3, on the same windows, coins and grades, and each also had to beat holding half
            the account in coins over the last 12 months alone. The table’s euro numbers are the ether run.
          </p>
        )}
        {name === 'session7' && (
          <p>
            This session’s five are all built on Dip and breakout, the owner’s favourite, at Bitvavo’s real fees and with any TAAPI indicator allowed.
            Same windows, coins and grades as Session 6, so the two tabs compare directly. The table’s euro numbers are the ether run.
          </p>
        )}
        {name === 'session8' && (
          <p>
            Session 7’s winner kept too little of the big rallies, like 2021. This session’s five also score a mountain grade: every rally where a coin
            at least doubled, and how much of it the strategy kept, with the biggest rallies counting most. The final score is three quarters the usual
            window score and one quarter the mountain grade, at Bitvavo’s real fees. The table’s euro numbers are the ether run.
          </p>
        )}
        {name === 'session9' && (
          <p>
            This session’s five are variants of Session 8’s winner, scored exactly like Session 8: three quarters the window score and one quarter
            the mountain grade, at Bitvavo’s real fees. The table’s euro numbers are the ether run.
          </p>
        )}
        {name === 'session10' && (
          <p>
            Session 9’s winners lost about four points when every setting was nudged at once, so this session ranks on steadiness too: half the usual
            robust score and half the score with all settings nudged together. Same scoring as Sessions 8 and 9 otherwise. The table’s euro numbers are
            the ether run.
          </p>
        )}
        {name === 'session11' && (
          <p>
            No new strategies here: the number one of Sessions 6 to 10, unchanged, run on all 29 coins the lab has candles for. Nineteen of them were
            never used by any research agent, so this is the first real test on unseen coins. Ranked on the absolute score over all 29. The table’s
            euro numbers are the ether run.
          </p>
        )}
      {name === 'custom' && (
          <p>
            Hand-made variants of strategies from the other tabs, tested on the same windows and shown the same way (the last test year). Their
            last-30-day result is in the notes above and in each card’s comparison text.
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
        <p className="tiny muted">Scores only compare within this session. A strategy is worth a look when it beats both lines above.</p>
      </Fold>
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
  bucket: string;
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
  bucket,
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
  /** Research tab this card sits on, so the write-up link returns here. */
  bucket?: string;
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
        <h2>{s.name}</h2>
        {isNum(m.absoluteScore) && (
          <span className="chip outline abs-chip" title="Absolute score: the same yardstick for every session (holding scores 45.7)">
            absolute {m.absoluteScore.toFixed(1)}
          </span>
        )}
      </header>

      <LineChart
        series={series}
        height={140}
        ariaLabel={`Value of €1,000 with ${s.name} versus buy and hold`}
        yFormat={euroAxis}
        tipFormat={(v) => eur(v)}
        baseline={1000}
        baselineLabel="€1,000 start"
      />

      <footer className="row rank-actions">
        {hasWriteup && (
          <button className="btn small" onClick={() => navigate(`/writeup?spec=${encodeURIComponent(s.id)}${bucket ? `&bucket=${encodeURIComponent(bucket)}` : ''}`)}>
            Read the full write-up
          </button>
        )}
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
        {onRemove && <RemoveButton onRemove={onRemove} />}
        {e.botReady && (
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
        )}
      </footer>

      <details className="rank-more">
        <summary>Details</summary>
        <div className="rank-more-body">
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
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
          <p className="notes" style={{ fontStyle: 'normal', color: 'var(--ink)', fontSize: '1.05rem' }}>
            {e.explanation.summary}
          </p>
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
          <p className="tiny muted">
            Test period {m.testPeriod ? `${dateOnly(m.testPeriod[0])} – ${dateOnly(m.testPeriod[1])}` : ''}
            {m.trainReturnPct !== undefined ? ` · on the tuning period it made ${pct(m.trainReturnPct, 0, true)}` : ''}
            {m.exposurePct !== undefined ? ` · in the market ${pct(m.exposurePct, 0)} of the time` : ''}
          </p>
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
          {e.lineage && (
            <span className="tiny muted mono">
              {e.lineage.experimentId}
              {e.lineage.agent ? ` · ${e.lineage.agent}` : ''}
              {e.lineage.round !== undefined ? ` · round ${e.lineage.round}` : ''}
            </span>
          )}
          {!e.botReady && <span className="small muted">Waiting to be ported to the bot</span>}
        </div>
      </details>
    </article>
  );
}

/** The fixed yardstick's lines to beat (out/abs_results/_yardsticks.json in stonks-local). */
const ABS_HOLD = 45.7;
const ABS_HALF = 43.0;

/** Every session card on the absolute score, best first. */
function AbsoluteBoard({ buckets, onOpen }: { buckets: Partial<Record<BucketName, ResearchBucket>>; onOpen: (bucket: string, rank: number) => void }) {
  const [all, setAll] = useState(false);
  const rows = useMemo(
    () =>
      Object.entries(buckets)
        .filter(([b]) => /^session\d+$/.test(b) || b === 'stoploss')
        .flatMap(([b, bk]) =>
          (bk?.top ?? []).filter((e) => isNum(e.metrics.absoluteScore) && (e.metrics.coinsTested ?? 10) === 10).map((e) => ({ b, e })),
        )
        .sort((x, y) => (y.e.metrics.absoluteScore ?? 0) - (x.e.metrics.absoluteScore ?? 0)),
    [buckets],
  );
  if (!rows.length) return null;
  const shown = all ? rows : rows.slice(0, 10);
  const yr = (v: unknown) => fx(v, (n) => pct(n, 0, true));
  return (
    <section className="card quiet research-about abs-board">
      <Fold title={`All sessions on one scale: the top ${Math.min(10, rows.length)}`}>
      <p className="small muted" style={{ margin: '0 0 10px' }}>
        Every session’s strategies scored the same way: 60% the 1-3 month window score, 20% how much of the big rallies (a coin at least doubling)
        they kept, and 20% the last 12 months, at Bitvavo’s fees on the same 10 coins since 2019. Holding scores {ABS_HOLD}, always half in {ABS_HALF}.
      </p>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>#</th>
              <th>Strategy</th>
              <th>Session</th>
              <th className="r">Absolute</th>
              <th className="r">Windows</th>
              <th className="r">Rallies kept</th>
              <th className="r">Last 12 months</th>
              <th className="r">Per year vs holding</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(({ b, e }, i) => {
              const m = e.metrics;
              return (
                <tr key={`${b}-${e.spec.id}`} className="abs-row" onClick={() => onOpen(b, e.rank)} title="Open this card">
                  <td>{i + 1}</td>
                  <td>{e.spec.name}</td>
                  <td>
                    {bucketTitle(b)} #{e.rank}
                  </td>
                  <td className="r">
                    <b>{fx(m.absoluteScore, (n) => n.toFixed(1))}</b>
                  </td>
                  <td className="r">{fx(m.absWindow, (n) => n.toFixed(1))}</td>
                  <td className="r">{fx(m.absMountain, (n) => `${n.toFixed(0)}%`)}</td>
                  <td className="r">{fx(m.absLast12, (n) => n.toFixed(1))}</td>
                  <td className="r">
                    {yr(m.absCagr)} vs {yr(m.absHoldCagr)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > 10 && (
        <button className="btn ghost small" style={{ marginTop: 8 }} onClick={() => setAll(!all)}>
          {all ? 'Show the top 10' : `Show all ${rows.length}`}
        </button>
      )}
      </Fold>
    </section>
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
  writeups,
  active,
  onActivate,
}: {
  hall: { data?: HallEntry[] | null; error?: Error | null; reload: () => void };
  writeups?: Set<string> | null;
  active: Overview['activeResearch'] | null;
  onActivate: (h: HallEntry) => void;
}) {
  const toast = useToast();
  // The owner's order, shown at once while the server saves it.
  const [order, setOrder] = useState<number[] | null>(null);
  if (hall.error) return <ErrorBox error={hall.error} onRetry={hall.reload} />;
  if (!hall.data) return <Skeleton h={200} />;
  const byId = new Map(hall.data.map((h) => [h.id, h]));
  const list = order && order.length === hall.data.length && order.every((id) => byId.has(id)) ? order.map((id) => byId.get(id)!) : hall.data;
  const move = async (i: number, to: number) => {
    if (to < 0 || to >= list.length) return;
    const ids = list.map((h) => h.id);
    const [id] = ids.splice(i, 1);
    ids.splice(to, 0, id);
    setOrder(ids);
    try {
      await api.reorderHall(ids);
    } catch (err) {
      toast((err as Error).message);
      setOrder(null);
    }
    hall.reload();
  };
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
    <div id="bucket-panel" role="tabpanel" aria-labelledby="tab-hall" className="stack" style={{ gap: 12 }}>
      <section className="card quiet bucket-intro">
        <h2>Hall of fame</h2>
        <Fold title="What this is">
          <p className="notes">
            Strategies you chose to keep. Each one is stored as it was when you kept it (results, charts and settings), so new research never replaces
            or deletes it. Only you can remove one.
          </p>
        </Fold>
      </section>
      {hall.data.length === 0 ? (
        <section className="card">
          <EmptyState title="Nothing kept yet">Use “☆ Keep in hall of fame” on a strategy in a session to keep it here for good.</EmptyState>
        </section>
      ) : (
        list.map((h, i) => (
          <div key={h.id} className="hall-item">
            {list.length > 1 && (
              <div className="hall-move" role="group" aria-label={`Move ${h.entry.spec.name}`}>
                <button type="button" className="btn ghost small" disabled={i === 0} onClick={() => void move(i, 0)} title="Move to the top" aria-label="Move to the top">
                  ⤒
                </button>
                <button type="button" className="btn ghost small" disabled={i === 0} onClick={() => void move(i, i - 1)} title="Move up" aria-label="Move up">
                  ↑
                </button>
                <button type="button" className="btn ghost small" disabled={i === list.length - 1} onClick={() => void move(i, i + 1)} title="Move down" aria-label="Move down">
                  ↓
                </button>
              </div>
            )}
          <RankCard
            e={{ ...h.entry, rank: i + 1 }}
            color={RANK_COLORS[i % RANK_COLORS.length]}
            anchor={`card-hall-${h.id}`}
            active={!!active && active.bucket === 'hall' && active.researchId === h.id}
            onActivate={() => onActivate(h)}
            origin={`kept ${dateOnly(h.addedAt)} · was ${bucketTitle(h.bucket)} #${h.rank}`}
            onRemove={() => void remove(h)}
            hasWriteup={!!writeups?.has(h.entry.spec.id)}
            bucket="hall"
          />
          </div>
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
      <LineChart series={series} height={180} ariaLabel="These strategies and the buy-and-hold benchmarks" yFormat={euroAxis} tipFormat={(v) => eur(v, true)} baseline={1000} />
      <Fold title="The numbers">
      <p className="small soft">
        €1,000 in each, over the test period. The dashed and dotted lines are the yardsticks: simply buying and holding.
      </p>
      <div className="table-wrap">
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
      </Fold>
    </section>
  );
}
