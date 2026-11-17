'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { codexUrl, exesOf, focusWindow, SCRIPT } = require('../jump');

test('codex: only a real thread id becomes a deep link', () => {
  assert.strictEqual(codexUrl('01A1E54C-BEDF-7561-A9CE-210401624F3A'), 'codex://threads/01a1e54c-bedf-7561-a9ce-210401624f3a');
  assert.strictEqual(codexUrl('codex'), null);
  assert.strictEqual(codexUrl('../../x'), null);
  assert.strictEqual(codexUrl('01a1e54c-bedf-7561-a9ce-210401624f3a/../../x'), null);
});

test('executables per agent come from the registry', () => {
  assert.ok(exesOf('opencode').includes('opencode'));
  assert.ok(exesOf('cursor').includes('cursor'));
  assert.deepStrictEqual(exesOf('nope'), []);
  assert.ok(exesOf('codex').length > 0);
});

test('the parent walk never lands on the desktop or a system host', () => {
  assert.match(SCRIPT, /'explorer'/);
  assert.match(SCRIPT, /MainWindowTitle/);
});

test('focusWindow passes its inputs through the environment, not the script text', async () => {
  let seen;
  const run = (cmd, args, opts, cb) => {
    seen = { args, env: opts.env };
    cb(null, 'found\n');
  };
  assert.strictEqual(await focusWindow(['opencode', 'opencode-cli'], 'a "quoted" $title', run), true);
  assert.strictEqual(seen.env.DOCK_EXES, 'opencode,opencode-cli');
  assert.strictEqual(seen.env.DOCK_TITLE, 'a "quoted" $title');
  assert.strictEqual(seen.args[seen.args.length - 1], SCRIPT);
  assert.strictEqual(await focusWindow([], '', run), false);
  assert.strictEqual(await focusWindow(['x'], '', (c, a, o, cb) => cb(null, 'none\n')), false);
  assert.strictEqual(await focusWindow(['x'], '', (c, a, o, cb) => cb(new Error('boom'), '')), false);
});
