'use strict';
// Glues the phone pieces to the dock: the HTTP server (phone.js), Tailscale (tailscale.js) and push (bark.js).
// Nothing runs unless the user turns "Phone access" on in Settings.
const fs = require('fs');
const path = require('path');
const { PhoneServer } = require('./phone');
const { Notifier, send: barkSend } = require('./bark');
const tailscale = require('./tailscale');
const { TaskRunner } = require('./tasks');
const { ChatIndex, readMessages, options: chatOptions, choose: chooseOpts } = require('./chats');

const DEFAULT_PORT = 47821;
const MAX_READ = 400;
const STATUS_TTL = 8000;

const isLoopback = (a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';

class PhoneHost {
  /**
   * deps: { dataDir, readConfig, patchConfig, rows() (what the dock shows), answer(body), dismiss(body),
   *         assetsDir, iconFile, qr(text) -> svg, run? (tailscale runner), dev? }
   */
  constructor(deps) {
    this.d = deps;
    this.server = null;
    this.ts = { installed: false };
    this.tsAt = 0;
    this.lastPush = null; // { ok, error?, at }
    this.error = '';
    this.notifier = new Notifier({ push: (m) => this.push(m) });
    this.run = deps.run || null;
    this.index = deps.chatIndex || new ChatIndex();
    this.taskRunner = new TaskRunner({
      mode: () => (this.cfg().tasksFull ? 'full' : 'edits'),
      dirs: () => this.cfg().dirs || [],
      onEnd: (t) => this.push({ title: 'Agent Dock', body: t.status === 'done' ? (this.d.lang() === 'zh' ? '任务完成' : 'Task finished') : this.d.lang() === 'zh' ? '任务失败' : 'Task failed' }),
      ...(deps.taskOpts || {}),
    });
  }

  livePort() {
    return this.server ? this.server.port : this.cfg().port;
  }

  cfg() {
    return { enabled: false, port: DEFAULT_PORT, answer: true, tasks: false, tasksFull: false, dirs: [], ...(this.d.readConfig().phone || {}) };
  }

  barkAddress() {
    const b = this.d.readConfig().bark;
    return typeof b === 'string' ? b.trim() : '';
  }

  runner() {
    if (this.run) return this.run;
    const exe = tailscale.find();
    return exe ? tailscale.runner(exe) : null;
  }

  async refreshTailscale(force) {
    if (!force && Date.now() - this.tsAt < STATUS_TTL) return this.ts;
    const run = this.runner();
    if (!run) {
      this.ts = { installed: false };
    } else {
      const s = await tailscale.status(run);
      this.ts = { ...s, serving: s.state === 'Running' ? await tailscale.serving(run, this.livePort()) : false };
    }
    this.tsAt = Date.now();
    return this.ts;
  }

  // ------------------------------------------------------------ server
  secure(req) {
    if (!isLoopback(req.socket.remoteAddress)) return false;
    if (this.d.dev) return true; // local development without Tailscale
    if (req.headers['tailscale-funnel-request'] !== undefined) return false; // came from the public internet, never an action
    const host = String(req.headers.host || '').toLowerCase();
    // what `tailscale serve` adds; a funnel (public) request never carries the login header
    // Host is our tailnet name (or the loopback address, in case the proxy rewrites it: the server's own Host check already
    // rejects every other name) and the login header, which a web page cannot add to a request.
    const hostOk = (!!this.ts.host && host === this.ts.host.toLowerCase()) || host === `127.0.0.1:${this.server ? this.server.port : this.cfg().port}`;
    return hostOk && typeof req.headers['tailscale-user-login'] === 'string' && !!req.headers['tailscale-user-login'];
  }

  features() {
    return { answer: this.cfg().answer !== false, tasks: !!this.cfg().tasks, tasksFull: !!(this.cfg().tasks && this.cfg().tasksFull) };
  }

  /** One start/stop at a time, so a launch start and a Settings toggle cannot overlap. */
  queue(fn) {
    const run = (this.chain || Promise.resolve()).then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  start() {
    return this.queue(() => this.startNow());
  }

  async startNow() {
    if (!this.cfg().enabled || this.server) return;
    await this.refreshTailscale(true);
    if (!this.cfg().enabled || this.server) return; // switched off (or started) while waiting
    const server = new PhoneServer({
      dataDir: this.d.dataDir,
      port: this.cfg().port,
      hosts: () => [this.ts.host],
      secure: (req) => this.secure(req),
      assets: this.assets(),
      handlers: {
        state: () => ({ rows: this.d.rows() }),
        chats: () => this.chatList(),
        chat: (q) => this.chatRead(q),
        features: () => this.features(),
        answer: (b, dev) => (this.features().answer ? this.d.answer(b) : { ok: false, error: 'disabled' }),
        dismiss: (b) => (this.features().answer ? this.d.dismiss(b) : { ok: false, error: 'disabled' }),
        task: (b) => this.task(b),
      },
    });
    try {
      await server.start();
      this.server = server;
      setTimeout(() => { try { if (this.cfg().tasks) this.index.list(); } catch {} }, 50); // warm the conversation index before the first phone request
      this.error = '';
    } catch (e) {
      this.error = e && e.code === 'EADDRINUSE' ? 'port in use' : 'could not start';
    }
  }

  opts() {
    return this.d.chatOptions ? this.d.chatOptions() : chatOptions();
  }

  /** Running (or last) turn of a conversation, by its id. */
  turnOf(id) {
    const mine = this.taskRunner.list().filter((t) => t.session === id || t.from === id);
    const running = mine.find((t) => t.status === 'running');
    const last = mine[mine.length - 1];
    return { running: !!running, taskId: running ? running.id : null, last: last ? { status: last.status, error: last.error, fork: last.fork, session: last.session } : null };
  }

  /** Open on this computer? The dock's own finished turns do not count as someone else writing. */
  liveOf(e) {
    const ends = this.taskRunner.list().filter((t) => t.session === e.id && t.status !== 'running').map((t) => t.endedAt || 0);
    const running = this.taskRunner.list().some((t) => t.session === e.id && t.status === 'running');
    return !running && this.index.live(e, { ownEnd: ends.length ? Math.max(...ends) : 0 });
  }

  chatList() {
    if (!this.cfg().tasks) return { ok: false, error: 'disabled' };
    const chats = this.index.list().map((c) => ({ key: c.key, agent: c.agent, title: c.title, project: c.project, at: c.at, running: this.turnOf(c.id).running, live: this.liveOf(c) }));
    const tasks = this.taskRunner.list().map((t) => ({ id: t.id, agent: t.agent, session: t.session, status: t.status, error: t.error, fork: t.fork }));
    return { ok: true, chats, tasks, options: this.opts(), folders: this.taskRunner.folders(), full: !!this.cfg().tasksFull };
  }

  /** The phone polls an open conversation: do not read the file again while it has not changed. */
  readCached(e, limit) {
    let sig = '';
    try {
      const st = fs.statSync(e.file);
      sig = `${st.size}:${st.mtimeMs}`;
    } catch {}
    this.readMemo = this.readMemo || new Map();
    const k = `${e.file}|${limit}`;
    const hit = this.readMemo.get(k);
    if (hit && hit.sig === sig) return hit.r;
    const r = readMessages(e.file, e.agent, { limit });
    r.more = r.more && limit < MAX_READ;
    this.readMemo.set(k, { sig, r });
    if (this.readMemo.size > 12) this.readMemo.delete(this.readMemo.keys().next().value);
    return r;
  }

  chatRead(q) {
    if (!this.cfg().tasks) return { ok: false, error: 'disabled' };
    const e = this.index.find(q && q.key);
    if (!e) return { ok: false, error: 'not found' };
    const limit = Math.min(MAX_READ, Math.max(10, Number(q.limit) || 40));
    const { messages, more } = this.readCached(e, limit);
    return { ok: true, chat: { key: e.key, agent: e.agent, title: e.title, project: e.project, live: this.liveOf(e) }, messages, more, ...this.turnOf(e.id) };
  }

  task(b) {
    if (!this.cfg().tasks) return { ok: false, error: 'disabled' };
    if (!b || typeof b !== 'object') return { ok: false, error: 'bad request' };
    if (b.op === 'stop') return { ok: this.taskRunner.stop(String(b.id)) };
    const pick = chooseOpts(this.opts(), b.agent, b.model, b.effort);
    if (!pick) return { ok: false, error: 'model' };
    const base = { prompt: b.prompt, model: pick.model, effort: pick.effort };
    if (b.op === 'send') {
      const e = this.index.find(b.key);
      if (!e) return { ok: false, error: 'not found' };
      // A copy whenever something else may hold the conversation: it is open on this computer, or (Codex, which shows no process) the
      // dock did not start it itself. A conversation the dock started keeps being continued in place.
      const live = this.liveOf(e);
      const owned = this.taskRunner.list().some((t) => t.session === e.id);
      const fork = live || (e.agent === 'codex' && !owned);
      const p2 = chooseOpts(this.opts(), e.agent, b.model, b.effort);
      if (!p2) return { ok: false, error: 'model' };
      const r = this.taskRunner.resume({ agent: e.agent, session: e.id, cwd: e.cwd, prompt: b.prompt, model: p2.model, effort: p2.effort, fork });
      return r.ok ? { ...r, key: r.session ? `${e.agent}:${r.session}` : null, fork } : r;
    }
    const r = this.taskRunner.start({ agent: b.agent, dir: b.dir, ...base });
    return r.ok && r.session ? { ...r, key: `${b.agent}:${r.session}` } : r;
  }

  stop() {
    return this.queue(async () => {
      this.taskRunner.stopAll();
      const s = this.server;
      this.server = null;
      if (s) await s.stop();
    });
  }

  assets() {
    const dir = this.d.assetsDir;
    return {
      '/': { file: path.join(dir, 'app.html'), type: 'text/html; charset=utf-8' },
      '/manifest.webmanifest': { file: path.join(dir, 'manifest.webmanifest'), type: 'application/manifest+json' },
      '/icon.png': { file: this.d.iconFile, type: 'image/png' },
    };
  }

  // ------------------------------------------------------------ settings and actions
  async set(patch) {
    if (patch && typeof patch === 'object') {
      const cur = this.d.readConfig().phone || {};
      const next = { ...cur };
      if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
      if (typeof patch.answer === 'boolean') next.answer = patch.answer;
      if (typeof patch.tasks === 'boolean') {
        next.tasks = patch.tasks;
        if (!patch.tasks) {
          next.tasksFull = false; // full permissions never outlive the switch they hang on
          this.taskRunner.stopAll();
        }
      }
      if (typeof patch.tasksFull === 'boolean') next.tasksFull = patch.tasksFull && next.tasks === true;
      this.d.patchConfig({ phone: next });
      if (typeof patch.bark === 'string') {
        const v = patch.bark.trim();
        if (v === '' || /^https?:\/\//i.test(v)) this.d.patchConfig({ bark: v });
      }
    }
    if (this.cfg().enabled) await this.start();
    else {
      await this.stop();
      const run = this.runner();
      if (run) {
        await this.refreshTailscale(true); // not the cache: whatever is published right now
        if (this.ts.serving) await tailscale.unserve(run); // nothing stays published when the phone feature is off
        this.ts = { ...this.ts, serving: false };
      }
    }
    return this.info();
  }

  async setupTailscale() {
    const run = this.runner();
    if (!run) return { ok: false, error: 'not installed' };
    await this.refreshTailscale(true);
    if (this.ts.state !== 'Running') return { ok: false, error: this.ts.state || 'not running' };
    if (!this.ts.https) return { ok: false, error: 'https' };
    if (!this.cfg().enabled) return { ok: false, error: 'off' };
    if (!this.server) await this.start();
    if (!this.server) return { ok: false, error: this.error || 'could not start' };
    const other = await tailscale.otherOn443(run, this.livePort());
    if (other === 'funnel') return { ok: false, error: 'funnel' };
    if (other) return { ok: false, error: 'busy443' };
    const r = await tailscale.serve(run, this.livePort());
    await this.refreshTailscale(true);
    return r;
  }

  /** A fresh one-time pairing: { url, code, expiresAt, qr }. */
  async pair() {
    if (!this.server) return { ok: false, error: 'off' };
    await this.refreshTailscale(true);
    const p = this.server.newPairing();
    const viaTailscale = !!(this.ts.host && this.ts.serving);
    const base = viaTailscale ? `https://${this.ts.host}` : `http://127.0.0.1:${this.server.port}`;
    const url = `${base}/pair#c=${p.code}`;
    return { ok: true, url, code: p.code, expiresAt: p.expiresAt, qr: this.d.qr(url), viaTailscale };
  }

  /** The folders phone tasks may run in are chosen on this computer only. */
  addDir(dir) {
    const cur = this.cfg().dirs || [];
    if (typeof dir !== 'string' || !dir || cur.some((d) => d.toLowerCase() === dir.toLowerCase())) return;
    this.d.patchConfig({ phone: { ...(this.d.readConfig().phone || {}), dirs: [...cur, dir].slice(-30) } });
  }

  removeDir(dir) {
    const cur = this.cfg().dirs || [];
    this.d.patchConfig({ phone: { ...(this.d.readConfig().phone || {}), dirs: cur.filter((d) => d !== dir) } });
  }

  revoke(id) {
    if (!this.server) return false;
    if (id === 'all') {
      this.server.revokeAll();
      return true;
    }
    return this.server.revoke(String(id));
  }

  async push(message) {
    const addr = this.barkAddress();
    if (!addr) return { ok: false, error: 'address' };
    await this.refreshTailscale(false);
    const url = this.ts.host && this.ts.serving ? `https://${this.ts.host}/` : undefined;
    const r = await barkSend(addr, { ...message, url });
    this.lastPush = { ok: r.ok, error: r.error || (r.ok ? '' : String(r.status || 'failed')), at: Date.now() };
    return r;
  }

  testPush() {
    return this.push({ title: 'Agent Dock', body: 'Test' });
  }

  /** Call after each scan with the rows the dock shows. */
  observe(rows, lang) {
    if (this.cfg().enabled && this.barkAddress()) this.notifier.observe(rows, lang);
  }

  async info() {
    const c = this.cfg();
    const ts = await this.refreshTailscale(false);
    const b = this.barkAddress();
    let barkHost = '';
    try {
      barkHost = b ? new URL(b).host : '';
    } catch {}
    return {
      enabled: c.enabled,
      answer: c.answer !== false,
      running: !!this.server,
      port: c.port,
      error: this.error,
      tailscale: ts,
      devices: this.server ? this.server.listDevices() : [],
      log: this.server ? this.server.log.slice(-12) : [],
      bark: barkHost, // the host only: the key stays in the config file
      lastPush: this.lastPush,
      tasks: c.tasks,
      tasksFull: c.tasksFull && c.tasks,
      dirs: c.dirs || [],
    };
  }
}

module.exports = { PhoneHost, DEFAULT_PORT };
