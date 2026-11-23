'use strict';
// A local log of every state change the dock sees, so the statistics window can draw "who was working,
// who was waiting for you, and for how long". Plain JSON lines, one file per month, in <data>/history.
//
//   { t, s: 'start' }                          the dock started: whatever was open before is closed at the last time seen
//   { t, s: 'beat' }                           the dock is alive (every 5 minutes)
//   { t, k, a, id, l, s: 'working'|'waiting'|'done'|'gone' }   one session changed state ('gone': it left the list)
//
// No native dependency: the data is small and only ever appended.
const fs = require('fs');
const path = require('path');

const MIN = 60 * 1000;
const BEAT_EVERY = 5 * MIN;
const GAP = 90 * 1000; // no scan for this long (the computer slept): what was open then is closed at the last scan
const PRIORITY = { waiting: 2, working: 1 }; // done is not drawn
const MAX_LABEL = 80;

const month = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

class History {
  constructor(dir, { now = () => Date.now() } = {}) {
    this.dir = dir;
    this.now = now;
    this.last = new Map(); // "agent:id" -> state
    this.lastBeat = 0;
    this.lastObs = 0;
    this.started = false;
  }

  append(events) {
    if (!events.length) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const byFile = new Map();
      for (const e of events) {
        const f = path.join(this.dir, month(e.t) + '.jsonl');
        byFile.set(f, (byFile.get(f) || '') + JSON.stringify(e) + '\n');
      }
      for (const [f, text] of byFile) fs.appendFileSync(f, text);
    } catch {}
  }

  /** Call with the sessions of every agent after each scan. */
  observe(sessions, now = this.now()) {
    const events = [];
    let restart = false;
    if (!this.started) {
      this.started = true;
      restart = true;
    } else if (this.lastObs && now - this.lastObs > GAP) {
      events.push({ t: this.lastObs, s: 'beat' }); // the last moment the dock really saw
      restart = true;
      this.last.clear(); // every open session states itself again below
    }
    if (restart) {
      events.push({ t: now, s: 'start' });
      this.lastBeat = now;
    } else if (now - this.lastBeat >= BEAT_EVERY) {
      events.push({ t: now, s: 'beat' });
      this.lastBeat = now;
    }
    this.lastObs = now;
    const present = new Set();
    for (const s of sessions) {
      const k = s.agent + ':' + s.id;
      present.add(k);
      if (this.last.get(k) === s.state) continue;
      this.last.set(k, s.state);
      events.push({ t: now, k, a: s.agent, id: String(s.id), l: s.label ? String(s.label).slice(0, MAX_LABEL) : undefined, s: s.state });
    }
    for (const k of [...this.last.keys()]) {
      if (present.has(k)) continue;
      this.last.delete(k);
      const i = k.indexOf(':');
      events.push({ t: now, k, a: k.slice(0, i), id: k.slice(i + 1), s: 'gone' });
    }
    this.append(events);
  }

  /** Events with from <= t <= to, oldest first. */
  read(from, to = this.now()) {
    const out = [];
    let names = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort();
    } catch {
      return out;
    }
    const lo = month(from);
    const hi = month(to);
    for (const n of names) {
      const m = n.slice(0, 7);
      if (m < lo || m > hi) continue;
      let text = '';
      try {
        text = fs.readFileSync(path.join(this.dir, n), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line) continue;
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (e && Number.isFinite(e.t) && e.t >= from && e.t <= to) out.push(e);
      }
    }
    return out;
  }
}

/**
 * Turn events into per-agent lanes. Returns
 *   { agents: { <id>: { segments: [{ from, to, state, count }], working, waiting } } }
 * `segments` are the union over that agent's sessions (waiting wins over working; done is left empty),
 * `working` / `waiting` are the milliseconds spent in each. An interval left open runs to `to`, unless a
 * later 'start' shows the dock was not running: then it ends at the last time the dock was seen.
 */
function timeline(events, from, to) {
  const intervals = []; // { agent, from, to, state, key }
  const open = new Map(); // key -> { agent, from, state }
  let seen = 0;
  const close = (key, at) => {
    const o = open.get(key);
    if (!o) return;
    open.delete(key);
    const a = Math.max(o.from, from);
    const b = Math.min(at, to);
    if (b > a && PRIORITY[o.state]) intervals.push({ agent: o.agent, from: a, to: b, state: o.state, key });
  };
  for (const e of events) {
    if (e.t > to) break;
    if (e.s === 'start') {
      for (const key of [...open.keys()]) close(key, seen || e.t);
      seen = e.t;
      continue;
    }
    seen = Math.max(seen, e.t);
    if (e.s === 'beat') continue;
    if (!e.k) continue;
    close(e.k, e.t);
    if (e.s === 'working' || e.s === 'waiting') open.set(e.k, { agent: e.a, from: e.t, state: e.s });
  }
  for (const key of [...open.keys()]) close(key, to);

  const agents = {};
  const byAgent = new Map();
  for (const iv of intervals) {
    if (!byAgent.has(iv.agent)) byAgent.set(iv.agent, []);
    byAgent.get(iv.agent).push(iv);
  }
  for (const [agent, list] of byAgent) {
    const cuts = [...new Set(list.flatMap((i) => [i.from, i.to]))].sort((x, y) => x - y);
    const segments = [];
    let working = 0;
    let waiting = 0;
    for (let i = 0; i + 1 < cuts.length; i++) {
      const a = cuts[i];
      const b = cuts[i + 1];
      let top = 0;
      let count = 0;
      let state = null;
      for (const iv of list) {
        if (iv.from <= a && iv.to >= b) {
          count++;
          if (PRIORITY[iv.state] > top) {
            top = PRIORITY[iv.state];
            state = iv.state;
          }
        }
      }
      if (!state) continue;
      if (state === 'working') working += b - a;
      else waiting += b - a;
      const prev = segments[segments.length - 1];
      if (prev && prev.to === a && prev.state === state && prev.count === count) prev.to = b;
      else segments.push({ from: a, to: b, state, count });
    }
    agents[agent] = { segments, working, waiting };
  }
  return { agents };
}

module.exports = { History, timeline, BEAT_EVERY };
