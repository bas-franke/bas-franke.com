// Mail to the owner when a live trade has finished (SPEC §5). A trade is every unmailed fill of one market and side; it
// is finished once nothing of that market and side still works, so a chase that reprices ten times is one mail. Rows
// stay unmailed until SendGrid took the mail, which survives restarts. Like alerts.ts it never throws, the trading loop
// does not wait for SendGrid, and a failed mail shows on the Health page instead of in a log that would mail again.

import { query } from '../db.js';
import { errText, log } from '../log.js';
import { alertsConfigured, deliver } from './alerts.js';
import { OPEN_STATUSES } from './store.js';
import { mailTime } from './time.js';

const DASHBOARD = 'https://stonks.bas-franke.com';
/** After a failed send the next tick that may try again: an outage of SendGrid is not hammered. */
const RETRY_MS = 5 * 60_000;
/** Mirrors the engine's CHASE_LEFTOVER_MS: a chase-cancelled order may get its rest placed again for this long. */
const CHASE_LEFTOVER_MS = 5 * 60_000;

export interface TradeFill {
  id: number;
  price: number;
  amount: number;
  quote: number;
  fee: number;
  feeCurrency: string | null;
  taker: boolean | null;
  executedAt: number;
}

export interface Trade {
  market: string;
  side: 'buy' | 'sell';
  fills: TradeFill[];
  strategyId: string | null;
  reason: string | null;
}

/** The account right after the trade, for the mail's percentage and details. */
export interface TradeAccount {
  equityEur: number;
  cashEur: number;
  /** Coins of the traded market held now, and their value. */
  held: (symbol: string) => { amount: number; eurValue: number };
  strategyName: (id: string) => string;
  /** Test mails say so at the top. */
  test?: boolean;
}

const baseOf = (market: string) => market.split('-')[0];
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** Whole percents; under 10 % one decimal, so a small trade does not read as nothing. */
export function pctText(pct: number): string {
  const rounded = pct >= 10 ? Math.round(pct) : Math.max(0.1, Math.round(pct * 10) / 10);
  return `${rounded}%`;
}

/** "B40% - 22:01 22-01-2026": the share of the whole portfolio traded, and when the trade finished. */
export function tradeSubject(t: Trade, equityEur: number): string {
  const pct = (sum(t.fills.map((f) => f.quote)) / equityEur) * 100;
  return `${t.side === 'buy' ? 'B' : 'S'}${pctText(pct)} - ${mailTime(Math.max(...t.fills.map((f) => f.executedAt)))}`;
}

const eur = (n: number) => `€${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const coins = (n: number) => n.toLocaleString('en-GB', { maximumFractionDigits: 8 });
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Fees in the currencies they were paid in. */
function feeText(fills: TradeFill[]): string {
  const per = new Map<string, number>();
  for (const f of fills) if (f.fee) per.set(f.feeCurrency ?? 'EUR', (per.get(f.feeCurrency ?? 'EUR') ?? 0) + f.fee);
  if (!per.size) return eur(0);
  return [...per].map(([currency, fee]) => (currency === 'EUR' ? eur(fee) : `${coins(fee)} ${currency}`)).join(' + ');
}

function liquidityText(fills: TradeFill[]): string {
  const taker = fills.filter((f) => f.taker).length;
  if (!taker) return 'Limit order (maker)';
  return taker === fills.length ? 'Market order (taker)' : 'Limit order, the rest at market';
}

/** Label and value per detail row, shared by the plain and the HTML version. */
function tradeRows(t: Trade, a: TradeAccount) {
  const symbol = baseOf(t.market);
  const amount = sum(t.fills.map((f) => f.amount));
  const quote = sum(t.fills.map((f) => f.quote));
  const held = a.held(symbol);
  const times = t.fills.map((f) => f.executedAt);
  const order: Array<[string, string]> = [
    ['Coin', t.market],
    ['Amount', `${coins(amount)} ${symbol}`],
    ['Average price', eur(quote / amount)],
    ['Total', eur(quote)],
    ['Fee', feeText(t.fills)],
    ['Filled as', `${liquidityText(t.fills)}, ${t.fills.length} fill${t.fills.length === 1 ? '' : 's'}`],
    ['First fill', mailTime(Math.min(...times))],
    ['Finished', mailTime(Math.max(...times))],
  ];
  if (t.strategyId) order.push(['Strategy', a.strategyName(t.strategyId)]);
  if (t.reason) order.push(['Why', t.reason]);
  const account: Array<[string, string]> = [
    ['Portfolio value', eur(a.equityEur)],
    ['Cash', eur(a.cashEur)],
    [`${symbol} held`, `${coins(held.amount)} ${symbol} (${eur(held.eurValue)})`],
  ];
  return { order, account, quote };
}

export function tradeText(t: Trade, a: TradeAccount): string {
  const { order, account } = tradeRows(t, a);
  const lines = (rows: Array<[string, string]>) => rows.map(([k, v]) => `${k}: ${v}`);
  return [
    ...(a.test ? ['TEST MAIL with sample numbers: no real trade happened.', ''] : []),
    `${t.side === 'buy' ? 'Bought' : 'Sold'} ${baseOf(t.market)}`,
    '',
    ...lines(order),
    '',
    'Account after this trade',
    ...lines(account),
    '',
    DASHBOARD,
  ].join('\n');
}

const htmlRows = (rows: Array<[string, string]>) =>
  rows
    .map(([k, v], i) => {
      const border = i ? 'border-top:1px solid #e4d9c7;' : '';
      return `<tr><td style="${border}padding:10px 12px 10px 0;color:#4f5668;font-size:14px;white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td><td style="${border}padding:10px 0;color:#18223a;font-size:14px;text-align:right">${escapeHtml(v)}</td></tr>`;
    })
    .join('');

