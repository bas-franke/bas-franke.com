/**
 * Pure decision logic of the bot, kept free of I/O so the tests can pin it down:
 * the executor's order planning (SPEC §2), paper fill rules, stops, positions and the daily loss guard (SPEC §5).
 */
import { roundAmount, roundPrice, roundQuote, sizeProblem, tickOf, type MarketRules } from '../bitvavo/precision.js';
import type { RiskSpec, StrategySpec, Weights } from '../strategies/index.js';
import { amsterdamDay } from './time.js';

export const MARKET_SLIPPAGE = 0.0005; // 5 bps, SPEC §2
export const CHURN_MIN_EUR = 5;
export const CHURN_MIN_FRACTION = 0.02;

export interface Holding {
  /** Coins owned (available + in orders). */
  total: number;
  /** Coins free to sell. */
  available: number;
}

export interface OrderIntent {
  market: string;
  side: 'buy' | 'sell';
  orderType: 'limit' | 'market';
  /** Rounded decimal strings, ready for Bitvavo. Market buys use amountQuote instead of amount. */
  amount?: string;
  amountQuote?: string;
  price?: string;
  postOnly: boolean;
  reason: string;
  /** EUR value the order moves, for logs. */
  valueEur: number;
}

export interface PlanInput {
  spec: StrategySpec;
  targets: Weights;
  /** EUR cash + every coin at its price (the whole account, or the paper wallet). */
  equityEur: number;
  /** Free EUR that buys may use. */
  cashAvailableEur: number;
  holdings: Record<string, Holding>;
  /** Price used to size and price orders, normally the close of the decision bar. */
  prices: Record<string, number>;
  rules: Record<string, MarketRules>;
  maxExposureEur: number | null;
  /** EUR value of coins that are not in the strategy's markets (they count toward maxExposureEur). */
  otherCoinsEur: number;
  /** Markets with one of the bot's orders still working, by side. */
  openSides: Record<string, Array<'buy' | 'sell'>>;
  fees: { maker: number; taker: number };
}

export interface PlanResult {
  orders: OrderIntent[];
  /** Markets whose working orders point the wrong way and must be cancelled before placing. */
  cancelMarkets: string[];
  notes: Array<{ market: string; note: string }>;
}

/**
 * Turns target weights into orders: diff = target EUR - current EUR per market. Differences under €5 or 2 % of
 * equity are ignored, except that a target of 0 sells the whole free position. Sells come first; buys share the
 * free cash (scaled down together when it is short, keeping room for the fee). Total coin value is capped at
 * maxExposureEur (other coins included).
 */
