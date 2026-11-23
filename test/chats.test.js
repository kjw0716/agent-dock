'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { ChatIndex, readMessages, options, choose, claudeMessages, codexMessages } = require('../chats');
const { TaskRunner, localDir } = require('../tasks');
const { PhoneHost } = require('../phone-host');

const tmp = (p = 'dock-chat-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const jl = (a) => a.map((o) => JSON.stringify(o)).join('\n') + '\n';
const ID = 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb';
const CX = '01a206a6-818a-73f1-964d-1a594bed4eb9';

// a fake home with one Claude and one Codex conversation
function home({ cwd = tmp('dock-cwd-') } = {}) {
  const h = tmp();
  const cdir = path.join(h, '.claude', 'projects', 'proj');
  fs.mkdirSync(cdir, { recursive: true });
  fs.writeFileSync(path.join(cdir, ID + '.jsonl'), jl([
    { type: 'attachment', cwd },
    { type: 'user', cwd, timestamp: '2026-11-22T10:00:00Z', message: { role: 'user', content: 'Fix the login bug' } },
    { type: 'user', cwd, message: { role: 'user', content: '<system-reminder>hidden</system-reminder>' } },
    { type: 'assistant', cwd, timestamp: '2026-11-22T10:00:05Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'Looking at it' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }] } },
    { type: 'user', cwd, message: { role: 'user', content: [{ type: 'tool_result', content: 'file1\nfile2' }] } },
    { type: 'assistant', cwd, isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'sub agent noise' }] } },
    { type: 'assistant', cwd, message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed.' }] } },
  ]));
  fs.mkdirSync(path.join(cdir, ID, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(cdir, ID, 'subagents', 'agent-x.jsonl'), jl([{ type: 'user', cwd, message: { role: 'user', content: 'sub' } }]));
  const xdir = path.join(h, '.codex', 'sessions', '2026', '11', '22');
  fs.mkdirSync(xdir, { recursive: true });
  fs.writeFileSync(path.join(xdir, `rollout-2026-11-22T10-00-00-${CX}.jsonl`), jl([
    { type: 'session_meta', payload: { id: CX, cwd } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'secret instructions' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\nstuff' }] } },
    { type: 'response_item', timestamp: '2026-11-22T10:01:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Rotate the certs' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['pwsh', '-c', 'dir'] }) } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } },
  ]));
  fs.mkdirSync(path.join(h, '.claude', 'sessions'), { recursive: true });
  return { h, cwd };
}

test('Claude transcript: your messages, replies and one-line tool calls; reminders, thinking, tool results and sidechains are left out', () => {
  const { h } = home();
  const e = new ChatIndex({ home: h }).list().find((c) => c.agent === 'claude');
  const r = readMessages(e.file, 'claude');
  assert.deepStrictEqual(r.messages.map((m) => [m.role, m.text]), [['user', 'Fix the login bug'], ['assistant', 'Looking at it'], ['tool', 'Bash · ls -la'], ['assistant', 'Fixed.']]);
  assert.strictEqual(r.more, false);
});

test('Codex transcript: developer and AGENTS.md blocks are left out; the shell call is one line', () => {
  const { h } = home();
  const e = new ChatIndex({ home: h }).list().find((c) => c.agent === 'codex');
  const r = readMessages(e.file, 'codex');
  assert.deepStrictEqual(r.messages.map((m) => [m.role, m.text]), [['user', 'Rotate the certs'], ['tool', 'shell · pwsh -c dir'], ['assistant', 'Done.']]);
});

test('index: both agents, no subagent transcripts, titles from the first message, cwd from the record; keys resolve only through the index', () => {
  const { h, cwd } = home();
  const ix = new ChatIndex({ home: h });
  const l = ix.list();
  assert.deepStrictEqual(l.map((c) => c.key).sort(), [`claude:${ID}`, `codex:${CX}`].sort());
  assert.strictEqual(l.find((c) => c.agent === 'claude').title, 'Fix the login bug');
  assert.strictEqual(l.find((c) => c.agent === 'claude').cwd, cwd);
  assert.ok(ix.find(`claude:${ID}`));
  for (const bad of ['claude:../../etc/passwd', 'claude:' + ID + '/../x', 'x:' + ID, `claude:${ID}\n`, 42, null, 'claude:short']) assert.strictEqual(ix.find(bad), null);
  assert.strictEqual(ix.find('claude:00000000-0000-4000-8000-000000000000'), null); // well formed but unknown
});

