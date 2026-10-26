/**
 * Price and amount rounding for Bitvavo orders. Bitvavo now publishes `tickSize` (price must be a multiple of it)
 * and has deprecated `pricePrecision` (5 significant digits, now usually null). We use tickSize when present and fall
 * back to pricePrecision significant digits otherwise.
 */

export interface MarketRules {
  market: string;
  base: string;
  quote: string;
  status: string;
  tickSize: string | null;
  pricePrecision: number | null;
  quantityDecimals: number;
  notionalDecimals: number;
  minOrderInBaseAsset: number;
  minOrderInQuoteAsset: number;
  maxOrderInBaseAsset: number;
  orderTypes: string[];
}

/** Count of decimals in a decimal string like "0.00100" → 5. */
export function decimalsOf(s: string): number {
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** Exact decimal arithmetic on a scaled integer avoids 0.1+0.2 style drift. */
function toScaled(v: number, decimals: number): bigint {
  return BigInt(Math.round(v * 10 ** decimals));
}

function scaledToString(n: bigint, decimals: number): string {
  const neg = n < 0n;
  let s = (neg ? -n : n).toString();
  if (decimals > 0) {
    s = s.padStart(decimals + 1, '0');
    s = `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
  }
  return (neg ? '-' : '') + s;
}

/**
 * Rounds a price to the market grid. `mode` "down" for buys (never pay more than intended), "up" for sells.
 * Returns a decimal string without exponent.
 */
export function roundPrice(price: number, rules: Pick<MarketRules, 'tickSize' | 'pricePrecision'>, mode: 'down' | 'up' | 'nearest'): string {
  if (!(price > 0) || !Number.isFinite(price)) throw new Error(`invalid price ${price}`);
  if (rules.tickSize && Number(rules.tickSize) > 0) {
    const d = decimalsOf(rules.tickSize);
    const tick = toScaled(Number(rules.tickSize), d);
    // Work in units of 10^-d with a small tolerance so 71000.00000001 does not round up a whole tick.
    const raw = price * 10 ** d;
    const eps = 1e-6;
    let units: bigint;
    const t = Number(tick);
    const q = raw / t;
    if (mode === 'down') units = BigInt(Math.floor(q + eps)) * tick;
    else if (mode === 'up') units = BigInt(Math.ceil(q - eps)) * tick;
    else units = BigInt(Math.round(q)) * tick;
    if (units <= 0n) units = tick;
    return scaledToString(units, d);
  }
  const digits = rules.pricePrecision && rules.pricePrecision > 0 ? rules.pricePrecision : 5;
  const exp = Math.floor(Math.log10(price));
  const decimals = Math.max(0, digits - 1 - exp);
  const factor = 10 ** (digits - 1 - exp);
  const scaled = price * factor;
  const r = mode === 'down' ? Math.floor(scaled + 1e-9) : mode === 'up' ? Math.ceil(scaled - 1e-9) : Math.round(scaled);
  const v = r / factor;
  return v.toFixed(decimals);
}

/** Rounds an amount down to quantityDecimals (never sell or buy more than we have money or coins for). */
export function roundAmount(amount: number, quantityDecimals: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return '0';
  const f = 10 ** quantityDecimals;
  const v = Math.floor(amount * f + 1e-9) / f;
  return v.toFixed(quantityDecimals);
}

/** Rounds a quote (EUR) amount down to notionalDecimals. */
export function roundQuote(eur: number, notionalDecimals: number): string {
  return roundAmount(eur, notionalDecimals);
}

/** Smallest valid step above/below a price (one tick), used to reprice post-only orders. */
export function tickOf(rules: Pick<MarketRules, 'tickSize' | 'pricePrecision'>, price: number): number {
  if (rules.tickSize && Number(rules.tickSize) > 0) return Number(rules.tickSize);
  const digits = rules.pricePrecision && rules.pricePrecision > 0 ? rules.pricePrecision : 5;
  return 10 ** (Math.floor(Math.log10(price)) - digits + 1);
}

/** Why an order of this size would be rejected, or null when it is fine. */
export function sizeProblem(rules: MarketRules, amount: number, price: number): string | null {
  if (!(amount > 0)) return 'amount rounds to zero';
  if (amount < rules.minOrderInBaseAsset) return `amount ${amount} is under the minimum ${rules.minOrderInBaseAsset} ${rules.base}`;
  if (rules.maxOrderInBaseAsset > 0 && amount > rules.maxOrderInBaseAsset) return `amount ${amount} is over the maximum ${rules.maxOrderInBaseAsset} ${rules.base}`;
  if (amount * price < rules.minOrderInQuoteAsset) return `order value €${(amount * price).toFixed(2)} is under the minimum €${rules.minOrderInQuoteAsset}`;
  return null;
}

export function parseMarketRules(m: Record<string, unknown>): MarketRules {
  const n = (v: unknown, d = 0) => (v === null || v === undefined || v === '' ? d : Number(v));
  return {
    market: String(m.market),
    base: String(m.base),
    quote: String(m.quote),
    status: String(m.status),
    tickSize: m.tickSize ? String(m.tickSize) : null,
    pricePrecision: m.pricePrecision === null || m.pricePrecision === undefined ? null : Number(m.pricePrecision),
    quantityDecimals: n(m.quantityDecimals, 8),
    notionalDecimals: n(m.notionalDecimals, 2),
    minOrderInBaseAsset: n(m.minOrderInBaseAsset),
    minOrderInQuoteAsset: n(m.minOrderInQuoteAsset, 5),
    maxOrderInBaseAsset: n(m.maxOrderInBaseAsset),
    orderTypes: Array.isArray(m.orderTypes) ? m.orderTypes.map(String) : [],
  };
}
