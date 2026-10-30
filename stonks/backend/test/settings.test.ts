import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

/** settings.ts against a fake `settings` table. Needs `--experimental-test-module-mocks`. */

let stored: Record<string, unknown> | undefined;
const sqls: string[] = [];
mock.module('../src/db.js', {
  exports: {
    query: async (sql: string) => {
      sqls.push(sql);
      if (sql.startsWith('SELECT value FROM settings')) return { rows: stored ? [{ value: structuredClone(stored) }] : [] };
      if (sql.startsWith('UPDATE settings SET value = jsonb_set')) {
        stored = { ...stored, enabled: false };
        return { rows: [] };
      }
      throw new Error(`unexpected SQL ${sql}`);
    },
  },
});
mock.module('../src/log.js', { exports: { log: async () => undefined } });
const { checkSettings, DEFAULT_LOSS_ACTION, getBotSettings, defaultBotSettings } = await import('../src/settings.js');

test('settings that stop validating switch the bot off for good, not just until the next deploy', async () => {
  // e.g. a family version the running code does not know
  stored = { ...defaultBotSettings(), enabled: true, mode: 'live', strategy: { ...defaultBotSettings().strategy, familyVersion: 99 } };
  const s = await getBotSettings();
  assert.equal(s.enabled, false);
  assert.equal(s.mode, 'live');
  assert.equal(stored.enabled, false, 'enabled: false is written back');
  // A later deploy that accepts the old value again finds the bot off.
  stored = { ...stored, strategy: defaultBotSettings().strategy };
  assert.equal((await getBotSettings()).enabled, false);
  // Valid settings are read as they are and never written.
  const writes = sqls.filter((q) => q.startsWith('UPDATE')).length;
  stored = { ...defaultBotSettings(), enabled: true };
  assert.equal((await getBotSettings()).enabled, true);
  assert.equal(sqls.filter((q) => q.startsWith('UPDATE')).length, writes);
});

test('the 24 h loss limit defaults to 15 % with no_buys; an old euro limit the owner picked stays in euros', async () => {
  assert.deepEqual(defaultBotSettings().dailyLossLimit, { unit: 'pct', value: 15, action: 'no_buys' });
  assert.equal(DEFAULT_LOSS_ACTION, 'no_buys');
  const { dailyLossLimit: _, ...base } = defaultBotSettings();
  stored = base;
  assert.deepEqual((await getBotSettings()).dailyLossLimit, { unit: 'pct', value: 15, action: 'no_buys' });
  stored = { ...base, dailyLossLimitEur: 100 };
  assert.deepEqual((await getBotSettings()).dailyLossLimit, { unit: 'pct', value: 10, action: 'no_buys' });
  stored = { ...base, dailyLossLimitEur: 250 };
  const s = await getBotSettings();
  assert.deepEqual(s.dailyLossLimit, { unit: 'eur', value: 250, action: 'no_buys' });
  assert.equal('dailyLossLimitEur' in s, false);
});

test('a stored limit is never rewritten: it only gains the default action, and a stored action stays', async () => {
  stored = { ...defaultBotSettings(), dailyLossLimit: { unit: 'pct', value: 10 } };
  assert.deepEqual((await getBotSettings()).dailyLossLimit, { unit: 'pct', value: 10, action: 'no_buys' });
  stored = { ...defaultBotSettings(), dailyLossLimit: { unit: 'eur', value: 40, action: 'stop' } };
  assert.deepEqual((await getBotSettings()).dailyLossLimit, { unit: 'eur', value: 40, action: 'stop' });
  stored = { ...defaultBotSettings(), dailyLossLimit: { unit: 'eur', value: 40, action: 'alert' } };
  assert.equal((await getBotSettings()).dailyLossLimit.action, 'alert');
  assert.throws(() => checkSettings({ ...defaultBotSettings(), dailyLossLimit: { unit: 'pct', value: 10, action: 'panic' } }), /dailyLossLimit.action/);
});
