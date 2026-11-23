'use strict';
// The statistics service of the main process: the history log (state timeline) and the usage worker (tokens).
const path = require('path');
const { Worker } = require('worker_threads');
const { timeline } = require('./history');

const DAY = 24 * 60 * 60 * 1000;
const RANGES = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 };
const DETAIL_DAYS = 14; // the hour-by-hour view can show any of the last two weeks
const LOOKBACK = 30 * DAY; // a session may have been working since before the window opened

const nextMidnight = (t) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.getTime();
};

/** Working / waiting milliseconds per local day from an agent's segments: { 'YYYY-MM-DD': { w, a } }. */
function perDay(segments) {
  const out = {};
  for (const s of segments) {
    let a = s.from;
    while (a < s.to) {
      const end = Math.min(s.to, nextMidnight(a));
      const k = dayKey(a);
      const slot = out[k] || (out[k] = { w: 0, a: 0 });
      if (s.state === 'waiting') slot.a += end - a;
      else slot.w += end - a;
      a = end;
    }
  }
  return out;
}

const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const startOfDay = (t) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** The time window of a range name: { from, to } in ms, `from` at local midnight. */
function windowOf(range, now = Date.now()) {
  const days = RANGES[range] || RANGES['7d'];
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1)); // calendar days, so a clock change inside the range does not add or drop one
  return { from: d.getTime(), to: now, days };
}

class StatsService {
  constructor({ dataDir, history, workerFile = path.join(__dirname, 'usage-worker.js'), home }) {
    this.history = history;
    this.pending = new Map();
    this.nextId = 1;
    this.worker = null;
    this.workerFile = workerFile;
    this.dataDir = dataDir;
    this.home = home;
    this.listeners = new Set();
  }

  start() {
    if (this.worker) return;
    let w;
    try {
      w = new Worker(this.workerFile, { workerData: { dataDir: this.dataDir, home: this.home } });
    } catch {
      return;
    }
    this.worker = w;
    w.on('message', (m) => {
      if (this.worker !== w) return;
      if (m && m.event === 'scanned') {
        for (const f of this.listeners) f();
        return;
      }
      const p = m && this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.result);
    });
    // Only the worker that is current may fail the pending requests: a stopped worker exits later, after a new one started.
    const fail = () => {
      if (this.worker !== w) return;
      this.worker = null;
      this.rejectAll('worker stopped');
    };
    w.on('error', fail);
    w.on('exit', fail);
  }

  rejectAll(why) {
    for (const p of this.pending.values()) p.reject(new Error(why));
    this.pending.clear();
  }

  stop() {
    const w = this.worker;
    this.worker = null; // from here on nothing the old worker says or does reaches a new one
    this.rejectAll('worker stopped');
    if (w) w.terminate();
  }

  onScanned(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  call(cmd, args) {
    this.start();
    if (!this.worker) return Promise.reject(new Error('no worker'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('timeout'));
      }, 30000);
      this.pending.set(id, { resolve: (v) => (clearTimeout(t), resolve(v)), reject: (e) => (clearTimeout(t), reject(e)) });
      this.worker.postMessage({ id, cmd, args });
    });
  }

  rescan() {
    return this.call('scan').catch(() => {});
  }

  /** Everything the statistics window draws for `range`. */
  async get(range, now = Date.now()) {
    const w = windowOf(range, now);
    const usage = await this.call('summary', { from: dayKey(w.from), to: dayKey(w.to), sessionsFrom: w.from });
    const events = this.history ? this.history.read(w.from - LOOKBACK, now) : [];
    const tl = timeline(events, w.from, now);
    const days = {};
    const detailFrom = Math.max(w.from, startOfDay(now - (DETAIL_DAYS - 1) * DAY));
    const detail = {};
    for (const [id, lane] of Object.entries(tl.agents)) {
      days[id] = perDay(lane.segments);
      const segs = lane.segments.filter((s) => s.to > detailFrom).map((s) => ({ ...s, from: Math.max(s.from, detailFrom) }));
      if (segs.length) detail[id] = segs;
    }
    // Only the time the dock was running is known: other time is simply not drawn.
    return { range, from: w.from, to: w.to, usage, states: { days, detail, detailFrom }, now };
  }
}

module.exports = { StatsService, windowOf, dayKey, perDay, RANGES };