export function planOrders(input: PlanInput): PlanResult {
  const { spec, equityEur } = input;
  const result: PlanResult = { orders: [], cancelMarkets: [], notes: [] };
  if (!(equityEur > 0)) {
    result.notes.push({ market: '*', note: 'equity is zero' });
    return result;
  }
  const targetEur: Record<string, number> = {};
  let totalTarget = 0;
  for (const m of spec.markets) {
    targetEur[m] = Math.max(0, input.targets[m] ?? 0) * equityEur;
    totalTarget += targetEur[m];
  }
  if (input.maxExposureEur !== null) {
    const room = Math.max(0, input.maxExposureEur - input.otherCoinsEur);
    if (totalTarget > room && totalTarget > 0) for (const m of spec.markets) targetEur[m] *= room / totalTarget;
  }

  const threshold = Math.max(CHURN_MIN_EUR, CHURN_MIN_FRACTION * equityEur);
  const limit = spec.execution.orderType === 'limit';
  const offset = spec.execution.limitOffsetBps / 10_000;
  const buys: Array<{ market: string; eur: number }> = [];

  for (const m of spec.markets) {
    const rules = input.rules[m];
    const price = input.prices[m];
    if (!rules || !(price > 0)) {
      result.notes.push({ market: m, note: 'no market data' });
      continue;
    }
    if (rules.status !== 'trading') {
      result.notes.push({ market: m, note: `market is ${rules.status}` });
      continue;
    }
    const h = input.holdings[m] ?? { total: 0, available: 0 };
    const current = h.total * price;
    const diff = targetEur[m] - current;
    const fullExit = targetEur[m] === 0 && h.available > 0;
    if (!fullExit && Math.abs(diff) < threshold) continue;
    const side: 'buy' | 'sell' = fullExit || diff < 0 ? 'sell' : 'buy';
    const open = input.openSides[m] ?? [];
    if (open.includes(side)) {
      result.notes.push({ market: m, note: `a ${side} order is still working` });
      continue;
    }
    if (open.length) result.cancelMarkets.push(m);
    if (side === 'buy') {
      buys.push({ market: m, eur: diff });
      continue;
    }
    const qty = fullExit ? h.available : Math.min(h.available, -diff / price);
    const p = limit ? Number(roundPrice(price * (1 + offset), rules, 'up')) : price;
    const amount = roundAmount(qty, rules.quantityDecimals);
    const problem = sizeProblem(rules, Number(amount), p);
    if (problem) {
      result.notes.push({ market: m, note: `sell skipped: ${problem}` });
      continue;
    }
    result.orders.push({
      market: m,
      side: 'sell',
      orderType: limit ? 'limit' : 'market',
      amount,
      price: limit ? roundPrice(price * (1 + offset), rules, 'up') : undefined,
      postOnly: limit && spec.execution.postOnly,
      reason: fullExit ? 'target 0: exit position' : `rebalance to ${(targetEur[m] / equityEur * 100).toFixed(1)} % of equity`,
      valueEur: Number(amount) * p,
    });
  }

  const fee = limit && spec.execution.postOnly ? input.fees.maker : input.fees.taker;
  const spendable = Math.max(0, input.cashAvailableEur / (1 + fee + (limit ? 0 : MARKET_SLIPPAGE)));
  const wanted = buys.reduce((s, b) => s + b.eur, 0);
  const scale = wanted > spendable ? spendable / wanted : 1;
  if (scale < 1 && buys.length) result.notes.push({ market: '*', note: `cash covers ${(scale * 100).toFixed(0)} % of the wanted buys` });
  for (const b of buys) {
    const rules = input.rules[b.market];
    const price = input.prices[b.market];
    const eur = b.eur * scale;
    if (limit) {
      const priceStr = roundPrice(price * (1 - offset), rules, 'down');
      const amount = roundAmount(eur / Number(priceStr), rules.quantityDecimals);
      const problem = sizeProblem(rules, Number(amount), Number(priceStr));
      if (problem) {
        result.notes.push({ market: b.market, note: `buy skipped: ${problem}` });
        continue;
      }
      result.orders.push({
        market: b.market, side: 'buy', orderType: 'limit', amount, price: priceStr, postOnly: spec.execution.postOnly,
        reason: `rebalance to ${(targetEur[b.market] / equityEur * 100).toFixed(1)} % of equity`, valueEur: Number(amount) * Number(priceStr),
      });
    } else {
      const quote = roundQuote(eur, rules.notionalDecimals);
      if (Number(quote) < rules.minOrderInQuoteAsset) {
        result.notes.push({ market: b.market, note: `buy skipped: €${quote} is under the minimum €${rules.minOrderInQuoteAsset}` });
        continue;
      }
      result.orders.push({
        market: b.market, side: 'buy', orderType: 'market', amountQuote: quote, postOnly: false,
        reason: `rebalance to ${(targetEur[b.market] / equityEur * 100).toFixed(1)} % of equity`, valueEur: Number(quote),
      });
    }
  }
  return result;
}

/**
 * Post-only repricing (SPEC §2): a buy at or above the best ask would take liquidity, so it joins the best bid
 * instead; a sell at or below the best bid joins the best ask. Returns the (possibly unchanged) price string.
 */
export function postOnlyPrice(side: 'buy' | 'sell', price: string, book: { bid: number; ask: number }, rules: MarketRules): string {
  const p = Number(price);
  if (side === 'buy' && p >= book.ask) {
    const target = Math.min(book.bid, book.ask - tickOf(rules, book.ask));
    return roundPrice(target, rules, 'down');
  }
  if (side === 'sell' && p <= book.bid) {
    const target = Math.max(book.ask, book.bid + tickOf(rules, book.bid));
    return roundPrice(target, rules, 'up');
  }
  return price;
}

/** Whether a resting paper limit order fills given the lowest/highest trade price seen while it was active. */
export function paperLimitFills(side: 'buy' | 'sell', price: number, lowSeen: number, highSeen: number): boolean {
  return side === 'buy' ? lowSeen < price : highSeen > price;
}

/** Paper market fill price: the touch plus 5 bps adverse slippage. */
export function paperMarketPrice(side: 'buy' | 'sell', book: { bid: number; ask: number }): number {
  return side === 'buy' ? book.ask * (1 + MARKET_SLIPPAGE) : book.bid * (1 - MARKET_SLIPPAGE);
}

/** EUR cost (buy, positive) or proceeds (sell) including the fee, which is paid in EUR. */
export function cashDelta(side: 'buy' | 'sell', amount: number, price: number, feeRate: number) {
  const quote = amount * price;
  const fee = quote * feeRate;
  return { quote, fee, eur: side === 'buy' ? -(quote + fee) : quote - fee };
}

export interface FillLike {
  id: number;
  market: string;
  side: 'buy' | 'sell';
  amount: number;
  quote: number;
  fee: number;
  feeCurrency: string | null;
}

export interface Position {
  qty: number;
  avgEntry: number;
  /** id of the first fill of the current position (changes when a new position starts after being flat). */
  openedByFill: number | null;
}

