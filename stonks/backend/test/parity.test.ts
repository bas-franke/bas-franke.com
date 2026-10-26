import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { targetSeries, validateSpec, type Candle, type Weights } from '../src/strategies/index.js';

/**
 * SPEC §6: each fixture from the Python lab is { spec, candles: { market: [[t,o,h,l,c,v], ...] }, targets: [[t, {market: w}], ...] }.
 * The TS family replays the same candles and must agree on every listed bar within 1e-9 (a market missing from a
 * weights object counts as 0). An optional `state` ({ startTime }) is passed through. No fixtures = nothing to check.
 */
const dir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'parity');
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
const TOL = 1e-9;

test('parity fixture folder is optional', () => {
  assert.ok(Array.isArray(files));
});

for (const file of files) {
  test(`parity: ${file}`, () => {
    const fx = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
      spec: unknown;
      candles: Record<string, Array<Array<number | string>>>;
      targets: Array<[number, Weights]>;
      state?: { startTime?: number };
    };
    const spec = validateSpec(fx.spec);
    const candles = Object.fromEntries(Object.entries(fx.candles).map(([m, rows]) => [m, rows.map((r) => r.map(Number) as Candle)]));
    const ours = new Map(targetSeries(candles, spec, fx.state).map(([t, w]) => [Number(t), w]));
    assert.ok(fx.targets.length > 0, 'fixture has no targets');
    let checked = 0;
    for (const [tRaw, expected] of fx.targets) {
      const t = Number(tRaw);
      const got = ours.get(t);
      assert.ok(got, `${file}: no TS output for bar ${t} (${new Date(t).toISOString()})`);
      for (const m of new Set([...Object.keys(expected), ...Object.keys(got)])) {
        const a = Number(expected[m] ?? 0);
        const b = Number(got[m] ?? 0);
        assert.ok(Math.abs(a - b) <= TOL, `${file}: bar ${t} (${new Date(t).toISOString()}) ${m}: python ${a} vs ts ${b}`);
      }
      checked++;
    }
    assert.equal(checked, fx.targets.length);
  });
}
