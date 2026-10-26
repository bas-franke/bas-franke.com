import { createHmac, randomUUID } from 'node:crypto';

/**
 * Minimal Bitvavo REST v2 client (https://docs.bitvavo.com). No dependencies.
 *
 * Signing: hex HMAC-SHA256(secret, timestamp + METHOD + '/v2' + path-with-query + body), sent with
 * Bitvavo-Access-Key / -Signature / -Timestamp / -Window headers.
 * Rate limit: Bitvavo allows 1000 weight points per minute and reports `bitvavo-ratelimit-remaining` and
 * `bitvavo-ratelimit-resetat` (ms). We stop sending below a safety margin until the reset, and stop entirely after
 * a 429 / ban error until the time Bitvavo names.
 */

export type OrderType = 'market' | 'limit' | 'stopLoss' | 'stopLossLimit' | 'takeProfit' | 'takeProfitLimit';
export type Side = 'buy' | 'sell';
export type TimeInForce = 'GTC' | 'IOC' | 'FOK';
export type OrderStatus = 'new' | 'awaitingTrigger' | 'canceled' | 'canceledAuction' | 'canceledSelfTradePrevention' | 'canceledIOC' | 'canceledFOK' | 'canceledMarketProtection' | 'canceledPostOnly' | 'expired' | 'filled' | 'partiallyFilled' | 'rejected';

export class BitvavoError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode: number | null,
    readonly endpoint: string,
    /** The order (or whatever) was definitely not accepted; safe to treat as "nothing happened". */
    readonly definitelyRejected: boolean,
  ) {
    super(message);
    this.name = 'BitvavoError';
  }
  /** Network problem or 5xx: the request may or may not have been executed. */
  get uncertain() {
    return !this.definitelyRejected;
  }
}

export class RateLimitedError extends BitvavoError {
  constructor(endpoint: string, readonly until: number) {
    super(`Bitvavo rate limit: pausing requests until ${new Date(until).toISOString()}`, 429, 105, endpoint, true);
    this.name = 'RateLimitedError';
  }
}

export interface BitvavoFill {
  id: string;
  timestamp: number;
  amount: string;
  price: string;
  taker: boolean;
  fee?: string;
  feeCurrency?: string;
  settled: boolean;
}

export interface BitvavoOrder {
  orderId: string;
  clientOrderId?: string;
  market: string;
  created: number;
  updated: number;
  status: OrderStatus | string;
  side: Side;
  orderType: OrderType;
  amount?: string;
  amountRemaining?: string;
  price?: string;
  amountQuote?: string;
  amountQuoteRemaining?: string;
  onHold?: string;
  onHoldCurrency?: string;
  triggerPrice?: string;
  triggerAmount?: string;
  filledAmount: string;
  filledAmountQuote: string;
  feePaid: string;
  feeCurrency?: string;
  fills?: BitvavoFill[];
  timeInForce?: string;
  postOnly?: boolean;
  operatorId?: number;
}

export interface BitvavoTrade {
  id: string;
  orderId: string;
  clientOrderId?: string;
  timestamp: number;
  market: string;
  side: Side;
  amount: string;
  price: string;
  taker: boolean;
  fee?: string;
  feeCurrency?: string;
  settled: boolean;
}

export interface PlaceOrderParams {
  market: string;
  side: Side;
  orderType: OrderType;
  /** A UUID; Bitvavo requires clientOrderId to be a UUID. */
  clientOrderId?: string;
  amount?: string;
  amountQuote?: string;
  price?: string;
  triggerAmount?: string;
  triggerType?: 'price';
  triggerReference?: 'lastTrade' | 'bestBid' | 'bestAsk' | 'midPrice';
  timeInForce?: TimeInForce;
  postOnly?: boolean;
  selfTradePrevention?: 'decrementAndCancel' | 'cancelOldest' | 'cancelNewest' | 'cancelBoth';
}

export interface UpdateOrderParams {
  market: string;
  orderId?: string;
  clientOrderId?: string;
  amount?: string;
  amountRemaining?: string;
  price?: string;
  triggerAmount?: string;
  timeInForce?: TimeInForce;
  selfTradePrevention?: PlaceOrderParams['selfTradePrevention'];
  postOnly?: boolean;
}

export interface ClientOptions {
  apiKey?: string;
  apiSecret?: string;
  baseUrl?: string;
  operatorId: number;
  /** Ms the signed request stays valid (default 10000, Bitvavo max 60000). */
  accessWindow?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Stop sending when fewer weight points than this remain until the reset. */
  safetyMargin?: number;
  timeoutMs?: number;
}

