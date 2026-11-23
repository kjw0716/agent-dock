'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PushSender, cleanSubscription } = require('../push');
const { PhoneHost } = require('../phone-host');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dock-push-'));
const P = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM'; // 87 chars, a real-looking p256dh
const A = 'tBHItJI5svbpez7KI4CCXg';
const sub = (endpoint) => ({ endpoint, keys: { p256dh: P, auth: A } });

test('only subscriptions of known push services are accepted (https, fixed hosts, no credentials, no odd port)', () => {
  for (const ok of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://web.push.apple.com/QGx', 'https://wns2-par02p.notify.windows.com/w/?token=x']) {
    assert.ok(cleanSubscription(sub(ok)), ok);
  }
  for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.example.com/x', 'https://fcm.googleapis.com.evil.com/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://user:pw@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://169.254.169.254/latest', 'ftp://web.push.apple.com/x', 'not a url', 'https://notapple.com/web.push.apple.com']) {
    assert.strictEqual(cleanSubscription(sub(bad)), null, bad);
  }
  assert.strictEqual(cleanSubscription(null), null);
  assert.strictEqual(cleanSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'short', auth: A } }), null);
  assert.strictEqual(cleanSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: P, auth: 'bad key!' } }), null);
  assert.strictEqual(cleanSubscription({ endpoint: 'https://fcm.googleapis.com/x'.padEnd(700, 'a'), keys: { p256dh: P, auth: A } }), null);
  assert.deepStrictEqual(cleanSubscription(sub('https://fcm.googleapis.com/fcm/send/abc')), { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: P, auth: A });
});

test('PushSender: VAPID keys are made once and reused, a payload goes to every target, gone subscriptions are reported', async () => {
  const dir = tmp();
  let made = 0;
  const sent = [];
  const webpush = {
    generateVAPIDKeys: () => ({ publicKey: 'PUB' + ++made, privateKey: 'PRIV' }),
    sendNotification: async (s, body, opts) => {
      sent.push({ s, body: JSON.parse(body), opts });
      if (s.endpoint.includes('gone')) throw Object.assign(new Error('x'), { statusCode: 410 });
      if (s.endpoint.includes('bad')) throw Object.assign(new Error('x'), { statusCode: 500 });
      if (s.endpoint.includes('stale')) throw Object.assign(new Error('x'), { statusCode: 403 }); // a different key pair
    },
  };
  const a = new PushSender({ dataDir: dir, webpush });
  assert.strictEqual(a.publicKey(), 'PUB1');
  assert.strictEqual(new PushSender({ dataDir: dir, webpush }).publicKey(), 'PUB1'); // from the file
  assert.strictEqual(made, 1);
  const r = await a.send([{ id: 'd1', endpoint: 'https://fcm.googleapis.com/ok', p256dh: P, auth: A }, { id: 'd2', endpoint: 'https://fcm.googleapis.com/gone', p256dh: P, auth: A }, { id: 'd3', endpoint: 'https://fcm.googleapis.com/bad', p256dh: P, auth: A }], { title: 'Claude', body: 'Waiting for you', open: 'claude:abc1234' });
  assert.deepStrictEqual(r, { sent: 1, gone: ['d2'], failed: 1 });
  const r2 = await a.send([{ id: 'd4', endpoint: 'https://fcm.googleapis.com/stale', p256dh: P, auth: A }], { title: 'x', body: 'y' });
  assert.deepStrictEqual(r2.gone, ['d4']);
  const broken = new PushSender({ dataDir: tmp(), webpush: { generateVAPIDKeys: () => { throw new Error('cannot load'); } } });
  assert.deepStrictEqual(await broken.send([{ id: 'd5', endpoint: 'https://fcm.googleapis.com/ok', p256dh: P, auth: A }], { title: 'x', body: 'y' }), { sent: 0, gone: [], failed: 1 });
  assert.deepStrictEqual(sent[0].body, { title: 'Claude', body: 'Waiting for you', open: 'claude:abc1234', tag: '' });
  assert.strictEqual(sent[0].opts.vapidDetails.subject, 'https://github.com/kjw0716/agent-dock'); // no personal address
  assert.strictEqual(sent[0].opts.TTL, 3600);
  assert.deepStrictEqual(await a.send([], { title: 'x', body: 'y' }), { sent: 0, gone: [], failed: 0 });
});

