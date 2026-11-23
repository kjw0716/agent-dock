'use strict';
// The phone side of Agent Dock: a small HTTP server that listens on 127.0.0.1 ONLY. A phone reaches it through
// `tailscale serve` (HTTPS inside your tailnet, never the public internet; see tailscale.js).
//
// Who may talk to it:
//  - the Host header must be one of the names we expect (blocks DNS rebinding from web pages on this computer);
//  - every data request carries a device token (cookie or Bearer header). A token is made once by pairing: the Dock shows
//    a one-time code (two minutes, one use), the phone swaps it for a token. Only a hash of each token is stored;
//  - requests that change something (answer, dismiss, new task) also need the connection to look like Tailscale serve
//    (`secure(req)`: loopback peer, our tailnet name, a Tailscale-User-Login header) and a matching Origin;
//  - the paired device is bound to the Tailscale login it first used, when the header is there.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COOKIE = 'dock_token';
const PAIR_LIFETIME = 2 * 60 * 1000;
const MAX_BODY = 64 * 1024;
const FAIL_WINDOW = 60 * 1000;
const FAIL_MAX = 8;

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const rnd = (n) => crypto.randomBytes(n).toString('base64url');
const same = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

class PhoneServer {
  /**
   * handlers: { state(), chats(), chat(q), answer(body), dismiss(body), task(body)?, features() }
   * hosts(): extra allowed Host values (the tailnet name); secure(req): see above.
   */
  constructor({ dataDir, port = 47821, handlers, hosts = () => [], secure = () => false, assets = {}, now = () => Date.now() }) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'phone.json');
    this.port = port;
    this.handlers = handlers;
    this.hosts = hosts;
    this.secure = secure;
    this.assets = assets; // path -> { file, type }
    this.now = now;
    this.server = null;
    this.devices = this.load();
    this.pairing = null; // { code, expiresAt }
    this.fails = [];
    this.log = []; // what the phones did, newest last (kept in memory)
  }

  // ------------------------------------------------------------ devices
  load() {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(v.devices) ? v.devices.filter((d) => d && typeof d.hash === 'string' && typeof d.id === 'string') : [];
    } catch {
      return [];
    }
  }

  save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, devices: this.devices }, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {}
  }

  listDevices() {
    return this.devices.map((d) => ({ id: d.id, label: d.label, created: d.created, lastSeen: d.lastSeen, login: d.login || '' }));
  }

  revoke(id) {
    const n = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length !== n) this.save();
    return n !== this.devices.length;
  }

  revokeAll() {
    this.devices = [];
    this.pairing = null;
    this.save();
  }

  /** A one-time code for a phone to pair with. */
  newPairing() {
    this.pairing = { code: rnd(6), expiresAt: this.now() + PAIR_LIFETIME };
    return { code: this.pairing.code, expiresAt: this.pairing.expiresAt };
  }

  record(device, what) {
    this.log.push({ at: this.now(), device: device ? device.label : '', what: String(what).slice(0, 200) });
    if (this.log.length > 200) this.log.shift();
  }

  // ------------------------------------------------------------ checks
  hostOk(host) {
    if (typeof host !== 'string') return false;
    const h = host.toLowerCase();
    return h === `127.0.0.1:${this.port}` || h === `localhost:${this.port}` || this.hosts().some((x) => x && (h === x.toLowerCase() || h === `${x.toLowerCase()}:443`));
  }

  originOk(req) {
    const o = req.headers.origin;
    if (!o) return true; // same-origin fetches from some browsers carry none; the cookie is SameSite=Strict
    try {
      return this.hostOk(new URL(o).host);
    } catch {
      return false;
    }
  }

  tokenOf(req) {
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
    const c = req.headers.cookie;
    if (typeof c === 'string') {
      for (const part of c.split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
      }
    }
    return '';
  }

  authenticate(req) {
    const token = this.tokenOf(req);
    if (!token) return null;
    const h = sha(token);
    const d = this.devices.find((x) => same(x.hash, h));
    if (!d) return null;
    const login = req.headers['tailscale-user-login'];
    if (d.login && typeof login === 'string' && login && login !== d.login) return null; // a different Tailscale user
    const now = this.now();
    if (!d.lastSeen || now - d.lastSeen > 60000) {
      d.lastSeen = now;
      this.save();
    }
    return d;
  }

  // ------------------------------------------------------------ http
  json(res, code, body, headers = {}) {
    const text = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...headers });
    res.end(text);
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      let tooLarge = false;
      req.on('data', (c) => {
        size += c.length;
        if (tooLarge) return; // keep reading (and dropping) so the 413 can be sent on the same connection
        if (size > MAX_BODY) {
          tooLarge = true;
          chunks.length = 0;
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooLarge) return reject(new Error('too large'));
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          reject(new Error('bad json'));
        }
      });
      req.on('error', reject);
    });
  }

  pairAttemptAllowed() {
    const now = this.now();
    this.fails = this.fails.filter((t) => now - t < FAIL_WINDOW);
    return this.fails.length < FAIL_MAX;
  }

  async handle(req, res) {
    const base = {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    };
    const send = (code, body, extra) => this.json(res, code, body, { ...base, ...(extra || {}) });
    try {
      if (!this.hostOk(req.headers.host)) return send(421, { error: 'host' });
      const url = new URL(req.url, 'http://x');
      const route = url.pathname;
      const secure = !!this.secure(req);

      // the page and its files carry no data
      if (req.method === 'GET' && !route.startsWith('/api/')) {
        const a = this.assets[route] || (route === '/pair' ? this.assets['/'] : null);
        if (!a) return send(404, { error: 'not found' });
        let body;
        try {
          body = fs.readFileSync(a.file);
        } catch {
          return send(404, { error: 'not found' });
        }
        const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
        res.writeHead(200, { ...base, 'Content-Type': a.type, 'Content-Length': body.length, ...(a.type.startsWith('text/html') ? { 'Content-Security-Policy': csp } : {}) });
        return res.end(body);
      }

      if (req.method === 'POST') {
        if (!this.originOk(req)) return send(403, { error: 'origin' });
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(415, { error: 'json only' });
      }

      if (req.method === 'POST' && route === '/api/pair') {
        if (!this.pairAttemptAllowed()) return send(429, { error: 'too many attempts' });
        const body = await this.readBody(req);
        const p = this.pairing;
        const ok = p && this.now() < p.expiresAt && typeof body.code === 'string' && same(body.code, p.code);
        if (!ok) {
          this.fails.push(this.now());
          return send(403, { error: 'code' });
        }
        this.pairing = null; // one use
        const token = rnd(32);
        const login = typeof req.headers['tailscale-user-login'] === 'string' ? req.headers['tailscale-user-login'] : '';
        const device = { id: rnd(6), hash: sha(token), label: String(body.label || 'Phone').replace(/[^\p{L}\p{N} ._()-]/gu, '').slice(0, 40) || 'Phone', login, created: this.now(), lastSeen: this.now() };
        this.devices.push(device);
        this.save();
        this.record(device, 'paired');
        return send(200, { ok: true }, { 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Strict; Path=/; Max-Age=31536000` });
      }

      const device = this.authenticate(req);
      if (!device) return send(401, { error: 'auth' });

      if (req.method === 'GET' && route === '/api/state') return send(200, { ...this.handlers.state(), features: this.handlers.features(), secure, now: this.now() });
      if (req.method === 'GET' && (route === '/api/chats' || route === '/api/chat')) {
        // full conversation text is the most sensitive thing served: only over Tailscale's HTTPS
        if (!secure) return send(403, { error: 'insecure' });
        const fn = this.handlers[route === '/api/chats' ? 'chats' : 'chat'];
        if (!fn) return send(404, { error: 'not found' });
        const r = await fn(Object.fromEntries(url.searchParams), device);
        if (route === '/api/chat' && this.now() - (device.readLogged || 0) > 5 * 60 * 1000) {
          device.readLogged = this.now(); // the activity log is not for every poll
          this.record(device, 'read chat');
        }
        return send(200, r === undefined ? { ok: false } : r);
      }
      if (req.method === 'POST' && ['/api/answer', '/api/dismiss', '/api/task'].includes(route)) {
        // an action changes something on this computer: only over Tailscale's HTTPS
        if (!secure) return send(403, { error: 'insecure' });
        const body = await this.readBody(req);
        const name = route.slice(5);
        const fn = this.handlers[name];
        if (!fn) return send(404, { error: 'not found' });
        const r = await fn(body, device);
        this.record(device, name + (r && r.ok === false ? ' (refused)' : ''));
        return send(200, r === undefined ? { ok: true } : r);
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) send(e && e.message === 'too large' ? 413 : e && e.message === 'bad json' ? 400 : 500, { error: 'failed' });
      else res.end();
    }
  }

  // ------------------------------------------------------------ lifecycle
  start() {
    if (this.server) return Promise.resolve(this.port);
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => this.handle(req, res));
      srv.requestTimeout = 15000;
      srv.headersTimeout = 10000;
      srv.on('error', (e) => {
        if (!this.server) reject(e);
      });
      srv.listen(this.port, '127.0.0.1', () => {
        this.server = srv;
        this.port = srv.address().port; // a port of 0 picks a free one (tests)
        resolve(this.port);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      const s = this.server;
      this.server = null;
      if (!s) return resolve();
      s.close(() => resolve());
      if (s.closeAllConnections) s.closeAllConnections();
    });
  }
}

module.exports = { PhoneServer, COOKIE, PAIR_LIFETIME, sha };
