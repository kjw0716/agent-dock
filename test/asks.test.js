'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pendingFromLines, transcriptPath, projectFolder, fromToolUse, lastReplyFromLines, excerpt } = require('../asks');
const { claudeSessions } = require('../sources');

// Synthetic transcript lines: nothing here comes from a real session.
const user = (text, extra = {}) => JSON.stringify({ type: 'user', timestamp: '2030-01-01T10:00:00Z', message: { role: 'user', content: text }, ...extra });
const toolResult = () => JSON.stringify({ type: 'user', timestamp: '2030-01-01T10:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
const assistant = (...blocks) => JSON.stringify({ type: 'assistant', timestamp: '2030-01-01T10:00:05Z', message: { role: 'assistant', content: blocks } });
const wrapUp = (input, id = 'tu_wrap') => ({ type: 'tool_use', id, name: 'mcp__ccd_turn__wrap_up', input });

const BOX = { recap: 'Built the thing.', ask: 'Ship it?', actions: [{ label: 'Ship', message: 'Yes, ship it' }, { label: 'Wait' }, { label: 'third' }], blocked: true };

test('a next-step box after the last user turn is pending, with its first two answers', () => {
  const ask = pendingFromLines([user('do it'), assistant(wrapUp(BOX)), toolResult(), assistant({ type: 'text', text: 'done' })]);
  assert.strictEqual(ask.kind, 'next_step');
  assert.strictEqual(ask.id, 'tu_wrap');
  assert.strictEqual(ask.question, 'Ship it?');
  assert.deepStrictEqual(ask.options.map((o) => o.label), ['Ship', 'Wait']);
  assert.strictEqual(ask.options[0].message, 'Yes, ship it');
  assert.strictEqual(ask.options[1].message, null);
});

test('a real user message after the box answers it; tool results and system reminders do not', () => {
  const lines = [user('do it'), assistant(wrapUp(BOX))];
  assert.ok(pendingFromLines([...lines, toolResult()]));
  assert.ok(pendingFromLines([...lines, user('<system-reminder>background</system-reminder>')]));
  assert.ok(pendingFromLines([...lines, user('meta', { isMeta: true })]));
  assert.strictEqual(pendingFromLines([...lines, user('yes please')]), null);
});

test('a box without a question or without anything for the user is ignored', () => {
  assert.strictEqual(pendingFromLines([user('x'), assistant(wrapUp({ recap: 'r', actions: [{ label: 'a' }] }))]), null);
  assert.strictEqual(pendingFromLines([user('x'), assistant(wrapUp({ recap: 'r', ask: 'q' }))]), null); // not blocked, no buttons
  assert.ok(pendingFromLines([user('x'), assistant(wrapUp({ recap: 'r', ask: 'q', blocked: true }))])); // blocked: needs the user
});

test('the newest box wins; the app\'s own actions are shown but carry no message', () => {
  const second = wrapUp({ recap: 'r', ask: 'Now what?', actions: [{ action: 'commit' }, { label: 'Later', message: 'later' }] }, 'tu_2');
  const ask = pendingFromLines([user('x'), assistant(wrapUp(BOX)), assistant(second)]);
  assert.strictEqual(ask.id, 'tu_2');
  assert.deepStrictEqual(ask.options.map((o) => [o.label, o.appAction || null]), [['Commit', 'commit'], ['Later', null]]);
});

test('a session offer is pending until the user speaks', () => {
  const offer = { type: 'tool_use', id: 'tu_offer', name: 'mcp__ccd_session__start_session', input: { initiation: 'offer', title: 'Fix the flaky test' } };
  const ask = pendingFromLines([user('x'), assistant(offer)]);
  assert.strictEqual(ask.kind, 'offer');
  assert.strictEqual(ask.question, 'Fix the flaky test');
  assert.strictEqual(fromToolUse({ ...offer, input: { initiation: 'user_asked', title: 't' } }), null);
});

test('broken and partial lines are skipped', () => {
  const ask = pendingFromLines(['{"type":"assis', user('x'), assistant(wrapUp(BOX)), '{"type":"user","mess']);
  assert.ok(ask);
});

test('transcript lookup: encoded folder first, then any project folder by session id', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-home-'));
  const sid = '11111111-2222-3333-4444-555555555555';
  const cwd = 'D:\\proj\\名字 x';
  assert.strictEqual(projectFolder(cwd), 'D--proj----x');
  const t0 = Date.now();
  assert.strictEqual(transcriptPath(sid, cwd, { home, now: t0 }), null);
  assert.strictEqual(transcriptPath(sid, cwd, { home, now: t0 + 1000 }), null); // the miss is remembered for a while
  const later = t0 + 60000;
  const other = path.join(home, '.claude', 'projects', 'some-other-folder');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, `${sid}.jsonl`), '');
  assert.strictEqual(transcriptPath(sid, cwd, { home, now: later }), path.join(other, `${sid}.jsonl`));
  const direct = path.join(home, '.claude', 'projects', projectFolder(cwd));
  fs.mkdirSync(direct, { recursive: true });
  fs.writeFileSync(path.join(direct, `${sid}.jsonl`), '');
  assert.strictEqual(transcriptPath(sid, cwd, { home, now: later }), path.join(direct, `${sid}.jsonl`));
  assert.strictEqual(transcriptPath('../../etc/passwd', cwd, { home, now: later }), null); // never a path outside the projects folder
});

