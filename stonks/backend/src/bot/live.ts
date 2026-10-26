import { randomUUID } from 'node:crypto';
import { bitvavo, BitvavoError, RateLimitedError, type BitvavoOrder, type PlaceOrderParams } from '../bitvavo/index.js';
import { query } from '../db.js';
import { errText, log } from '../log.js';
import type { Balance, Broker, PlaceContext } from './broker.js';
import { postOnlyPrice, type OrderIntent } from './logic.js';
import { bestBidAsk, ruleFor } from './marketData.js';
import { fillsForOrder, insertOrder, isOpenStatus, openOrders, recordFill, updateOrder, type OrderRow } from './store.js';

/** Bitvavo: "No order found". */
const ORDER_NOT_FOUND = 240;
/** A pending order the exchange still does not know after this long was never placed. */
const PENDING_GIVE_UP_MS = 2 * 60_000;

const idsOf = (o: OrderRow) => (o.exchangeOrderId ? { orderId: o.exchangeOrderId } : { clientOrderId: o.meta.uuid });

/**
 * Real Bitvavo orders. Every order is written to the DB as "pending" BEFORE it is sent, with the UUID used as
 * Bitvavo's clientOrderId, so a crash or network error between sending and saving is resolved on the next sync by
 * looking the order up by that UUID. Requests that may have reached the exchange are never resent.
 */
export class LiveBroker implements Broker {
  readonly mode = 'live' as const;

  async balances(): Promise<Balance[]> {
    const raw = await bitvavo.balance();
    return raw.map((b) => ({ symbol: b.symbol, available: Number(b.available), inOrder: Number(b.inOrder) }));
  }

  async place(intent: OrderIntent, ctx: PlaceContext): Promise<OrderRow | null> {
    let row: OrderRow | null = null;
    try {
      const rules = await ruleFor(intent.market);
      let price = intent.price;
      if (intent.orderType === 'limit' && intent.postOnly && price) {
        const repriced = postOnlyPrice(intent.side, price, await bestBidAsk(intent.market), rules);
        if (repriced !== price) {
          await log('info', 'order_repriced', `Post-only ${intent.side} ${intent.market} at ${price} would cross the book; repriced to ${repriced}`);
          price = repriced;
        }
      }
      const uuid = randomUUID();
      row = await insertOrder({
        mode: 'live', clientOrderId: `stonks-${uuid}`, market: intent.market, side: intent.side, orderType: intent.orderType,
        price: price ?? null, amount: intent.amount ?? '0', status: 'pending', strategyId: ctx.strategyId, reason: intent.reason,
        meta: { uuid, activeFrom: Date.now(), expiresAt: intent.orderType === 'limit' ? ctx.expiresAt : null, fallback: ctx.fallback, postOnly: intent.postOnly, amountQuote: intent.amountQuote, barTime: ctx.barTime },
      });
      const params: PlaceOrderParams = { market: intent.market, side: intent.side, orderType: intent.orderType, clientOrderId: uuid };
      if (intent.orderType === 'limit') {
        params.amount = intent.amount;
        params.price = price;
        params.postOnly = intent.postOnly;
        params.timeInForce = 'GTC';
      } else if (intent.amountQuote) params.amountQuote = intent.amountQuote;
      else params.amount = intent.amount;
      await log('info', 'order_sending', `Live ${intent.orderType} ${intent.side} ${intent.amount ?? `€${intent.amountQuote}`} ${intent.market}${price ? ` at ${price}` : ''} (${intent.reason})`, { orderId: row.id, clientOrderId: uuid });
      const res = await bitvavo.placeOrder(params);
      await this.apply(row, res);
      await log('info', 'order_placed', `Live order ${row.id} accepted by Bitvavo: ${res.status}`, { orderId: row.id, exchangeOrderId: res.orderId });
      return row;
    } catch (err) {
      if (!row) {
        await log('error', 'order_failed', `Live ${intent.side} ${intent.market} not sent: ${errText(err)}`);
        return null;
      }
      if (err instanceof BitvavoError && err.definitelyRejected) {
        await updateOrder(row.id, { status: 'rejected' }, { error: err.message });
        await log('error', 'order_rejected', `Bitvavo rejected live ${intent.side} ${intent.market}: ${err.message}`, { orderId: row.id, errorCode: err.errorCode });
        return null;
      }
      // Unknown outcome: keep it "pending"; sync looks it up by clientOrderId and never resends.
      await updateOrder(row.id, {}, { error: errText(err) });
      await log('warn', 'order_uncertain', `Live order ${row.id} outcome unknown (${errText(err)}); will check with Bitvavo`, { orderId: row.id });
      return row;
    }
  }

  async cancel(order: OrderRow, why: string): Promise<boolean> {
    if (order.mode !== 'live' || !order.clientOrderId.startsWith('stonks-')) return false; // only ever our own orders
    try {
      await bitvavo.cancelOrder(order.market, idsOf(order));
      await log('info', 'order_canceled', `Live ${order.side} ${order.market} order ${order.id} cancelled: ${why}`, { orderId: order.id });
    } catch (err) {
      if (!(err instanceof BitvavoError && err.errorCode === ORDER_NOT_FOUND)) {
        await log('error', 'cancel_failed', `Cancelling live order ${order.id} (${order.market}) failed: ${errText(err)}`, { orderId: order.id });
        return false;
      }
    }
    // Read back the final state: it may have (partly) filled just before the cancel.
    await this.syncOne(order).catch(() => undefined);
    const { rows } = await query('SELECT status FROM orders WHERE id = $1', [order.id]);
    return !isOpenStatus(String(rows[0]?.status ?? 'canceled'));
  }

