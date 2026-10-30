import type { OrderIntent } from './logic.js';
import type { Mode, OrderRow } from './store.js';

export interface Balance {
  symbol: string;
  available: number;
  inOrder: number;
}

export interface PlaceContext {
  strategyId: string | null;
  /** When an unfilled limit order gets cancelled (null = never). */
  expiresAt: number | null;
  fallback: 'cancel' | 'market';
  barTime?: number;
  fees: { maker: number; taker: number };
  /** Limit orders that follow the order book (settings.chase, every limit order): start of the chain and its first order's id. */
  chase?: { since: number; root: number | null };
}

/** Order meta fields for a chased limit order. */
export const chaseMeta = (ctx: PlaceContext) =>
  ctx.chase ? { chaseSince: ctx.chase.since, ...(ctx.chase.root !== null ? { chaseRoot: ctx.chase.root } : {}) } : {};

/** Paper and live trading behind one interface; every method logs its own problems and never double-places. */
export interface Broker {
  readonly mode: Mode;
  balances(): Promise<Balance[]>;
  /** Places one order. Returns the DB row, or null when it was not placed (reason logged). */
  place(intent: OrderIntent, ctx: PlaceContext): Promise<OrderRow | null>;
  /** Cancels one of the bot's orders; true when it is no longer working. */
  cancel(order: OrderRow, why: string): Promise<boolean>;
  /** Brings open orders up to date and records fills. Returns the number of new fills. */
  sync(fees: { maker: number; taker: number }): Promise<number>;
}
