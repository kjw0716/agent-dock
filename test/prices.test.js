'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULTS, loadTable, makePrice } = require('../prices');

test('prices a Claude call: input, output, cache read, 5-minute and 1-hour cache write', () => {
  const price = makePrice(DEFAULTS);
  // claude-sonnet-5-5: in 2, out 10, cacheRead 0.1, write 5m 2.5, write 1h 4 (per million)
  const c = price('claude', 'claude-sonnet-5-5', { i: 1e6, o: 1e6, cr: 1e6, cw: 2e6, cw1: 1e6 });
  assert.ok(Math.abs(c - (2 + 10 + 0.1 + 2.5 + 4)) < 1e-9);
});

test('a [1m] suffix or a snapshot date still finds the model; a different version is unpriced, not guessed', () => {
  const price = makePrice(DEFAULTS);
  const one = { i: 1e6, o: 0, cr: 0, cw: 0, cw1: 0 };
  assert.strictEqual(price('claude', 'claude-opus-5-5[1m]', one), 4);
  assert.strictEqual(price('claude', 'claude-opus-5-20261101', one), 5); // claude-opus-5 plus a date
  assert.strictEqual(price('claude', 'claude-opus-5-6', one), null); // a version nobody priced yet
  assert.strictEqual(price('claude', 'claude-sonnet-5-9', one), null);
});

test('an unknown model is null, not free; a user entry adds one', () => {
  const price = makePrice(DEFAULTS);
  assert.strictEqual(price('codex', 'gpt-6.2-astra', { i: 10, o: 10, cr: 0, cw: 0, cw1: 0 }), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-prices-'));
  const f = path.join(dir, 'prices.json');
  fs.writeFileSync(f, JSON.stringify({ models: { 'GPT-6.2-astra': { in: 1, out: 8, cacheRead: 0.1 } } }));
  const mine = makePrice(loadTable(f));
  assert.ok(Math.abs(mine('codex', 'gpt-6.2-astra', { i: 1e6, o: 1e6, cr: 1e6, cw: 0, cw1: 0 }) - 9.1) < 1e-9);
});

test('a broken prices file falls back to the built-in table', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-prices-'));
  const f = path.join(dir, 'prices.json');
  fs.writeFileSync(f, '{not json');
  assert.ok(loadTable(f)['claude-opus-5-5']);
});
