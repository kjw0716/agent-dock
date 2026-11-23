'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { PhoneServer, COOKIE } = require('../phone');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dock-phone-'));

async function setup({ secure = () => true, hosts = () => ['dock.tail1234.ts.net'], now } = {}) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'page.html'), '<html>hi</html>');
  const calls = [];
  const srv = new PhoneServer({
    dataDir: dir,
    port: 0,
    hosts,
    secure,
    now,
    assets: { '/': { file: path.join(dir, 'page.html'), type: 'text/html; charset=utf-8' } },
    handlers: {
      state: () => ({ rows: [{ id: 'claude' }] }),
      features: () => ({ answer: true, tasks: false }),
      answer: async (b) => (calls.push(['answer', b]), { ok: true }),
      dismiss: async (b) => (calls.push(['dismiss', b]), { ok: true }),
    },
  });
  await srv.start();
  return { srv, dir, calls };
}

const call = (srv, { method = 'GET', path: p = '/', headers = {}, body, host } = {}) =>
  new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: srv.port, method, path: p, headers: { Host: host || `127.0.0.1:${srv.port}`, ...(data !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    if (data !== null) r.write(data);
    r.end();
  });

const pair = async (srv, extra = {}) => {
  const { code } = srv.newPairing();
  const r = await call(srv, { method: 'POST', path: '/api/pair', body: { code, label: 'My iPhone' }, headers: extra.headers });
  const cookie = (r.headers['set-cookie'] || [])[0] || '';
  return { r, cookie: cookie.split(';')[0], token: cookie.split(';')[0].split('=')[1] };
};

test('a Host that is not ours is refused (DNS rebinding), ours is served', async () => {
  const { srv } = await setup();
  assert.strictEqual((await call(srv, { host: 'evil.example.com' })).status, 421);
  assert.strictEqual((await call(srv, { host: `evil.example.com:${srv.port}` })).status, 421);
  assert.strictEqual((await call(srv, { host: 'dock.tail1234.ts.net' })).status, 200);
  const page = await call(srv);
  assert.strictEqual(page.status, 200);
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.strictEqual(page.headers['cache-control'], 'no-store');
  await srv.stop();
});

test('data needs a token: none, a wrong one, and a revoked one are refused', async () => {
  const { srv } = await setup();
  assert.strictEqual((await call(srv, { path: '/api/state' })).status, 401);
  assert.strictEqual((await call(srv, { path: '/api/state', headers: { Cookie: `${COOKIE}=nope` } })).status, 401);
  const { r, cookie } = await pair(srv);
  assert.strictEqual(r.status, 200);
  assert.match(r.headers['set-cookie'][0], /HttpOnly/);
  assert.match(r.headers['set-cookie'][0], /SameSite=Strict/);
  assert.match(r.headers['set-cookie'][0], /Secure/);
  const ok = await call(srv, { path: '/api/state', headers: { Cookie: cookie } });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(ok.json.rows, [{ id: 'claude' }]);
  assert.strictEqual(ok.json.secure, true);
  const id = srv.listDevices()[0].id;
  assert.ok(srv.revoke(id));
  assert.strictEqual((await call(srv, { path: '/api/state', headers: { Cookie: cookie } })).status, 401);
  await srv.stop();
});

test('a Bearer header works like the cookie, and only a hash of the token is stored', async () => {
  const { srv, dir } = await setup();
  const { token } = await pair(srv);
  assert.strictEqual((await call(srv, { path: '/api/state', headers: { Authorization: `Bearer ${token}` } })).status, 200);
  const stored = fs.readFileSync(path.join(dir, 'phone.json'), 'utf8');
  assert.ok(!stored.includes(token));
  assert.match(stored, /"hash"/);
  await srv.stop();
});

