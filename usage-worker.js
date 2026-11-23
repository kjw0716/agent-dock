'use strict';
// Runs the transcript indexer off the main thread. Messages in: { id, cmd: 'scan' | 'summary', args };
// messages out: { id, result } for a request, { event: 'scanned' } when a scan finishes.
// A scan works in slices of about a second and lets queued requests run in between, so a summary asked for
// during the first full index answers at once from what has been read so far (`scanning: true`).
const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const usage = require('./usage');
const { loadTable, makePrice } = require('./prices');

const dataDir = workerData.dataDir;
const cacheFile = path.join(dataDir, 'usage-index.json');
const pricesFile = path.join(dataDir, 'prices.json');
const home = workerData.home || undefined;

let index = usage.load(cacheFile);
let scanning = false;
let again = false;

const yieldNow = () => new Promise((r) => setImmediate(r));

async function scanAll() {
  if (scanning) {
    again = true;
    return;
  }
  scanning = true;
  try {
    do {
      again = false;
      let changed = false;
      for (;;) {
        const r = usage.scan(index, { home, budgetMs: 1000 });
        if (r.files > 0 || r.rebuilt) changed = true;
        if (r.complete) break;
        await yieldNow();
      }
      if (changed) usage.save(cacheFile, index); // an idle pass writes nothing
    } while (again);
  } catch {
    // a failed scan leaves the last good index in place
  } finally {
    scanning = false;
    parentPort.postMessage({ event: 'scanned' });
  }
}

parentPort.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  if (m.cmd === 'scan') {
    void scanAll();
    parentPort.postMessage({ id: m.id, result: { started: true } });
  } else if (m.cmd === 'summary') {
    try {
      const a = m.args || {};
      const price = makePrice(loadTable(pricesFile));
      const result = usage.summary(index, { from: a.from, to: a.to, sessionsFrom: a.sessionsFrom, limit: 300, price });
      parentPort.postMessage({ id: m.id, result: { ...result, scanning } });
    } catch (e) {
      parentPort.postMessage({ id: m.id, error: String(e && e.message) });
    }
  }
});

void scanAll();
