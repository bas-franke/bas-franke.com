import type pg from 'pg';
import { query } from '../db.js';

export type Mode = 'paper' | 'live';

/** Statuses that still need watching. "pending" = written to the DB, not yet confirmed by the exchange. */
export const OPEN_STATUSES = ['pending', 'new', 'partiallyFilled', 'awaitingTrigger'] as const;
export const isOpenStatus = (s: string) => (OPEN_STATUSES as readonly string[]).includes(s);

/** Extra per-order data kept in `orders.raw`. */
export interface OrderMeta {
  /** The UUID sent to Bitvavo as clientOrderId (client_order_id is "stonks-" + this). */
  uuid: string;
  /** When the order started working (ms). */
  activeFrom: number;
  /** When an unfilled limit order is cancelled (ms); null = never (market orders, stops). */
  expiresAt: number | null;
  fallback: 'cancel' | 'market';
  postOnly: boolean;
  amountQuote?: string;
  /** Bar the decision was made on. */
  barTime?: number;
  /** Paper broker: minute up to which the fill check has looked at prices. */
  checkedFrom?: number;
  /** Paper broker: fee rate a fill pays (maker or taker). */
  feeRate?: number;
  /** Last exchange response or error. */
  exchange?: unknown;
  error?: string;
  /** Set once the fallback market order for this order has been placed (never twice). */
  fallbackDone?: boolean;
  /** Order-book chase: when the first order of this chain was placed (ms); re-placed orders keep it. */
  chaseSince?: number;
  /** Order-book chase: id of the first order of this chain. */
  chaseRoot?: number;
  /** Order-book chase: when this order was cancelled to be re-placed (ms). */
  chaseCancelAt?: number;
  /** Order-book chase: set once the rest of this order was re-placed or given up (never twice). */
  chaseDone?: boolean;
}

export interface OrderRow {
  id: number;
  mode: Mode;
  clientOrderId: string;
  exchangeOrderId: string | null;
  market: string;
  side: 'buy' | 'sell';
  orderType: string;
  price: number | null;
  amount: number;
  filledAmount: number;
  filledQuote: number;
  feePaid: number;
  feeCurrency: string | null;
  status: string;
  strategyId: string | null;
  reason: string | null;
  meta: OrderMeta;
  createdAt: Date;
}

const rowToOrder = (r: Record<string, unknown>): OrderRow => ({
  id: Number(r.id),
  mode: r.mode as Mode,
  clientOrderId: String(r.client_order_id),
  exchangeOrderId: (r.exchange_order_id as string | null) ?? null,
  market: String(r.market),
  side: r.side as 'buy' | 'sell',
  orderType: String(r.order_type),
  price: r.price === null ? null : Number(r.price),
  amount: Number(r.amount),
  filledAmount: Number(r.filled_amount),
  filledQuote: Number(r.filled_quote),
  feePaid: Number(r.fee_paid),
  feeCurrency: (r.fee_currency as string | null) ?? null,
  status: String(r.status),
  strategyId: (r.strategy_id as string | null) ?? null,
  reason: (r.reason as string | null) ?? null,
  meta: (r.raw ?? {}) as OrderMeta,
  createdAt: r.created_at as Date,
});

export async function openOrders(mode: Mode, market?: string): Promise<OrderRow[]> {
  const { rows } = await query(
    `SELECT * FROM orders WHERE mode = $1 AND status = ANY($2) AND ($3::text IS NULL OR market = $3) ORDER BY id`,
    [mode, OPEN_STATUSES, market ?? null],
  );
  return rows.map(rowToOrder);
}

/**
 * Orders the chase cancelled after `since` (ms) whose rest was not re-placed yet: Bitvavo can be slow to report a
 * cancelled order, so the cancel did not confirm and the next tick continues the chain once sync has closed it.
 */
export async function chaseLeftovers(mode: Mode, since: number): Promise<OrderRow[]> {
  const { rows } = await query(
    `SELECT * FROM orders WHERE mode = $1 AND status = 'canceled' AND (raw->>'chaseCancelAt')::bigint > $2
       AND NOT COALESCE((raw->>'chaseDone')::boolean, false) ORDER BY id`,
    [mode, since],
  );
  return rows.map(rowToOrder);
}

export async function getOrderRow(id: number, db?: pg.PoolClient): Promise<OrderRow | undefined> {
  const sql = 'SELECT * FROM orders WHERE id = $1';
  const { rows } = db ? await db.query(sql, [id]) : await query(sql, [id]);
  return rows[0] ? rowToOrder(rows[0]) : undefined;
}