test('reading from the end: only the newest messages come back, with "more" set, and a half-written last line is ignored', () => {
  const dir = tmp();
  const f = path.join(dir, 'big.jsonl');
  const lines = [];
  for (let i = 0; i < 500; i++) lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: 'message ' + i + ' ' + 'x'.repeat(2000) } }));
  fs.writeFileSync(f, lines.join('\n') + '\n{"type":"user","message":{"role":"user","content":"half writ');
  const r = readMessages(f, 'claude', { limit: 5 });
  assert.strictEqual(r.messages.length, 5);
  assert.ok(r.messages[4].text.startsWith('message 499 '));
  assert.strictEqual(r.more, true);
});

test('long text is cut, and tool lines stay short', () => {
  const m = claudeMessages([{ type: 'user', message: { content: 'a'.repeat(9000) } }, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'b'.repeat(500) } }] } }]);
  assert.ok(m[0].text.length <= 6001);
  assert.ok(m[1].text.length <= 161);
  assert.deepStrictEqual(codexMessages([{ type: 'turn_context' }, null]), []);
});

test('model and effort come from the computer\'s lists only', () => {
  const h = tmp();
  fs.mkdirSync(path.join(h, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(h, '.codex', 'config.toml'), 'model = "m-one"\n');
  fs.writeFileSync(path.join(h, '.codex', 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'm-one', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], default_reasoning_level: 'low' },
    { slug: 'm-two', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }] },
    { slug: 'hidden', visibility: 'hide', supported_reasoning_levels: [{ effort: 'low' }] },
    { slug: 'bad name;rm', visibility: 'list', supported_reasoning_levels: [] },
  ] }));
  const o = options({ home: h });
  assert.deepStrictEqual(o.codex.models.map((m) => m.id), ['m-one', 'm-two']);
  assert.strictEqual(o.codex.default, 'm-one');
  assert.deepStrictEqual(choose(o, 'claude', 'opus', 'max'), { model: 'opus', effort: 'max' });
  assert.deepStrictEqual(choose(o, 'claude', '', ''), { model: '', effort: '' });
  assert.strictEqual(choose(o, 'claude', 'opus; calc', ''), null);
  assert.strictEqual(choose(o, 'claude', 'gpt-6', ''), null);
  assert.strictEqual(choose(o, 'claude', 'opus', '"; rm'), null);
  assert.deepStrictEqual(choose(o, 'codex', 'm-two', 'ultra'), { model: 'm-two', effort: 'ultra' });
  assert.strictEqual(choose(o, 'codex', 'm-one', 'ultra'), null); // per model
  assert.strictEqual(choose(o, 'codex', '', 'ultra'), null); // the default model does not offer it
  assert.strictEqual(choose(o, 'codex', 'hidden', ''), null);
  assert.strictEqual(choose(o, 'codex', { a: 1 }, ''), null);
  assert.strictEqual(choose(o, 'codex', 'm-one', 5), null);
});

test('live: a recent change or a live Claude process with this id; the dock\'s own finished turn does not count', () => {
  const { h } = home();
  const e = new ChatIndex({ home: h, now: () => Date.now() }).list().find((c) => c.agent === 'claude');
  let ix = new ChatIndex({ home: h, now: () => Date.now() + 60 * 60 * 1000 }); // an hour later: nothing recent
  assert.strictEqual(ix.live(e, { alive: () => true }), false);
  fs.writeFileSync(path.join(h, '.claude', 'sessions', '1.json'), JSON.stringify({ sessionId: ID, pid: 4242 }));
  assert.strictEqual(ix.live(e, { alive: (p) => p === 4242 }), true);
  assert.strictEqual(ix.live(e, { alive: () => false }), false);
  ix = new ChatIndex({ home: h });
  assert.strictEqual(ix.live(e, { alive: () => false }), true); // just written
  assert.strictEqual(ix.live(e, { alive: () => false, ownEnd: fs.statSync(e.file).mtimeMs }), false); // written by the dock itself
});