/**
 * Replays fills (oldest first) into a position with an average entry price. The entry is the average fill price
 * (fees excluded, like the backtests); fees paid in the coin itself reduce the quantity.
 */
export function replayPosition(fills: FillLike[], dust = 1e-12): Position {
  let qty = 0;
  let cost = 0;
  let opened: number | null = null;
  for (const f of fills) {
    if (f.side === 'buy') {
      if (qty <= dust) {
        qty = 0;
        cost = 0;
        opened = f.id;
      }
      const feeBase = f.feeCurrency && f.feeCurrency !== 'EUR' ? f.fee : 0;
      qty += f.amount - feeBase;
      cost += f.quote;
    } else if (qty > dust) {
      const sold = Math.min(f.amount, qty);
      cost *= (qty - sold) / qty;
      qty -= sold;
      if (qty <= dust) {
        qty = 0;
        cost = 0;
        opened = null;
      }
    }
  }
  return { qty, avgEntry: qty > 0 ? cost / qty : 0, openedByFill: opened };
}

/** Which safety exit fires at `price`, if any. `peak` is the highest price seen since the position opened. */
export function stopHit(risk: RiskSpec, avgEntry: number, peak: number, price: number): string | null {
  if (!(avgEntry > 0) || !(price > 0)) return null;
  if (risk.stopLossPct && price <= avgEntry * (1 - risk.stopLossPct))
    return `stop loss: price ${price} is ${(risk.stopLossPct * 100).toFixed(2)} % under the average entry ${avgEntry.toFixed(2)}`;
  if (risk.trailingStopPct && peak > 0 && price <= peak * (1 - risk.trailingStopPct))
    return `trailing stop: price ${price} fell ${(risk.trailingStopPct * 100).toFixed(2)} % from the peak ${peak}`;
  if (risk.takeProfitPct && price >= avgEntry * (1 + risk.takeProfitPct))
    return `take profit: price ${price} is ${(risk.takeProfitPct * 100).toFixed(2)} % above the average entry ${avgEntry.toFixed(2)}`;
  return null;
}

// ---------- daily loss guard (SPEC §5) ----------

export interface DayState {
  /** Europe/Amsterdam calendar day the baseline belongs to. */
  day: string;
  startEquity: number;
  /** Coin and EUR quantities at the last check, to tell trades from deposits and withdrawals. */
  lastHoldings: Record<string, number>;
  /** Highest fills.id already accounted for in lastHoldings. */
  lastFillId: number;
}

export interface DayCheck {
  state: DayState;
  newDay: boolean;
  /** EUR value of deposits (+) / withdrawals (-) detected since the last check; the baseline moved by this much. */
  flowEur: number;
  lossEur: number;
  tripped: boolean;
}

/**
 * Updates the start-of-day baseline and tells whether the loss limit is hit (startOfDay - equity >= limit).
 * Quantity changes not explained by the fills since the last check count as deposits/withdrawals: the baseline
 * moves by their EUR value (ignored under max(€2, 0.5 % of equity) so rounding and fee timing do not trigger it).
 */
export function checkDay(
  prev: DayState | undefined,
  now: number,
  equityEur: number,
  holdings: Record<string, number>,
  priceOf: (symbol: string) => number,
  newFills: Array<FillLike & { base: string }>,
  limitEur: number,
): DayCheck {
  const day = amsterdamDay(now);
  const maxFillId = newFills.reduce((m, f) => Math.max(m, f.id), prev?.lastFillId ?? 0);
  if (!prev || prev.day !== day) {
    const state: DayState = { day, startEquity: equityEur, lastHoldings: { ...holdings }, lastFillId: maxFillId };
    return { state, newDay: true, flowEur: 0, lossEur: 0, tripped: false };
  }
  const expected: Record<string, number> = { ...prev.lastHoldings };
  const add = (s: string, v: number) => (expected[s] = (expected[s] ?? 0) + v);
  for (const f of newFills) {
    if (f.id <= prev.lastFillId) continue;
    const feeCur = f.feeCurrency ?? 'EUR';
    if (f.side === 'buy') {
      add(f.base, f.amount);
      add('EUR', -f.quote);
    } else {
      add(f.base, -f.amount);
      add('EUR', f.quote);
    }
    add(feeCur, -f.fee);
  }
  let flow = 0;
  for (const s of new Set([...Object.keys(expected), ...Object.keys(holdings)])) {
    flow += ((holdings[s] ?? 0) - (expected[s] ?? 0)) * priceOf(s);
  }
  const tolerance = Math.max(2, 0.005 * equityEur);
  const flowEur = Math.abs(flow) > tolerance ? flow : 0;
  const state: DayState = { day, startEquity: prev.startEquity + flowEur, lastHoldings: { ...holdings }, lastFillId: maxFillId };
  const lossEur = state.startEquity - equityEur;
  return { state, newDay: false, flowEur, lossEur, tripped: lossEur >= limitEur };
}
