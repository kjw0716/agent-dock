'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { History, timeline } = require('../history');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dock-hist-'));
const S = (agent, id, state, label) => ({ agent, id, state, label });
const MIN = 60000;
const T0 = Date.parse('2026-11-20T10:00:00Z');

test('records a change once, and a session that left', () => {
  const dir = tmp();
  const h = new History(dir);
  h.observe([S('claude', 'a', 'working', 'site')], T0);
  h.observe([S('claude', 'a', 'working', 'site')], T0 + 1000); // no change: nothing written
  h.observe([S('claude', 'a', 'done', 'site')], T0 + 2000);
  h.observe([], T0 + 3000);
  const ev = h.read(T0 - 1, T0 + 10000);
  assert.deepStrictEqual(ev.map((e) => e.s), ['start', 'working', 'done', 'gone']);
  assert.strictEqual(ev[1].k, 'claude:a');
  assert.strictEqual(ev[1].l, 'site');
});

test('timeline: waiting wins over working, union over sessions, done is empty', () => {
  const ev = [
    { t: T0, s: 'start' },
    { t: T0, k: 'claude:a', a: 'claude', id: 'a', s: 'working' },
    { t: T0 + 10 * MIN, k: 'claude:b', a: 'claude', id: 'b', s: 'waiting' },
    { t: T0 + 20 * MIN, k: 'claude:b', a: 'claude', id: 'b', s: 'done' },
    { t: T0 + 30 * MIN, k: 'claude:a', a: 'claude', id: 'a', s: 'done' },
  ];
  const r = timeline(ev, T0, T0 + 60 * MIN).agents.claude;
  assert.strictEqual(r.working, 20 * MIN); // 0-10 and 20-30
  assert.strictEqual(r.waiting, 10 * MIN); // 10-20 while a also works
  assert.deepStrictEqual(r.segments.map((s) => [s.state, s.from - T0, s.to - T0]), [['working', 0, 10 * MIN], ['waiting', 10 * MIN, 20 * MIN], ['working', 20 * MIN, 30 * MIN]]);
});

test('timeline: an interval open when the dock stopped ends at the last time it was seen', () => {
  const ev = [
    { t: T0, s: 'start' },
    { t: T0, k: 'codex:x', a: 'codex', id: 'x', s: 'working' },
    { t: T0 + 5 * MIN, s: 'beat' },
    { t: T0 + 120 * MIN, s: 'start' }, // the dock was off in between
    { t: T0 + 120 * MIN, k: 'codex:x', a: 'codex', id: 'x', s: 'done' },
  ];
  const r = timeline(ev, T0, T0 + 180 * MIN).agents.codex;
  assert.strictEqual(r.working, 5 * MIN);
});

test('timeline: an interval still open runs to the end of the range and is cut to the range', () => {
  const ev = [{ t: T0 - 60 * MIN, k: 'codex:x', a: 'codex', id: 'x', s: 'working' }];
  const r = timeline(ev, T0, T0 + 30 * MIN).agents.codex;
  assert.strictEqual(r.working, 30 * MIN);
});

test('a long gap (the computer slept) closes what was open at the last scan and states every session again', () => {
  const dir = tmp();
  const h = new History(dir);
  h.observe([S('claude', 'a', 'working')], T0);
  h.observe([S('claude', 'a', 'working')], T0 + 1000);
  h.observe([S('claude', 'a', 'working')], T0 + 8 * 3600000); // eight hours later
  const ev = h.read(T0 - 1, T0 + 9 * 3600000);
  assert.deepStrictEqual(ev.map((e) => e.s), ['start', 'working', 'beat', 'start', 'working']);
  const r = timeline(ev, T0, T0 + 9 * 3600000).agents.claude;
  assert.strictEqual(r.working, 1000 + 3600000); // 1 s before the machine slept, nothing while it slept, then the hour after waking
});

test('read spans month files and skips bad lines', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '2026-10.jsonl'), '{"t":' + Date.parse('2026-10-31T23:00:00Z') + ',"s":"beat"}\nnot json\n');
  fs.writeFileSync(path.join(dir, '2026-11.jsonl'), '{"t":' + Date.parse('2026-11-01T01:00:00Z') + ',"s":"beat"}\n');
  const h = new History(dir);
  const ev = h.read(Date.parse('2026-10-31T00:00:00Z'), Date.parse('2026-11-02T00:00:00Z'));
  assert.strictEqual(ev.length, 2);
});
