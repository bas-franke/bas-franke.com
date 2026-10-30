import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { codeHashOf, PREPARE_BUSY_MS, PREPARE_FAIL_MS, preparePy, resetPrepare, setLabRunner, setPyCatalog } from '../src/strategies/python.js';

const realNow = Date.now;
let now = 1_000_000;
let calls = 0;
let answer: () => unknown;

beforeEach(() => {
  now = 1_000_000;
  calls = 0;
  Date.now = () => now;
  resetPrepare();
  setLabRunner(async () => {
    calls++;
    return answer();
  });
});

after(() => {
  Date.now = realNow;
  setLabRunner(null);
  setPyCatalog(null);
});

/** One preparePy call; resolves when it has settled, with what `onDone` got (undefined = not called). */
async function prepare() {
  const done: Array<Error | null> = [];
  preparePy({ family: 'x' }, (err) => done.push(err));
  await new Promise((r) => setTimeout(r, 5));
  return done;
}

test('a busy lab does not report ready and is left alone for a while', async () => {
  answer = () => ({ busy: true });
  assert.deepEqual(await prepare(), []);
  assert.equal(calls, 1);
  now += PREPARE_BUSY_MS - 1;
  await prepare();
  assert.equal(calls, 1);
  now += 1;
  answer = () => ({ ready: true });
  assert.deepEqual(await prepare(), [null]);
  assert.equal(calls, 2);
});

test('an incomplete history is an error naming what failed, retried with growing pauses', async () => {
  answer = () => ({ ready: false, failed: { 'ETH-EUR 1h': 'BitvavoError: HTTP 500' } });
  const [err] = await prepare();
  assert.match(String(err), /ETH-EUR 1h: BitvavoError/);
  now += PREPARE_FAIL_MS - 1;
  assert.deepEqual(await prepare(), []);
  now += 1;
  assert.equal((await prepare()).length, 1);
  now += PREPARE_FAIL_MS; // the second pause is twice as long
  assert.deepEqual(await prepare(), []);
  assert.equal(calls, 2);
  now += PREPARE_FAIL_MS;
  answer = () => ({ ready: true });
  assert.deepEqual(await prepare(), [null]);
  answer = () => {
    throw new Error('lab crashed');
  };
  assert.match(String((await prepare())[0]), /lab crashed/); // success cleared the pause
});

test('codeHashOf covers the family a wrapper runs', () => {
  const base = { title: '', summary: '', version: 1, multiMarket: false, anchored: false, params: [] };
  setPyCatalog([
    { ...base, family: 'wrap', codeHash: 'aaa' },
    { ...base, family: 'lead', codeHash: 'bbb' },
    { ...base, family: 'old' },
  ]);
  assert.equal(codeHashOf('wrap'), 'aaa');
  assert.equal(codeHashOf('old'), undefined);
  assert.equal(codeHashOf('nope'), undefined);
  assert.equal(codeHashOf({ family: 'wrap', params: { fast: 3 } }), 'aaa');
  assert.equal(codeHashOf({ family: 'wrap', params: { inner: { family: 'lead', params: {} } } }), 'aaa+bbb');
});