const heading = (text: string) =>
  `<div style="margin:0 0 4px;color:#8a6a22;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase">${escapeHtml(text)}</div>`;

/** Tables and inline styles only: that is what mail clients keep. Colours are the dashboard's paper theme. */
export function tradeHtml(t: Trade, a: TradeAccount): string {
  const { order, account, quote } = tradeRows(t, a);
  const buy = t.side === 'buy';
  const accent = buy ? '#3c6a3c' : '#a0432a';
  const soft = buy ? '#e0ebd9' : '#f6e0d6';
  const pct = pctText((quote / a.equityEur) * 100);
  const sans = "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const test = a.test
    ? `<tr><td style="padding:10px 28px;background:#f2e7cc;color:#8a6a22;font-size:13px;font-weight:700;text-align:center">Test mail with sample numbers: no real trade happened</td></tr>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#f4ede3;font-family:${sans}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4ede3"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fbf7f0;border:1px solid #e4d9c7;border-radius:16px;overflow:hidden">
${test}
<tr><td style="padding:24px 28px 0;color:#18223a;font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:700">stonks<span style="color:#c9a24a">.</span></td></tr>
<tr><td style="padding:18px 28px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${soft};border-radius:11px"><tr><td style="padding:20px 22px">
<div style="color:${accent};font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase">${buy ? 'Bought' : 'Sold'} ${escapeHtml(baseOf(t.market))}</div>
<div style="margin-top:4px;color:${accent};font-family:Georgia,'Times New Roman',serif;font-size:42px;line-height:1.1;font-weight:700">${pct}</div>
<div style="margin-top:6px;color:#18223a;font-size:14px">of the portfolio, ${escapeHtml(eur(quote))}</div>
</td></tr></table></td></tr>
<tr><td style="padding:22px 28px 0">${heading('The order')}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${htmlRows(order)}</table></td></tr>
<tr><td style="padding:18px 28px 0">${heading('Account after this trade')}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${htmlRows(account)}</table></td></tr>
<tr><td style="padding:22px 28px 26px"><a href="${DASHBOARD}/trades" style="display:inline-block;background:#c9a24a;color:#18223a;font-size:14px;font-weight:700;text-decoration:none;padding:11px 20px;border-radius:11px">Open the trades</a></td></tr>
</table></td></tr></table></body></html>`;
}

