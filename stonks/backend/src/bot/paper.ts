import { randomUUID } from 'node:crypto';
import { roundAmount } from '../bitvavo/precision.js';
import { db } from '../db.js';
import { errText, log } from '../log.js';
import { getSetting, setSetting } from '../settings.js';
import type { Balance, Broker, PlaceContext } from './broker.js';
import { cashDelta, paperLimitFills, paperMarketPrice, postOnlyPrice, type OrderIntent } from './logic.js';
import { bestBidAsk, minuteCandlesSince, ruleFor } from './marketData.js';
import { getOrderRow, insertOrder, openOrders, recordFill, updateOrder, type OrderRow } from './store.js';

/** `settings.paper_wallet`: { EUR: 1000, BTC: 0.01, ... } (SPEC §4). */
export type Wallet = Record<string, number>;

const WALLET_KEY = 'paper_wallet';
const ceilMinute = (ts: number) => Math.ceil(ts / 60_000) * 60_000;

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

      let price = intent.price!;
      if (intent.postOnly) {
        const repriced = postOnlyPrice(intent.side, price, book, rules);
        if (repriced !== price) {
          await log('info', 'order_repriced', `Post-only ${intent.side} ${intent.market} at ${price} would cross the book; repriced to ${repriced}`);
          price = repriced;
        }
      }
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
      const row = await insertOrder({
        mode: 'paper', clientOrderId: `stonks-${uuid}`, exchangeOrderId: `paper-${uuid}`, market: intent.market, side: intent.side,
        orderType: 'limit', price, amount: amountStr, status: 'new', strategyId: ctx.strategyId, reason: intent.reason,
        meta: { uuid, activeFrom: now, expiresAt: ctx.expiresAt, fallback: ctx.fallback, postOnly: intent.postOnly, barTime: ctx.barTime, feeRate, checkedFrom: ceilMinute(now) },
      });
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
        const from = o.meta.checkedFrom ?? ceilMinute(o.meta.activeFrom);
        let low = Infinity;
        let high = -Infinity;
        let lastSeen = from;
        if (Date.now() >= from) {
          const candles = await minuteCandlesSince(o.market, from);
          for (const c of candles) {
            low = Math.min(low, c[3]);
            high = Math.max(high, c[2]);
            lastSeen = Math.max(lastSeen, c[0]);
          }
        }
        // The live touch also counts (covers the first, partial minute after placing).
        const book = await bestBidAsk(o.market);
        low = Math.min(low, book.ask);
        high = Math.max(high, book.bid);
        if (paperLimitFills(o.side, o.price, low, high)) {
          if (await this.applyFill(o.id, o.price, o.meta.feeRate ?? 0, false)) fills++;
        } else if (lastSeen !== o.meta.checkedFrom) {
          await updateOrder(o.id, {}, { checkedFrom: lastSeen });
        }
      } catch (err) {
        await log('warn', 'paper_sync_failed', `Checking paper order ${o.id} (${o.market}) failed: ${errText(err)}`);
      }
    }
    return fills;
  }

  /**
   * Fills a whole paper order at `price` in one transaction: wallet, fill row and order row move together, and an
   * order that is no longer open is left alone (so a fill can never be applied twice).
   */
  private async applyFill(orderId: number, price: number, feeRate: number, taker: boolean): Promise<boolean> {
    const client = await db().connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query("SELECT value FROM settings WHERE key = $1 FOR UPDATE", [WALLET_KEY]);
      const wallet: Wallet = rows[0]?.value ?? { EUR: this.startEur() };
      const o = await getOrderRow(orderId, client);
      const lock = await client.query("SELECT id FROM orders WHERE id = $1 AND status IN ('pending','new','partiallyFilled','awaitingTrigger') FOR UPDATE", [orderId]);
      if (!o || !lock.rowCount) {
        await client.query('ROLLBACK');
        return false;
      }
      const base = o.market.split('-')[0];
      let amount = o.amount - o.filledAmount;
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
      await recordFill(
        { orderId, mode: 'paper', tradeId: `paper-${o.meta.uuid}-1`, market: o.market, side: o.side, price, amount, quote: d.quote, fee: d.fee, feeCurrency: 'EUR', taker, executedAt: Date.now() },
        client,
      );
      await updateOrder(
        orderId,
        { status: 'filled', filledAmount: o.filledAmount + amount, filledQuote: o.filledQuote + d.quote, feePaid: o.feePaid + d.fee, feeCurrency: 'EUR', price: o.price ?? price },
        undefined,
        client,
      );
      await client.query('COMMIT');
      await log('info', 'order_filled', `Paper ${o.side} ${amount} ${o.market} filled at ${price} (fee €${d.fee.toFixed(4)}, ${taker ? 'taker' : 'maker'})`, { orderId, price, amount, fee: d.fee });
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
