'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepare, installed, install, uninstall, resolveClaude, cmdLine, run, PLUGIN_ID } = require('../plugin-install');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dock-plug-'));

test('prepare copies the plugin and fills in the channel folder as a JSON string', () => {
  const data = tmp();
  const folder = prepare(data);
  const reg = fs.readFileSync(path.join(folder, 'hooks', 'register.ts'), 'utf8');
  assert.ok(!reg.includes('__AGENT_DOCK_CHANNEL_JSON__'));
  assert.ok(reg.includes(JSON.stringify(path.join(data, 'channel').replace(/\\/g, '/'))));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(folder, 'hooks', 'hooks.json'), 'utf8')), { modules: ['./register.ts'] });
  const market = JSON.parse(fs.readFileSync(path.join(folder, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.strictEqual(market.plugins[0].name, 'agent-dock');
});

test('installed reads Claude\'s record; a different plugin is not ours', () => {
  const home = tmp();
  const dir = path.join(home, '.claude', 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  const rec = (id) => fs.writeFileSync(path.join(dir, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [id]: [{ scope: 'user', version: '0.1.0' }] } }));
  assert.strictEqual(installed({ home, env: {} }), null);
  rec('agent-hud@agent-hud');
  assert.strictEqual(installed({ home, env: {} }), null);
  rec(PLUGIN_ID);
  assert.strictEqual(installed({ home, env: {} }).version, '0.1.0');
});

test('install validates, adds the marketplace, then installs; uninstall removes both', async () => {
  const calls = [];
  const exec = (cmd, args, _o, cb) => { calls.push([cmd, ...args].join(' ')); cb(null, 'ok\n', ''); };
  const data = tmp();
  assert.deepStrictEqual(await install(data, { exec }), { ok: true });
  assert.match(calls[0], /^claude plugin validate .*claude-plugin$/);
  assert.match(calls[1], /^claude plugin marketplace add .*claude-plugin$/);
  assert.strictEqual(calls[2], `claude plugin install ${PLUGIN_ID} --scope user`);
  calls.length = 0;
  assert.strictEqual((await uninstall({ exec })).ok, true);
  assert.deepStrictEqual(calls, [`claude plugin uninstall ${PLUGIN_ID} --scope user`, 'claude plugin marketplace remove agent-dock']);
});

test('install stops at the first failing step and says which; a missing claude command is explained', async () => {
  const exec = (cmd, args, _o, cb) => (args[1] === 'marketplace' ? cb(Object.assign(new Error('boom'), { code: 1 }), '', 'bad') : cb(null, 'ok', ''));
  const r = await install(tmp(), { exec });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.step, 'plugin marketplace add');
  const missing = await install(tmp(), { exec: (c, a, o, cb) => cb(Object.assign(new Error('x'), { code: 'ENOENT' }), '', '') });
  assert.match(missing.error, /not found on PATH/);
});

test('resolveClaude finds claude.exe, then an npm-style claude.cmd, on PATH; cmdLine quotes and refuses quotes', () => {
  const bin = tmp();
  const other = tmp();
  const env = { PATH: `${other};${bin}` };
  assert.strictEqual(resolveClaude({ env, platform: 'win32' }), null);
  fs.writeFileSync(path.join(bin, 'claude.cmd'), '');
  assert.strictEqual(resolveClaude({ env, platform: 'win32' }), path.join(bin, 'claude.cmd'));
  fs.writeFileSync(path.join(other, 'claude.exe'), '');
  assert.strictEqual(resolveClaude({ env, platform: 'win32' }), path.join(other, 'claude.exe'));
  assert.strictEqual(resolveClaude({ env, platform: 'linux' }), 'claude');
  const cl = ['C:', 'bin', 'claude.cmd'].join(path.win32.sep);
  const dd = ['C:', 'my data', 'claude-plugin'].join(path.win32.sep);
  assert.strictEqual(cmdLine(cl, ['plugin', 'marketplace', 'add', dd]), '""' + cl + '" plugin marketplace add "' + dd + '""');
  assert.throws(() => cmdLine('claude.cmd', ['a"b']));
});

test('a .cmd launcher in a folder with a space really runs, with a spaced argument last', { skip: process.platform !== 'win32' }, async () => {
  const dir = path.join(tmp(), 'sp dir');
  fs.mkdirSync(dir);
  const stub = path.join(dir, 'claude.cmd');
  fs.writeFileSync(stub, ['@echo off', 'echo ARGS:%*', ''].join('\r\n'));
  const r = await run(['plugin', 'validate', 'C:/x y/z'], { file: stub });
  assert.strictEqual(r.ok, true, r.error);
  assert.ok(r.output.includes('ARGS:plugin validate "C:/x y/z"'), r.output);
});
