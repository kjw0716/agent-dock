'use strict';
// Push notifications to the phone through Bark (https://github.com/Finb/Bark), a service you may run yourself.
// Only the agent's name and what happened are sent ("Claude · Waiting for you"): never a question, a reply or a session name.
// The Bark address (it contains your device key) lives in <data>/config.json on this computer and is never logged.
const http = require('http');
const https = require('https');

const SEND_WINDOW = 60 * 1000;
const SEND_MAX = 6; // a storm of events must not become a storm of pushes

const TEXT = {
  en: { waiting: 'Waiting for you', done: 'Finished', more: (n) => ` (${n})` },
  zh: { waiting: '等你回答', done: '已完成', more: (n) => `（${n}）` },
};

/** The Bark URL for one message, or null when `base` is not an http(s) address. */
function barkUrl(base, { title, body, url }) {
  let u;
  try {
    u = new URL(String(base).trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const root = u.origin + u.pathname.replace(/\/+$/, '');
  const q = new URLSearchParams({ group: 'Agent Dock' });
  if (url) q.set('url', url);
  return `${root}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?${q.toString()}`;
}

/** Fire one request; resolves { ok, status } or { ok: false, error } (never the address). */
function send(base, message, { timeout = 8000, request } = {}) {
  const target = barkUrl(base, message);
  if (!target) return Promise.resolve({ ok: false, error: 'address' });
  const get = request || ((url, opts, cb) => (url.startsWith('https:') ? https : http).get(url, opts, cb));
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    try {
      const req = get(target, { timeout }, (res) => {
        res.resume();
        finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
      });
      req.on('timeout', () => {
        req.destroy();
        finish({ ok: false, error: 'timeout' });
      });
      req.on('error', () => finish({ ok: false, error: 'network' }));
    } catch {
      finish({ ok: false, error: 'network' });
    }
  });
}

/** Turns the sessions the dock shows into push messages: once per event, and never for what was already there at start. */
class Notifier {
  constructor({ push, now = () => Date.now() }) {
    this.push = push; // ({ title, body }) => Promise
    this.now = now;
    this.seen = new Set();
    this.primed = false;
    this.sent = [];
  }

  events(rows) {
    const out = [];
    for (const r of rows) {
      for (const s of r.sessions) {
        if (s.labelKey) continue; // the placeholder of an open app is not a session
        if (s.state === 'waiting') out.push({ key: `w:${r.id}:${s.id}:${s.ask ? s.ask.id : s.since}`, agent: r.id, name: r.name, kind: 'waiting' });
        else if (s.state === 'done' && s.unread) out.push({ key: `d:${r.id}:${s.id}:${s.since}`, agent: r.id, name: r.name, kind: 'done' });
      }
    }
    return out;
  }

  /** Call after every scan with the rows shown. Returns the messages it pushed. */
  observe(rows, lang = 'en') {
    const events = this.events(rows);
    if (!this.primed) {
      this.primed = true;
      for (const e of events) this.seen.add(e.key);
      return [];
    }
    const fresh = events.filter((e) => !this.seen.has(e.key));
    for (const e of fresh) this.seen.add(e.key);
    if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-1000));
    const groups = new Map();
    for (const e of fresh) {
      const g = groups.get(e.agent + e.kind) || { name: e.name, kind: e.kind, n: 0 };
      g.n++;
      groups.set(e.agent + e.kind, g);
    }
    const tx = TEXT[lang] || TEXT.en;
    const pushed = [];
    for (const g of groups.values()) {
      const now = this.now();
      this.sent = this.sent.filter((t) => now - t < SEND_WINDOW);
      if (this.sent.length >= SEND_MAX) break;
      this.sent.push(now);
      const message = { title: String(g.name || 'Agent'), body: tx[g.kind] + (g.n > 1 ? tx.more(g.n) : '') };
      pushed.push(message);
      Promise.resolve(this.push(message)).catch(() => {});
    }
    return pushed;
  }
}

module.exports = { Notifier, barkUrl, send, SEND_MAX };
