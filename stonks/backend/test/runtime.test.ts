import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The lab bridge reads its paths from config at import: point its candle store at an empty temp folder first.
const dataDir = mkdtempSync(path.join(tmpdir(), 'stonks-labdata-'));
process.env.STONKS_LAB_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const { config } = await import('../src/config.js');
const { setPyCatalog } = await import('../src/strategies/python.js');
const rt = await import('../src/strategies/runtime.js');

const fakeCatalog = [
  {
    family: 'moon_core',
    title: 'Moon core',
    summary: 'Holds BTC while the moon is full.',
    version: 2,
    multiMarket: true,
    anchored: false,
    params: [
      { name: 'len', type: 'int' as const, default: 50, min: 10, max: 400, zero: true, description: 'average length' },
      { name: 'thr', type: 'number' as const, default: 0.1, min: 0.01, max: 0.5, description: 'threshold' },
      { name: 'step', type: 'choice' as const, default: 0.25, options: [0, 0.25, 0.5], description: 'grid step' },
      { name: 'mode', type: 'choice' as const, default: 'own', options: ['own', 'pool'], description: 'signal source' },
      { name: 'flip', type: 'boolean' as const, default: false, description: 'invert' },
    ],
  },
  { family: 'ema_cross', title: 'EMA crossover', summary: '', version: 7, multiMarket: false, anchored: false, params: [] },
];

test('lab families validate against their published params and keep the lab-only universe field', () => {
  setPyCatalog(fakeCatalog);
  const s = rt.validateAnySpec({ family: 'moon_core', markets: ['BTC-EUR', 'ETH-EUR'], interval: '4h', params: { len: 0, step: '0.5' }, universe: 'top10_pit' });
  assert.equal(s.familyVersion, 2);
  assert.deepEqual(s.params, { len: 0, thr: 0.1, step: 0.5, mode: 'own', flip: false }); // 0 = off is allowed, "0.5" from the form is 0.5
  assert.equal(s.universe, 'top10_pit');
  assert.equal(s.risk.maxWeight, 1);
  assert.equal(s.execution.orderType, 'limit');
  assert.ok(rt.runsInPython(s));
  for (const [input, msg] of [
    [{ params: { len: 5 } }, /len must be 0 \(off\) or between 10 and 400/],
    [{ params: { len: 50.5 } }, /whole number/],
    [{ params: { mode: 'moon' } }, /mode must be one of own, pool/],
    [{ params: { nope: 1 } }, /no parameter "nope"/],
    [{ familyVersion: 1 }, /version 1 is not supported, the server runs version 2/],
    [{ risk: { maxWeight: 2 } }, /maxWeight/],
  ] as const)
    assert.throws(() => rt.validateAnySpec({ family: 'moon_core', markets: ['BTC-EUR'], interval: '1d', ...input }), msg);
});