/** The signature Bitvavo expects; `path` starts with "/v2/". */
export function signRequest(secret: string, timestamp: number, method: string, path: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}${method.toUpperCase()}${path}${body}`).digest('hex');
}

/** Bitvavo clientOrderId must be a UUID. */
export const newClientOrderUuid = () => randomUUID();

const toQuery = (params: Record<string, string | number | boolean | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};

export class BitvavoClient {
  private readonly key: string;
  private readonly secret: string;
  private readonly base: string;
  private readonly prefix: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly window: number;
  private readonly margin: number;
  private readonly timeoutMs: number;
  readonly operatorId: number;
  /** Server time minus local time, measured with `syncTime()`. */
  timeOffset = 0;
  rateLimitRemaining: number | null = null;
  rateLimitResetAt = 0;
  blockedUntil = 0;
  lastPrivateOkAt = 0;
  lastPrivateError: string | null = null;

  constructor(opts: ClientOptions) {
    this.key = opts.apiKey ?? '';
    this.secret = opts.apiSecret ?? '';
    const url = new URL(opts.baseUrl ?? 'https://api.bitvavo.com/v2');
    this.base = url.origin;
    this.prefix = url.pathname.replace(/\/$/, '') || '/v2';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.window = Math.min(60_000, opts.accessWindow ?? 10_000);
    this.margin = opts.safetyMargin ?? 50;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.operatorId = opts.operatorId;
  }

  get hasKeys() {
    return Boolean(this.key && this.secret);
  }

  /** Low-level request. `path` is relative to /v2, e.g. "/order" or "/BTC-EUR/candles". */
  async request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; auth?: boolean; retries?: number } = {}): Promise<T> {
    const fullPath = `${this.prefix}${path}${toQuery(opts.query ?? {})}`;
    const endpoint = `${method} ${path}`;
    const now = this.now();
    if (this.blockedUntil > now) throw new RateLimitedError(endpoint, this.blockedUntil);
    if (this.rateLimitRemaining !== null && this.rateLimitRemaining < this.margin && this.rateLimitResetAt > now)
      throw new RateLimitedError(endpoint, this.rateLimitResetAt);
    const auth = opts.auth ?? false;
    if (auth && !this.hasKeys) throw new BitvavoError('No Bitvavo API key configured', 0, null, endpoint, true);

    const body = opts.body === undefined ? '' : JSON.stringify(opts.body);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (auth) {
      const ts = Math.round(now + this.timeOffset);
      headers['Bitvavo-Access-Key'] = this.key;
      headers['Bitvavo-Access-Timestamp'] = String(ts);
      headers['Bitvavo-Access-Signature'] = signRequest(this.secret, ts, method, fullPath, body);
      headers['Bitvavo-Access-Window'] = String(this.window);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${fullPath}`, {
        method,
        headers,
        body: body || undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const e = new BitvavoError(`Bitvavo ${endpoint} network error: ${(err as Error).message}`, 0, null, endpoint, false);
      // Only reads are retried; a write that may have reached the exchange is resolved by the caller.
      if (method === 'GET' && (opts.retries ?? 1) > 0) return this.request<T>(method, path, { ...opts, retries: (opts.retries ?? 1) - 1 });
      if (auth) this.lastPrivateError = e.message;
      throw e;
    }

    const remaining = res.headers.get('bitvavo-ratelimit-remaining');
    const resetAt = res.headers.get('bitvavo-ratelimit-resetat');
    if (remaining !== null && remaining !== '') this.rateLimitRemaining = Number(remaining);
    if (resetAt !== null && resetAt !== '') this.rateLimitResetAt = Number(resetAt);

    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    const errObj = data && typeof data === 'object' && !Array.isArray(data) && 'errorCode' in data ? (data as { errorCode: number; error?: string }) : null;
    if (!res.ok || errObj) {
      const code = errObj?.errorCode ?? null;
      const msg = errObj?.error ?? (text.slice(0, 200) || res.statusText);
      if (res.status === 429 || code === 105 || code === 112) {
        // 105: banned / rate limit exceeded. The message usually names the time; otherwise wait for the reset or 60 s.
        const named = /(\d{13})/.exec(msg ?? '');
        this.blockedUntil = Math.max(named ? Number(named[1]) : 0, this.rateLimitResetAt, this.now() + 60_000);
        if (auth) this.lastPrivateError = msg;
        throw new RateLimitedError(endpoint, this.blockedUntil);
      }
      if (res.status >= 500 && method === 'GET' && (opts.retries ?? 1) > 0)
        return this.request<T>(method, path, { ...opts, retries: (opts.retries ?? 1) - 1 });
      const e = new BitvavoError(`Bitvavo ${endpoint} failed (${res.status}${code ? `, code ${code}` : ''}): ${msg}`, res.status, code, endpoint, res.status >= 400 && res.status < 500);
      if (auth) this.lastPrivateError = e.message;
      throw e;
    }
    if (auth) {
      this.lastPrivateOkAt = this.now();
      this.lastPrivateError = null;
    }
    return data as T;
  }

  // ---- public ----

  async time(): Promise<number> {
    const r = await this.request<{ time: number }>('GET', '/time');
    return r.time;
  }

  /** Measures the clock difference to Bitvavo so signed timestamps stay inside the access window. */
  async syncTime(): Promise<number> {
    const before = this.now();
    const server = await this.time();
    const after = this.now();
    this.timeOffset = server - (before + after) / 2;
    return this.timeOffset;
  }

  markets(market?: string) {
    return this.request<Array<Record<string, unknown>> | Record<string, unknown>>('GET', '/markets', { query: { market } });
  }

  assets(symbol?: string) {
    return this.request<unknown>('GET', '/assets', { query: { symbol } });
  }

  tickerPrice(market?: string) {
    return this.request<Array<{ market: string; price: string }> | { market: string; price: string }>('GET', '/ticker/price', { query: { market } });
  }

  tickerBook(market?: string) {
    return this.request<Array<TickerBook> | TickerBook>('GET', '/ticker/book', { query: { market } });
  }

  book(market: string, depth?: number) {
    return this.request<{ market: string; nonce: number; bids: [string, string][]; asks: [string, string][] }>('GET', `/${encodeURIComponent(market)}/book`, { query: { depth } });
  }

  /** Candles newest first, as Bitvavo returns them: [timestamp, open, high, low, close, volume] as strings. */
  candles(market: string, interval: string, opts: { limit?: number; start?: number; end?: number } = {}) {
    return this.request<Array<[number, string, string, string, string, string]>>('GET', `/${encodeURIComponent(market)}/candles`, {
      query: { interval, limit: opts.limit, start: opts.start, end: opts.end },
    });
  }

  // ---- private ----

  balance(symbol?: string) {
    return this.request<Array<{ symbol: string; available: string; inOrder: string }>>('GET', '/balance', { query: { symbol }, auth: true });
  }

  accountFees(market?: string) {
    return this.request<{ tier?: number; volume?: string; maker?: string; taker?: string; fees?: { maker: string; taker: string } }>('GET', '/account/fees', { query: { market }, auth: true });
  }

  placeOrder(p: PlaceOrderParams) {
    return this.request<BitvavoOrder>('POST', '/order', { body: { ...p, operatorId: this.operatorId }, auth: true });
  }

  getOrder(market: string, ids: { orderId?: string; clientOrderId?: string }) {
    return this.request<BitvavoOrder>('GET', '/order', { query: { market, ...ids }, auth: true });
  }

  updateOrder(p: UpdateOrderParams) {
    return this.request<BitvavoOrder>('PUT', '/order', { body: { ...p, operatorId: this.operatorId }, auth: true });
  }

  cancelOrder(market: string, ids: { orderId?: string; clientOrderId?: string }) {
    return this.request<{ orderId: string; clientOrderId?: string }>('DELETE', '/order', { query: { market, ...ids, operatorId: this.operatorId }, auth: true });
  }

  orders(market: string, opts: { limit?: number; start?: number; end?: number; orderIdFrom?: string; orderIdTo?: string } = {}) {
    return this.request<BitvavoOrder[]>('GET', '/orders', { query: { market, ...opts }, auth: true });
  }

  ordersOpen(market?: string) {
    return this.request<BitvavoOrder[]>('GET', '/ordersOpen', { query: { market }, auth: true });
  }

  /**
   * Cancels EVERY open order in a market (or the whole account), including ones the bot did not place.
   * The bot never calls this; it cancels its own orders one by one.
   */
  cancelOrders(market?: string) {
    return this.request<Array<{ orderId: string }>>('DELETE', '/orders', { query: { market, operatorId: this.operatorId }, auth: true });
  }

  trades(market: string, opts: { limit?: number; start?: number; end?: number; tradeIdFrom?: string; tradeIdTo?: string } = {}) {
    return this.request<BitvavoTrade[]>('GET', '/trades', { query: { market, ...opts }, auth: true });
  }
}

export interface TickerBook {
  market: string;
  bid: string | null;
  ask: string | null;
  bidSize?: string | null;
  askSize?: string | null;
}
