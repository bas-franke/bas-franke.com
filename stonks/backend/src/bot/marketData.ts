import { bitvavo, parseMarketRules, type MarketRules, type TickerBook } from '../bitvavo/index.js';
import { INTERVAL_MS, type Candle, type Interval } from '../strategies/index.js';

/** Market rules from GET /v2/markets, cached for an hour (SPEC §7 `GET /api/markets`). */
let marketsCache: { at: number; rules: Map<string, MarketRules> } | null = null;
let marketsInflight: Promise<Map<string, MarketRules>> | null = null;

export async function marketRules(force = false): Promise<Map<string, MarketRules>> {
  if (!force && marketsCache && Date.now() - marketsCache.at < 3_600_000) return marketsCache.rules;
  if (marketsInflight) return marketsInflight;
  marketsInflight = (async () => {
    try {
      const raw = await bitvavo.markets();
      const list = (Array.isArray(raw) ? raw : [raw]).map(parseMarketRules);
      const rules = new Map(list.map((r) => [r.market, r]));
      marketsCache = { at: Date.now(), rules };
      return rules;
    } catch (err) {
      if (marketsCache) return marketsCache.rules; // stale beats nothing
      throw err;
    } finally {
      marketsInflight = null;
    }
  })();
  return marketsInflight;
}

export async function ruleFor(market: string): Promise<MarketRules> {
  const rules = await marketRules();
  const r = rules.get(market);
  if (!r) throw new Error(`Bitvavo has no market ${market}`);
  return r;
}

/** Last trade prices for every market, cached briefly. */
let priceCache: { at: number; prices: Map<string, number> } | null = null;
export async function allPrices(maxAgeMs = 10_000): Promise<Map<string, number>> {
  if (priceCache && Date.now() - priceCache.at < maxAgeMs) return priceCache.prices;
  const raw = await bitvavo.tickerPrice();
  const list = Array.isArray(raw) ? raw : [raw];
  const prices = new Map<string, number>();
  for (const p of list) {
    const v = Number(p.price);
    if (Number.isFinite(v) && v > 0) prices.set(p.market, v);
  }
  priceCache = { at: Date.now(), prices };
  return prices;
}

/** EUR value of one unit of `symbol` (EUR = 1, unknown = 0). */
export function eurPrice(symbol: string, prices: Map<string, number>): number {
  if (symbol === 'EUR') return 1;
  return prices.get(`${symbol}-EUR`) ?? 0;
}

export async function bestBidAsk(market: string): Promise<{ bid: number; ask: number }> {
  const raw = (await bitvavo.tickerBook(market)) as TickerBook;
  const bid = Number(raw.bid);
  const ask = Number(raw.ask);
  if (!(bid > 0) || !(ask > 0)) throw new Error(`No order book for ${market}`);
  return { bid, ask };
}

/** Bitvavo's order book (best level first) as numbers: `[price, size]`. */
export async function bookDepth(market: string, depth = 200): Promise<{ bids: Array<[number, number]>; asks: Array<[number, number]> }> {
  const raw = await bitvavo.book(market, depth);
  const levels = (side: Array<[string, string]>) => side.map(([p, q]): [number, number] => [Number(p), Number(q)]);
  return { bids: levels(raw.bids), asks: levels(raw.asks) };
}

const toCandle = (c: [number, string, string, string, string, string]): Candle => [
  Number(c[0]), Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4]), Number(c[5]),
];

/**
 * Closed candles (oldest first) whose open time is <= `lastBar`, at least `bars` of them when available, or every
 * candle from `from` when given (capped at `maxBars`). Pages backwards through Bitvavo's 1440-candle limit.
 */
export async function closedCandles(market: string, interval: Interval, lastBar: number, opts: { bars: number; from?: number; maxBars?: number }): Promise<Candle[]> {
  const ms = INTERVAL_MS[interval];
  const maxBars = opts.maxBars ?? 10_000;
  let want = opts.bars;
  if (opts.from !== undefined) want = Math.max(want, Math.ceil((lastBar - opts.from) / ms) + 1);
  want = Math.min(want, maxBars);
  const out = new Map<number, Candle>();
  // Bitvavo's `end` returns candles whose close (open + interval) is <= end.
  let end = lastBar + ms;
  const maxPages = Math.ceil(want / 1440) + 2;
  for (let page = 0; page < maxPages && out.size < want; page++) {
    const limit = Math.min(1440, want - out.size + 2);
    const raw = await bitvavo.candles(market, interval, { limit, end });
    if (!raw.length) break;
    let oldest = Infinity;
    for (const r of raw) {
      const c = toCandle(r);
      if (c[0] <= lastBar) out.set(c[0], c);
      oldest = Math.min(oldest, c[0]);
    }
    if (raw.length < limit) break;
    end = oldest;
  }
  return [...out.values()].sort((a, b) => a[0] - b[0]).slice(-want);
}

/** True when Bitvavo has a newer candle but none at `bar`: nothing traded in that bar (not a late candle). */
export async function barWasEmpty(market: string, interval: Interval, bar: number): Promise<boolean> {
  const times = (await bitvavo.candles(market, interval, { start: bar, limit: 3 })).map((c) => Number(c[0]));
  return !times.includes(bar) && times.some((t) => t > bar);
}

/** 1-minute candles from `from` (inclusive) up to now, including the one still forming. Used by the paper broker. */
export async function minuteCandlesSince(market: string, from: number): Promise<Candle[]> {
  const raw = await bitvavo.candles(market, '1m', { start: from, limit: 1440 });
  return raw.map(toCandle).filter((c) => c[0] >= from).sort((a, b) => a[0] - b[0]);
}
