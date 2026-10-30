import { randomUUID } from 'node:crypto';
import { bitvavo } from '../bitvavo/index.js';
import { roundAmount } from '../bitvavo/precision.js';
import { db } from '../db.js';
import { errText, log } from '../log.js';
import { getSetting, setSetting } from '../settings.js';
import { chaseMeta, type Balance, type Broker, type PlaceContext } from './broker.js';
import { cashDelta, paperLimitFills, paperMarketPrice, type OrderIntent } from './logic.js';
import { bestBidAsk, ruleFor } from './marketData.js';
import { getOrderRow, insertOrder, openOrders, recordFill, updateOrder, type OrderRow } from './store.js';

/** `settings.paper_wallet`: { EUR: 1000, BTC: 0.01, ... } (SPEC §4). */
export type Wallet = Record<string, number>;

const WALLET_KEY = 'paper_wallet';

/** Queue proxy: a resting paper order gets at most this share of the volume traded through its price. */
export const PAPER_QUEUE_SHARE = 0.25;
/** Bitvavo's page size for public trades, its limit on start..end (as in live.ts), and how far back one check pages. */
const TRADES_PAGE = 1000;
const TRADES_MAX_SPAN_MS = 86_000_000;
const TRADES_MAX_PAGES = 10;
/** An order with less than this left is finished (float noise, not a real rest). */
const DUST = 1e-12;

/** One public market trade, the fields the fill check needs. */
export interface MarketTrade {
  id: string;
  timestamp: number;
  amount: string;
  price: string;
}

/** Public trades of a market after `from` (ms), newest first as Bitvavo pages them; at most TRADES_MAX_PAGES pages. */
async function tradesSince(market: string, from: number, now: number): Promise<MarketTrade[]> {
  const start = Math.max(from, now - TRADES_MAX_SPAN_MS);
  const seen = new Map<string, MarketTrade>();
  let end = now;
  for (let page = 0; page < TRADES_MAX_PAGES; page++) {
    const raw = await bitvavo.request<MarketTrade[]>('GET', `/${market}/trades`, { query: { start, end, limit: TRADES_PAGE } });
    for (const t of raw) seen.set(t.id, t);
    if (raw.length < TRADES_PAGE) break;
    const oldest = Math.min(...raw.map((t) => t.timestamp));
    if (oldest >= end) break; // a full page within one millisecond: nothing further to page to
    end = oldest;
  }
  return [...seen.values()];
}

/**
 * Volume traded strictly through a resting order's price after it was placed (SPEC §2: touching is not enough). Trades
 * from before `activeFrom` never count, so an order, repriced or not, only sees the market it actually stood in.
 */
export function volumeThrough(trades: MarketTrade[], side: 'buy' | 'sell', price: number, activeFrom: number): number {
  let volume = 0;
  for (const t of trades) {
    const p = Number(t.price);
    if (t.timestamp > activeFrom && paperLimitFills(side, price, p, p)) volume += Number(t.amount);
  }
  return volume;
}

/**
 * How much of an order fills now: its total is capped at `share` of the volume through its price, rounded down to the
 * market's decimals. A rest under one step cannot be traded, so that case fills the order completely.
 */
export function queueFillAmount(amount: number, filled: number, through: number, quantityDecimals: number, share = PAPER_QUEUE_SHARE): number {
  const rest = amount - filled;
  const want = Math.min(rest, through * share - filled);
  if (!(want > 0)) return 0;
  return rest - want < 10 ** -quantityDecimals ? rest : Number(roundAmount(want, quantityDecimals));
}

