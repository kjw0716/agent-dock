'use strict';
// Web Push to the paired phones (iPhone home-screen web apps from iOS 16.4, Android browsers): no third-party app or address.
//
//  - The dock makes a VAPID key pair once and keeps it in <data>/push-keys.json (in your account's data folder). The public half goes to the page so
//    the phone can subscribe; the private half never leaves this file.
//  - A phone's subscription (an address at Apple's / Google's / Mozilla's push service plus two keys) is stored on its device
//    record in phone.json, so revoking the phone removes it.
//  - The address a phone hands over is only ever POSTed to if it belongs to a known push service (https, a fixed list of hosts):
//    a paired phone cannot make the dock call an arbitrary address.
//  - The payload is encrypted for that phone by the web-push library; the push service only sees that a message exists.
//    The text is the agent's name and what happened, nothing more.
const fs = require('fs');
const path = require('path');

const HOSTS = [
  /^fcm\.googleapis\.com$/, // Chrome / Android
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /^[a-z0-9.-]*\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/, // Safari / iOS home-screen apps
  /^[a-z0-9.-]*\.push\.apple\.com$/,
  /^[a-z0-9.-]*\.notify\.windows\.com$/, // Edge
];
const B64URL = /^[A-Za-z0-9_-]{16,128}$/;
const SUBJECT = 'https://github.com/kjw0716/agent-dock'; // shown to the push service; no personal address

/** { endpoint, p256dh, auth } for a subscription from the page, or null when it is not acceptable. */
function cleanSubscription(sub) {
  if (!sub || typeof sub !== 'object') return null;
  const keys = sub.keys || {};
  if (typeof sub.endpoint !== 'string' || sub.endpoint.length > 600 || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return null;
  let u;
  try {
    u = new URL(sub.endpoint);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  if (!HOSTS.some((r) => r.test(u.hostname.toLowerCase()))) return null;
  if (!B64URL.test(keys.p256dh) || !B64URL.test(keys.auth)) return null;
  return { endpoint: u.href, p256dh: keys.p256dh, auth: keys.auth };
}

class PushSender {
  constructor({ dataDir, webpush } = {}) {
    this.file = path.join(dataDir, 'push-keys.json');
    this.dataDir = dataDir;
    this.webpush = webpush || null;
    this.keys = null;
  }

  lib() {
    if (!this.webpush) this.webpush = require('web-push');
    return this.webpush;
  }

  /** { publicKey, privateKey }, made on first use. */
  vapid() {
    if (this.keys) return this.keys;
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (v && typeof v.publicKey === 'string' && typeof v.privateKey === 'string') return (this.keys = v);
    } catch {}
    const k = this.lib().generateVAPIDKeys();
    this.keys = { publicKey: k.publicKey, privateKey: k.privateKey };
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.keys), { mode: 0o600 });
    } catch {}
    return this.keys;
  }

  publicKey() {
    return this.vapid().publicKey;
  }

  /**
   * targets: [{ id, endpoint, p256dh, auth }]; payload: { title, body, open? }.
   * Resolves { sent, gone: [ids whose subscription the push service says no longer exists], failed }.
   */
  async send(targets, payload) {
    const out = { sent: 0, gone: [], failed: 0 };
    if (!targets.length) return out;
    let k;
    try {
      k = this.vapid();
    } catch {
      out.failed = targets.length; // the push library could not load: nothing sent, nothing thrown at the caller
      return out;
    }
    const body = JSON.stringify({ title: String(payload.title || 'Agent Dock').slice(0, 80), body: String(payload.body || '').slice(0, 160), ...(payload.open ? { open: String(payload.open).slice(0, 120) } : {}), tag: payload.tag || '' });
    await Promise.all(
      targets.map(async (t) => {
        try {
          await this.lib().sendNotification({ endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth } }, body, { TTL: 3600, urgency: 'high', timeout: 10000, vapidDetails: { subject: SUBJECT, publicKey: k.publicKey, privateKey: k.privateKey } });
          out.sent++;
        } catch (e) {
          // 404/410: the phone removed it. 401/403: it was made for a different key pair (this file was lost): it can never work again
          if (e && [401, 403, 404, 410].includes(e.statusCode)) out.gone.push(t.id);
          else out.failed++;
        }
      })
    );
    return out;
  }
}

module.exports = { PushSender, cleanSubscription, HOSTS };
