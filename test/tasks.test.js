'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { TaskRunner, findClaude, findCodex } = require('../tasks');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dock-task-'));

function fakeSpawn() {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { written: '', end(t) { this.written = t; } });
    calls.push({ cmd, args, opts, child });
    return child;
  };
  return { spawn, calls };
}
const make = (over = {}) => {
  const dir = tmp();
  const f = fakeSpawn();
  const killed = [];
  const r = new TaskRunner({ mode: () => 'edits', dirs: () => [dir], spawn: f.spawn, claude: () => 'C:\\bin\\claude.exe', codex: () => 'C:\\npm\\codex.js', kill: (c) => killed.push(c.pid), ...over });
  return { r, dir, f, killed };
};

test('a Claude task: prompt on stdin only, no shell, folder from the allow-list, edits mode, result read from the stream', () => {
  const { r, dir, f } = make();
  const res = r.start({ agent: 'claude', dir, prompt: 'Fix the login bug\nthen run nothing' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.id, 't1');
  assert.match(res.session, /^[0-9a-f-]{36}$/);
  const c = f.calls[0];
  assert.strictEqual(c.cmd, 'C:\\bin\\claude.exe');
  assert.deepStrictEqual(c.args, ['-p', '--output-format', 'stream-json', '--verbose', '--session-id', res.session, '--permission-mode', 'acceptEdits', '--tools', 'Read,Edit,Write,Glob,Grep', '--strict-mcp-config', '--restricted']);
  assert.ok(!c.args.join(' ').includes('Fix the login bug')); // never on the command line
  assert.strictEqual(c.child.stdin.written, 'Fix the login bug\nthen run nothing');
  assert.strictEqual(c.opts.shell, false);
  assert.strictEqual(c.opts.cwd.toLowerCase(), fs.realpathSync.native(dir).toLowerCase());
  c.child.stdout.emit('data', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it' }] } }) + '\n');
  c.child.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Fixed in login.js' }) + '\n');
  c.child.emit('exit', 0);
  const t = r.list()[0];
  assert.strictEqual(t.status, 'done');
  assert.strictEqual(t.text, 'Fixed in login.js');
});

test('full mode is the user\'s own setting and adds no prompts; Codex runs through Electron\'s node with the sandbox flag of the mode', () => {
  const full = make({ mode: () => 'full' });
  full.r.start({ agent: 'claude', dir: full.dir, prompt: 'x' });
  assert.ok(full.f.calls[0].args.includes('--dangerously-skip-permissions'));
  assert.ok(!full.f.calls[0].args.includes('--permission-mode'));
  const cx = make();
  cx.r.start({ agent: 'codex', dir: cx.dir, prompt: 'do it' });
  const c = cx.f.calls[0];
  assert.strictEqual(c.cmd, process.execPath);
  assert.strictEqual(c.opts.env.ELECTRON_RUN_AS_NODE, '1');
  assert.deepStrictEqual(c.args.slice(0, 4), ['C:\\npm\\codex.js', 'exec', '--json', '--skip-git-repo-check']);
  assert.ok(c.args.includes('--sandbox') && c.args.includes('read-only'));
  assert.strictEqual(c.args.at(-1), '-'); // the prompt comes from stdin
  assert.strictEqual(c.child.stdin.written, 'do it');
  cx.f.calls[0].child.stdout.emit('data', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done: certs rotated' } }) + '\n');
  cx.f.calls[0].child.emit('exit', 0);
  assert.strictEqual(cx.r.list()[0].text, 'Done: certs rotated');
  const fx = make({ mode: () => 'full' });
  fx.r.start({ agent: 'codex', dir: fx.dir, prompt: 'x' });
  assert.ok(fx.f.calls[0].args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('refused: unknown agent, empty or control-character prompts, a folder that is not on the list (even a sub-folder or a path trick)', () => {
  const { r, dir, f } = make();
  assert.strictEqual(r.start({ agent: 'rm', dir, prompt: 'x' }).error, 'agent');
  assert.strictEqual(r.start({ agent: 'claude', dir, prompt: '   ' }).error, 'prompt');
  assert.strictEqual(r.start({ agent: 'claude', dir, prompt: 'a\u0000b' }).error, 'prompt');
  assert.strictEqual(r.start({ agent: 'claude', dir, prompt: 'x'.repeat(8001) }).error, 'prompt');
  const other = tmp();
  assert.strictEqual(r.start({ agent: 'claude', dir: other, prompt: 'x' }).error, 'folder');
  fs.mkdirSync(path.join(dir, 'sub'));
  assert.strictEqual(r.start({ agent: 'claude', dir: path.join(dir, 'sub'), prompt: 'x' }).error, 'folder');
  assert.strictEqual(r.start({ agent: 'claude', dir: path.join(dir, 'sub', '..'), prompt: 'x' }).ok, true); // resolves to the allowed folder itself
  assert.strictEqual(r.start({ agent: 'claude', dir: 123, prompt: 'x' }).error, 'folder');
  assert.strictEqual(f.calls.length, 1);
});

test('at most four run at once; a missing CLI is reported; stop and stopAll kill the process tree; a failing run is marked failed', () => {
  const { r, dir, f, killed } = make();
  assert.ok(r.start({ agent: 'claude', dir, prompt: 'a' }).ok);
  assert.ok(r.start({ agent: 'claude', dir, prompt: 'b' }).ok);
  assert.ok(r.start({ agent: 'claude', dir, prompt: 'c' }).ok);
  assert.ok(r.start({ agent: 'claude', dir, prompt: 'd' }).ok);
  assert.strictEqual(r.start({ agent: 'claude', dir, prompt: 'e' }).error, 'busy');
  assert.ok(r.stop('t1'));
  assert.deepStrictEqual(killed, [4242]);
  assert.strictEqual(r.list()[0].status, 'stopped');
  f.calls[1].child.stdout.emit('data', JSON.stringify({ type: 'result', is_error: true, result: 'boom' }) + '\n');
  f.calls[1].child.emit('exit', 1);
  assert.strictEqual(r.list()[1].status, 'failed');
  assert.strictEqual(r.list()[1].error, 'boom');
  const none = make({ claude: () => null, codex: () => null });
  assert.strictEqual(none.r.start({ agent: 'claude', dir: none.dir, prompt: 'x' }).error, 'not installed');
  assert.strictEqual(none.r.start({ agent: 'codex', dir: none.dir, prompt: 'x' }).error, 'not installed');
  const two = make();
  two.r.start({ agent: 'claude', dir: two.dir, prompt: 'x' });
  two.r.start({ agent: 'claude', dir: two.dir, prompt: 'y' });
  two.r.stopAll();
  assert.strictEqual(two.killed.length, 2);
});

test('the dock\'s own AGENT_DOCK_* variables are not passed to the child; finders only return real files, never shims', () => {
  process.env.AGENT_DOCK_SECRET = 'x';
  const { r, dir, f } = make();
  r.start({ agent: 'claude', dir, prompt: 'x' });
  assert.ok(!('AGENT_DOCK_SECRET' in f.calls[0].opts.env));
  delete process.env.AGENT_DOCK_SECRET;
  assert.strictEqual(findClaude({ env: { PATH: 'C:\\a;C:\\b', LOCALAPPDATA: 'C:\\L', USERPROFILE: 'C:\\U' }, exists: (p) => p === path.join('C:\\b', 'claude.exe') || p === path.join('C:\\a', 'claude.cmd') }), path.join('C:\\b', 'claude.exe'));
  assert.strictEqual(findClaude({ env: { PATH: 'C:\\a' }, exists: () => false }), null);
  assert.strictEqual(findCodex({ env: { APPDATA: 'C:\\R' }, exists: (p) => p.endsWith(path.join('@openai', 'codex', 'bin', 'codex.js')) }), path.join('C:\\R', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
});
