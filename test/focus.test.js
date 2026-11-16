'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FocusReader } = require('../focus');

function registry(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-focus-'));
  const dir = path.join(root, 'acct', 'org');
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(body));
  return { root, dir };
}

test('reads lastFocusedAt of a chat and follows later changes', () => {
  const { root, dir } = registry({ local_a: { lastFocusedAt: 1000 }, local_b: { title: 'never opened' } });
  const f = new FocusReader({ roots: [root] });
  assert.strictEqual(f.lastFocused('local_a'), 1000);
  assert.strictEqual(f.lastFocused('local_b'), 0);
  const file = path.join(dir, 'local_a.json');
  fs.writeFileSync(file, JSON.stringify({ lastFocusedAt: 2500 }));
  fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000)); // make sure the mtime differs
  assert.strictEqual(f.lastFocused('local_a'), 2500);
});

test('unknown chats and malformed ids give 0', () => {
  const { root } = registry({});
  const f = new FocusReader({ roots: [root, path.join(root, 'missing')] });
  assert.strictEqual(f.lastFocused('local_nope'), 0);
  assert.strictEqual(f.lastFocused('../../etc/passwd'), 0);
  assert.strictEqual(f.lastFocused(undefined), 0);
});

test('a chat that appears later is found after the miss window', () => {
  const { root, dir } = registry({});
  const f = new FocusReader({ roots: [root] });
  assert.strictEqual(f.lastFocused('local_late', 1000), 0);
  fs.writeFileSync(path.join(dir, 'local_late.json'), JSON.stringify({ lastFocusedAt: 77 }));
  assert.strictEqual(f.lastFocused('local_late', 2000), 0); // still inside the miss window
  assert.strictEqual(f.lastFocused('local_late', 1000 + 16000), 77);
});

test('the newest value across several roots wins', () => {
  const a = registry({ local_x: { lastFocusedAt: 10 } });
  const b = registry({ local_x: { lastFocusedAt: 30 } });
  assert.strictEqual(new FocusReader({ roots: [a.root, b.root] }).lastFocused('local_x'), 30);
});
