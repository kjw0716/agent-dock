'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Notifier, barkUrl, send, SEND_MAX } = require('../bark');

const row = (id, name, sessions) => ({ id, name, sessions });
const S = (id, state, extra = {}) => ({ id, state, since: 1000, ...extra });

test('barkUrl builds the path from title and body, keeps the key, refuses non-http addresses', () => {
  const u = barkUrl('https://bark.example.com/KEY123/', { title: 'Claude', body: 'Waiting for you', url: 'https://dock.ts.net/' });
  assert.strictEqual(u, 'https://bark.example.com/KEY123/Claude/Waiting%20for%20you?group=Agent+Dock&url=https%3A%2F%2Fdock.ts.net%2F');
  assert.strictEqual(barkUrl('ftp://x/KEY', { title: 'a', body: 'b' }), null);
  assert.strictEqual(barkUrl('not a url', { title: 'a', body: 'b' }), null);
});

test('send reports the status and never the address; a failing network is an error, not a throw', async () => {
  const ok = await send('https://bark.example.com/KEY', { title: 'a', body: 'b' }, { request: (url, o, cb) => { cb({ statusCode: 200, resume() {} }); return { on() {}, destroy() {} }; } });
  assert.deepStrictEqual(ok, { ok: true, status: 200 });
  const bad = await send('https://bark.example.com/KEY', { title: 'a', body: 'b' }, { request: () => { throw new Error('boom https://bark.example.com/KEY'); } });
  assert.deepStrictEqual(bad, { ok: false, error: 'network' });
  assert.deepStrictEqual(await send('nope', { title: 'a', body: 'b' }), { ok: false, error: 'address' });
});

test('nothing is pushed for what was already there at start; a new waiting session pushes once, with no session text', () => {
  const pushed = [];
  const n = new Notifier({ push: (m) => pushed.push(m) });
  const waiting = S('a', 'waiting', { ask: { id: 'q1', question: 'Secret question?' } });
  assert.deepStrictEqual(n.observe([row('claude', 'Claude', [waiting])]), []); // start: seeded only
  assert.deepStrictEqual(n.observe([row('claude', 'Claude', [waiting])]), []);
  const fresh = n.observe([row('claude', 'Claude', [waiting, S('b', 'waiting', { ask: { id: 'q2', question: 'Another secret?' } })])]);
  assert.deepStrictEqual(fresh, [{ title: 'Claude', body: 'Waiting for you', open: 'claude:b' }]); // `open` is a session id, never text
  assert.ok(!JSON.stringify(pushed).includes('secret'));
  assert.deepStrictEqual(n.observe([row('claude', 'Claude', [waiting, S('b', 'waiting', { ask: { id: 'q2' } })])]), []); // not twice
});

test('finished and unread pushes; several at once become one message with a count; placeholders and read ones are ignored', () => {
  const n = new Notifier({ push() {} });
  n.observe([row('codex', 'Codex', [])]);
  const out = n.observe([row('codex', 'Codex', [S('x', 'done', { unread: true }), S('y', 'done', { unread: true }), S('z', 'done'), { id: 'codex', state: 'done', labelKey: 'open', unread: true, since: 1 }])]);
  assert.deepStrictEqual(out, [{ title: 'Codex', body: 'Finished (2)' }]);
  const zh = new Notifier({ push() {} });
  zh.observe([row('codex', 'Codex', [])]);
  assert.deepStrictEqual(zh.observe([row('codex', 'Codex', [S('x', 'waiting', { ask: { id: 'q' } })])], 'zh'), [{ title: 'Codex', body: '等你回答', open: 'codex:x' }]);
});

test('a storm is capped: at most SEND_MAX pushes a minute', () => {
  let t = 0;
  const n = new Notifier({ push() {}, now: () => t });
  n.observe([]);
  let count = 0;
  for (let i = 0; i < 20; i++) count += n.observe([row('a' + i, 'A' + i, [S('s', 'waiting', { ask: { id: 'q' } })])]).length;
  assert.strictEqual(count, SEND_MAX);
  t += 61000;
  assert.strictEqual(n.observe([row('late', 'Late', [S('s', 'waiting', { ask: { id: 'q' } })])]).length, 1);
});