// ---------------------------------------------------------------- runner
function fakeSpawn() {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.pid = 1;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { written: '', end(t) { this.written = t; } });
    calls.push({ cmd, args, opts, child });
    return child;
  };
  return { spawn, calls };
}
const runner = (dir, mode = 'edits', over = {}) => {
  const f = fakeSpawn();
  return { f, r: new TaskRunner({ mode: () => mode, dirs: () => [dir], spawn: f.spawn, claude: () => 'claude.exe', codex: () => 'codex.js', kill: () => {}, ...over }) };
};

test('resume (Claude): --resume with the session, model and effort flags, the prompt on stdin, cwd from the index', () => {
  const dir = tmp();
  const { f, r } = runner(dir, 'full');
  const res = r.resume({ agent: 'claude', session: ID, cwd: dir, prompt: 'continue', model: 'opus', effort: 'high' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.session, ID);
  const c = f.calls[0];
  assert.deepStrictEqual(c.args, ['-p', '--output-format', 'stream-json', '--verbose', '--resume', ID, '--model', 'opus', '--effort', 'high', '--dangerously-skip-permissions']);
  assert.strictEqual(c.child.stdin.written, 'continue');
  assert.strictEqual(c.opts.cwd.toLowerCase(), fs.realpathSync.native(dir).toLowerCase());
  assert.strictEqual(r.resume({ agent: 'claude', session: ID, cwd: dir, prompt: 'again' }).error, 'busy'); // one running turn per conversation
});

test('resume as a copy: a new session id is chosen up front and returned', () => {
  const dir = tmp();
  const { f, r } = runner(dir, 'full');
  const res = r.resume({ agent: 'claude', session: ID, cwd: dir, prompt: 'x', fork: true });
  assert.notStrictEqual(res.session, ID);
  const a = f.calls[0].args;
  assert.deepStrictEqual(a.slice(4, 8), ['--resume', ID, '--fork-session', '--session-id']);
  assert.strictEqual(a[8], res.session);
  assert.strictEqual(r.list()[0].from, ID);
});

test('resume (Codex): exec resume with the sandbox as a config value, session before the stdin marker; full mode bypasses', () => {
  const dir = tmp();
  const ro = runner(dir);
  ro.r.resume({ agent: 'codex', session: CX, cwd: dir, prompt: 'x', model: 'm-one', effort: 'low' });
  const a = ro.f.calls[0].args;
  assert.deepStrictEqual(a.slice(0, 3), ['codex.js', 'exec', 'resume']);
  assert.ok(a.includes('sandbox_mode="read-only"') && a.includes('model_reasoning_effort="low"'));
  assert.deepStrictEqual(a.slice(-2), [CX, '-']);
  assert.ok(!a.includes('-C'));
  const full = runner(dir, 'full');
  full.r.resume({ agent: 'codex', session: CX, cwd: dir, prompt: 'x' });
  assert.ok(full.f.calls[0].args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('resume: session ids are checked, the working directory must be local and real, and without full permissions it must be an allowed folder', () => {
  const dir = tmp();
  const other = tmp();
  const { f, r } = runner(dir);
  assert.strictEqual(r.resume({ agent: 'claude', session: '../x', cwd: dir, prompt: 'x' }).error, 'session');
  assert.strictEqual(r.resume({ agent: 'claude', session: ID + ' --x', cwd: dir, prompt: 'x' }).error, 'session');
  assert.strictEqual(r.resume({ agent: 'claude', session: ID, cwd: '\\\\evil\\share', prompt: 'x' }).error, 'folder');
  assert.strictEqual(r.resume({ agent: 'claude', session: ID, cwd: 'relative', prompt: 'x' }).error, 'folder');
  assert.strictEqual(r.resume({ agent: 'claude', session: ID, cwd: path.join(dir, 'missing'), prompt: 'x' }).error, 'folder');
  assert.strictEqual(r.resume({ agent: 'claude', session: ID, cwd: other, prompt: 'x' }).error, 'outside');
  fs.mkdirSync(path.join(dir, 'sub'));
  assert.strictEqual(r.resume({ agent: 'claude', session: ID, cwd: path.join(dir, 'sub'), prompt: 'x' }).ok, true); // inside an allowed folder
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(runner(dir, 'full').r.resume({ agent: 'claude', session: ID, cwd: other, prompt: 'x' }).ok, true);
  assert.strictEqual(localDir('\\\\?\\UNC\\host\\share'), null);
});

test('model and effort are checked once more at launch (word characters only)', () => {
  const dir = tmp();
  const { r } = runner(dir, 'full');
  assert.strictEqual(r.resume({ agent: 'claude', session: ID, cwd: dir, prompt: 'x', model: 'opus --x' }).error, 'model');
  assert.strictEqual(r.resume({ agent: 'codex', session: CX, cwd: dir, prompt: 'x', effort: 'high"; x' }).error, 'model');
});

test('a new Codex conversation learns its id from the thread.started event', () => {
  const dir = tmp();
  const { f, r } = runner(dir);
  const res = r.start({ agent: 'codex', dir, prompt: 'x' });
  assert.strictEqual(res.session, '');
  f.calls[0].child.stdout.emit('data', JSON.stringify({ type: 'thread.started', thread_id: CX }) + '\n');
  assert.strictEqual(r.list()[0].session, CX);
});

// ------------------------------------------------------------- phone host
function host(cfg, extra = {}) {
  const dir = tmp('dock-host-');
  const cwd = tmp('dock-cwd-');
  const { h } = home({ cwd });
  const config = { phone: { enabled: true, port: 0, tasks: true, dirs: [cwd], ...cfg } };
  const f = fakeSpawn();
  const ph = new PhoneHost({
    dataDir: dir, readConfig: () => config, patchConfig: (p) => Object.assign(config, p), rows: () => [], answer: () => ({ ok: true }), dismiss: () => ({ ok: true }),
    assetsDir: dir, iconFile: dir, qr: () => '', lang: () => 'en', run: async () => ({ code: 1, error: 'ENOENT', stdout: '', stderr: '' }), dev: true,
    chatIndex: new ChatIndex({ home: h }), chatOptions: () => options({ home: h }),
    taskOpts: { spawn: f.spawn, claude: () => 'claude.exe', codex: () => 'codex.js', kill: () => {} }, ...extra,
  });
  return { ph, f, cwd, h, config };
}

test('chats are refused while the switch is off; reading returns the transcript and the running state', () => {
  const off = host({ tasks: false });
  assert.strictEqual(off.ph.chatList().error, 'disabled');
  assert.strictEqual(off.ph.chatRead({ key: `claude:${ID}` }).error, 'disabled');
  assert.strictEqual(off.ph.task({ op: 'send', key: `claude:${ID}`, agent: 'claude', prompt: 'x' }).error, 'disabled');
  const on = host({});
  const list = on.ph.chatList();
  assert.strictEqual(list.ok, true);
  assert.strictEqual(list.chats.length, 2);
  const r = on.ph.chatRead({ key: `claude:${ID}`, limit: 40 });
  assert.strictEqual(r.messages.length, 4);
  assert.strictEqual(r.running, false);
  assert.strictEqual(on.ph.chatRead({ key: 'claude:../../x' }).error, 'not found');
});

test('send: continues the conversation from the index (never a path or folder from the phone), values must be on the lists', () => {
  const { ph, f, cwd } = host({ tasksFull: true });
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(ph.index.find(`claude:${ID}`).file, old, old); // not touched lately: nothing else is writing it
  const bad =ph.task({ op: 'send', key: `claude:${ID}`, agent: 'claude', prompt: 'x', model: 'nope' });
  assert.strictEqual(bad.error, 'model');
  const ok = ph.task({ op: 'send', key: `claude:${ID}`, agent: 'claude', prompt: 'carry on', model: 'sonnet', effort: 'low', dir: 'C:\\Windows', cwd: 'C:\\Windows' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.key, `claude:${ID}`);
  assert.strictEqual(f.calls[0].opts.cwd.toLowerCase(), fs.realpathSync.native(cwd).toLowerCase());
  assert.ok(f.calls[0].args.includes('--resume') && f.calls[0].args.includes('sonnet'));
  assert.strictEqual(ph.chatRead({ key: `claude:${ID}` }).running, true);
  assert.strictEqual(ph.chatList().chats.find((c) => c.agent === 'claude').running, true);
});

test('a conversation open on the computer is continued as a copy; Codex conversations the dock did not start are copied too', () => {
  const { ph, f, h } = host({ tasksFull: true });
  fs.writeFileSync(path.join(h, '.claude', 'sessions', '9.json'), JSON.stringify({ sessionId: ID, pid: process.pid }));
  const r = ph.task({ op: 'send', key: `claude:${ID}`, agent: 'claude', prompt: 'x' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.fork, true);
  assert.notStrictEqual(r.key, `claude:${ID}`);
  assert.ok(f.calls[0].args.includes('--fork-session'));
  const cx = ph.task({ op: 'send', key: `codex:${CX}`, agent: 'codex', prompt: 'x' }); // the file was just written, and the dock did not start it
  assert.strictEqual(cx.ok, true);
  assert.strictEqual(cx.fork, true);
  assert.strictEqual(cx.key, null); // the copy's id comes with the thread.started event
  assert.deepStrictEqual(f.calls[1].args.slice(0, 3), ['codex.js', 'exec', 'fork']);
  f.calls[1].child.stdout.emit('data', JSON.stringify({ type: 'thread.started', thread_id: '01a206b4-a1da-72b0-9373-1a5fa992b808' }) + '\n');
  assert.strictEqual(ph.chatList().tasks.find((t) => t.agent === 'codex').session, '01a206b4-a1da-72b0-9373-1a5fa992b808');
  assert.strictEqual(ph.task({ op: 'send', key: `codex:${CX}`, agent: 'codex', prompt: 'again' }).error, 'busy'); // the copy of it is still running
});

test('Codex: a conversation the dock itself started is continued in place, not copied', () => {
  const { ph, f, cwd } = host({ tasksFull: true });
  const started = ph.task({ op: 'start', agent: 'codex', dir: fs.realpathSync.native(cwd), prompt: 'x' });
  assert.strictEqual(started.ok, true);
  f.calls[0].child.stdout.emit('data', JSON.stringify({ type: 'thread.started', thread_id: CX }) + '\n');
  f.calls[0].child.emit('exit', 0);
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(ph.index.find(`codex:${CX}`).file, old, old);
  const r = ph.task({ op: 'send', key: `codex:${CX}`, agent: 'codex', prompt: 'more' });
  assert.strictEqual(r.fork, false);
  assert.deepStrictEqual(f.calls[1].args.slice(0, 3), ['codex.js', 'exec', 'resume']);
});

test('keys resolve by exact id only: a suffix of a real id finds nothing', () => {
  const { h } = home();
  const ix = new ChatIndex({ home: h, limit: 1 });
  assert.ok(ix.find(`claude:${ID}`));
  assert.strictEqual(ix.find('claude:' + ID.slice(-12)), null);
});

test('edits mode: Claude runs restricted (no user/project settings), so a chat cannot write itself a hook', () => {
  const dir = tmp();
  const { f, r } = runner(dir);
  r.resume({ agent: 'claude', session: ID, cwd: dir, prompt: 'x' });
  assert.ok(f.calls[0].args.includes('--restricted') && f.calls[0].args.includes('--strict-mcp-config'));
});

test('without full permissions a conversation outside the allowed folders is refused', () => {
  const { ph, config } = host({});
  config.phone.dirs = [tmp('dock-other-')];
  assert.strictEqual(ph.task({ op: 'send', key: `claude:${ID}`, agent: 'claude', prompt: 'x' }).error, 'outside');
});

test('paging: list(limit) says whether more exist; the agent list for new chats comes with the options', () => {
  const { h } = home();
  const ix = new ChatIndex({ home: h });
  assert.strictEqual(ix.list(1).length, 1);
  assert.strictEqual(ix.more, true);
  assert.strictEqual(ix.list(10).length, 2);
  assert.strictEqual(ix.more, false);
  const o = options({ home: h });
  assert.deepStrictEqual(o.agents.map((a) => a.id), ['claude', 'codex', 'grok']);
});

test('chatList: the limit is clamped and "more" is reported', () => {
  const { ph } = host({});
  const l = ph.chatList({ limit: '1' }); // below the minimum of 20: both conversations come back
  assert.strictEqual(l.chats.length, 2);
  assert.strictEqual(l.more, false);
  assert.ok(l.options.agents.length >= 2);
});

// ------------------------------------------------------------ OpenCode and Grok
const OC_ID = 'ses_0123456789abcdef';
function fakeDb(sessions, messages) {
  return () => ({
    prepare: (sql) => ({
      all: (...a) => (/FROM session_v2/.test(sql) ? sessions.slice(0, a[0]) : /FROM session_message/.test(sql) ? messages.slice().reverse().slice(0, a[1]) : []),
    }),
    close() {},
  });
}
const ocMessages = [
  { type: 'synthetic', data: JSON.stringify({ text: 'AGENTS.md injected' }), time_created: 1 },
  { type: 'user', data: JSON.stringify({ text: 'Why is the build slow?', time: { created: 1000 } }), time_created: 1000 },
  { type: 'assistant', data: JSON.stringify({ content: [{ type: 'reasoning', text: 'hidden' }, { type: 'tool', name: 'read', state: { input: { filePath: 'a.js' } } }, { type: 'tool', name: 'grep', state: { input: { pattern: 'x' } } }, { type: 'text', text: 'It is the bundler.' }] }), time_created: 2000 },
];

test('OpenCode: chats listed and read through the database (reasoning and injected rows left out, tool calls collapsed)', () => {
  const { h, cwd } = home();
  const ix = new ChatIndex({ home: h, openDb: fakeDb([{ id: OC_ID, directory: cwd.replace(/\\/g, '/'), title: 'Build speed', time_updated: Date.now() - 5000 }], ocMessages) });
  const l = ix.list();
  const e = l.find((c) => c.agent === 'opencode');
  assert.ok(e);
  assert.strictEqual(e.key, `opencode:${OC_ID}`);
  assert.strictEqual(e.title, 'Build speed');
  assert.strictEqual(ix.find(`opencode:${OC_ID}`).id, OC_ID);
  const r = ix.read(e, 40);
  assert.deepStrictEqual(r.messages.map((m) => [m.role, m.text]), [['user', 'Why is the build slow?'], ['tool', 'read · a.js\ngrep · x'], ['assistant', 'It is the bundler.']]);
  assert.strictEqual(ix.live(e), true); // updated a moment ago
});

test('OpenCode without the sqlite driver simply has no chats', () => {
  const { h } = home();
  const ix = new ChatIndex({ home: h, openDb: () => null });
  assert.deepStrictEqual(ix.list().map((c) => c.agent).sort(), ['claude', 'codex']);
});

test('Grok: sessions listed from summary.json, transcript from chat_history.jsonl (wrapper stripped, injected rows and results left out)', () => {
  const { h, cwd } = home();
  const sid = '01a19feb-b5ae-78b1-8263-d0780d83199f';
  const dir = path.join(h, '.grok', 'sessions', encodeURIComponent(cwd), sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ info: { id: sid, cwd }, generated_title: 'Fix the flow', updated_at: '2026-11-22T10:00:00Z' }));
  fs.writeFileSync(path.join(dir, 'chat_history.jsonl'), jl([
    { type: 'system', content: 'You are Grok' },
    { type: 'user', content: [{ type: 'text', text: 'injected' }], synthetic_reason: 'user_info' },
    { type: 'user', content: [{ type: 'text', text: '<user_query>\nFix it\n</user_query>' }] },
    { type: 'reasoning', encrypted_content: 'x' },
    { type: 'assistant', content: 'Looking.', tool_calls: [{ name: 'read_file', arguments: JSON.stringify({ target_file: 'a.js' }) }] },
    { type: 'tool_result', content: 'big output' },
    { type: 'assistant', content: 'Done.' },
  ]));
  const ix = new ChatIndex({ home: h, openDb: () => null });
  const e = ix.list().find((c) => c.agent === 'grok');
  assert.ok(e);
  assert.strictEqual(e.title, 'Fix the flow');
  assert.deepStrictEqual(ix.read(e, 40).messages.map((m) => [m.role, m.text]), [['user', 'Fix it'], ['assistant', 'Looking.'], ['tool', 'read_file · a.js'], ['assistant', 'Done.']]);
});

test('options: OpenCode appears only with its CLI, Grok is history-only, models are provider/model from its own list', () => {
  const h = tmp();
  assert.deepStrictEqual(options({ home: h }).agents.map((a) => a.id), ['claude', 'codex', 'grok']);
  const o = options({ home: h, opencode: { models: ['opencode/big-pickle', 'bad model;x', 'colab-qwen/qwen3'] } });
  assert.deepStrictEqual(o.agents.map((a) => a.id), ['claude', 'codex', 'opencode', 'grok']);
  assert.strictEqual(o.agents.find((a) => a.id === 'grok').chat, false);
  assert.deepStrictEqual(o.opencode.models, ['opencode/big-pickle', 'colab-qwen/qwen3']);
  assert.deepStrictEqual(choose(o, 'opencode', 'opencode/big-pickle', 'high'), { model: 'opencode/big-pickle', effort: 'high' });
  assert.strictEqual(choose(o, 'opencode', 'unknown/model', ''), null);
  assert.strictEqual(choose(o, 'opencode', 'opencode/big-pickle', 'ultra'), null);
  assert.strictEqual(choose(o, 'grok', '', ''), null);
});

test('OpenCode runner: run --standalone with the prompt on stdin; plan agent without full permissions, --auto with it; copies and new chats learn the id from the stream', () => {
  const dir = tmp();
  const ro = runner(dir, 'edits', { opencode: () => 'C:\\oc\\opencode-cli.exe' });
  const res = ro.r.resume({ agent: 'opencode', session: OC_ID, cwd: dir, prompt: 'go', model: 'opencode/big-pickle', effort: 'high' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.session, OC_ID);
  const a = ro.f.calls[0].args;
  assert.deepStrictEqual(a, ['run', '--standalone', '--format', 'json', '-m', 'opencode/big-pickle#high', '-s', OC_ID, '--agent', 'plan']);
  assert.strictEqual(ro.f.calls[0].child.stdin.written, 'go');
  const full = runner(dir, 'full', { opencode: () => 'oc.exe' });
  full.r.resume({ agent: 'opencode', session: OC_ID, cwd: dir, prompt: 'x', fork: true });
  assert.deepStrictEqual(full.f.calls[0].args.slice(-4), ['-s', OC_ID, '--fork', '--auto']);
  full.f.calls[0].child.stdout.emit('data', JSON.stringify({ type: 'step_start', sessionID: OC_ID }) + '\n');
  assert.strictEqual(full.r.list()[0].session, ''); // the old id is not the copy
  full.f.calls[0].child.stdout.emit('data', JSON.stringify({ type: 'text', sessionID: 'ses_newcopy0123456', part: { text: 'hello' } }) + '\n');
  assert.strictEqual(full.r.list()[0].session, 'ses_newcopy0123456');
  assert.strictEqual(full.r.list()[0].text, 'hello');
  assert.strictEqual(runner(dir, 'full', { opencode: () => null }).r.resume({ agent: 'opencode', session: OC_ID, cwd: dir, prompt: 'x' }).error, 'not installed');
  assert.strictEqual(runner(dir, 'full', { opencode: () => 'oc.exe' }).r.resume({ agent: 'opencode', session: OC_ID, cwd: dir, prompt: 'x', model: 'noslash' }).error, 'model');
});

test('send: Grok is history only; an OpenCode conversation the dock did not start is copied first', () => {
  const f = fakeSpawn();
  const { h, cwd } = home();
  const ix = new ChatIndex({ home: h, openDb: fakeDb([{ id: OC_ID, directory: cwd, title: 'T', time_updated: Date.now() - 3600000 }], ocMessages) });
  const { ph } = host({ tasksFull: true }, { chatIndex: ix, chatOptions: () => options({ home: h, opencode: { models: ['opencode/big-pickle'] } }), taskOpts: { spawn: f.spawn, claude: () => 'c.exe', codex: () => 'x.js', opencode: () => 'oc.exe', kill: () => {} } });
  assert.strictEqual(ph.canSend('grok'), false);
  assert.strictEqual(ph.task({ op: 'send', key: 'grok:01a19feb-b5ae-78b1-8263-d0780d83199f', agent: 'grok', prompt: 'x' }).error, 'agent');
  assert.strictEqual(ph.task({ op: 'start', agent: 'grok', dir: cwd, prompt: 'x' }).error, 'agent');
  const r = ph.task({ op: 'send', key: `opencode:${OC_ID}`, agent: 'opencode', prompt: 'go', model: 'opencode/big-pickle' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.fork, true);
  assert.ok(f.calls[0].args.includes('--fork'));
  assert.strictEqual(ph.chatRead({ key: `opencode:${OC_ID}` }).chat.canSend, true);
});

test('OpenCode read-only runs ignore the folder\'s own config and plugins; full permissions leave them alone', () => {
  const dir = tmp();
  const ro = runner(dir, 'edits', { opencode: () => 'oc.exe' });
  ro.r.resume({ agent: 'opencode', session: OC_ID, cwd: dir, prompt: 'x' });
  const env = ro.f.calls[0].opts.env;
  assert.strictEqual(env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
  assert.strictEqual(env.OPENCODE_CONFIG_PROJECT_DISABLE, '1');
  assert.strictEqual(env.PWD, fs.realpathSync.native(dir));
  const full = runner(dir, 'full', { opencode: () => 'oc.exe' });
  full.r.resume({ agent: 'opencode', session: OC_ID, cwd: dir, prompt: 'x' });
  assert.ok(!('OPENCODE_DISABLE_PROJECT_CONFIG' in full.f.calls[0].opts.env) || full.f.calls[0].opts.env.OPENCODE_DISABLE_PROJECT_CONFIG !== '1');
});

test('an OpenCode or Grok conversation beyond the page is still found by its exact id, and finding it does not replace the page', () => {
  const { h, cwd } = home();
  const sid = '01a19feb-b5ae-78b1-8263-d0780d83199f';
  const dir = path.join(h, '.grok', 'sessions', encodeURIComponent(cwd), sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ info: { id: sid, cwd }, generated_title: 'Old one', updated_at: '2020-01-01T00:00:00Z' }));
  fs.writeFileSync(path.join(dir, 'chat_history.jsonl'), '');
  const calls = [];
  const openDb = () => ({
    prepare: (sql) => ({
      all: () => [],
      get: (id) => { calls.push(id); return id === OC_ID ? { id: OC_ID, directory: cwd, title: 'Deep', time_updated: 5 } : undefined; },
    }),
    close() {},
  });
  const ix = new ChatIndex({ home: h, openDb });
  ix.list(1); // a small page the phone is looking at
  const page = ix.cache;
  assert.strictEqual(ix.find(`grok:${sid}`).title, 'Old one');
  assert.strictEqual(ix.find(`opencode:${OC_ID}`).title, 'Deep');
  assert.strictEqual(ix.find('opencode:ses_doesnotexist0000'), null);
  assert.strictEqual(ix.cache, page);
  assert.strictEqual(ix.cacheLimit, 1);
});

test('the phone page\'s logo code never lets an id into markup or reach the prototype', () => {
  const vm = require('vm');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'mascots.js'), 'utf8'), ctx);
  const svg = vm.runInContext('logoSvg("a\\"><script>x</script>", 20) + logoSvg("constructor", 20) + logoSvg("__proto__", 20) + logoSvg("claude", 20)', ctx);
  assert.ok(!/<script/.test(svg));
  assert.strictEqual((svg.match(/<svg /g) || []).length, 4);
});

test('reading a conversation is memoised per conversation, not per file (every OpenCode chat shares one database file)', () => {
  const f = fakeSpawn();
  const { h, cwd } = home();
  const reads = [];
  const openDb = () => ({
    prepare: (sql) => ({
      all: (...a) => (/FROM session_v2/.test(sql) ? [{ id: 'ses_aaaaaaaaaaaaaaaa', directory: cwd, title: 'A', time_updated: 7 }, { id: 'ses_bbbbbbbbbbbbbbbb', directory: cwd, title: 'B', time_updated: 7 }] : (reads.push(a[0]), [{ type: 'user', data: JSON.stringify({ text: 'hello ' + a[0] }), time_created: 1 }])),
      get: () => undefined,
    }),
    close() {},
  });
  const { ph } = host({ tasksFull: true }, { chatIndex: new ChatIndex({ home: h, openDb }), chatOptions: () => options({ home: h }), taskOpts: { spawn: f.spawn, kill: () => {} } });
  const a = ph.chatRead({ key: 'opencode:ses_aaaaaaaaaaaaaaaa' });
  const b = ph.chatRead({ key: 'opencode:ses_bbbbbbbbbbbbbbbb' });
  assert.strictEqual(a.messages[0].text, 'hello ses_aaaaaaaaaaaaaaaa');
  assert.strictEqual(b.messages[0].text, 'hello ses_bbbbbbbbbbbbbbbb');
});
