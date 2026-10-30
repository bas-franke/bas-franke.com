import { useMemo, useState } from 'react';
import { api } from '../api';
import { ARTICLES } from '../articles';
import { HeroBanner, SleepingCatArt } from '../components/art';
import { DailyBars, LineChart, type LineSeries } from '../components/charts';
import { WatchingCat } from '../components/icons';
import { ErrorBox, Fold, ModeBadge, Modal, Segmented, Skeleton, Switch, Tip, useAsync, useToast, useVisibleInterval } from '../components/ui';
import { ago, amount, dateOnly, eur, familyLabel, humanize, lossLimitText, num, pct, signedEur, toDate } from '../format';
import { navigate } from '../router';
import type { CompareRange, EquityPoint, Overview } from '../types';

const greeting = () => {
  const h = new Date().getHours();
  return h < 6 ? 'Quiet night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

export default function OverviewPage() {
  const ov = useAsync(() => api.overview(), []);
  useVisibleInterval(() => ov.reload(), 15_000);
  const o = ov.data;
  const day = useAsync(() => api.compare('day'), [o?.bot.mode]);
  useVisibleInterval(() => day.reload(), 60_000);
  const todayPct = o && o.todayPnlEur !== null && o.equityEur - o.todayPnlEur > 0 ? (o.todayPnlEur / (o.equityEur - o.todayPnlEur)) * 100 : null;

  return (
    <div className="stack overview-page">
      <HeroBanner>
        <span className="eyebrow">{new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</span>
        <span className="greet">{greeting()}.</span>
        {o ? (
          <>
            <div>
              <div className="soft small">Everything together is worth</div>
              <div className="row" style={{ alignItems: 'baseline', gap: 12 }}>
                <div className="hero-num">{eur(o.equityEur)}</div>
                <QuoteShare o={o} />
              </div>
            </div>
            <div className="row">
              {o.todayPnlEur !== null && (
                <span className={`chip ${o.todayPnlEur >= 0 ? 'gain' : 'loss'}`}>
                  {signedEur(o.todayPnlEur)}
                  {todayPct !== null && ` · ${pct(todayPct, 1, true)}`} today
                </span>
              )}
              {day.data &&
                (['btc', 'eth'] as const).map((k) => {
                  const c = sinceMidnight(day.data![k]);
                  return c === null ? null : (
                    <span key={k} className={`chip ${c >= 0 ? 'gain' : 'loss'}`} title={`${k.toUpperCase()}-EUR price change today`}>
                      {k.toUpperCase()} {pct(c, 1, true)} today
                    </span>
                  );
                })}
              <ModeBadge mode={o.bot.mode} />
              <span className="chip">{o.running ? 'Bot is awake' : o.bot.enabled ? 'Bot is waking up' : 'Bot is resting'}</span>
            </div>
          </>
        ) : (
          <>
            <Skeleton h={44} w="70%" />
            <Skeleton h={22} w="50%" />
          </>
        )}
      </HeroBanner>

      {ov.error && !o && <ErrorBox error={ov.error} onRetry={ov.reload} />}

      {o && <CompareCard mode={o.bot.mode} />}

      {o && (
        <div className="grid overview-grid">
          <div className="stack">
            <BotCard o={o} onChange={ov.reload} />
            <LossCard o={o} />
            <EquityCard mode={o.bot.mode} />
          </div>
          <div className="stack">
            <StrategyCard o={o} />
            <BalancesCard o={o} />
            <RecentTradesCard o={o} />
          </div>
        </div>
      )}
      {o && <ReadingCard />}
      {!o && !ov.error && (
        <div className="grid overview-grid">
          <div className="card">
            <Skeleton h={120} />
          </div>
          <div className="card">
            <Skeleton h={120} />
          </div>
        </div>
      )}
    </div>
  );
}

function ReadingCard() {
  return (
    <section className="card" aria-labelledby="reading-h">
      <div className="card-head">
        <span className="eyebrow" id="reading-h">
          Reading
        </span>
      </div>
      <div className="article-cards">
        {ARTICLES.map((a) => (
          <a
            key={a.slug}
            className="article-card"
            href={`/article?slug=${a.slug}`}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              navigate(`/article?slug=${a.slug}`);
            }}
          >
            <span className="tiny muted">
              {a.tag} · {dateOnly(a.date)} · {a.minutes} min read
            </span>
            <h3>{a.title}</h3>
            <p className="small soft">{a.blurb}</p>
            <span className="small article-more">Read the full article →</span>
          </a>
        ))}
      </div>
    </section>
  );
}

