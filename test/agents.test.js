'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { otherSessions, installedIds, newest } = require('../agents');
const { summarize } = require('../sources');

const NOW = Date.parse('2026-11-15T12:00:00Z');
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hud-home-'));
const touch = (file, ageMs) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
  const t = new Date(NOW - ageMs);
  fs.utimesSync(file, t, t);
};

test('opencode: fresh write is working, quiet but app open is done, quiet without app is hidden', () => {
  const h = home();
  const env = { home: h, appData: path.join(h, 'AppData') };
  const wal = path.join(h, '.local', 'share', 'opencode', 'opencode.db-wal');
  touch(wal, 3000);
  let s = otherSessions({ now: NOW, env }).find((x) => x.agent === 'opencode');
  assert.strictEqual(s.state, 'working');

  touch(wal, 5 * 60000);
  s = otherSessions({ now: NOW, env, running: new Set(['opencode.exe']) }).find((x) => x.agent === 'opencode');
  assert.strictEqual(s.state, 'done');
  assert.strictEqual(s.labelKey, 'open');
  assert.strictEqual(s.dim, false);

  touch(wal, 8 * 3600e3);
  assert.strictEqual(otherSessions({ now: NOW, env }).find((x) => x.agent === 'opencode'), undefined);
  s = otherSessions({ now: NOW, env, running: new Set(['opencode-cli.exe']) }).find((x) => x.agent === 'opencode');
  assert.strictEqual(s.state, 'done');
  assert.strictEqual(s.dim, true);
});

test('directory agents use the newest file below the sessions folder', () => {
  const h = home();
  const env = { home: h, appData: path.join(h, 'AppData') };
  touch(path.join(h, '.grok', 'sessions', 'a', 'old.json'), 3600e3);
  touch(path.join(h, '.grok', 'sessions', 'b', 'new.json'), 2000);
  const s = otherSessions({ now: NOW, env }).find((x) => x.agent === 'grok');
  assert.strictEqual(s.state, 'working');
  assert.ok(newest(path.join(h, '.grok', 'sessions')) > 0);
});

test('installedIds and `only` filter', () => {
  const h = home();
  const env = { home: h, appData: path.join(h, 'AppData') };
  fs.mkdirSync(path.join(h, '.cursor'), { recursive: true });
  fs.mkdirSync(path.join(h, 'AppData', 'Block', 'goose'), { recursive: true });
  assert.deepStrictEqual(installedIds(env).sort(), ['cursor', 'goose']);
  touch(path.join(h, '.grok', 'sessions', 'x'), 1000);
  touch(path.join(h, '.qwen', 'projects', 'x'), 1000);
  const only = new Set(['qwen']);
  assert.deepStrictEqual(otherSessions({ now: NOW, env, only }).map((x) => x.agent), ['qwen']);
});

test('summarize keeps registry order and works with generic sessions', () => {
  const mk = (agent, state) => ({ agent, id: agent, label: 'x', state, since: 1 });
  const rows = summarize([mk('opencode', 'done'), mk('claude', 'working'), mk('cursor', 'working')]);
  assert.deepStrictEqual(rows.map((r) => r.id), ['claude', 'opencode', 'cursor']);
});