/** Unmailed live fills of the last day grouped into trades, without those that still have an order working. */
export async function finishedTrades(now = Date.now()): Promise<Trade[]> {
  const { rows } = await query(
    `SELECT f.*, o.strategy_id, o.reason FROM fills f LEFT JOIN orders o ON o.id = f.order_id
      WHERE f.mode = 'live' AND f.mailed_at IS NULL AND f.executed_at > to_timestamp($1 / 1000.0) ORDER BY f.id`,
    [now - 86_400_000],
  );
  if (!rows.length) return [];
  const working = await query(
    `SELECT DISTINCT market, side FROM orders WHERE mode = 'live' AND (status = ANY($1)
       OR (status = 'canceled' AND (raw->>'chaseCancelAt')::bigint > $2 AND NOT COALESCE((raw->>'chaseDone')::boolean, false)))`,
    [OPEN_STATUSES, now - CHASE_LEFTOVER_MS],
  );
  const busy = new Set(working.rows.map((r) => `${r.market}|${r.side}`));
  const trades = new Map<string, Trade>();
  for (const r of rows) {
    const key = `${r.market}|${r.side}`;
    if (busy.has(key)) continue;
    let t = trades.get(key);
    if (!t) trades.set(key, (t = { market: String(r.market), side: r.side as Trade['side'], fills: [], strategyId: null, reason: null }));
    t.fills.push({
      id: Number(r.id), price: Number(r.price), amount: Number(r.amount), quote: Number(r.quote), fee: Number(r.fee),
      feeCurrency: (r.fee_currency as string | null) ?? null, taker: (r.taker as boolean | null) ?? null, executedAt: new Date(r.executed_at as Date).getTime(),
    });
    t.strategyId = (r.strategy_id as string | null) ?? t.strategyId;
    // The chase marks its later orders in the reason; the first one says why the trade happened.
    t.reason ??= (r.reason as string | null) ?? null;
  }
  return [...trades.values()];
}

let sending = false;
let nextTry = 0;

/** From the engine after every tick. Returns at once: the mails go out behind it, one at a time. */
export async function mailFinishedTrades(account: TradeAccount | undefined, now = Date.now()): Promise<void> {
  // Without an account there is no percentage yet: the fills wait for a tick that has one.
  if (sending || now < nextTry || !account?.equityEur || !alertsConfigured()) return;
  try {
    const trades = await finishedTrades(now);
    if (!trades.length) return;
    sending = true;
    void send(trades, account);
  } catch (err) {
    console.error(`[stonks] trade mail failed: ${errText(err)}`);
  }
}

async function send(trades: Trade[], account: TradeAccount) {
  try {
    for (const t of trades) {
      const subject = tradeSubject(t, account.equityEur);
      const sent = await deliver(subject, tradeText(t, account), tradeHtml(t, account));
      if (!sent.ok) {
        nextTry = Date.now() + RETRY_MS;
        return;
      }
      await query('UPDATE fills SET mailed_at = now() WHERE id = ANY($1)', [t.fills.map((f) => f.id)]);
      await log('info', 'trade_mailed', `Mailed "${subject}" for ${t.side} ${t.market}`, { fills: t.fills.map((f) => f.id) });
    }
  } catch (err) {
    nextTry = Date.now() + RETRY_MS;
    console.error(`[stonks] trade mail failed: ${errText(err)}`);
  } finally {
    sending = false;
  }
}

/** POST /api/bot/test-alert: a trade mail with sample numbers, right now. */
export async function sendTestAlert(): Promise<{ ok: boolean; configured: boolean; error?: string }> {
  if (!alertsConfigured()) return { ok: false, configured: false, error: 'Mail is not set up: SENDGRID_API_KEY must be set on the server.' };
  const trade = sampleTrade();
  const account = sampleAccount();
  const r = await deliver(tradeSubject(trade, account.equityEur), tradeText(trade, account), tradeHtml(trade, account));
  return { ...r, configured: true };
}

export const sampleTrade = (now = Date.now()): Trade => ({
  market: 'BTC-EUR',
  side: 'buy',
  strategyId: 'sample',
  reason: 'target 40.0 %',
  fills: [
    { id: 0, price: 92_000, amount: 0.003, quote: 276, fee: 0.41, feeCurrency: 'EUR', taker: false, executedAt: now - 90_000 },
    { id: 0, price: 92_040, amount: 0.00134725, quote: 124, fee: 0.19, feeCurrency: 'EUR', taker: false, executedAt: now },
  ],
});

export const sampleAccount = (): TradeAccount => ({
  equityEur: 1000,
  cashEur: 599.4,
  held: () => ({ amount: 0.00434725, eurValue: 400 }),
  strategyName: () => 'Sample strategy',
  test: true,
});