function BotCard({ o, onChange }: { o: Overview; onChange: () => void }) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const on = o.bot.enabled;
  const live = o.bot.mode === 'live';

  const act = async (start: boolean) => {
    setBusy(true);
    try {
      await (start ? api.start() : api.stop());
      toast(start ? 'The bot is awake and watching the market.' : 'The bot is resting. Its open orders were cancelled.');
      onChange();
    } catch (e) {
      toast(`Couldn’t ${start ? 'start' : 'stop'} the bot: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      setConfirming(false);
      setUnderstood(false);
    }
  };

  return (
    <section className="card status-card" aria-labelledby="bot-h">
      <div className="status-main">
        <Switch checked={on} disabled={busy} label="Bot on or off" onChange={(v) => (v ? setConfirming(true) : act(false))} />
        <div>
          <div className="state" id="bot-h">
            {on ? (o.running ? 'Trading, calmly' : 'Starting up…') : 'Resting'}
          </div>
          <div className="sub">
            {on
              ? o.lastTickAt
                ? `Last look at the market ${ago(o.lastTickAt)}.`
                : 'Getting ready for its first look at the market.'
              : 'Switched off. Nothing will be bought or sold until you turn it on.'}
          </div>
        </div>
        <div className="status-art" aria-hidden="true">
          {on ? <WatchingCat /> : <SleepingCatArt className="" width={150} />}
        </div>
      </div>
      <div className="row">
        <ModeBadge mode={o.bot.mode} />
        {o.bitvavo.connected ? (
          <span className="chip gain">
            <span className="dot" />
            Bitvavo connected
          </span>
        ) : (
          <span className={`chip ${live ? 'loss' : 'brass'}`} title={o.bitvavo.error}>
            <span className="dot" />
            {live ? 'Bitvavo offline' : 'Bitvavo: prices only'}
          </span>
        )}
        <a
          className="chip outline"
          href="/trades"
          onClick={(e) => {
            e.preventDefault();
            navigate('/trades');
          }}
          style={{ textDecoration: 'none' }}
        >
          {o.openOrders} open order{o.openOrders === 1 ? '' : 's'}
        </a>
      </div>
      {!o.bitvavo.connected && o.bitvavo.error && <div className={`callout ${live ? 'loss' : ''}`}>{o.bitvavo.error}</div>}

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={live ? 'Start trading with real money?' : 'Wake the bot up?'}
        actions={
          <>
            <button className="btn ghost" onClick={() => setConfirming(false)}>
              Not now
            </button>
            <button className={`btn ${live ? 'danger' : 'primary'}`} disabled={busy || (live && !understood)} onClick={() => act(true)}>
              {live ? 'Start live trading' : 'Start the bot'}
            </button>
          </>
        }
      >
        <p>
          It will run <b>{o.bot.strategy.name}</b> on {o.bot.strategy.markets.join(', ')}, checking every {o.bot.strategy.interval}.
        </p>
        <p className="small">
          If the portfolio loses {lossLimitText(o.dailyLossLimit, o.dailyLossLimitEur)} or more within 24 hours, it switches itself off again.
          {o.bot.maxExposureEur !== null ? ` It never holds more than ${eur(o.bot.maxExposureEur, true)} in coins.` : ' It may use the whole portfolio.'}
        </p>
        {live ? (
          <>
            <div className="callout loss">
              <b>Live mode.</b> The bot will place real orders on your Bitvavo account, with real euros. Losses are real too.
            </div>
            <label className="check">
              <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
              I understand this trades with real money.
            </label>
          </>
        ) : (
          <div className="callout brass">Paper mode: orders are simulated on live prices. No real money moves.</div>
        )}
      </Modal>
    </section>
  );
}

const RECENT_TRADES = 5;

/**
 * The newest filled orders. The percentage is how the trade did: a buy against today's price, a sell against the
 * buy before it in the same coin. A cancelled order whose tiny rest went unfilled counts as filled (see Trades).
 */
function RecentTradesCard({ o }: { o: Overview }) {
  const orders = useAsync(
    () => Promise.all([api.orders({ mode: o.bot.mode, limit: 100 }), api.fills({ mode: o.bot.mode, limit: 300 })]).then(([a, b]) => ({ list: a.orders, fills: b.fills })),
    [o.bot.mode],
  );
  useVisibleInterval(() => orders.reload(), 60_000);
  const rows = useMemo(() => {
    // Euros and coins actually traded per order, from its fills (market orders carry no price of their own).
    const traded = new Map<string, { q: number; a: number }>();
    for (const f of orders.data?.fills ?? []) {
      if (f.orderId === undefined) continue;
      const t = traded.get(String(f.orderId)) ?? { q: 0, a: 0 };
      t.q += num(f.price) * num(f.amount);
      t.a += num(f.amount);
      traded.set(String(f.orderId), t);
    }
    const filledOf = (x: (typeof list)[number]) => num(x.filledAmount ?? x.filled) || traded.get(String(x.id))?.a || 0;
    const list = orders.data?.list ?? [];
    const done = list.filter((x) => {
      const amt = num(x.amount);
      return x.status === 'filled' || (/cancel|expired/i.test(x.status) && amt > 0 && filledOf(x) / amt >= 0.995);
    });
    const avg = (x: (typeof list)[number]) => {
      const t = traded.get(String(x.id));
      if (t && t.a > 0) return t.q / t.a;
      const f = filledOf(x);
      const q = num(x.filledQuote);
      return f > 0 && q > 0 ? q / f : num(x.price);
    };
    const now = new Map(o.balances.map((b) => [b.symbol.toUpperCase(), num(b.eurValue) / (num(b.available) + num(b.inOrder) || 1)]));
    // `done` is newest first: the buy a sell closes is the next older buy in the same market.
    return done.slice(0, RECENT_TRADES).map((x, i) => {
      const p = avg(x);
      let ref: number | undefined;
      if (x.side === 'buy') ref = now.get(x.market.split('-')[0].toUpperCase());
      else {
        const buy = done.slice(i + 1).find((y) => y.side === 'buy' && y.market === x.market);
        ref = buy ? avg(buy) : undefined;
      }
      const change = ref && p ? (x.side === 'buy' ? (ref / p - 1) * 100 : (p / ref - 1) * 100) : null;
      const value = num(x.filledQuote) || traded.get(String(x.id))?.q || filledOf(x) * p;
      return { x, value: Number.isFinite(value) && value > 0 ? value : null, change: change !== null && Number.isFinite(change) ? change : null };
    });
  }, [orders.data, o.balances]);

  return (
    <section className="card" aria-labelledby="recent-h">
      <div className="card-head">
        <span className="eyebrow" id="recent-h">
          Latest trades
        </span>
        <Tip>Only orders that filled. A buy shows how its coin did since; a sell shows its result against the buy before it.</Tip>
        <span className="spacer" />
        <a
          className="small"
          href="/trades"
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            navigate('/trades');
          }}
        >
          All trades →
        </a>
      </div>
      {orders.error ? (
        <ErrorBox error={orders.error} onRetry={orders.reload} />
      ) : !orders.data ? (
        <Skeleton h={120} />
      ) : rows.length === 0 ? (
        <p className="small muted">No filled trades yet.</p>
      ) : (
        <ul className="recent-trades">
          {rows.map(({ x, value, change }) => (
            <li key={String(x.id)}>
              <span className={`side ${x.side}`}>{x.side}</span>
              <span className="recent-what">
                <b>{x.market.split('-')[0]}</b>
                <span className="tiny muted">{ago(x.createdAt ?? x.created_at)}</span>
              </span>
              <span className="tnum recent-value">{value === null ? '–' : eur(value)}</span>
              <span className={`chip tnum ${change === null ? '' : change >= 0 ? 'gain' : 'loss'}`} title={x.side === 'buy' ? 'Since the buy' : 'Against the buy before it'}>
                {change === null ? '–' : pct(change, 1, true)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** How much of the portfolio sits in the currency the strategy trades against (EUR for BTC-EUR), also when that is nothing. */
function QuoteShare({ o }: { o: Overview }) {
  const quote = (o.bot.strategy?.markets?.[0]?.split('-')[1] ?? 'EUR').toUpperCase();
  const bal = o.balances.find((b) => b.symbol.toUpperCase() === quote);
  const value = bal ? num(bal.eurValue) : 0;
  const share = o.equityEur > 0 ? (value / o.equityEur) * 100 : 0;
  return (
    <span className="chip" title={`Part of the portfolio held in ${quote}, ready to buy with`}>
      {pct(share, 1)} in {quote} · {eur(value)}
    </span>
  );
}

function LossCard({ o }: { o: Overview }) {
  const pnl = o.last24hPnlEur ?? null;
  const limit = o.dailyLossLimitEur;
  const loss = Math.max(0, -(pnl ?? 0));
  const frac = Math.min(1, loss / (limit || 1));
  const baseline = pnl === null ? 0 : o.equityEur - pnl;
  const changePct = pnl !== null && baseline > 0 ? (pnl / baseline) * 100 : null;
  const since = o.lossWindowSince ? new Date(o.lossWindowSince) : null;
  // The window is shorter than 24 h right after the bot was switched on.
  const partial = since !== null && Date.now() - since.getTime() < 23.9 * 3_600_000;
  // Calm sage → brass → terracotta as the loss nears the limit.
  const color = frac < 0.4 ? 'var(--gain)' : frac < 0.75 ? 'var(--brass)' : 'var(--loss)';
  return (
    <section className="card">
      <div className="card-head">
        <span className="eyebrow">Last 24 hours</span>
        <Tip>
          Profit or loss over the last 24 hours, counting coins at today’s price. Deposits and withdrawals don’t count. If the loss reaches the
          max loss from Settings, the bot switches itself off.
        </Tip>
      </div>
      <div className="row" style={{ alignItems: 'baseline' }}>
        <span className={`mid-num ${pnl === null ? 'muted' : pnl >= 0 ? 'gain' : 'loss'}`}>{pnl === null ? '€ 0,00' : signedEur(pnl)}</span>
        {changePct !== null && <span className={`small ${changePct >= 0 ? 'gain' : 'loss'}`}>{pct(changePct, 1, true)}</span>}
        <span className="spacer" />
        <span className="small muted">max loss {lossLimitText(o.dailyLossLimit, limit)}</span>
      </div>
      <div
        className="meter"
        style={{ marginTop: 12 }}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={loss}
        aria-label="Loss over the last 24 hours compared to the max loss"
      >
        <span style={{ width: `${Math.max(frac * 100, (pnl ?? 0) < 0 ? 2 : 0)}%`, background: color }} />
      </div>
      <Fold title="What this means">
        <p className="small soft">
          {pnl === null
            ? 'The 24-hour count starts once the bot is switched on and has recorded its first value.'
            : pnl >= 0
            ? 'Up over the last 24 hours. Nothing to worry about.'
            : frac < 0.75
              ? `${Math.round(frac * 100)}% of the loss budget used. ${eur(limit - loss)} left before the bot pauses.`
              : `Close to the limit: ${eur(limit - loss)} left before the bot switches itself off.`}
          {partial && since && ` Counting since ${since.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}, when the bot was switched on.`}
        </p>
      </Fold>
    </section>
  );
}

function dailyPnl(points: EquityPoint[]) {
  const byDay = new Map<string, number>();
  for (const p of points) {
    const d = toDate(p.ts);
    if (!d) continue;
    byDay.set(d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }), num(p.totalEur));
  }
  const days = [...byDay.entries()];
  const out: { day: string; value: number }[] = [];
  for (let i = 1; i < days.length; i++) out.push({ day: days[i][0], value: days[i][1] - days[i - 1][1] });
  return out;
}

/** % change of a price line since local midnight (or since the line starts, if later). */
function sinceMidnight(pts: [number, number][]): number | null {
  const midnight = new Date().setHours(0, 0, 0, 0);
  const first = pts.find((p) => p[0] >= midnight);
  const last = pts[pts.length - 1];
  return first && last && first !== last ? (last[1] / first[1] - 1) * 100 : null;
}

const COMPARE_RANGES: { value: CompareRange; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
  { value: 'all', label: 'All' },
];

/** Portfolio vs just holding BTC or ETH, every line indexed to 100 at the start of the range (SPEC §5a). Informative. */
function CompareCard({ mode }: { mode: string }) {
  const [range, setRange] = useState<CompareRange>(() => {
    try {
      const v = localStorage.getItem('stonks-compare-range');
      return COMPARE_RANGES.some((r) => r.value === v) ? (v as CompareRange) : 'month';
    } catch {
      return 'month';
    }
  });
  const pick = (r: CompareRange) => {
    setRange(r);
    try {
      localStorage.setItem('stonks-compare-range', r);
    } catch {
      /* the choice just isn't remembered */
    }
  };
  const cmp = useAsync(() => api.compare(range), [range, mode]);
  useVisibleInterval(() => cmp.reload(), 60_000, true);
  const lines = useMemo(() => {
    const d = cmp.data;
    if (!d) return [];
    const defs = [
      { key: 'portfolio', name: `Your portfolio (${d.mode})`, color: 'var(--ink)', pts: d.portfolio, area: true, unit: 'value' },
      { key: 'btc', name: 'Just holding BTC', color: 'var(--brass)', pts: d.btc, dash: '6 4', unit: 'BTC price' },
      { key: 'eth', name: 'Just holding ETH', color: 'var(--s2)', pts: d.eth, dash: '2 4', unit: 'ETH price' },
    ];
    return defs
      .filter((x) => x.pts.length > 1)
      .map((x) => {
        const base = x.pts[0][1];
        const last = x.pts[x.pts.length - 1][1];
        const series: LineSeries = {
          name: x.name,
          color: x.color,
          dash: x.dash,
          area: x.area,
          width: x.key === 'portfolio' ? 2.4 : 1.8,
          points: x.pts.map(([t, v]) => [t, (v / base) * 100] as [number, number]),
          tip: ([, i]) => `${i.toFixed(1)} · ${eur((i * base) / 100)}`,
        };
        return { ...x, base, last, change: (last / base - 1) * 100, series };
      });
  }, [cmp.data]);
  const label = COMPARE_RANGES.find((r) => r.value === range)!.label.toLowerCase();

  return (
    <section className="card">
      <div className="card-head" style={{ flexWrap: 'wrap', gap: 10 }}>
        <h2 style={{ marginRight: 'auto' }}>You vs just holding</h2>
        <Segmented label="Range" value={range} onChange={pick} options={COMPARE_RANGES} />
      </div>
      {cmp.error && <ErrorBox error={cmp.error} onRetry={cmp.reload} />}
      {!cmp.data && !cmp.error && <Skeleton h={260} />}
      {cmp.data && lines.length === 0 && (
        <p className="soft small" style={{ padding: '30px 0' }}>
          Nothing to compare yet. Prices and your portfolio are recorded every minute; the lines appear shortly.
        </p>
      )}
      {lines.length > 0 && (
        <div className="compare-grid">
          <LineChart
            series={lines.map((l) => l.series)}
            height={180}
            legend={false}
            baseline={100}
            ariaLabel={`Your portfolio and buy and hold BTC and ETH over the last ${label}, indexed to 100`}
            yFormat={(v) => v.toFixed(0)}
          />
          <ul className="compare-side" aria-label="Change over the range">
            {lines.map((l) => (
              <li key={l.key}>
                <span className={`swatch${l.dash ? ' dashed' : ''}`} style={{ color: l.color }} />
                <div style={{ minWidth: 0 }}>
                  <div className="small">{l.name}</div>
                  <div className={`mid-num ${l.change >= 0 ? 'gain' : 'loss'}`}>{pct(l.change, 1, true)}</div>
                  <div className="tiny soft">
                    {l.unit} {eur(l.base)} → {eur(l.last)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {lines.length > 0 && (
        <Fold title="How to read this">
          <p className="tiny soft">
            All lines start at 100{' '}
            {range !== 'all' && Date.parse(cmp.data!.start) - Date.parse(cmp.data!.from) < 3_600_000
              ? `at the beginning of the ${label}`
              : `when your portfolio tracking began (${dateOnly(cmp.data!.start)})`}
            . Informative only: it does not change what the bot does. Deposits and withdrawals show up as jumps in your line.
          </p>
        </Fold>
      )}
    </section>
  );
}

function EquityCard({ mode }: { mode: string }) {
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const eq = useAsync(() => api.equity({ mode, days: Number(days) + 1 }), [mode, days]);
  const pts = eq.data?.points ?? [];
  const bh = (eq.data as { buyHold?: EquityPoint[] } | undefined)?.buyHold;
  const series = useMemo(() => {
    const s: LineSeries[] = [
      {
        name: 'Your portfolio',
        color: 'var(--ink)',
        area: true,
        points: pts.map((p) => [toDate(p.ts)!.getTime(), num(p.totalEur)] as [number, number]),
      },
    ];
    if (bh?.length)
      s.push({
        name: 'If you had just held',
        color: 'var(--brass)',
        points: bh.map((p) => [toDate(p.ts)!.getTime(), num(p.totalEur)] as [number, number]),
        dash: '5 5',
      });
    return s;
  }, [pts, bh]);
  const bars = useMemo(() => dailyPnl(pts), [pts]);
  const first = pts[0] ? num(pts[0].totalEur) : 0;
  const last = pts.length ? num(pts[pts.length - 1].totalEur) : 0;

  return (
    <section className="card">
      <div className="card-head">
        <h2 style={{ marginRight: 'auto' }}>How it’s going</h2>
        <Segmented
          label="Period"
          value={days}
          onChange={setDays}
          options={[
            { value: '7', label: '7 days' },
            { value: '30', label: '30 days' },
            { value: '90', label: '90 days' },
          ]}
        />
      </div>
      {eq.error && <ErrorBox error={eq.error} onRetry={eq.reload} />}
      {!eq.data && !eq.error && <Skeleton h={240} />}
      {eq.data && pts.length < 2 && (
        <p className="soft small" style={{ padding: '30px 0' }}>
          No history yet. Once the bot has been running a little while, its value shows up here.
        </p>
      )}
      {pts.length >= 2 && (
        <>
          <p className="small soft" style={{ marginBottom: 12 }}>
            {last >= first ? 'Up' : 'Down'} <b className={last >= first ? 'gain' : 'loss'}>{signedEur(last - first)}</b> over these {days} days
            ({mode === 'live' ? 'live' : 'paper'} account).
          </p>
          <LineChart
            series={series}
            height={160}
            ariaLabel={`Portfolio value over the last ${days} days`}
            yFormat={(v) => `€${Math.round(v).toLocaleString('en-US')}`}
            tipFormat={(v) => eur(v)}
          />
          {bars.length > 1 && (
            <Fold title="Result per day">
              <DailyBars days={bars} format={signedEur} />
            </Fold>
          )}
        </>
      )}
    </section>
  );
}

function StrategyCard({ o }: { o: Overview }) {
  const s = o.bot.strategy;
  return (
    <section className="card">
      <div className="card-head">
        <span className="eyebrow">The plan it follows</span>
        <button className="btn ghost small" onClick={() => navigate('/settings')}>
          Change
        </button>
      </div>
      <h2>{s.name}</h2>
      <ActiveResearchLine o={o} />
      <div className="row" style={{ margin: '10px 0 14px' }}>
        <span className="chip brass">{familyLabel(s.family)}</span>
        <span className="chip">every {s.interval}</span>
        {s.markets.length <= 3 ? s.markets.map((m) => <span className="chip outline" key={m}>{m}</span>) : <span className="chip outline">{s.markets.length} markets</span>}
      </div>
      <Fold title="How this plan works">
        <p className="soft" style={{ fontSize: '0.95rem' }}>
          {o.strategyExplanation}
        </p>
        <div className="params">
          {Object.entries(s.params).map(([k, v]) => (
            <span className="chip" key={k}>
              {k} {String(v)}
            </span>
          ))}
        </div>
        <dl className="kv">
          <dt>Orders</dt>
          <dd>
            {s.execution.orderType === 'limit'
              ? `limit, ${s.execution.limitOffsetBps} bps from close${s.execution.postOnly ? ', maker only' : ''}`
              : 'market'}
          </dd>
          <dt>Stop-loss</dt>
          <dd>{s.risk.stopLossPct ? `${Math.round(s.risk.stopLossPct * 100)}%` : 'none'}</dd>
          {s.risk.trailingStopPct ? (
            <>
              <dt>Trailing stop</dt>
              <dd>{Math.round(s.risk.trailingStopPct * 100)}%</dd>
            </>
          ) : null}
          <dt>Max in coins</dt>
          <dd>{o.bot.maxExposureEur === null ? 'whole portfolio' : eur(o.bot.maxExposureEur, true)}</dd>
        </dl>
      </Fold>
    </section>
  );
}

function BalancesCard({ o }: { o: Overview }) {
  const rows = [...o.balances].sort((a, b) => num(b.eurValue) - num(a.eurValue));
  const total = rows.reduce((s, b) => s + num(b.eurValue), 0) || 1;
  return (
    <section className="card">
      <div className="card-head">
        <span className="eyebrow">What’s in the {o.bot.mode === 'live' ? 'account' : 'paper wallet'}</span>
      </div>
      {rows.length === 0 && <p className="soft small">No balances yet.</p>}
      {rows.map((b) => (
        <div className="balance-row" key={b.symbol}>
          <span className={`coin ${b.symbol}`}>{b.symbol.slice(0, 4)}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 500 }}>{b.symbol === 'EUR' ? 'Euros' : b.symbol}</div>
            <div className="tiny muted tnum">
              {b.symbol === 'EUR' ? eur(b.available) : amount(b.available)} available
              {num(b.inOrder) > 0 ? ` · ${b.symbol === 'EUR' ? eur(b.inOrder) : amount(b.inOrder)} in orders` : ''}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="tnum" style={{ fontWeight: 500 }}>{eur(b.eurValue)}</div>
            <div className="tiny muted tnum">{Math.round((num(b.eurValue) / total) * 100)}%</div>
          </div>
        </div>
      ))}
      <p className="tiny muted" style={{ marginTop: 10 }}>
        Fees: {humanize('maker')} {(o.bot.fees.maker * 100).toFixed(2)}% · taker {(o.bot.fees.taker * 100).toFixed(2)}%
      </p>
    </section>
  );
}

const BUCKET_LABEL: Record<string, string> = { minute: 'Minute', hourly: 'Hourly', daily: 'Daily', weekly: 'Weekly', mixed: 'Mixed', custom: 'Custom', stoploss: 'Stoploss', session1: 'Session 1', session2: 'Session 2', session3: 'Session 3', session4: 'Session 4', session5: 'Session 5', hall: 'Hall of fame' };

/** Where the current strategy came from, when it was activated from the Research page (SPEC §8). */
function ActiveResearchLine({ o }: { o: Overview }) {
  const a = o.activeResearch ?? o.bot.activeResearch;
  if (!a) return null;
  const href = `/research?bucket=${encodeURIComponent(a.bucket)}&rank=${a.rank}`;
  return (
    <div className="active-research small soft" style={{ marginTop: 8 }}>
      <span>
        From the research lab: <b>{BUCKET_LABEL[a.bucket] ?? a.bucket.replace(/^session(\d+)$/, 'Session $1')} #{a.rank}</b>, activated {dateOnly(a.activatedAt)}
      </span>
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault();
          navigate(href);
        }}
      >
        See its card →
      </a>
    </div>
  );
}
