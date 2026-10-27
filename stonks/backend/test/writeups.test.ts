import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startHarness, type Harness } from './helpers/api-harness.js';

// Strategy write-ups (SPEC §8b): stored per spec id, readable when logged in.
describe('strategy write-ups', () => {
  let h: Harness;
  let cookie: string;
  before(async () => {
    h = await startHarness();
    cookie = await h.login();
  });
  after(() => h.close());
  const doc = { title: 'Mixed #1 explained', sections: [{ type: 'text', title: 'ELI5', body: 'x' }, { type: 'example', title: 'e', charts: [] }] };

  test('saved per spec id, listed, read back; only logged in', async () => {
    assert.equal((await h.req('GET', '/api/writeups/mtf_guard_a24-eth-1h-949312', { cookie })).status, 404);
    assert.equal((await h.req('PUT', '/api/writeups/mtf_guard_a24-eth-1h-949312', { json: doc })).status, 401);
    const big = { ...doc, sections: [...doc.sections, { type: 'example', title: 'x', charts: [{ series: [{ points: Array.from({ length: 4000 }, (_, i) => [i, i]) }] }] }] };
    assert.equal((await h.req('PUT', '/api/writeups/mtf_guard_a24-eth-1h-949312', { json: big, cookie })).status, 200, 'larger bodies are accepted after login');
    assert.equal((await h.req('PUT', '/api/writeups/mtf_guard_a24-eth-1h-949312', { json: doc, cookie })).status, 200);
    const list = (await (await h.req('GET', '/api/writeups', { cookie })).json()) as any;
    assert.deepEqual(list.writeups.map((w: any) => w.specId), ['mtf_guard_a24-eth-1h-949312']);
    const got = (await (await h.req('GET', '/api/writeups/mtf_guard_a24-eth-1h-949312', { cookie })).json()) as any;
    assert.equal(got.title, 'Mixed #1 explained');
    assert.equal(got.sections.length, 2);
  });

  test('bad write-ups are refused', async () => {
    for (const bad of [{}, { title: 'x', sections: [] }, { title: 'x', sections: [{ type: 'script' }] }])
      assert.equal((await h.req('PUT', '/api/writeups/abc', { json: bad, cookie })).status, 400, JSON.stringify(bad));
    assert.equal((await h.req('GET', '/api/writeups/bad%20id', { cookie })).status, 400);
  });
});
