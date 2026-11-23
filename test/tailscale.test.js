'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ts = require('../tailscale');

const runWith = (answers) => async (args) => {
  const key = args.join(' ');
  for (const [k, v] of Object.entries(answers)) if (key.startsWith(k)) return { code: 0, stdout: '', stderr: '', error: '', ...v };
  return { code: 1, stdout: '', stderr: 'unexpected ' + key, error: '' };
};

test('find prefers the Program Files copy, then PATH, then nothing', () => {
  const fsx = { statSync: (p) => { if (p === 'C:\\x\\tailscale.exe') return { isFile: () => true }; throw new Error('no'); } };
  assert.strictEqual(ts.find({ fsx, candidates: ['C:\\x\\tailscale.exe'] }), 'C:\\x\\tailscale.exe');
  assert.strictEqual(ts.find({ fsx, candidates: ['C:\\y\\tailscale.exe'], onPath: () => true }), 'tailscale');
  assert.strictEqual(ts.find({ fsx, candidates: ['C:\\y\\tailscale.exe'] }), null);
});

test('status reads the state, this computer\'s tailnet name (no trailing dot) and whether HTTPS is enabled', async () => {
  const run = runWith({ 'status --json': { stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'pc.tail1234.ts.net.' }, CertDomains: ['pc.tail1234.ts.net'] }) } });
  assert.deepStrictEqual(await ts.status(run), { installed: true, state: 'Running', host: 'pc.tail1234.ts.net', https: true });
  const noHttps = runWith({ 'status --json': { stdout: JSON.stringify({ BackendState: 'NeedsLogin', Self: {} }) } });
  assert.deepStrictEqual(await ts.status(noHttps), { installed: true, state: 'NeedsLogin', host: '', https: false });
  assert.deepStrictEqual(await ts.status(async () => ({ code: 1, stdout: '', stderr: '', error: 'ENOENT' })), { installed: false });
  const junk = await ts.status(runWith({ 'status --json': { stdout: 'not json', stderr: 'daemon not running\nmore' } }));
  assert.strictEqual(junk.state, 'Unknown');
});

test('serve publishes the local port on HTTPS 443 with the exact arguments (no shell, never funnel); errors give the first line', async () => {
  let seen = null;
  const run = async (args) => { seen = args; return { code: 0, stdout: '', stderr: '', error: '' }; };
  assert.deepStrictEqual(await ts.serve(run, 47821), { ok: true });
  assert.deepStrictEqual(seen, ['serve', '--bg', '--https=443', 'http://127.0.0.1:47821']);
  assert.ok(!seen.includes('funnel'));
  const bad = await ts.serve(async () => ({ code: 1, stdout: '', stderr: '\nHTTPS is not enabled\nsee admin', error: '' }), 1);
  assert.deepStrictEqual(bad, { ok: false, error: 'HTTPS is not enabled' });
  assert.deepStrictEqual(await ts.serving(runWith({ 'serve status': { stdout: 'https://pc.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:47821' } }), 47821), true);
  assert.deepStrictEqual(await ts.serving(runWith({ 'serve status': { stdout: 'nothing' } }), 47821), false);
  let off = null;
  await ts.unserve(async (a) => { off = a; return { code: 0, stdout: '', stderr: '', error: '' }; });
  assert.deepStrictEqual(off, ['serve', '--https=443', 'off']);
});
