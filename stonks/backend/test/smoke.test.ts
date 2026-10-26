import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrations } from '../src/migrations.js';

test('migrations have unique names', () => {
  const names = migrations.map((m) => m.name);
  assert.equal(new Set(names).size, names.length);
});