export async function getWallet(startEur: number): Promise<Wallet> {
  const w = await getSetting<Wallet>(WALLET_KEY);
  if (w && typeof w === 'object') return w;
  const fresh: Wallet = { EUR: startEur };
  await db().query(
    `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
    [WALLET_KEY, JSON.stringify(fresh)],
  );
  return (await getSetting<Wallet>(WALLET_KEY)) ?? fresh;
}

/** Cancels every open paper order and starts the wallet over with `startEur`. */
export async function resetPaperWallet(startEur: number): Promise<void> {
  await db().query(`UPDATE orders SET status = 'canceled', reason = COALESCE(reason, '') || ' (paper wallet reset)', updated_at = now()
                    WHERE mode = 'paper' AND status IN ('pending','new','partiallyFilled','awaitingTrigger')`);
  await setSetting(WALLET_KEY, { EUR: startEur });
  await log('info', 'paper_wallet_reset', `Paper wallet reset to €${startEur}`);
}

/** What open paper orders hold back: EUR for buys (with the fee), coins for sells. */
function reserved(orders: OrderRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of orders) {
    const base = o.market.split('-')[0];
    if (o.side === 'buy') out.EUR = (out.EUR ?? 0) + (o.amount - o.filledAmount) * (o.price ?? 0) * (1 + (o.meta.feeRate ?? 0));
    else out[base] = (out[base] ?? 0) + (o.amount - o.filledAmount);
  }
  return out;
}

export class PaperBroker implements Broker {
  readonly mode = 'paper' as const;
  constructor(private readonly startEur: () => number) {}

  async balances(): Promise<Balance[]> {
    const wallet = await getWallet(this.startEur());
    const res = reserved(await openOrders('paper'));
    const symbols = new Set([...Object.keys(wallet), 'EUR']);
    return [...symbols]
      .map((symbol) => {
        const total = Number(wallet[symbol] ?? 0);
        const inOrder = Math.min(total, res[symbol] ?? 0);
        return { symbol, available: Math.max(0, total - inOrder), inOrder };
      })
      .filter((b) => b.symbol === 'EUR' || b.available + b.inOrder > 0);
  }

  async place(intent: OrderIntent, ctx: PlaceContext): Promise<OrderRow | null> {
    try {
      const rules = await ruleFor(intent.market);
      const book = await bestBidAsk(intent.market);
      const balances = await this.balances();
      const free = (s: string) => balances.find((b) => b.symbol === s)?.available ?? 0;
      const base = intent.market.split('-')[0];
      const uuid = randomUUID();
      const now = Date.now();

      if (intent.orderType === 'market') {
        const price = paperMarketPrice(intent.side, book);
        let amount = intent.side === 'buy' ? Number(intent.amountQuote) / price : Number(intent.amount);
        if (intent.side === 'buy') amount = Math.min(amount, free('EUR') / (price * (1 + ctx.fees.taker)));
        else amount = Math.min(amount, free(base));
        const amountStr = roundAmount(amount, rules.quantityDecimals);
        if (!(Number(amountStr) > 0)) {
          await log('warn', 'order_skipped', `Paper ${intent.side} ${intent.market} skipped: not enough ${intent.side === 'buy' ? 'EUR' : base}`);
          return null;
        }
        const row = await insertOrder({
          mode: 'paper', clientOrderId: `stonks-${uuid}`, exchangeOrderId: `paper-${uuid}`, market: intent.market, side: intent.side,
          orderType: 'market', price: null, amount: amountStr, status: 'new', strategyId: ctx.strategyId, reason: intent.reason,
          meta: { uuid, activeFrom: now, expiresAt: null, fallback: 'cancel', postOnly: false, amountQuote: intent.amountQuote, barTime: ctx.barTime, feeRate: ctx.fees.taker },
        });
        await log('info', 'order_placed', `Paper market ${intent.side} ${amountStr} ${intent.market} (${intent.reason})`, { orderId: row.id });
        await this.applyFill(row.id, price, ctx.fees.taker, true);
        return (await getOrderRow(row.id)) ?? row;
      }

      const price = intent.price!;
      const crosses = intent.side === 'buy' ? Number(price) >= book.ask : Number(price) <= book.bid;
      const feeRate = crosses ? ctx.fees.taker : ctx.fees.maker;
      let amount = Number(intent.amount);
      if (intent.side === 'buy') amount = Math.min(amount, free('EUR') / (Number(price) * (1 + feeRate)));
      else amount = Math.min(amount, free(base));
      const amountStr = roundAmount(amount, rules.quantityDecimals);
      if (!(Number(amountStr) > 0) || Number(amountStr) * Number(price) < rules.minOrderInQuoteAsset) {
        await log('warn', 'order_skipped', `Paper ${intent.side} ${intent.market} skipped: not enough ${intent.side === 'buy' ? 'EUR' : base} for a minimum order`);
        return null;
      }
      // Bitvavo cancels a post-only order that would cross when it arrives, so the order never rests or reserves funds.
      const rejected = intent.postOnly && crosses;
      const row = await insertOrder({
        mode: 'paper', clientOrderId: `stonks-${uuid}`, exchangeOrderId: `paper-${uuid}`, market: intent.market, side: intent.side,
        orderType: 'limit', price, amount: amountStr, status: rejected ? 'canceledPostOnly' : 'new', strategyId: ctx.strategyId, reason: intent.reason,
        meta: { uuid, activeFrom: now, expiresAt: ctx.expiresAt, fallback: ctx.fallback, postOnly: intent.postOnly, barTime: ctx.barTime, feeRate, ...chaseMeta(ctx) },
      });
      if (rejected) {
        await log('warn', 'order_canceled_post_only', `Paper post-only ${intent.side} ${intent.market} at ${price} would cross the book (${book.bid} / ${book.ask}): cancelled like Bitvavo does`, { orderId: row.id, book });
        return row;
      }
      await log('info', 'order_placed', `Paper limit ${intent.side} ${amountStr} ${intent.market} at ${price} (${intent.reason})`, { orderId: row.id, postOnly: intent.postOnly });
      if (crosses) {
        // Only reachable without postOnly: a marketable limit order takes liquidity at its own price.
        await this.applyFill(row.id, Number(price), feeRate, true);
        return (await getOrderRow(row.id)) ?? row;
      }
      return row;
    } catch (err) {
      await log('error', 'order_failed', `Paper ${intent.side} ${intent.market} failed: ${errText(err)}`);
      return null;
    }
  }

  async cancel(order: OrderRow, why: string): Promise<boolean> {
    const client = await db().connect();
    try {
      // Status guard: an order that just filled stays filled.
      const res = await client.query(
        `UPDATE orders SET status = 'canceled', updated_at = now() WHERE id = $1 AND status IN ('pending','new','partiallyFilled','awaitingTrigger')`,
        [order.id],
      );
      if (res.rowCount) await log('info', 'order_canceled', `Paper ${order.side} ${order.market} order ${order.id} cancelled: ${why}`, { orderId: order.id });
      return true;
    } finally {
      client.release();
    }
  }

  async sync(): Promise<number> {
    let fills = 0;
    for (const o of await openOrders('paper')) {
      try {
        if (o.orderType !== 'limit' || o.price === null) continue;
        const rules = await ruleFor(o.market);
        const trades = await tradesSince(o.market, o.meta.activeFrom, Date.now());
        const through = volumeThrough(trades, o.side, o.price, o.meta.activeFrom);
        const amount = queueFillAmount(o.amount, o.filledAmount, through, rules.quantityDecimals);
        if (amount > 0 && (await this.applyFill(o.id, o.price, o.meta.feeRate ?? 0, false, amount))) fills++;
      } catch (err) {
        await log('warn', 'paper_sync_failed', `Checking paper order ${o.id} (${o.market}) failed: ${errText(err)}`);
      }
    }
    return fills;
  }

  /**
   * Fills `requested` of a paper order (default: all that is left) at `price` in one transaction: wallet, fill row and
   * order row move together, and an order that is no longer open is left alone (so a fill can never be applied twice).
   * A partial fill leaves the order working as `partiallyFilled`.
   */
  private async applyFill(orderId: number, price: number, feeRate: number, taker: boolean, requested = Infinity): Promise<boolean> {
    const client = await db().connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query("SELECT value FROM settings WHERE key = $1 FOR UPDATE", [WALLET_KEY]);
      const wallet: Wallet = rows[0]?.value ?? { EUR: this.startEur() };
      const lock = await client.query("SELECT id FROM orders WHERE id = $1 AND status IN ('pending','new','partiallyFilled','awaitingTrigger') FOR UPDATE", [orderId]);
      const o = await getOrderRow(orderId, client);
      if (!o || !lock.rowCount) {
        await client.query('ROLLBACK');
        return false;
      }
      const base = o.market.split('-')[0];
      const open = o.amount - o.filledAmount;
      const planned = Math.min(requested, open);
      let amount = planned;
      const eur = Number(wallet.EUR ?? 0);
      const coins = Number(wallet[base] ?? 0);
      if (o.side === 'buy') amount = Math.min(amount, eur / (price * (1 + feeRate)));
      else amount = Math.min(amount, coins);
      if (!(amount > 0)) {
        await client.query("UPDATE orders SET status = 'canceled', reason = COALESCE(reason,'') || ' (paper: not enough funds at fill time)', updated_at = now() WHERE id = $1", [orderId]);
        await client.query('COMMIT');
        await log('warn', 'paper_fill_failed', `Paper order ${orderId} cancelled: not enough funds when it would fill`);
        return false;
      }
      const d = cashDelta(o.side, amount, price, feeRate);
      wallet.EUR = eur + d.eur;
      wallet[base] = o.side === 'buy' ? coins + amount : coins - amount;
      if (Math.abs(wallet[base]) < 1e-12) delete wallet[base];
      await client.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [WALLET_KEY, JSON.stringify(wallet)],
      );
      const done = await client.query('SELECT COUNT(*) AS n FROM fills WHERE order_id = $1', [orderId]);
      await recordFill(
        { orderId, mode: 'paper', tradeId: `paper-${o.meta.uuid}-${Number(done.rows[0].n) + 1}`, market: o.market, side: o.side, price, amount, quote: d.quote, fee: d.fee, feeCurrency: 'EUR', taker, executedAt: Date.now() },
        client,
      );
      const left = open - planned;
      await updateOrder(
        orderId,
        { status: left > DUST ? 'partiallyFilled' : 'filled', filledAmount: o.filledAmount + amount, filledQuote: o.filledQuote + d.quote, feePaid: o.feePaid + d.fee, feeCurrency: 'EUR', price: o.price ?? price },
        undefined,
        client,
      );
      await client.query('COMMIT');
      await log('info', 'order_filled', `Paper ${o.side} ${amount} ${o.market} filled at ${price} (fee €${d.fee.toFixed(4)}, ${taker ? 'taker' : 'maker'}${left > DUST ? `, ${left} still working` : ''})`, { orderId, price, amount, fee: d.fee });
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