test('an idle Claude session with a pending box is Waiting; a busy one stays Working', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-reg-'));
  const reg = (pid, sessionId, status) => fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: 'C:/p', kind: 'interactive', status, statusUpdatedAt: 1000, name: 'S' + pid }));
  reg(1, 'aaaaaaaa-0000-0000-0000-000000000001', 'idle');
  reg(2, 'aaaaaaaa-0000-0000-0000-000000000002', 'idle');
  reg(3, 'aaaaaaaa-0000-0000-0000-000000000003', 'busy');
  const asks = (sid) => (sid.endsWith('1') || sid.endsWith('3') ? { id: 'x', question: 'q?', options: [], at: 5000 } : null);
  const by = Object.fromEntries(claudeSessions({ dir, now: 9000, alive: () => true, asks }).map((s) => [s.label, s]));
  assert.strictEqual(by.S1.state, 'waiting');
  assert.strictEqual(by.S1.ask.question, 'q?');
  assert.strictEqual(by.S2.state, 'done');
  assert.strictEqual(by.S3.state, 'working'); // asks only matter for a session that is idle
});

const say = (text, extra = {}) => JSON.stringify({ type: 'assistant', uuid: 'u1', timestamp: '2030-01-01T10:00:09Z', message: { role: 'assistant', content: [{ type: 'text', text }], ...extra } });

test('the last reply is the final assistant text after the last real user message', () => {
  assert.strictEqual(lastReplyFromLines([user('go'), assistant({ type: 'tool_use', id: 'x', name: 'Bash', input: {} })]), null);
  const r = lastReplyFromLines([user('go'), say('First thought.'), toolResult(), say('All **done**: tests pass.')]);
  assert.strictEqual(r.text, 'All done: tests pass.');
  assert.ok(r.id.startsWith('reply:'));
  assert.strictEqual(lastReplyFromLines([user('go'), say('Old.'), user('next')]), null); // the user spoke again
});

test('excerpt strips markdown and code, and clips long text at a word', () => {
  const md = ['## Title', '', 'Use `foo()` and [docs](http://x).', '```js', 'secret()', '```', '- one', '- two'].join(String.fromCharCode(10));
  assert.strictEqual(excerpt(md), 'Title Use foo() and docs. one two');
  const long = excerpt('word '.repeat(200), 50);
  assert.ok(long.length <= 52 && long.endsWith('…'), long);
});

test('an idle Claude session carries its last reply; a busy one does not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-reg2-'));
  const reg = (pid, sessionId, status) => fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: 'C:/p', kind: 'interactive', status, statusUpdatedAt: 1000, name: 'S' + pid }));
  reg(1, 'bbbbbbbb-0000-0000-0000-000000000001', 'idle');
  reg(2, 'bbbbbbbb-0000-0000-0000-000000000002', 'busy');
  const inspect = () => ({ ask: null, reply: { text: 'Finished the report.', at: 5, id: 'reply:1' } });
  const by = Object.fromEntries(claudeSessions({ dir, now: 9000, alive: () => true, inspect }).map((s) => [s.label, s]));
  assert.strictEqual(by.S1.reply.text, 'Finished the report.');
  assert.strictEqual(by.S2.reply, undefined);
});

test('excerpt keeps snake_case but drops emphasis underscores', () => {
  assert.strictEqual(excerpt('snake_case and _italic_ and __bold__ words.'), 'snake_case and italic and bold words.');
});

test('a Claude session carries its desktop host id only in the form the app accepts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-reg3-'));
  const reg = (pid, sessionId, host) => fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: 'C:/p', kind: 'interactive', status: 'busy', statusUpdatedAt: 1000, name: 'S' + pid, hostSessionId: host }));
  reg(1, 'cccccccc-0000-0000-0000-000000000001', 'local_3254948c-279c-4a07-99cf-e11ca13031ba');
  reg(2, 'cccccccc-0000-0000-0000-000000000002', 'local_x y');
  reg(3, 'cccccccc-0000-0000-0000-000000000003', undefined);
  const by = Object.fromEntries(claudeSessions({ dir, now: 9000, alive: () => true, inspect: () => ({ ask: null, reply: null }) }).map((s) => [s.label, s]));
  assert.strictEqual(by.S1.host, 'local_3254948c-279c-4a07-99cf-e11ca13031ba');
  assert.strictEqual(by.S2.host, undefined);
  assert.strictEqual(by.S3.host, undefined);
});
