import { useMemo, useState } from 'react';
import { api } from '../api';
import { HeroBanner, SleepingCatArt } from '../components/art';
import { DailyBars, LineChart, type LineSeries } from '../components/charts';
import { WatchingCat } from '../components/icons';
import { ErrorBox, ModeBadge, Modal, Segmented, Skeleton, Switch, Tip, useAsync, useToast, useVisibleInterval } from '../components/ui';
import { ago, amount, dateOnly, eur, familyLabel, humanize, num, signedEur, toDate } from '../format';
import { navigate } from '../router';
import type { EquityPoint, Overview } from '../types';

const greeting = () => {
  const h = new Date().getHours();
  return h < 6 ? 'Quiet night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

export default function OverviewPage() {
  const ov = useAsync(() => api.overview(), []);
  useVisibleInterval(() => ov.reload(), 15_000);
  const o = ov.data;

  return (
    <div className="stack">
      <HeroBanner>
        <span className="eyebrow">{new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</span>
        <span className="greet">{greeting()}.</span>
        {o ? (
          <>
            <div>
              <div className="soft small">Everything together is worth</div>
              <div className="hero-num">{eur(o.equityEur)}</div>
            </div>
            <div className="row">
              {o.todayPnlEur !== null && (
                <span className={`chip ${o.todayPnlEur >= 0 ? 'gain' : 'loss'}`}>{signedEur(o.todayPnlEur)} today</span>
              )}
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
          </div>
        </div>
      )}
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
          If the portfolio loses {eur(o.dailyLossLimitEur, true)} or more in one day, it switches itself off again.
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

function LossCard({ o }: { o: Overview }) {
  const pnl = o.todayPnlEur;
  const loss = Math.max(0, -(pnl ?? 0));
  const frac = Math.min(1, loss / (o.dailyLossLimitEur || 1));
  // Calm sage → brass → terracotta as the day's loss nears the limit.
  const color = frac < 0.4 ? 'var(--gain)' : frac < 0.75 ? 'var(--brass)' : 'var(--loss)';
  return (
    <section className="card">
      <div className="card-head">
        <span className="eyebrow">Today</span>
        <Tip>
          Profit or loss since midnight (Amsterdam time), counting coins at today’s price. If the loss reaches the daily limit, the bot switches itself off.
        </Tip>
      </div>
      <div className="row" style={{ alignItems: 'baseline' }}>
        <span className={`mid-num ${pnl === null ? 'muted' : pnl >= 0 ? 'gain' : 'loss'}`}>{pnl === null ? '€ 0,00' : signedEur(pnl)}</span>
        <span className="spacer" />
        <span className="small muted">daily loss limit {eur(o.dailyLossLimitEur, true)}</span>
      </div>
      <div
        className="meter"
        style={{ marginTop: 12 }}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={o.dailyLossLimitEur}
        aria-valuenow={loss}
        aria-label="Today's loss compared to the daily limit"
      >
        <span style={{ width: `${Math.max(frac * 100, (pnl ?? 0) < 0 ? 2 : 0)}%`, background: color }} />
      </div>
      <p className="small soft" style={{ marginTop: 10 }}>
        {pnl === null
          ? 'Today’s count starts once the bot has recorded its first value of the day.'
          : pnl >= 0
          ? 'Up for the day. Nothing to worry about.'
          : frac < 0.75
            ? `${Math.round(frac * 100)}% of today’s loss budget used. ${eur(o.dailyLossLimitEur - loss)} left before the bot pauses.`
            : `Close to the limit: ${eur(o.dailyLossLimitEur - loss)} left before the bot switches itself off.`}
      </p>
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
            height={240}
            ariaLabel={`Portfolio value over the last ${days} days`}
            yFormat={(v) => `€${Math.round(v).toLocaleString('en-US')}`}
            tipFormat={(v) => eur(v)}
          />
          {bars.length > 1 && (
            <>
              <div className="card-head" style={{ marginTop: 20, marginBottom: 6 }}>
                <span className="eyebrow">Result per day</span>
              </div>
              <DailyBars days={bars} format={signedEur} />
            </>
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
      <p className="soft" style={{ fontSize: '0.95rem' }}>
        {o.strategyExplanation}
      </p>
      <hr className="divider" />
      <div className="params">
        {Object.entries(s.params).map(([k, v]) => (
          <span className="chip" key={k}>
            {k} {String(v)}
          </span>
        ))}
      </div>
      <dl className="kv" style={{ marginTop: 14 }}>
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

const BUCKET_LABEL: Record<string, string> = { minute: 'Minute', hourly: 'Hourly', daily: 'Daily', weekly: 'Weekly' };

/** Where the current strategy came from, when it was activated from the Research page (SPEC §8). */
function ActiveResearchLine({ o }: { o: Overview }) {
  const a = o.activeResearch ?? o.bot.activeResearch;
  if (!a) return null;
  const href = `/research?bucket=${encodeURIComponent(a.bucket)}&rank=${a.rank}`;
  return (
    <div className="active-research small soft" style={{ marginTop: 8 }}>
      <span>
        From the research lab: <b>{BUCKET_LABEL[a.bucket] ?? a.bucket} #{a.rank}</b>, activated {dateOnly(a.activatedAt)}
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
