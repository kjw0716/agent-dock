'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { UnreadTracker } = require('../unread');

const s = (agent, id, state) => ({ agent, id, state });

test('finishing while watched makes a session unread; starting again clears it', () => {
  const t = new UnreadTracker();
  assert.strictEqual(t.update([s('claude', 'a', 'working'), s('claude', 'b', 'done')]), false);
  assert.deepStrictEqual(t.list(), []); // b was already done when the dock saw it first
  assert.strictEqual(t.update([s('claude', 'a', 'done'), s('claude', 'b', 'done')]), true);
  assert.deepStrictEqual(t.list(), ['claude:a']);
  assert.strictEqual(t.update([s('claude', 'a', 'done'), s('claude', 'b', 'done')]), false); // staying done changes nothing
  t.update([s('claude', 'a', 'working'), s('claude', 'b', 'done')]);
  assert.deepStrictEqual(t.list(), []); // you replied
});

test('a waiting session that finishes is unread too; waiting itself is not', () => {
  const t = new UnreadTracker();
  t.update([s('codex', 'x', 'waiting')]);
  assert.deepStrictEqual(t.list(), []);
  t.update([s('codex', 'x', 'done')]);
  assert.deepStrictEqual(t.list(), ['codex:x']);
});

test('readAgent clears only that agent; has() answers per session', () => {
  const t = new UnreadTracker();
  t.update([s('claude', 'a', 'working'), s('codex', 'c', 'working')]);
  t.update([s('claude', 'a', 'done'), s('codex', 'c', 'done')]);
  assert.ok(t.has(s('claude', 'a')) && t.has(s('codex', 'c')));
  assert.strictEqual(t.readAgent('claude'), true);
  assert.ok(!t.has(s('claude', 'a')) && t.has(s('codex', 'c')));
  assert.strictEqual(t.readAgent('claude'), false);
  assert.strictEqual(t.readAgent('cla'), false); // never a prefix match on another agent
});

test('a session that disappears is forgotten', () => {
  const t = new UnreadTracker();
  t.update([s('claude', 'a', 'working')]);
  t.update([s('claude', 'a', 'done')]);
  assert.strictEqual(t.update([]), true);
  assert.deepStrictEqual(t.list(), []);
  t.update([s('claude', 'a', 'done')]); // comes back already done: not unread
  assert.deepStrictEqual(t.list(), []);
});

test('remembered keys survive a restart only while the session is still done', () => {
  const t = new UnreadTracker(['claude:a', 'claude:gone', 'claude:busy']);
  t.update([s('claude', 'a', 'done'), s('claude', 'busy', 'working')]);
  assert.deepStrictEqual(t.list(), ['claude:a']);
  const t2 = new UnreadTracker(['claude:a']);
  t2.update([s('claude', 'a', 'done')]);
  t2.update([s('claude', 'a', 'done')]);
  assert.deepStrictEqual(t2.list(), ['claude:a']); // not re-evaluated after the first update
});
