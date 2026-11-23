'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scan, emptyIndex, summary, claudeUsage, codexUsage, load, save } = require('../usage');
const { DEFAULTS, makePrice } = require('../prices');

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dock-usage-'));
const write = (file, lines, append = false) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  (append ? fs.appendFileSync : fs.writeFileSync)(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
};
const T = '2026-11-20T10:00:00.000Z';

const claudeLine = (id, usage, extra = {}) => ({ type: 'assistant', timestamp: T, sessionId: 's1', cwd: 'C:\\proj\\site', message: { id, model: 'claude-sonnet-5-5', role: 'assistant', usage }, ...extra });

test('claudeUsage: counters, 1-hour cache write, synthetic model ignored', () => {
  const u = claudeUsage(claudeLine('m1', { input_tokens: 2, output_tokens: 79, cache_read_input_tokens: 54558, cache_creation_input_tokens: 33602, cache_creation: { ephemeral_1h_input_tokens: 33602, ephemeral_5m_input_tokens: 0 } }));
  assert.deepStrictEqual(u.u, { i: 2, o: 79, cr: 54558, cw: 33602, cw1: 33602 });
  assert.strictEqual(u.ctx, 2 + 54558 + 33602);
  assert.strictEqual(claudeUsage({ message: { model: '<synthetic>', usage: { input_tokens: 1 } } }), null);
});

test('codexUsage: cached input is part of input, reasoning part of output', () => {
  const r = codexUsage({ input_tokens: 26744, cached_input_tokens: 14848, cache_write_input_tokens: 0, output_tokens: 532, reasoning_output_tokens: 229, total_tokens: 27276 });
  assert.deepStrictEqual(r.u, { i: 11896, o: 532, cr: 14848, cw: 0, cw1: 0 });
  assert.strictEqual(r.u.i + r.u.cr + r.u.o, 27276);
});

test('scan Claude: the same message id on several lines counts once, sub-agent files included', () => {
  const h = home();
  const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 };
  write(path.join(h, '.claude', 'projects', 'p1', 's1.jsonl'), [claudeLine('m1', usage), claudeLine('m1', usage), claudeLine('m2', usage)]);
  write(path.join(h, '.claude', 'projects', 'p1', 's1', 'subagents', 'agent-x.jsonl'), [claudeLine('m3', usage, { isSidechain: true })]);
  const idx = emptyIndex();
  scan(idx, { home: h });
  const s = summary(idx, {});
  assert.strictEqual(s.totals.n, 3);
  assert.strictEqual(s.totals.i, 30);
  assert.strictEqual(s.sessions.length, 1);
  assert.strictEqual(s.sessions[0].sub, 130); // the sub-agent's call
  assert.strictEqual(s.sessions[0].p, 'C:\\proj\\site');
});

test('session titles come from custom-title lines (Claude) and session_meta (Codex); sessionCount is not capped by the list limit', () => {
  const h = home();
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  write(path.join(h, '.claude', 'projects', 'p1', 's1.jsonl'), [claudeLine('m1', usage), { type: 'custom-title', customTitle: 'Fix the login bug', sessionId: 's1' }]);
  write(path.join(h, '.codex', 'sessions', '2026', '11', '20', 'rollout-t.jsonl'), [{ timestamp: T, type: 'session_meta', payload: { id: 'cx9', cwd: 'C:\\w', thread_name: 'Rotate certs' } }, { timestamp: T, type: 'turn_context', payload: { model: 'gpt-x' } }, { timestamp: T, type: 'token_usage_record', payload: { response_id: 'r', usage: cu(10, 0, 5) } }]);
  const idx = emptyIndex();
  scan(idx, { home: h });
  const s = summary(idx, { limit: 1 });
  assert.strictEqual(s.sessionCount, 2);
  assert.strictEqual(s.sessions.length, 1);
  const all = summary(idx, {});
  assert.deepStrictEqual(all.sessions.map((x) => x.title).sort(), ['Fix the login bug', 'Rotate certs']);
});

test('scan is incremental: a half-written last line waits, appended lines are added once', () => {
  const h = home();
  const f = path.join(h, '.claude', 'projects', 'p1', 's1.jsonl');
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  write(f, [claudeLine('m1', usage)]);
  fs.appendFileSync(f, JSON.stringify(claudeLine('m2', usage)).slice(0, 40)); // no newline yet
  const idx = emptyIndex();
  scan(idx, { home: h });
  assert.strictEqual(summary(idx, {}).totals.n, 1);
  fs.appendFileSync(f, JSON.stringify(claudeLine('m2', usage)).slice(40) + '\n');
  scan(idx, { home: h });
  assert.strictEqual(summary(idx, {}).totals.n, 2);
  scan(idx, { home: h }); // nothing new
  assert.strictEqual(summary(idx, {}).totals.n, 2);
});