export async function insertOrder(o: {
  mode: Mode;
  clientOrderId: string;
  market: string;
  side: 'buy' | 'sell';
  orderType: string;
  price: string | null;
  amount: string;
  status: string;
  strategyId: string | null;
  reason: string;
  meta: OrderMeta;
  exchangeOrderId?: string | null;
}): Promise<OrderRow> {
  const { rows } = await query(
    `INSERT INTO orders (mode, client_order_id, exchange_order_id, market, side, order_type, price, amount, status, strategy_id, reason, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [o.mode, o.clientOrderId, o.exchangeOrderId ?? null, o.market, o.side, o.orderType, o.price, o.amount, o.status, o.strategyId, o.reason, JSON.stringify(o.meta)],
  );
  return rowToOrder(rows[0]);
}

export async function updateOrder(
  id: number,
  patch: Partial<{ status: string; exchangeOrderId: string | null; filledAmount: number; filledQuote: number; feePaid: number; feeCurrency: string | null; price: string | number | null; amount: string | number }>,
  metaPatch?: Partial<OrderMeta>,
  db?: pg.PoolClient,
): Promise<void> {
  const cols: Record<string, unknown> = {
    status: patch.status,
    exchange_order_id: patch.exchangeOrderId,
    filled_amount: patch.filledAmount,
    filled_quote: patch.filledQuote,
    fee_paid: patch.feePaid,
    fee_currency: patch.feeCurrency,
    price: patch.price,
    amount: patch.amount,
  };
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(cols)) {
    if (v === undefined) continue;
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  if (metaPatch) {
    params.push(JSON.stringify(metaPatch));
    sets.push(`raw = COALESCE(raw, '{}'::jsonb) || $${params.length}::jsonb`);
  }
  params.push(id);
  const sql = `UPDATE orders SET ${[...sets, 'updated_at = now()'].join(', ')} WHERE id = $${params.length}`;
  if (db) await db.query(sql, params);
  else await query(sql, params);
}

export interface FillRow {
  id: number;
  orderId: number | null;
  market: string;
  side: 'buy' | 'sell';
  price: number;
  amount: number;
  quote: number;
  fee: number;
  feeCurrency: string | null;
  executedAt: Date;
}

const rowToFill = (r: Record<string, unknown>): FillRow => ({
  id: Number(r.id),
  orderId: r.order_id === null ? null : Number(r.order_id),
  market: String(r.market),
  side: r.side as 'buy' | 'sell',
  price: Number(r.price),
  amount: Number(r.amount),
  quote: Number(r.quote),
  fee: Number(r.fee),
  feeCurrency: (r.fee_currency as string | null) ?? null,
  executedAt: r.executed_at as Date,
});

/**
 * Records one execution; idempotent on (mode, exchange_trade_id). A fill seen earlier without its fee (Bitvavo
 * only reports the fee once settled) gets the fee filled in. Returns true when the row is new.
 */
export async function recordFill(
  f: { orderId: number | null; mode: Mode; tradeId: string; market: string; side: 'buy' | 'sell'; price: number; amount: number; quote: number; fee: number; feeCurrency: string | null; taker: boolean | null; executedAt: number },
  db?: pg.PoolClient,
): Promise<boolean> {
  const sql = `INSERT INTO fills (order_id, mode, exchange_trade_id, market, side, price, amount, quote, fee, fee_currency, taker, executed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12 / 1000.0))
     ON CONFLICT (mode, exchange_trade_id) DO UPDATE SET fee = EXCLUDED.fee, fee_currency = EXCLUDED.fee_currency
       WHERE fills.fee_currency IS NULL AND EXCLUDED.fee_currency IS NOT NULL
     RETURNING (xmax = 0) AS inserted`;
  const params = [f.orderId, f.mode, f.tradeId, f.market, f.side, f.price, f.amount, f.quote, f.fee, f.feeCurrency, f.taker, f.executedAt];
  const { rows } = db ? await db.query(sql, params) : await query(sql, params);
  return Boolean(rows[0]?.inserted);
}

export async function fillsFor(mode: Mode, market: string): Promise<FillRow[]> {
  const { rows } = await query('SELECT * FROM fills WHERE mode = $1 AND market = $2 ORDER BY executed_at, id', [mode, market]);
  return rows.map(rowToFill);
}

export async function fillsAfter(mode: Mode, afterId: number): Promise<FillRow[]> {
  const { rows } = await query('SELECT * FROM fills WHERE mode = $1 AND id > $2 ORDER BY id LIMIT 5000', [mode, afterId]);
  return rows.map(rowToFill);
}

export async function maxFillId(mode: Mode): Promise<number> {
  const { rows } = await query('SELECT COALESCE(MAX(id), 0) AS m FROM fills WHERE mode = $1', [mode]);
  return Number(rows[0].m);
}

export async function fillsForOrder(orderId: number): Promise<FillRow[]> {
  const { rows } = await query('SELECT * FROM fills WHERE order_id = $1 ORDER BY id', [orderId]);
  return rows.map(rowToFill);
}
