'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { claudeSessions, codexSessions, codexReduce, summarize } = require('../sources');

const NOW = Date.parse('2026-11-15T12:00:00Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hud-'));
const write = (dir, name, v) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), typeof v === 'string' ? v : JSON.stringify(v));
};

test('claude: busy / waiting / idle map to three states, dead pid and unknown status dropped', () => {
  const dir = tmp();
  const base = { kind: 'interactive', cwd: 'C:\\x\\proj', statusUpdatedAt: NOW - 60000 };
  write(dir, '1.json', { ...base, pid: 1, sessionId: 'a', status: 'busy', name: 'A' });
  write(dir, '2.json', { ...base, pid: 2, sessionId: 'b', status: 'waiting' });
  write(dir, '3.json', { ...base, pid: 3, sessionId: 'c', status: 'idle', statusUpdatedAt: NOW - 3600e3 });
  write(dir, '4.json', { ...base, pid: 4, sessionId: 'd', status: 'busy' }); // dead
  write(dir, '5.json', { ...base, pid: 5, sessionId: 'e', status: 'mystery' }); // unknown
  write(dir, '6.json', { ...base, pid: 6, sessionId: 'f', status: 'busy', kind: 'sdk' }); // not interactive
  write(dir, '7.json', '{broken');
  const s = claudeSessions({ dir, now: NOW, alive: (pid) => pid !== 4 });
  const by = Object.fromEntries(s.map((x) => [x.id, x]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['a', 'b', 'c']);
  assert.strictEqual(by.a.state, 'working');
  assert.strictEqual(by.a.label, 'A');
  assert.strictEqual(by.b.state, 'waiting');
  assert.strictEqual(by.b.label, 'proj');
  assert.strictEqual(by.c.state, 'done');
  assert.strictEqual(by.c.dim, true);
});

const ev = (type, payload, t = '2026-11-15T11:00:00Z') => JSON.stringify({ timestamp: t, type: 'event_msg', payload: { type, ...payload } });
const item = (type, payload) => JSON.stringify({ timestamp: '2026-11-15T11:00:01Z', type: 'response_item', payload: { type, ...payload } });

test('codex reduce: started -> running, complete -> done', () => {
  assert.strictEqual(codexReduce([ev('task_started')]).running, true);
  assert.strictEqual(codexReduce([ev('task_started'), ev('task_complete')]).running, false);
  assert.strictEqual(codexReduce([ev('task_started'), ev('turn_aborted')]).running, false);
  assert.strictEqual(codexReduce(['{partial', ev('task_started'), '{"trunc']).running, true);
});

test('codex reduce: open request_user_input or approval event means waiting', () => {
  const q = codexReduce([ev('task_started'), item('function_call', { call_id: 'x', name: 'request_user_input' })]);
  assert.strictEqual(q.waiting, true);
  const answered = codexReduce([ev('task_started'), item('function_call', { call_id: 'x', name: 'request_user_input' }), item('function_call_output', { call_id: 'x' })]);
  assert.strictEqual(answered.waiting, false);
  assert.strictEqual(codexReduce([ev('task_started'), ev('exec_approval_request')]).waiting, true);
  assert.strictEqual(codexReduce([ev('task_started'), ev('exec_approval_request'), ev('exec_command_end')]).waiting, false);
  assert.strictEqual(codexReduce([ev('task_complete'), ev('exec_approval_request')]).waiting, false);
});

test('codex files: running, stale running, hidden old done, subagent skipped', () => {
  const root = tmp();
  const d = new Date(NOW);
  const dir = path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  const meta = (id, extra = {}) => JSON.stringify({ timestamp: '2026-11-15T10:00:00Z', type: 'session_meta', payload: { id, cwd: 'C:\\w\\' + id, ...extra } });
  write(dir, 'rollout-a.jsonl', [meta('run'), ev('task_started')].join('\n') + '\n');
  write(dir, 'rollout-b.jsonl', [meta('stale'), ev('task_started')].join('\n') + '\n');
  write(dir, 'rollout-c.jsonl', [meta('done'), ev('task_started'), ev('task_complete', {}, '2026-11-15T11:50:00Z')].join('\n') + '\n');
  write(dir, 'rollout-d.jsonl', [meta('old'), ev('task_started'), ev('task_complete', {}, '2026-11-15T08:00:00Z')].join('\n') + '\n');
  write(dir, 'rollout-w.jsonl', [meta('wait'), ev('task_started'), item('function_call', { call_id: 'q', name: 'request_user_input' })].join('\n') + '\n');
  write(dir, 'rollout-e.jsonl', [meta('sub', { source: { subagent: { other: 'x' } } }), ev('task_started')].join('\n') + '\n');
  const set = (n, ageMin) => fs.utimesSync(path.join(dir, n), new Date(NOW - ageMin * 60000), new Date(NOW - ageMin * 60000));
  set('rollout-a.jsonl', 1); set('rollout-b.jsonl', 45); set('rollout-c.jsonl', 5); set('rollout-d.jsonl', 240); set('rollout-e.jsonl', 1); set('rollout-w.jsonl', 40);
  const by = Object.fromEntries(codexSessions({ root, now: NOW }).map((s) => [s.id, s]));
  assert.strictEqual(by.run.state, 'working');
  assert.strictEqual(by.stale.state, 'done');
  assert.strictEqual(by.wait.state, 'waiting');
  assert.strictEqual(by.done.state, 'done');
  assert.strictEqual(by.old, undefined);
  assert.strictEqual(by.sub, undefined);
  assert.strictEqual(by.run.label, 'run');
});

test('summarize: one row per agent, waiting > working > done, deduped', () => {
  const mk = (agent, id, state, since = 1) => ({ agent, id, label: id, state, since });
  const rows = summarize([mk('claude', 'a', 'done'), mk('claude', 'b', 'working'), mk('claude', 'b', 'working'), mk('claude', 'c', 'waiting'), mk('codex', 'x', 'done')]);
  assert.deepStrictEqual(rows.map((r) => [r.id, r.state, r.sessions.length]), [['claude', 'waiting', 3], ['codex', 'done', 1]]);
});

test('codex: row stays while the app is open even if every session is old', () => {
  const root = tmp();
  const d = new Date(NOW);
  const dir = path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  const meta = JSON.stringify({ timestamp: '2026-11-15T01:00:00Z', type: 'session_meta', payload: { id: 'old1', cwd: 'C:\\w\\proj' } });
  write(dir, 'rollout-o.jsonl', [meta, ev('task_started'), ev('task_complete', {}, '2026-11-15T02:00:00Z')].join('\n') + '\n');
  fs.utimesSync(path.join(dir, 'rollout-o.jsonl'), new Date(NOW - 5 * 3600e3), new Date(NOW - 5 * 3600e3));
  assert.strictEqual(codexSessions({ root, now: NOW }).length, 0);
  const shown = codexSessions({ root, now: NOW, open: true });
  assert.strictEqual(shown.length, 1);
  assert.strictEqual(shown[0].state, 'done');
  assert.strictEqual(shown[0].dim, true);
  const empty = codexSessions({ root: tmp(), now: NOW, open: true });
  assert.strictEqual(empty.length, 1);
  assert.strictEqual(empty[0].labelKey, 'open');
});

test('codex: a completed turn carries its last agent message, a restarted turn does not', () => {
  const done = codexReduce([ev('task_started'), ev('task_complete', { last_agent_message: 'Shipped it. **All** green.' })]);
  assert.strictEqual(done.message, 'Shipped it. All green.');
  assert.strictEqual(codexReduce([ev('task_started'), ev('task_complete', {}), ev('task_started')]).message, null);
  assert.strictEqual(codexReduce([ev('task_started'), ev('turn_aborted')]).message, null);
});

test('claude: a dismissed (or already opened) question no longer makes the session wait', () => {
  const dir = tmp();
  write(dir, '1.json', { kind: 'interactive', pid: 1, sessionId: 'q', status: 'idle', cwd: 'C:/x/p', statusUpdatedAt: NOW - 60000, hostSessionId: 'local_q' });
  const ask = { id: 'ask1', kind: 'next_step', question: 'Ship?', recap: 'ok', options: [], at: NOW - 30000 };
  const asks = () => ask;
  assert.strictEqual(claudeSessions({ dir, now: NOW, alive: () => true, asks })[0].state, 'waiting');
  const skipped = claudeSessions({ dir, now: NOW, alive: () => true, asks, skipAsk: (sid, a) => sid === 'q' && a.id === 'ask1' })[0];
  assert.strictEqual(skipped.state, 'done');
  assert.strictEqual(skipped.ask, undefined);
  assert.strictEqual(skipped.since, NOW - 60000); // not moved forward by the question
  assert.strictEqual(claudeSessions({ dir, now: NOW, alive: () => true, asks, skipAsk: () => false })[0].state, 'waiting');
});