  async sync(): Promise<number> {
    let fills = 0;
    for (const o of await openOrders('live')) {
      try {
        fills += await this.syncOne(o);
      } catch (err) {
        if (err instanceof RateLimitedError) throw err;
        await log('warn', 'order_sync_failed', `Checking live order ${o.id} (${o.market}) failed: ${errText(err)}`, { orderId: o.id });
      }
    }
    return fills;
  }

  /** Startup check: orders Bitvavo reports open that carry one of our UUIDs but are closed in the DB get re-synced. */
  async reconcile(): Promise<void> {
    const open = await bitvavo.ordersOpen();
    for (const ex of open.filter((o) => o.clientOrderId)) {
      const { rows } = await query("SELECT * FROM orders WHERE mode = 'live' AND client_order_id = $1", [`stonks-${ex.clientOrderId}`]);
      if (!rows[0]) continue; // not ours: never touched
      if (!isOpenStatus(String(rows[0].status))) {
        await log('warn', 'reconcile', `Bitvavo still has order ${ex.orderId} open that the DB had as ${rows[0].status}; updating`, { orderId: rows[0].id });
        await query("UPDATE orders SET status = 'new', updated_at = now() WHERE id = $1", [rows[0].id]);
      }
    }
    await this.sync();
  }

  private async syncOne(o: OrderRow): Promise<number> {
    let ex: BitvavoOrder;
    try {
      ex = await bitvavo.getOrder(o.market, idsOf(o));
    } catch (err) {
      if (err instanceof BitvavoError && err.errorCode === ORDER_NOT_FOUND && o.status === 'pending' && Date.now() - o.meta.activeFrom > PENDING_GIVE_UP_MS) {
        await updateOrder(o.id, { status: 'rejected' }, { error: 'Bitvavo never received this order' });
        await log('warn', 'order_not_found', `Live order ${o.id} was never received by Bitvavo; marked rejected`, { orderId: o.id });
        return 0;
      }
      throw err;
    }
    return this.apply(o, ex);
  }

  /** Copies the exchange's view of an order into the DB and records its fills. Returns new fills. */
  private async apply(o: OrderRow, ex: BitvavoOrder): Promise<number> {
    const prev = o.status;
    await updateOrder(
      o.id,
      {
        status: ex.status,
        exchangeOrderId: ex.orderId,
        filledAmount: Number(ex.filledAmount ?? 0),
        filledQuote: Number(ex.filledAmountQuote ?? 0),
        feePaid: Number(ex.feePaid ?? 0),
        feeCurrency: ex.feeCurrency ?? null,
        amount: ex.amount ?? (o.amount || ex.filledAmount),
        price: ex.price ?? o.price,
      },
      { exchange: { status: ex.status, updated: ex.updated, amountRemaining: ex.amountRemaining } },
    );
    let fresh = 0;
    let fills = ex.fills ?? [];
    const filled = Number(ex.filledAmount ?? 0);
    const known = (await fillsForOrder(o.id)).reduce((s, f) => s + f.amount, 0);
    const listed = fills.reduce((s, f) => s + Number(f.amount), 0);
    if (filled > Math.max(known, listed) + 1e-12) {
      // The order response did not carry every fill: read them from the trade history.
      // Bitvavo allows at most 24 h between start and end.
      const start = Math.max(0, o.meta.activeFrom - 60_000);
      const trades = await bitvavo.trades(o.market, { start, end: Math.min(Date.now(), start + 86_000_000), limit: 1000 });
      fills = trades
        .filter((t) => t.orderId === ex.orderId)
        .map((t) => ({ id: t.id, timestamp: t.timestamp, amount: t.amount, price: t.price, taker: t.taker, fee: t.fee, feeCurrency: t.feeCurrency, settled: t.settled }));
    }
    for (const f of fills) {
      const amount = Number(f.amount);
      const price = Number(f.price);
      const isNew = await recordFill({
        orderId: o.id, mode: 'live', tradeId: String(f.id), market: o.market, side: o.side, price, amount, quote: amount * price,
        fee: Number(f.fee ?? 0), feeCurrency: f.feeCurrency ?? null, taker: f.taker ?? null, executedAt: Number(f.timestamp),
      });
      if (isNew) {
        fresh++;
        await log('info', 'order_filled', `Live ${o.side} ${amount} ${o.market} filled at ${price}${f.fee ? ` (fee ${f.fee} ${f.feeCurrency})` : ''}`, { orderId: o.id, tradeId: f.id, taker: f.taker });
      }
    }
    if (prev !== ex.status && !isOpenStatus(ex.status))
      await log('info', 'order_closed', `Live order ${o.id} (${o.side} ${o.market}) is ${ex.status}`, { orderId: o.id, filledAmount: ex.filledAmount });
    return fresh;
  }
}