test('the bot only trades BTC-EUR and ETH-EUR, whichever engine runs the family', () => {
  setPyCatalog(fakeCatalog);
  assert.ok(rt.validateAnySpec({ family: 'moon_core', markets: ['BTC-EUR', 'ETH-EUR'], interval: '4h' }));
  for (const markets of [['SOL-EUR'], ['BTC-EUR', 'SOL-EUR']]) {
    assert.throws(() => rt.validateAnySpec({ family: 'moon_core', markets, interval: '4h' }), /SOL-EUR" is not allowed/);
    assert.throws(() => rt.validateAnySpec({ family: 'rotation_momentum', markets, interval: '1d' }), /SOL-EUR" is not allowed/);
  }
});

test('a TypeScript port wins at its version; another version of the same family runs in the lab', () => {
  setPyCatalog(fakeCatalog);
  const ts = rt.validateAnySpec({ family: 'ema_cross', markets: ['BTC-EUR'], interval: '1h', params: { fast: 5, slow: 20 } });
  assert.ok(!rt.runsInPython(ts));
  assert.deepEqual(rt.candlePlan(ts).markets, ['BTC-EUR']);
  const lab = rt.validateAnySpec({ family: 'ema_cross', familyVersion: 7, markets: ['BTC-EUR'], interval: '1h' });
  assert.ok(rt.runsInPython(lab));
  assert.deepEqual(rt.candlePlan(lab), { markets: ['BTC-EUR'], bars: 3 }); // the lab reads its own history
  assert.ok(rt.isRunnable('moon_core', 2) && rt.isRunnable('moon_core', undefined) && !rt.isRunnable('moon_core', 3));
  assert.ok(!rt.isRunnable('mystery', 1));
  const fams = rt.allFamilies() as Array<{ family: string; params: Array<{ type: string; options?: string[] }> }>;
  const moon = fams.find((f) => f.family === 'moon_core')!;
  assert.deepEqual(moon.params.map((p) => p.type), ['int', 'number', 'enum', 'enum', 'boolean']);
  assert.deepEqual(moon.params[2].options, ['0', '0.25', '0.5']);
  assert.equal(fams.filter((f) => f.family === 'ema_cross').length, 1);
  assert.match(rt.explainAny(lab), /lab's own code/);
});

test('wrapper families keep their lead (an object param) and reject non-objects', () => {
  const lead = { family: 'wick_pressure', params: { lookback: 63 } };
  setPyCatalog([
    ...fakeCatalog,
    {
      family: 'mtf_guard_a24', title: 'Long-term lead with a fast crash guard', summary: '', version: 1, multiMarket: false, anchored: false,
      params: [{ name: 'leadTf', type: 'choice' as const, default: '1d', options: ['same', '1d'], description: 'lead time frame' }],
      objectParams: [{ name: 'inner', default: { family: 'ema_cross', params: {} } }],
    },
  ]);
  const s = rt.validateAnySpec({ family: 'mtf_guard_a24', markets: ['ETH-EUR'], interval: '1h', params: { inner: lead } });
  assert.deepEqual(s.params, { inner: lead, leadTf: '1d' });
  const d = rt.validateAnySpec({ family: 'mtf_guard_a24', markets: ['ETH-EUR'], interval: '1h' });
  assert.deepEqual((d.params as Record<string, unknown>).inner, { family: 'ema_cross', params: {} });
  assert.throws(() => rt.validateAnySpec({ family: 'mtf_guard_a24', markets: ['ETH-EUR'], interval: '1h', params: { inner: 'x' } }), /inner must be an object/);
  setPyCatalog(fakeCatalog);
});

const haveLab = existsSync(path.join(config.labDir, 'stonks_lab', 'live.py'));

test('the real lab runs a family the bot has no port of', { skip: !haveLab && 'no lab checkout next to this project' }, async () => {
  setPyCatalog(null);
  assert.ok(rt.isRunnable('supertrend'), 'the lab catalog lists supertrend');
  const spec = await rt.checkSpec({ family: 'supertrend', markets: ['BTC-EUR'], interval: '1d' });
  assert.ok(rt.runsInPython(spec));
  assert.ok(rt.explainAny(spec).length > 40);
  // nothing downloaded in the temp store yet: it answers at once instead of trading on partial history
  const d = await rt.decide(spec, Date.UTC(2026, 9, 1), {});
  assert.deepEqual(d, { warming: ['BTC-EUR 1d'] });
  const bad = rt.checkSpec({ family: 'ema_cross', familyVersion: 1, markets: ['BTC-EUR'], interval: '1d', params: { fast: 50, slow: 20 } });
  await assert.rejects(bad, /fast must be smaller than slow/);
});

test('a hold from the lab, or no candle data at all, is never a zero-weight decision', async () => {
  // TypeScript families: no candles at all means t null and weights 0, which must not read as "sell everything"
  const spec = rt.validateAnySpec({ family: 'ema_cross', markets: ['BTC-EUR'], interval: '1h', params: { fast: 2, slow: 5 } });
  assert.deepEqual(await rt.decide(spec, Date.UTC(2026, 9, 1), {}), { hold: 'no candle data', t: null });
});