test('the pairing code works once, expires after two minutes, and wrong guesses are rate limited', async () => {
  let t = 1000000;
  const { srv } = await setup({ now: () => t });
  const first = await pair(srv);
  assert.strictEqual(first.r.status, 200);
  // the same code a second time
  const { code } = srv.newPairing();
  assert.strictEqual((await call(srv, { method: 'POST', path: '/api/pair', body: { code } })).status, 200);
  assert.strictEqual((await call(srv, { method: 'POST', path: '/api/pair', body: { code } })).status, 403);
  // expired
  const p2 = srv.newPairing();
  t += 2 * 60 * 1000 + 1;
  assert.strictEqual((await call(srv, { method: 'POST', path: '/api/pair', body: { code: p2.code } })).status, 403);
  // guessing: eight failures, then 429 even for a right code
  t += 5 * 60 * 1000;
  const p3 = srv.newPairing();
  for (let i = 0; i < 8; i++) await call(srv, { method: 'POST', path: '/api/pair', body: { code: 'wrong' + i } });
  assert.strictEqual((await call(srv, { method: 'POST', path: '/api/pair', body: { code: p3.code } })).status, 429);
  t += 61 * 1000;
  assert.strictEqual((await call(srv, { method: 'POST', path: '/api/pair', body: { code: p3.code } })).status, 200);
  await srv.stop();
});

test('actions: refused when not over Tailscale, refused for a foreign Origin or non-JSON, otherwise handled', async () => {
  const insecure = await setup({ secure: () => false });
  const a = await pair(insecure.srv);
  const blocked = await call(insecure.srv, { method: 'POST', path: '/api/answer', body: { x: 1 }, headers: { Cookie: a.cookie } });
  assert.strictEqual(blocked.status, 403);
  assert.strictEqual(blocked.json.error, 'insecure');
  assert.strictEqual(insecure.calls.length, 0);
  assert.strictEqual((await call(insecure.srv, { path: '/api/state', headers: { Cookie: a.cookie } })).status, 200); // viewing is fine
  await insecure.srv.stop();

  const { srv, calls } = await setup();
  const { cookie } = await pair(srv);
  const bad = await call(srv, { method: 'POST', path: '/api/answer', body: { x: 1 }, headers: { Cookie: cookie, Origin: 'https://evil.example.com' } });
  assert.strictEqual(bad.status, 403);
  const text = await call(srv, { method: 'POST', path: '/api/answer', body: 'x=1', headers: { Cookie: cookie, 'Content-Type': 'text/plain' } });
  assert.strictEqual(text.status, 415);
  const ok = await call(srv, { method: 'POST', path: '/api/answer', body: { sessionId: 's', custom: 'go' }, headers: { Cookie: cookie, Origin: `http://127.0.0.1:${srv.port}` } });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(calls, [['answer', { sessionId: 's', custom: 'go' }]]);
  assert.strictEqual(srv.log.at(-1).what, 'answer');
  assert.strictEqual((await call(srv, { method: 'POST', path: '/api/task', body: {}, headers: { Cookie: cookie } })).status, 404); // no task handler yet
  await srv.stop();
});

test('a device is bound to the Tailscale login it paired with', async () => {
  const { srv } = await setup();
  const { cookie } = await pair(srv, { headers: { 'Tailscale-User-Login': 'me@example.com' } });
  assert.strictEqual((await call(srv, { path: '/api/state', headers: { Cookie: cookie, 'Tailscale-User-Login': 'me@example.com' } })).status, 200);
  assert.strictEqual((await call(srv, { path: '/api/state', headers: { Cookie: cookie, 'Tailscale-User-Login': 'other@example.com' } })).status, 401);
  await srv.stop();
});

test('an oversized body is refused, and revokeAll clears every device and the code', async () => {
  const { srv } = await setup();
  const { cookie } = await pair(srv);
  const big = await call(srv, { method: 'POST', path: '/api/dismiss', body: JSON.stringify({ x: 'a'.repeat(70000) }), headers: { Cookie: cookie } });
  assert.strictEqual(big.status, 413);
  srv.newPairing();
  srv.revokeAll();
  assert.deepStrictEqual(srv.listDevices(), []);
  assert.strictEqual(srv.pairing, null);
  assert.strictEqual((await call(srv, { path: '/api/state', headers: { Cookie: cookie } })).status, 401);
  await srv.stop();
});
