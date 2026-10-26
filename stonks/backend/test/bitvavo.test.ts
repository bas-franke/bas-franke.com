import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BitvavoClient, BitvavoError, RateLimitedError, signRequest } from '../src/bitvavo/client.js';
import { parseMarketRules, roundAmount, roundPrice, sizeProblem } from '../src/bitvavo/precision.js';

test('signature matches the documented Bitvavo example', () => {
  const body = '{"market":"BTC-EUR","side":"buy","price":"5000","amount":"1.23","orderType":"limit"}';
  assert.equal(
    signRequest('bitvavo', 1548172481125, 'POST', '/v2/order', body),
    '44d022723a20973a18f7ee97398b9fdd405d2d019c8d39e24b8cc0dcb39ca016',
  );
  // GET: the query string is part of the signed path, the body is empty (vector computed with openssl).
  assert.equal(
    signRequest('bitvavo', 1548175200641, 'get', '/v2/balance?symbol=BTC', ''),
    'ab19440567c8e8bc561a21a6dc128df1c991a7b2af54a7ad3fc4fae491d376ec',
  );
});

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: Array<() => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    return next();
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('private requests are signed over /v2 + path + query + body and carry operatorId', async () => {
  const { fn, calls } = fakeFetch([() => json({ orderId: 'x', status: 'new' }, 200, { 'bitvavo-ratelimit-remaining': '990', 'bitvavo-ratelimit-resetat': '1700000060000' })]);
  const c = new BitvavoClient({ apiKey: 'k', apiSecret: 's', operatorId: 1001, fetchImpl: fn, now: () => 1700000000000 });
  await c.placeOrder({ market: 'BTC-EUR', side: 'buy', orderType: 'limit', amount: '0.001', price: '50000', postOnly: true, clientOrderId: 'uuid-1' });
  const call = calls[0];
  assert.equal(call.url, 'https://api.bitvavo.com/v2/order');
  const h = call.init.headers as Record<string, string>;
  const body = String(call.init.body);
  assert.equal(JSON.parse(body).operatorId, 1001);
  assert.equal(h['Bitvavo-Access-Key'], 'k');
  assert.equal(h['Bitvavo-Access-Timestamp'], '1700000000000');
  assert.equal(h['Bitvavo-Access-Window'], '10000');
  assert.equal(h['Bitvavo-Access-Signature'], signRequest('s', 1700000000000, 'POST', '/v2/order', body));
  assert.equal(c.rateLimitRemaining, 990);
  assert.equal(c.lastPrivateOkAt, 1700000000000);

  const g = fakeFetch([() => json({ orderId: 'x' })]);
  const c2 = new BitvavoClient({ apiKey: 'k', apiSecret: 's', operatorId: 7, fetchImpl: g.fn, now: () => 5 });
  await c2.cancelOrder('ETH-EUR', { orderId: 'abc' });
  assert.equal(g.calls[0].url, 'https://api.bitvavo.com/v2/order?market=ETH-EUR&orderId=abc&operatorId=7');
  assert.equal(g.calls[0].init.method, 'DELETE');
  const sig = (g.calls[0].init.headers as Record<string, string>)['Bitvavo-Access-Signature'];
  assert.equal(sig, signRequest('s', 5, 'DELETE', '/v2/order?market=ETH-EUR&orderId=abc&operatorId=7', ''));
});

test('public requests are not signed; private ones without keys fail before sending', async () => {
  const { fn, calls } = fakeFetch([() => json([[1, '1', '2', '0.5', '1.5', '10']])]);
  const c = new BitvavoClient({ operatorId: 1, fetchImpl: fn });
  await c.candles('BTC-EUR', '1h', { limit: 5 });
  assert.equal(calls[0].url, 'https://api.bitvavo.com/v2/BTC-EUR/candles?interval=1h&limit=5');
  assert.equal((calls[0].init.headers as Record<string, string>)['Bitvavo-Access-Key'], undefined);
  await assert.rejects(c.balance(), (e: unknown) => e instanceof BitvavoError && e.definitelyRejected);
  assert.equal(calls.length, 1);
});