test('scan: a transcript that shrank rebuilds the index instead of double counting', () => {
  const h = home();
  const f = path.join(h, '.claude', 'projects', 'p1', 's1.jsonl');
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  write(f, [claudeLine('m1', usage), claudeLine('m2', usage)]);
  const idx = emptyIndex();
  scan(idx, { home: h });
  write(f, [claudeLine('m9', usage)]);
  const r = scan(idx, { home: h });
  assert.strictEqual(r.rebuilt, true);
  assert.strictEqual(summary(idx, {}).totals.n, 1);
});

const codexMeta = [
  { timestamp: T, type: 'session_meta', payload: { id: 'cx1', cwd: 'C:\\work' } },
  { timestamp: T, type: 'turn_context', payload: { model: 'gpt-6.2-astra', cwd: 'C:\\work' } },
];
const cu = (input, cached, out) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: out, reasoning_output_tokens: 0, total_tokens: input + out });

test('scan Codex (newer): token_usage_record counts once even though token_count repeats it', () => {
  const h = home();
  const f = path.join(h, '.codex', 'sessions', '2026', '11', '20', 'rollout-a.jsonl');
  write(f, [
    ...codexMeta,
    { timestamp: T, type: 'token_usage_record', payload: { response_id: 'r1', usage: cu(1000, 400, 50) } },
    { timestamp: T, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: cu(1000, 400, 50), last_token_usage: cu(1000, 400, 50) } } },
  ]);
  const idx = emptyIndex();
  scan(idx, { home: h });
  const s = summary(idx, {});
  assert.strictEqual(s.totals.i, 600);
  assert.strictEqual(s.totals.cr, 400);
  assert.strictEqual(s.totals.o, 50);
  assert.strictEqual(s.byModel['gpt-6.2-astra'].n, 1);
  assert.strictEqual(s.sessions[0].id, 'cx1');
});

test('scan Codex (older): token_count uses the per-call value and skips a repeated event', () => {
  const h = home();
  const f = path.join(h, '.codex', 'sessions', '2026', '11', '20', 'rollout-b.jsonl');
  const ev = (total, last) => ({ timestamp: T, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } });
  write(f, [...codexMeta, ev(cu(100, 0, 10), cu(100, 0, 10)), ev(cu(100, 0, 10), cu(100, 0, 10)), ev(cu(250, 0, 30), cu(150, 0, 20)), { timestamp: T, type: 'event_msg', payload: { type: 'token_count', info: null } }]);
  const idx = emptyIndex();
  scan(idx, { home: h });
  const s = summary(idx, {});
  assert.strictEqual(s.totals.i, 250);
  assert.strictEqual(s.totals.o, 30);
});

test('summary: unpriced models are reported, never counted as free; day range filters', () => {
  const idx = emptyIndex();
  const rec = require('../usage').record;
  rec(idx, { agent: 'claude', sessionId: 'a', project: 'p', model: 'priced', at: Date.parse('2026-11-19T12:00:00'), u: { i: 1000000, o: 0, cr: 0, cw: 0, cw1: 0 } });
  rec(idx, { agent: 'claude', sessionId: 'a', project: 'p', model: 'mystery', at: Date.parse('2026-11-20T12:00:00'), u: { i: 5, o: 5, cr: 0, cw: 0, cw1: 0 } });
  const price = (a, m, b) => (m === 'priced' ? (b.i / 1e6) * 3 : null);
  const all = summary(idx, { price });
  assert.strictEqual(all.totals.cost, 3);
  assert.deepStrictEqual(all.totals.unpriced, ['mystery']);
  assert.strictEqual(all.sessions[0].cost, null); // mixed: not a total for that session
  const one = summary(idx, { price, from: '2026-11-20', to: '2026-11-20' });
  assert.strictEqual(one.totals.tokens, 10);
});

