'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { windowOf, dayKey, RANGES } = require('../stats');

test('windowOf: a range starts at local midnight N-1 days ago and ends now', () => {
  const now = new Date(2026, 10, 20, 15, 30).getTime(); // 20 Nov 2026 15:30 local
  const w = windowOf('7d', now);
  assert.strictEqual(dayKey(w.from), '2026-11-14');
  assert.strictEqual(new Date(w.from).getHours(), 0);
  assert.strictEqual(w.to, now);
  assert.strictEqual(w.days, 7);
});

test('windowOf: an unknown range falls back to 7 days; all named ranges exist', () => {
  assert.strictEqual(windowOf('nonsense').days, 7);
  assert.deepStrictEqual(Object.keys(RANGES), ['7d', '30d', '90d', '365d']);
});

test('stop() then start() again: the old worker exiting later does not fail the new one', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { StatsService } = require('../stats');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-worker-'));
  const file = path.join(dir, 'echo-worker.js');
  fs.writeFileSync(file, "const { parentPort } = require('worker_threads'); parentPort.on('message', (m) => parentPort.postMessage({ id: m.id, result: 'ok' }));");
  const svc = new StatsService({ dataDir: dir, history: null, workerFile: file });
  assert.strictEqual(await svc.call('x'), 'ok');
  svc.stop();
  assert.strictEqual(await svc.call('x'), 'ok'); // a new worker straight away, before the old one has finished exiting
  await new Promise((r) => setTimeout(r, 300)); // the old worker's exit event arrives now
  assert.strictEqual(await svc.call('x'), 'ok'); // the new worker is still the current one
  svc.stop();
});

test('perDay splits a segment at local midnight and sums working and waiting separately', () => {
  const { perDay } = require('../stats');
  const mid = new Date(2026, 10, 21, 0, 0).getTime(); // 21 Nov 00:00 local
  const H = 3600000;
  const out = perDay([
    { from: mid - 2 * H, to: mid + 3 * H, state: 'working', count: 1 }, // crosses midnight: 2 h on the 20th, 3 h on the 21st
    { from: mid + 5 * H, to: mid + 6 * H, state: 'waiting', count: 1 },
  ]);
  assert.deepStrictEqual(out['2026-11-20'], { w: 2 * H, a: 0 });
  assert.deepStrictEqual(out['2026-11-21'], { w: 3 * H, a: H });
});
