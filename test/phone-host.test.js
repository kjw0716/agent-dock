'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PhoneHost } = require('../phone-host');

function make({ cfg = {}, ts = {}, serve = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-host-'));
  fs.writeFileSync(path.join(dir, 'app.html'), '<html/>');
  const config = { phone: { enabled: true, port: 0, ...cfg } };
  const runs = [];
  const run = async (args) => {
    runs.push(args.join(' '));
    const key = args.join(' ');
    if (key === 'status --json') return { code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'pc.tail1.ts.net.' }, CertDomains: ['pc.tail1.ts.net'], ...ts }), stderr: '', error: '' };
    if (key === 'serve status --json') return { code: 0, stdout: JSON.stringify(serve.json || {}), stderr: '', error: '' };
    if (key === 'serve status') return { code: 0, stdout: typeof serve.text === 'function' ? serve.text(host.server && host.server.port) : serve.text || '', stderr: '', error: '' };
    return { code: 0, stdout: '', stderr: '', error: '' };
  };
  const host = new PhoneHost({
    dataDir: dir,
    readConfig: () => config,
    patchConfig: (p) => Object.assign(config, p),
    rows: () => [],
    answer: () => ({ ok: true }),
    dismiss: () => ({ ok: true }),
    assetsDir: dir,
    iconFile: path.join(dir, 'app.html'),
    qr: (t) => `<svg>${t}</svg>`,
    lang: () => 'en',
    run,
    dev: false,
  });
  return { host, config, runs, dir };
}
const reqOf = (headers, remote = '127.0.0.1') => ({ socket: { remoteAddress: remote }, headers });

test('secure(): only a loopback peer carrying the Tailscale login header, with our name; never a funnel request', async () => {
  const { host } = make();
  await host.start();
  const port = host.server.port;
  const login = { 'tailscale-user-login': 'me@example.com' };
  assert.strictEqual(host.secure(reqOf({ host: 'pc.tail1.ts.net', ...login })), true);
  assert.strictEqual(host.secure(reqOf({ host: `127.0.0.1:${port}`, ...login })), true);
  assert.strictEqual(host.secure(reqOf({ host: 'pc.tail1.ts.net' })), false); // no login header: not through serve
  assert.strictEqual(host.secure(reqOf({ host: 'evil.example.com', ...login })), false);
  assert.strictEqual(host.secure(reqOf({ host: 'pc.tail1.ts.net', ...login, 'tailscale-funnel-request': '?1' })), false);
  assert.strictEqual(host.secure(reqOf({ host: 'pc.tail1.ts.net', ...login }, '192.168.1.5')), false); // not from loopback
  await host.stop();
});

test('start and stop are serial: overlapping starts make one server, a stop during a start wins', async () => {
  const { host, config } = make();
  const a = host.start();
  const b = host.start();
  await Promise.all([a, b]);
  assert.ok(host.server);
  assert.strictEqual(host.error, '');
  const first = host.server;
  config.phone.enabled = false;
  const c = host.stop();
  const d = host.start(); // enabled is false again: must not bring the server back
  await Promise.all([c, d]);
  assert.strictEqual(host.server, null);
  assert.notStrictEqual(host.server, first);
});

test('turning Phone off checks what is published right now and unpublishes it', async () => {
  const { host, runs } = make({ serve: { text: 'https://pc.tail1.ts.net\n|-- / proxy http://127.0.0.1:47821' }, cfg: { port: 47821 } });
  await host.start();
  host.ts = { ...host.ts, serving: false }; // a stale cache that says "not published"
  host.tsAt = Date.now();
  await host.set({ enabled: false });
  assert.ok(runs.includes('serve --https=443 off'));
  assert.strictEqual(host.server, null);
});

test('setupTailscale: refused while Phone is off, with something else on 443, or with Funnel on; otherwise publishes', async () => {
  const off = make({ cfg: { enabled: false } });
  assert.strictEqual((await off.host.setupTailscale()).error, 'off');

  const other = make({ serve: { json: { Web: { 'pc.tail1.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } } } });
  assert.strictEqual((await other.host.setupTailscale()).error, 'busy443');
  assert.ok(!other.runs.some((r) => r.startsWith('serve --bg')));
  await other.host.stop();

  const funnel = make({ serve: { json: { AllowFunnel: { 'pc.tail1.ts.net:443': true } } } });
  assert.strictEqual((await funnel.host.setupTailscale()).error, 'funnel');
  await funnel.host.stop();

  const free = make();
  const r = await free.host.setupTailscale();
  assert.strictEqual(r.ok, true);
  assert.ok(free.runs.some((x) => x.startsWith('serve --bg --https=443 http://127.0.0.1:')));
  await free.host.stop();
});

test('pairing needs the server; the URL is the tailnet one only when published, never contains a stored secret', async () => {
  const { host } = make();
  assert.strictEqual((await host.pair()).error, 'off');
  await host.start();
  const local = await host.pair();
  assert.strictEqual(local.ok, true);
  assert.ok(local.url.startsWith('http://127.0.0.1:'));
  assert.strictEqual(local.viaTailscale, false);
  const live = await (async () => {
    host.d.run = null;
    return host.pair();
  })();
  assert.strictEqual(live.viaTailscale, false); // not published yet
  const pub = make({ serve: { text: (port) => `https://pc.tail1.ts.net
|-- / proxy http://127.0.0.1:${port}` } });
  await pub.host.start();
  const published = await pub.host.pair();
  assert.ok(published.url.startsWith('https://pc.tail1.ts.net/pair#c='));
  assert.strictEqual(published.viaTailscale, true);
  await pub.host.stop();
  const unused = live;
  await host.stop();
});

test('tasks: off by default (the server refuses them), full permissions cannot be on without tasks, and switching tasks off clears full', async () => {
  const { host, config } = make();
  await host.start();
  assert.strictEqual(host.task({ op: 'start', agent: 'claude', dir: '.', prompt: 'x' }).error, 'disabled');
  await host.set({ tasksFull: true }); // tasks are off: cannot be turned on this way
  assert.notStrictEqual(config.phone.tasksFull, true);
  await host.set({ tasks: true });
  await host.set({ tasksFull: true });
  assert.strictEqual(config.phone.tasksFull, true);
  assert.strictEqual(host.taskRunner.mode(), 'full');
  await host.set({ tasks: false });
  assert.strictEqual(config.phone.tasksFull, false);
  assert.strictEqual(host.taskRunner.mode(), 'edits');
  await host.stop();
});

test('the Bark address is only replaced by something valid and never returned whole', async () => {
  const { host, config } = make();
  await host.set({ bark: 'https://bark.example.com/SECRETKEY' });
  assert.strictEqual(config.bark, 'https://bark.example.com/SECRETKEY');
  await host.set({ bark: 'javascript:alert(1)' });
  assert.strictEqual(config.bark, 'https://bark.example.com/SECRETKEY'); // refused, kept
  const info = await host.info();
  assert.strictEqual(info.bark, 'bark.example.com');
  assert.ok(!JSON.stringify(info).includes('SECRETKEY'));
  await host.set({ bark: '' });
  assert.strictEqual(config.bark, '');
  await host.stop();
});

test('addDir / removeDir keep a de-duplicated list in the config', () => {
  const { host, config } = make();
  host.addDir('C:\\work\\a');
  host.addDir('c:\\work\\A');
  host.addDir('C:\\work\\b');
  assert.deepStrictEqual(config.phone.dirs, ['C:\\work\\a', 'C:\\work\\b']);
  host.removeDir('C:\\work\\a');
  assert.deepStrictEqual(config.phone.dirs, ['C:\\work\\b']);
});