test('save and load round trip; a different version starts empty', () => {
  const h = home();
  const f = path.join(h, 'idx.json');
  const idx = emptyIndex();
  idx.seen = ['abc'];
  save(f, idx);
  assert.deepStrictEqual(load(f).seen, ['abc']);
  fs.writeFileSync(f, JSON.stringify({ version: 99, files: {}, days: {}, sessions: {} }));
  assert.deepStrictEqual(load(f).seen, []);
});

// ---- Grok and OpenCode
test('scan Grok: turn_completed usage per model (cached part inside input) and the reported cost', () => {
  const h = home();
  const dir = path.join(h, '.grok', 'sessions', 'C%3A%5Cw', 'g1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ info: { id: 'g1', cwd: 'C:\w' }, session_summary: 'Fix the bug' }));
  const model = { inputTokens: 18474, outputTokens: 1922, cachedReadTokens: 1664, cacheCreationTokens: 0, reasoningTokens: 1846, totalTokens: 20396, modelCalls: 1, costUsdTicks: 459840000 };
  write(path.join(dir, 'updates.jsonl'), [
    { timestamp: 1793684387, method: 'x', params: { sessionId: 'g1', update: { sessionUpdate: 'hook_execution' } } },
    { timestamp: 1793684489, method: 'x', params: { sessionId: 'g1', update: { sessionUpdate: 'turn_completed', usage: { ...model, modelUsage: { 'grok-4.7-build': model } } }, _meta: { agentTimestampMs: 1793684489098 } } },
  ]);
  const idx = emptyIndex();
  scan(idx, { home: h });
  const s = summary(idx, {});
  assert.strictEqual(s.totals.i, 18474 - 1664);
  assert.strictEqual(s.totals.cr, 1664);
  assert.strictEqual(s.totals.o, 1922);
  assert.strictEqual(s.byModel['grok-4.7-build'].n, 1);
  assert.deepStrictEqual(s.totals.unpriced, []); // not in the price table, but Grok reported what the call cost
  assert.ok(Math.abs(s.totals.cost - 0.045984) < 1e-9);
  assert.strictEqual(s.sessions[0].title, 'Fix the bug');
  assert.strictEqual(s.sessions[0].p, 'C:\w');
});

// a fake better-sqlite3: prepare(sql).all(...) answers from tables
const fakeDb = (sessions, messages) => ({
  prepare: (sql) => ({
    all: (since) => (sql.includes('from session_v2') ? sessions : messages.filter((m) => m.time_updated > since)),
  }),
  close() {},
});
const ocRow = (id, sid, upd, done, model, cost, t) => ({ id, session_id: sid, time_updated: upd, done, model, cost, ti: t.i, tout: t.o, tr: t.r || 0, tcr: t.cr || 0, tcw: t.cw || 0 });

test('scan OpenCode: finished assistant rows only, counted once, reasoning billed as output, reported cost kept', () => {
  const h = home();
  const dbFile = path.join(h, '.local', 'share', 'opencode', 'opencode.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  fs.writeFileSync(dbFile, '');
  const sessions = [{ id: 's1', title: 'Gmail helper', directory: 'C:/w/gmail' }];
  const messages = [
    ocRow('m1', 's1', 1000, 1000, 'qwen3-coder', 0, { i: 100, o: 10, cr: 500 }),
    ocRow('m2', 's1', 2000, null, 'qwen3-coder', 0, { i: 999, o: 99 }), // still streaming: not counted yet
    ocRow('m3', 's1', 3000, 3000, 'claude-opus-4-6', 0.5, { i: 7, o: 20, r: 5, cr: 1000, cw: 40 }),
  ];
  const idx = emptyIndex();
  scan(idx, { home: h, openDb: () => fakeDb(sessions, messages) });
  let s = summary(idx, { price: makePrice(DEFAULTS) });
  assert.strictEqual(s.totals.n, 2);
  assert.strictEqual(s.byModel['claude-opus-4-6'].o, 25); // output + reasoning
  assert.strictEqual(s.byModel['claude-opus-4-6'].cw, 40);
  assert.deepStrictEqual(s.totals.unpriced, []); // qwen: not priced, but OpenCode reported 0, which is a real answer
  assert.strictEqual(s.sessions[0].title, 'Gmail helper');
  assert.strictEqual(s.sessions[0].p, 'C:/w/gmail');
  // the streaming row finishes; the others are not counted again
  messages[1] = ocRow('m2', 's1', 4000, 4000, 'qwen3-coder', 0, { i: 999, o: 99 });
  scan(idx, { home: h, openDb: () => fakeDb(sessions, messages) });
  s = summary(idx, { price: makePrice(DEFAULTS) });
  assert.strictEqual(s.totals.n, 3);
  assert.strictEqual(s.byModel['qwen3-coder'].i, 1099);
});

test('OpenCode without the sqlite driver is left out, the rest still works', () => {
  const h = home();
  const dbFile = path.join(h, '.local', 'share', 'opencode', 'opencode.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  fs.writeFileSync(dbFile, '');
  const usage1 = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  write(path.join(h, '.claude', 'projects', 'p1', 's1.jsonl'), [claudeLine('m1', usage1)]);
  const idx = emptyIndex();
  scan(idx, { home: h, openDb: () => null });
  assert.strictEqual(summary(idx, {}).totals.n, 1);
});

test('summary: per agent x model and agent x project totals, unpriced calls counted per group, agent cost per day', () => {
  const idx = emptyIndex();
  const rec = require('../usage').record;
  const at = Date.parse('2026-11-20T12:00:00');
  rec(idx, { agent: 'claude', sessionId: 'a', project: 'p1', model: 'priced', at, u: { i: 1e6, o: 0, cr: 0, cw: 0, cw1: 0 } });
  rec(idx, { agent: 'codex', sessionId: 'b', project: 'p2', model: 'mystery', at, u: { i: 10, o: 10, cr: 0, cw: 0, cw1: 0 } });
  const price = (a, m, b) => (m === 'priced' ? (b.i / 1e6) * 3 : null);
  const s = summary(idx, { price });
  assert.strictEqual(s.byAM['claude|priced'].cost, 3);
  assert.strictEqual(s.byAM['codex|mystery'].unp, 1);
  assert.strictEqual(s.byAP['codex|p2'].n, 1);
  assert.strictEqual(s.byDay['2026-11-20'].agentCost.claude, 3);
  assert.strictEqual(s.byDay['2026-11-20'].agentCost.codex, undefined);
});

// ---- Kilo / MiMo (SQLite `message` layout), Gemini CLI, Qwen Code: written from the projects' source, tested on fixtures
test('scan Kilo: v1 `message` rows with data.role assistant, modelID, disjoint token buckets', () => {
  const h = home();
  const dbFile = path.join(h, '.local', 'share', 'kilo', 'kilo.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  fs.writeFileSync(dbFile, '');
  const calls = [];
  const db = {
    prepare: (sql) => ({
      all: (since) => {
        calls.push(sql.includes('from message') ? 'message' : sql.includes('from session ') || sql.endsWith('from session') ? 'session' : 'other');
        if (sql.includes('from session')) return [{ id: 'k1', title: 'Kilo task', directory: 'C:/w/kilo' }];
        return [{ id: 'm1', session_id: 'k1', time_updated: 5000, done: 5000, model: 'claude-sonnet-5-5', cost: 0.2, ti: 10, tout: 20, tr: 5, tcr: 100, tcw: 3 }].filter((r) => r.time_updated > since);
      },
    }),
    close() {},
  };
  const idx = emptyIndex();
  scan(idx, { home: h, openDb: () => db });
  const s = summary(idx, { price: makePrice(DEFAULTS) });
  assert.strictEqual(s.byAgent.kilo.n, 1);
  assert.strictEqual(s.byAM['kilo|claude-sonnet-5-5'].o, 25);
  assert.strictEqual(s.sessions[0].title, 'Kilo task');
  assert.ok(calls.includes('message'));
});

test('scan Gemini CLI: gemini messages with tokens; cached is inside input, thoughts are billed as output, a repeated id counts once', () => {
  const h = home();
  const f = path.join(h, '.gemini', 'tmp', 'proj-slug', 'chats', 'session-2026-11-20T10-00-abc.jsonl');
  const msg = (id, tokens) => ({ id, timestamp: '2026-11-20T10:00:00.000Z', type: 'gemini', model: 'gemini-3-pro', content: 'x', tokens });
  write(f, [
    { type: 'user', id: 'u1', content: 'hi' },
    msg('g1', { input: 1000, output: 50, cached: 400, thoughts: 30, tool: 20, total: 1100 }),
    msg('g1', { input: 1000, output: 50, cached: 400, thoughts: 30, tool: 20, total: 1100 }),
  ]);
  const idx = emptyIndex();
  scan(idx, { home: h });
  const s = summary(idx, {});
  assert.strictEqual(s.byAgent.gemini.n, 1);
  assert.strictEqual(s.totals.cr, 400);
  assert.strictEqual(s.totals.i, 1000 - 400 + 20);
  assert.strictEqual(s.totals.o, 80);
  assert.strictEqual(s.sessions[0].p, 'proj-slug');
});

test('scan Qwen Code: assistant usageMetadata, prompt includes cached, candidates include thoughts', () => {
  const h = home();
  const f = path.join(h, '.qwen', 'projects', 'c--w-app', 'chats', 'sess1.jsonl');
  write(f, [
    { type: 'user', uuid: 'u', message: 'x' },
    { type: 'assistant', uuid: 'a1', sessionId: 'sess1', cwd: 'C:\w\app', model: 'qwen3-coder-plus', timestamp: '2026-11-20T10:00:00.000Z', usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 300, thoughtsTokenCount: 100, cachedContentTokenCount: 1500, totalTokenCount: 2300 } },
  ]);
  const idx = emptyIndex();
  scan(idx, { home: h });
  const s = summary(idx, {});
  assert.strictEqual(s.totals.i, 500);
  assert.strictEqual(s.totals.cr, 1500);
  assert.strictEqual(s.totals.o, 300);
  assert.strictEqual(s.sessions[0].p, 'C:\w\app');
});

test('scan Pi / Oh My Pi: assistant message usage and standalone usage entries, with their own cost', () => {
  const h = home();
  const f = path.join(h, '.pi', 'agent', 'sessions', '--C--w--', '2026-11-20T10-00-00_s1.jsonl');
  write(f, [
    { type: 'session', id: 's1' },
    { type: 'message', timestamp: '2026-11-20T10:00:00.000Z', message: { role: 'user', content: 'hi' } },
    { type: 'message', timestamp: '2026-11-20T10:00:05.000Z', message: { role: 'assistant', provider: 'anthropic', model: 'claude-sonnet-5-5', timestamp: 1795200005000, usage: { input: 100, output: 40, cacheRead: 900, cacheWrite: 50, totalTokens: 1090, cost: { total: 0.012 } } } },
    { type: 'usage', kind: 'compaction', model: 'claude-haiku-5-5', timestamp: '2026-11-20T10:01:00.000Z', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } },
  ]);
  const idx = emptyIndex();
  scan(idx, { home: h });
  const s = summary(idx, { price: () => null });
  assert.strictEqual(s.byAgent.pi.n, 2);
  assert.strictEqual(s.totals.cr, 900);
  assert.strictEqual(s.totals.o, 45);
  assert.ok(Math.abs(s.totals.cost - 0.013) < 1e-9); // the agent's own cost, since the price function knows no model
});

test('scan Kimi CLI: StatusUpdate token_usage (disjoint buckets), counted once per message id', () => {
  const h = home();
  const f = path.join(h, '.kimi', 'sessions', 'abc123hash', 'sess-9', 'wire.jsonl');
  const upd = (id) => ({ timestamp: 1795200000.5, message: { type: 'StatusUpdate', payload: { message_id: id, token_usage: { input_other: 120, output: 30, input_cache_read: 800, input_cache_creation: 10 } } } });
  write(f, [{ type: 'metadata', protocol_version: '1' }, upd('m1'), upd('m1'), upd('m2')]);
  const idx = emptyIndex();
  scan(idx, { home: h });
  const s = summary(idx, {});
  assert.strictEqual(s.byAgent.kimi.n, 2);
  assert.strictEqual(s.totals.i, 240);
  assert.strictEqual(s.totals.cr, 1600);
});

test('record ignores a row without a usable time and keeps "|" out of group keys', () => {
  const idx = emptyIndex();
  const rec = require('../usage').record;
  rec(idx, { agent: 'x', sessionId: 'a', project: 'p|q', model: 'm|n', at: NaN, u: { i: 1, o: 1, cr: 0, cw: 0, cw1: 0 } });
  assert.strictEqual(summary(idx, {}).totals.n, 0);
  rec(idx, { agent: 'x', sessionId: 'a', project: 'p|q', model: 'm|n', at: Date.parse('2026-11-20T12:00:00'), u: { i: 1, o: 1, cr: 0, cw: 0, cw1: 0 } });
  const s = summary(idx, {});
  assert.deepStrictEqual(Object.keys(s.byAM), ['x|m/n']);
  assert.deepStrictEqual(Object.keys(s.byAP), ['x|p/q']);
});
