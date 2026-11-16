'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { OpenCodeReader, toSessions, label } = require('../opencode');
const { UnreadTracker } = require('../unread');

const NOW = 1_800_000_000_000;
const row = (o) => ({ id: 'ses_a', title: 'Chat', directory: 'C:/x/proj', time_busy: NOW - 60000, time_idle: NOW - 30000, time_viewed: NOW - 30000, time_updated: NOW - 30000, ...o });

test('busy is a busy mark newer than the idle mark', () => {
  const [w] = toSessions([row({ time_busy: NOW - 5000, time_idle: NOW - 50000 })], { now: NOW, open: true });
  assert.strictEqual(w.state, 'working');
  assert.strictEqual(w.since, NOW - 5000);
  const [first] = toSessions([row({ time_busy: NOW - 5000, time_idle: null })], { now: NOW, open: true });
  assert.strictEqual(first.state, 'working'); // its very first turn
  const [d] = toSessions([row()], { now: NOW, open: true });
  assert.strictEqual(d.state, 'done');
  assert.strictEqual(d.since, NOW - 30000);
  assert.strictEqual(d.exact, true);
});

test('a busy mark with no app running is a cut-off run, not work in progress', () => {
  const [s] = toSessions([row({ time_busy: NOW - 5 * 3600 * 1000, time_idle: NOW - 6 * 3600 * 1000 })], { now: NOW, open: false });
  assert.strictEqual(s.state, 'done');
  assert.strictEqual(s.abandoned, true);
});

test('old finished chats are hidden; untitled chats use the folder name', () => {
  assert.strictEqual(toSessions([row({ time_idle: NOW - 7 * 3600 * 1000, time_busy: NOW - 8 * 3600 * 1000 })], { now: NOW }).length, 0);
  assert.strictEqual(label('Untitled', 'C:/Users/pc/Downloads/gmail'), 'gmail');
  assert.strictEqual(label('  Hello ', 'x'), 'Hello');
});

test('the reader gives null without a driver and when the database throws', () => {
  assert.strictEqual(new OpenCodeReader({ driver: null }).sessions({ now: NOW }), null);
  class Bad {
    constructor() {
      throw new Error('locked');
    }
  }
  assert.strictEqual(new OpenCodeReader({ driver: Bad, file: 'x' }).sessions({ now: NOW }), null);
});

test('the reader maps rows and reopens after an error', () => {
  let opened = 0;
  let fail = false;
  class Fake {
    constructor() {
      opened++;
    }
    prepare() {
      return { all: () => { if (fail) throw new Error('schema'); return [row({ id: 's1' }), row({ id: 's2', time_busy: NOW - 1000, time_idle: NOW - 9000 })]; } };
    }
    close() {}
  }
  const r = new OpenCodeReader({ driver: Fake, file: 'x' });
  const list = r.sessions({ now: NOW, open: true });
  assert.deepStrictEqual(list.map((s) => [s.id, s.state]), [['s1', 'done'], ['s2', 'working']]);
  fail = true;
  assert.strictEqual(r.sessions({ now: NOW, open: true }), null);
  fail = false;
  assert.strictEqual(r.sessions({ now: NOW + 11000, open: true }).length, 2);
  assert.strictEqual(opened, 2);
});

test('an exact busy spell counts as unread however short, a guessed one does not', () => {
  const minWork = (agent, s) => (agent === 'claude' || s.exact ? 0 : 30000);
  const t = new UnreadTracker();
  t.update([{ agent: 'opencode', id: 'a', state: 'working', exact: true }], 0, minWork);
  t.update([{ agent: 'opencode', id: 'a', state: 'done', exact: true }], 2000, minWork);
  assert.deepStrictEqual(t.list(), ['opencode:a']);
  const g = new UnreadTracker();
  g.update([{ agent: 'opencode', id: 'a', state: 'working' }], 0, minWork);
  g.update([{ agent: 'opencode', id: 'a', state: 'done' }], 2000, minWork);
  assert.deepStrictEqual(g.list(), []);
});