function host(extra = {}) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'app.html'), '<html/>');
  const config = { phone: { enabled: true, port: 0 } };
  const calls = [];
  const pushSender = { publicKey: () => 'PUBKEY', send: async (targets, payload) => { calls.push({ targets, payload }); return { sent: targets.length, gone: extra.gone || [], failed: 0 }; } };
  const ph = new PhoneHost({
    dataDir: dir, readConfig: () => config, patchConfig: (p) => Object.assign(config, p), rows: () => [], answer: () => ({ ok: true }), dismiss: () => ({ ok: true }),
    assetsDir: dir, iconFile: path.join(dir, 'app.html'), qr: () => '', lang: () => 'en', run: async () => ({ code: 1, error: 'ENOENT', stdout: '', stderr: '' }), dev: true, pushSender,
  });
  return { ph, calls, config };
}

test('a phone subscribes and unsubscribes on its own device record; revoking the phone removes the subscription; bad input is refused', async () => {
  const { ph } = host();
  await ph.start();
  ph.server.devices.push({ id: 'dev1', hash: 'h1', label: 'iPhone' }, { id: 'dev2', hash: 'h2', label: 'Pixel' });
  const dev1 = ph.server.devices[0];
  assert.deepStrictEqual(ph.pushState(dev1), { key: 'PUBKEY', subscribed: false });
  assert.strictEqual(ph.pushOp({ op: 'subscribe', subscription: sub('https://evil.example.com/x') }, dev1).error, 'subscription');
  assert.strictEqual(ph.pushOp({ op: 'subscribe', subscription: sub('https://web.push.apple.com/abc') }, dev1).ok, true);
  assert.strictEqual(ph.pushState(dev1).subscribed, true);
  assert.deepStrictEqual(ph.server.pushTargets().map((t) => t.id), ['dev1']);
  assert.strictEqual(ph.server.listDevices().find((d) => d.id === 'dev1').push, true);
  assert.ok(!JSON.stringify(ph.server.listDevices()).includes('apple')); // the endpoint is not shown anywhere
  assert.strictEqual(ph.pushOp({ op: 'nope' }, dev1).error, 'op');
  assert.strictEqual(ph.pushOp(null, dev1).ok, false);
  ph.server.revoke('dev1');
  assert.deepStrictEqual(ph.server.pushTargets(), []);
  ph.server.setPush('dev2', cleanSubscription(sub('https://fcm.googleapis.com/x')));
  assert.strictEqual(ph.pushOp({ op: 'unsubscribe' }, ph.server.devices[0]).ok, true);
  assert.deepStrictEqual(ph.server.pushTargets(), []);
  await ph.stop();
});

test('push(): web push goes to every subscribed phone with the tap target as a link; a subscription the service reports gone is dropped; without any channel nothing is sent', async () => {
  const { ph, calls } = host({ gone: ['dev1'] });
  await ph.start();
  assert.strictEqual((await ph.push({ title: 'Claude', body: 'Waiting for you' })).error, 'address'); // no Bark, nobody subscribed
  ph.server.devices.push({ id: 'dev1', hash: 'h1', label: 'iPhone' });
  ph.server.setPush('dev1', cleanSubscription(sub('https://web.push.apple.com/abc')));
  const r = await ph.push({ title: 'Claude', body: 'Waiting for you', open: 'claude:abc1234' });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].payload.open, 'claude:abc1234');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(ph.server.pushTargets(), []); // reported gone: removed
  await ph.stop();
});