test('error mapping: 4xx is a definite rejection, network errors on writes are uncertain and not retried', async () => {
  const a = fakeFetch([() => json({ errorCode: 216, error: 'Insufficient balance' }, 400)]);
  const c = new BitvavoClient({ apiKey: 'k', apiSecret: 's', operatorId: 1, fetchImpl: a.fn });
  await assert.rejects(c.placeOrder({ market: 'BTC-EUR', side: 'buy', orderType: 'market', amountQuote: '10' }), (e: unknown) => {
    assert.ok(e instanceof BitvavoError);
    assert.equal(e.errorCode, 216);
    assert.equal(e.definitelyRejected, true);
    return true;
  });
  assert.match(c.lastPrivateError ?? '', /Insufficient balance/);

  const b = fakeFetch([() => Promise.reject(new Error('socket hang up'))]);
  const c2 = new BitvavoClient({ apiKey: 'k', apiSecret: 's', operatorId: 1, fetchImpl: b.fn });
  await assert.rejects(c2.placeOrder({ market: 'BTC-EUR', side: 'buy', orderType: 'market', amountQuote: '10' }), (e: unknown) => e instanceof BitvavoError && e.uncertain);
  assert.equal(b.calls.length, 1);

  const r = fakeFetch([() => Promise.reject(new Error('reset')), () => json({ time: 42 })]);
  const c3 = new BitvavoClient({ operatorId: 1, fetchImpl: r.fn });
  assert.equal(await c3.time(), 42);
  assert.equal(r.calls.length, 2);
});

test('rate limits: low remaining weight and 429 pause all requests until the reset', async () => {
  let now = 1_000_000;
  const { fn, calls } = fakeFetch([
    () => json({ time: 1 }, 200, { 'bitvavo-ratelimit-remaining': '10', 'bitvavo-ratelimit-resetat': String(1_000_000 + 30_000) }),
    () => json({ time: 2 }),
    () => json({ errorCode: 105, error: 'Your IP or API key has been banned for not respecting the rate limit. The ban expires at 1000100000000' }, 429),
  ]);
  const c = new BitvavoClient({ operatorId: 1, fetchImpl: fn, now: () => now });
  await c.time();
  await assert.rejects(c.time(), RateLimitedError);
  assert.equal(calls.length, 1);
  now += 31_000;
  assert.equal(await c.time(), 2);
  await assert.rejects(c.time(), (e: unknown) => e instanceof RateLimitedError && e.until === 1000100000000);
  await assert.rejects(c.time(), RateLimitedError);
  assert.equal(calls.length, 3);
});

const btc = parseMarketRules({
  market: 'BTC-EUR', status: 'trading', base: 'BTC', quote: 'EUR', pricePrecision: null, minOrderInBaseAsset: '0.00006942',
  minOrderInQuoteAsset: '5.00', maxOrderInBaseAsset: '13884.01694877', quantityDecimals: 8, notionalDecimals: 2, tickSize: '1.00',
});
const fun = parseMarketRules({
  market: 'FUN-EUR', status: 'trading', base: 'FUN', quote: 'EUR', minOrderInBaseAsset: '355.00519', minOrderInQuoteAsset: '5.00',
  quantityDecimals: '5', notionalDecimals: '2', tickSize: '0.0000010',
});

test('prices round to the tick size (down for buys, up for sells), amounts down to quantityDecimals', () => {
  assert.equal(roundPrice(71234.56, btc, 'down'), '71234.00');
  assert.equal(roundPrice(71234.56, btc, 'up'), '71235.00');
  assert.equal(roundPrice(71234, btc, 'up'), '71234.00');
  assert.equal(roundPrice(71234.0000001, btc, 'up'), '71234.00');
  assert.equal(roundPrice(0.0012345, fun, 'down'), '0.0012340');
  assert.equal(roundPrice(0.0012345, fun, 'up'), '0.0012350');
  assert.equal(roundPrice(0.001234, fun, 'up'), '0.0012340');
  // Deprecated pricePrecision fallback: 5 significant digits.
  const old = { tickSize: null, pricePrecision: 5 };
  assert.equal(roundPrice(12345.678, old, 'down'), '12345');
  assert.equal(roundPrice(0.123456, old, 'up'), '0.12346');
  assert.equal(roundAmount(0.123456789, 8), '0.12345678');
  assert.equal(roundAmount(1.9999, 2), '1.99');
  assert.equal(roundAmount(0.1 + 0.2, 1), '0.3');
  assert.equal(roundAmount(-1, 2), '0');
});

test('size checks enforce the minimum in base and quote', () => {
  assert.equal(sizeProblem(btc, 0.0001, 71000), null);
  assert.match(sizeProblem(btc, 0.00005, 71000)!, /under the minimum 0.00006942/);
  assert.match(sizeProblem(btc, 0.00007, 70000)!, /under the minimum €5/);
  assert.match(sizeProblem(btc, 0, 70000)!, /zero/);
});
