'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Channel, clean, refusal, PROMPT_LIFETIME } = require('../channel');

const SID = '0a0a0a0a-1111-2222-3333-444444444444';
const mk = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-chan-'));
  const ch = new Channel(dir);
  ch.prepare();
  return { dir, ch };
};
const checkIn = (dir, id, at = Date.now(), extra = {}) => fs.writeFileSync(path.join(dir, 'sessions', `${id}.json`), JSON.stringify({ at, ...extra }));

test('text is cleaned and refused when it would run a command, bash or a memory note', () => {
  assert.strictEqual(clean('a\u001b[31mred\u001b[0m\u0007b'), 'aredb');
  assert.strictEqual(refusal('  '), 'The answer is empty');
  for (const bad of ['/clear', '!rm -rf x', '# note', '\u001b[0m/clear']) assert.ok(refusal(bad), bad);
  assert.strictEqual(refusal('Yes, ship it'), null);
  assert.ok(refusal('x'.repeat(2001)));
});

test('leave: only to a session that checked in recently, one atomic file with the ask id and an expiry', () => {
  const { dir, ch } = mk();
  assert.match(ch.leave({ sessionId: SID, askId: 't1', text: 'yes' }).error, /not loaded/);
  checkIn(dir, SID);
  const r = ch.leave({ sessionId: SID, askId: 't1', text: 'yes\u0007', now: Date.now() });
  assert.ok(r.ok);
  const file = path.join(dir, 'prompts', SID, `${r.id}.json`);
  const v = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(v.text, 'yes');
  assert.strictEqual(v.askId, 't1');
  assert.strictEqual(v.expiresAt - v.at, PROMPT_LIFETIME);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'prompts', SID)), [`${r.id}.json`]); // no temp file left
  assert.ok(ch.leave({ sessionId: '../evil', text: 'x' }).error);
  assert.ok(ch.leave({ sessionId: SID, text: '/clear' }).error);
});

test('a stale or ended check-in does not count as loaded', () => {
  const { dir, ch } = mk();
  checkIn(dir, SID);
  assert.ok(ch.loaded().has(SID));
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(dir, 'sessions', `${SID}.json`), old, old);
  assert.ok(!ch.loaded().has(SID));
  checkIn(dir, SID, Date.now(), { ended: 1 });
  assert.ok(!ch.loaded().has(SID));
});

test('state follows what the plugin writes back; cancel leaves a marker', () => {
  const { dir, ch } = mk();
  checkIn(dir, SID);
  const { id } = ch.leave({ sessionId: SID, askId: 'a', text: 'ok' });
  const file = ch.promptFile(SID, id);
  const put = (extra) => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...extra }));
  assert.strictEqual(ch.state(SID, id).state, 'waiting');
  put({ takenAt: 1 });
  assert.strictEqual(ch.state(SID, id).state, 'taken');
  put({ startedAt: 2 });
  assert.strictEqual(ch.state(SID, id).state, 'started');
  put({ refused: 'busy' });
  assert.deepStrictEqual(ch.state(SID, id), { state: 'refused', reason: 'busy' });
  assert.strictEqual(ch.state(SID, id, Date.now() + 10 * PROMPT_LIFETIME).state, 'refused');
  const { id: id2 } = ch.leave({ sessionId: SID, askId: 'b', text: 'ok' });
  assert.strictEqual(ch.state(SID, id2, Date.now() + 10 * PROMPT_LIFETIME).state, 'expired');
  ch.cancel(SID, id2);
  assert.ok(fs.existsSync(path.join(dir, 'prompts', SID, `${id2}.cancel`)));
  assert.strictEqual(ch.state(SID, 'not-an-id'), null);
});

test('cleanup removes old files and empty folders only', () => {
  const { dir, ch } = mk();
  checkIn(dir, SID);
  const { id } = ch.leave({ sessionId: SID, askId: 'a', text: 'ok' });
  ch.cleanup();
  assert.ok(fs.existsSync(ch.promptFile(SID, id)));
  const old = new Date(Date.now() - 2 * 3600e3);
  fs.utimesSync(ch.promptFile(SID, id), old, old);
  ch.cleanup();
  assert.ok(!fs.existsSync(ch.promptFile(SID, id)));
  assert.ok(!fs.existsSync(path.join(dir, 'prompts', SID)));
});