test('observe(): notifications are produced for web push even without a Bark address, and not when nothing is set up', async () => {
  const { ph, calls } = host();
  await ph.start();
  const row = (state, id) => [{ id: 'claude', name: 'Claude', sessions: [{ id, state, since: 1, ask: state === 'waiting' ? { id: 'q' + id } : null }] }];
  ph.observe(row('done', 's0000001'), 'en');
  ph.observe(row('waiting', 's0000002'), 'en');
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(calls.length, 0); // nobody subscribed, no Bark: silent
  ph.server.devices.push({ id: 'dev1', hash: 'h1', label: 'iPhone' });
  ph.server.setPush('dev1', cleanSubscription(sub('https://web.push.apple.com/abc')));
  ph.observe(row('done', 's0000003'), 'en'); // the first call with a channel only seeds what is already there
  ph.observe(row('waiting', 's0000004'), 'en');
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].payload, { title: 'Claude', body: 'Waiting for you', open: 'claude:s0000004' });
  await ph.stop();
});

test('the service worker file ships with the page and only shows what the dock sent', () => {
  const sw = fs.readFileSync(path.join(__dirname, '..', 'phone', 'sw.js'), 'utf8');
  assert.ok(/addEventListener\('push'/.test(sw) && /showNotification/.test(sw) && /notificationclick/.test(sw));
  assert.ok(!/fetch\(/.test(sw)); // it never fetches anything
  new Function(sw); // parses
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('push.js') && pkg.build.files.includes('phone/**'));
  assert.ok(/^[\^~]?3\./.test(pkg.dependencies['web-push']), 'web-push 4 is ES-module only and cannot be require()d by the Node inside Electron 33');
});

test('service worker behaviour with a fake worker scope: shows exactly what was pushed (bounded), always shows something, opens the conversation on tap', async () => {
  const vm = require('vm');
  const handlers = {};
  const shown = [];
  const posted = [];
  const opened = [];
  let clientList = [];
  const self = {
    addEventListener: (n, fn) => { handlers[n] = fn; },
    skipWaiting() {},
    clients: { claim: async () => {}, matchAll: async () => clientList, openWindow: async (u) => opened.push(u) },
    registration: { showNotification: async (title, o) => shown.push({ title, o }) },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'phone', 'sw.js'), 'utf8'), { self });
  const run = async (name, ev) => { let p; ev.waitUntil = (x) => { p = x; }; handlers[name](ev); await p; };
  await run('push', { data: { json: () => ({ title: 'Claude', body: 'Waiting for you', open: 'claude:abc1234' }) } });
  assert.deepStrictEqual(shown[0].title, 'Claude');
  assert.strictEqual(shown[0].o.body, 'Waiting for you');
  assert.strictEqual(shown[0].o.data.open, 'claude:abc1234');
  await run('push', { data: { json: () => { throw new Error('bad'); } } }); // unreadable: still a notification
  assert.strictEqual(shown[1].title, 'Agent Dock');
  await run('push', { data: { json: () => ({ title: 'x'.repeat(500), body: 'y'.repeat(500), open: '../evil?x=1' }) } });
  assert.ok(shown[2].title.length <= 80 && shown[2].o.body.length <= 160);
  assert.strictEqual(shown[2].o.data.open, ''); // not a session id: dropped
  let closed = false;
  await run('notificationclick', { notification: { close() { closed = true; }, data: { open: 'claude:abc1234' } } });
  assert.ok(closed);
  assert.deepStrictEqual(opened, ['/#open=claude%3Aabc1234']);
  clientList = [{ focus: async () => {}, postMessage: (m) => posted.push(m) }];
  await run('notificationclick', { notification: { close() {}, data: { open: 'codex:zzz9999' } } });
  assert.strictEqual(JSON.stringify(posted), JSON.stringify([{ open: 'codex:zzz9999' }])); // compared as text: the worker's objects come from another realm
});
