'use strict';
// Conversations for the phone: a PC-side index of recent Claude Code and Codex sessions, a transcript reader, and the model /
// thinking-effort lists a phone may choose from.
//
// Rules that keep this safe:
//  - the phone only ever names a conversation by an opaque key "agent:id"; the key is resolved through this index, so a file
//    path or a working directory never comes from the phone;
//  - model and effort are accepted only from the lists below (never passed through as free text);
//  - a transcript is read from the end of the file in bounded chunks, tool results and hidden reasoning are left out, and every
//    message is cut to a fixed length.
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_MSG = 6000;
const HEAD_BYTES = 1024 * 1024;
const LIST_TTL = 4000;
const KEY = /^(claude|codex|opencode|grok):([A-Za-z0-9][A-Za-z0-9_-]{6,80})$/;

const RECENT_MS = 3 * 60 * 1000;

function pidAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const CLAUDE_MODELS =['fable', 'opus', 'sonnet', 'haiku'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const OPENCODE_EFFORTS = ['medium', 'high'];

const clip = (s, n = MAX_MSG) => {
  s = String(s || '').replace(/\r\n/g, '\n').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
};

function readSlice(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

const parseLines = (text) => {
  const out = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {}
  }
  return out;
};

// Text the user did not type: injected reminders, command wrappers, instruction blocks.
const noise = (t) => /^\s*</.test(t) || /^\s*# AGENTS\.md/.test(t) || /^\s*Caveat:/.test(t) || /^\s*\[Request interrupted/.test(t);

function toolLine(name, input) {
  let o = input;
  if (typeof o === 'string') {
    try {
      o = JSON.parse(o);
    } catch {
      o = null;
    }
  }
  let hint = '';
  if (o && typeof o === 'object') {
    const v = o.description || o.command || o.cmd || o.file_path || o.filePath || o.target_file || o.path || o.pattern || o.query || o.url || o.prompt || '';
    hint = Array.isArray(v) ? v.join(' ') : String(v);
  }
  return clip(`${name}${hint ? ' · ' + hint.replace(/\s+/g, ' ') : ''}`, 160);
}

// ------------------------------------------------------------------ Claude
function claudeMessages(objs) {
  const out = [];
  for (const o of objs) {
    if (!o || o.isSidechain || o.isMeta) continue;
    const at = Date.parse(o.timestamp) || 0;
    const c = o.message && o.message.content;
    if (o.type === 'user') {
      const parts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text) : [];
      const t = parts.join('\n');
      if (t.trim() && !noise(t)) out.push({ role: 'user', text: clip(t), at });
    } else if (o.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (!b) continue;
        if (b.type === 'text' && String(b.text || '').trim() && b.text.trim() !== '(no content)') out.push({ role: 'assistant', text: clip(b.text), at });
        else if (b.type === 'tool_use') out.push({ role: 'tool', text: toolLine(b.name || 'tool', b.input), at });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------- Codex
function codexMessages(objs) {
  const out = [];
  for (const o of objs) {
    if (!o || o.type !== 'response_item' || !o.payload) continue;
    const p = o.payload;
    const at = Date.parse(o.timestamp) || 0;
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant') && Array.isArray(p.content)) {
      const t = p.content.filter((b) => b && (b.type === 'input_text' || b.type === 'output_text')).map((b) => b.text).join('\n');
      if (!t.trim()) continue;
      if (p.role === 'user' && noise(t)) continue;
      out.push({ role: p.role, text: clip(t), at });
    } else if (p.type === 'function_call') out.push({ role: 'tool', text: toolLine(p.name || 'tool', p.arguments), at });
    else if (p.type === 'local_shell_call' && p.action) out.push({ role: 'tool', text: toolLine('shell', { command: Array.isArray(p.action.command) ? p.action.command.join(' ') : p.action.command }), at });
  }
  return out;
}

const extractor = (agent) => (agent === 'claude' ? claudeMessages : agent === 'grok' ? grokMessages : codexMessages);

/** A run of tool calls becomes one row (the first few lines and a count): a long agent turn would otherwise fill the page. */
function collapseTools(msgs) {
  const out = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (m.role === 'tool' && last && last.role === 'tool') {
      last.lines.push(m.text);
      continue;
    }
    out.push(m.role === 'tool' ? { ...m, lines: [m.text] } : m);
  }
  return out.map((m) => {
    if (m.role !== 'tool') return m;
    const { lines, ...rest } = m;
    return { ...rest, text: lines.slice(0, 4).join('\n') + (lines.length > 4 ? `\n… +${lines.length - 4}` : '') };
  });
}

/** The last `limit` messages of a transcript: { messages, more }. Reads from the end in growing, bounded chunks. */
function readMessages(file, agent, { limit = 60, maxBytes = 24 * 1024 * 1024 } = {}) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { messages: [], more: false };
  }
  const extract = extractor(agent);
  let bytes = 384 * 1024;
  let msgs = [];
  let start = 0;
  for (;;) {
    start = Math.max(0, size - bytes);
    let text = readSlice(file, start, size - start);
    if (start > 0) {
      const i = text.indexOf('\n');
      text = i === -1 ? '' : text.slice(i + 1); // the first line is cut
    }
    msgs = extract(parseLines(text));
    if (msgs.length > limit || start === 0 || bytes >= maxBytes) break;
    bytes *= 4;
  }
  msgs = collapseTools(msgs);
  return { messages: msgs.slice(-limit), more: start > 0 || msgs.length > limit };
}

// --------------------------------------------------------------------- Index
function firstText(file, agent) {
  const objs = parseLines(readSlice(file, 0, Math.min(HEAD_BYTES, fs.statSync(file).size)));
  const first = extractor(agent)(objs).find((m) => m.role === 'user');
  return first ? clip(first.text.replace(/\s+/g, ' '), 90) : '';
}

class ChatIndex {
  constructor({ home = os.homedir(), now = () => Date.now(), limit = 40, openDb = openSqlite } = {}) {
    this.home = home;
    this.openDb = openDb;
    this.now = now;
    this.limit = limit;
    this.head = new Map(); // file -> { cwd, title, id }
    this.cache = null;
    this.at = 0;
  }

  claudeFiles() {
    const root = path.join(this.home, '.claude', 'projects');
    const out = [];
    let dirs = [];
    try {
      dirs = fs.readdirSync(root);
    } catch {
      return out;
    }
    for (const d of dirs) {
      let files;
      try {
        files = fs.readdirSync(path.join(root, d));
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const file = path.join(root, d, f);
        try {
          const st = fs.statSync(file);
          if (st.isFile()) out.push({ agent: 'claude', file, id: f.slice(0, -6), mtime: st.mtimeMs });
        } catch {}
      }
    }
    return out;
  }

  codexFiles() {
    const root = path.join(this.home, '.codex', 'sessions');
    const out = [];
    const sub = (p) => {
      try {
        return fs.readdirSync(p).filter((x) => /^\d+$/.test(x)).sort().reverse();
      } catch {
        return [];
      }
    };
    let days = 0;
    for (const y of sub(root))
      for (const m of sub(path.join(root, y)))
        for (const d of sub(path.join(root, y, m))) {
          if (++days > 90) return out; // only the most recent days are ever walked
          const dir = path.join(root, y, m, d);
          let files = [];
          try {
            files = fs.readdirSync(dir).filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'));
          } catch {}
          for (const f of files) {
            const file = path.join(dir, f);
            try {
              out.push({ agent: 'codex', file, id: f.replace(/\.jsonl$/, '').slice(-36), mtime: fs.statSync(file).mtimeMs });
            } catch {}
          }
          if (out.length >= this.limit * 2) return out;
        }
    return out;
  }

  info(e) {
    let h = this.head.get(e.file);
    if (h && h.done) return h;
    h = h || { cwd: '', title: '', id: e.id, done: false, skip: false };
    try {
      const objs = parseLines(readSlice(e.file, 0, Math.min(HEAD_BYTES, fs.statSync(e.file).size)));
      if (e.agent === 'claude') {
        const o = objs.find((x) => x && typeof x.cwd === 'string' && x.cwd);
        h.cwd = o ? o.cwd : '';
      } else {
        const meta = objs.find((x) => x && x.type === 'session_meta');
        const p = (meta && meta.payload) || {};
        h.cwd = typeof p.cwd === 'string' ? p.cwd : '';
        if (p.id) h.id = String(p.id);
        h.skip = !!(p.source && p.source.subagent);
        h.thread = typeof (p.thread_name || p.name) === 'string' ? p.thread_name || p.name : '';
      }
      const t = extractor(e.agent)(objs).find((m) => m.role === 'user');
      h.title = h.thread || (t ? clip(t.text.replace(/\s+/g, ' '), 90) : '');
      h.done = !!(h.title && h.cwd);
    } catch {}
    this.head.set(e.file, h);
    return h;
  }

  /** [{ key, agent, id, file, cwd, title, project, at }], newest first. */
  list(limit = this.limit) {
    if (this.cache && this.cacheLimit === limit && this.now() - this.at < LIST_TTL) return this.cache;
    const all = [...this.claudeFiles(), ...this.codexFiles()].sort((a, b) => b.mtime - a.mtime);
    const out = [];
    let more = false;
    for (const e of all) {
      if (out.length >= limit) {
        more = true;
        break;
      }
      const h = this.info(e);
      if (h.skip || !h.cwd) continue;
      const id = h.id || e.id;
      if (!KEY.test(`${e.agent}:${id}`)) continue;
      out.push({ key: `${e.agent}:${id}`, agent: e.agent, id, file: e.file, cwd: h.cwd, title: h.title || path.basename(h.cwd), project: path.basename(h.cwd) || h.cwd, at: e.mtime });
    }
    // OpenCode and Grok bring their own list (already ordered); merge by time and cut to the page size
    const extra = [];
    for (const o of openCodeList(openCodeDb(this.home), this.openDb, limit + 1)) {
      if (o.cwd) extra.push({ key: `opencode:${o.id}`, agent: 'opencode', id: o.id, file: openCodeDb(this.home), cwd: o.cwd, title: o.title || path.basename(o.cwd), project: path.basename(o.cwd) || o.cwd, at: o.at });
    }
    for (const g of grokList(this.home, limit + 1)) {
      if (g.cwd) extra.push({ key: `grok:${g.id}`, agent: 'grok', id: g.id, file: g.file, cwd: g.cwd, title: g.title || path.basename(g.cwd), project: path.basename(g.cwd) || g.cwd, at: g.at });
    }
    const merged = [...out, ...extra.filter((e) => KEY.test(e.key))].sort((a, b) => b.at - a.at);
    if (merged.length > limit) more = true;
    out.length = 0;
    out.push(...merged.slice(0, limit));
    this.cache = out;
    this.cacheLimit = limit;
    this.more = more;
    this.at = this.now();
    return out;
  }

  /** The last `limit` messages of a conversation: { messages, more }. */
  read(e, limit) {
    if (e.agent === 'opencode') return openCodeRead(e.file, this.openDb, e.id, limit);
    return readMessages(e.file, e.agent, { limit });
  }

  /**
   * Whether something on this computer may be writing the conversation right now: a Claude session that has this id and a live
   * process, or a transcript that changed in the last few minutes (the only signal Codex gives). Never trusts the phone.
   */
  live(e, { alive = pidAlive, recent = RECENT_MS, ownEnd = 0 } = {}) {
    let touched = 0;
    if (e.agent === 'opencode') touched = e.at; // the database file is shared by every chat: the chat's own time
    else {
      try {
        touched = fs.statSync(e.file).mtimeMs;
      } catch {}
    }
    // `ownEnd`: when the dock's own last turn here finished; a file that has not changed since then was written by the dock itself
    if (this.now() - touched < recent && !(ownEnd && touched <= ownEnd + 5000)) return true;
    if (e.agent !== 'claude') return false;
    return this.claudeLiveIds(alive).has(e.id);
  }

  /** Ids of Claude sessions with a live process (read from ~/.claude/sessions; cached for a moment on the real check). */
  claudeLiveIds(alive) {
    const cached = alive === pidAlive;
    if (cached && this.liveCache && this.now() - this.liveCache.at < 2000) return this.liveCache.ids;
    const ids = new Set();
    const dir = path.join(this.home, '.claude', 'sessions');
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {}
    for (const f of files) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (d && typeof d.sessionId === 'string' && alive(d.pid)) ids.add(d.sessionId);
      } catch {}
    }
    if (cached) this.liveCache = { at: this.now(), ids };
    return ids;
  }

  /** The entry for a phone-supplied key, or null. The key is only compared with what the index found. */
  find(key) {
    if (typeof key !== 'string' || !KEY.test(key)) return null;
    // the page the phone is looking at (whatever its size) first; anything else is looked up by id without touching that page
    return this.list(this.cacheLimit || this.limit).find((c) => c.key === key) || this.findDeep(key);
  }

  // A session older than the newest `limit` ones is still resolvable, by id, through the same scan.
  findDeep(key) {
    const [agent, id] = key.split(':');
    if (agent === 'opencode') {
      const o = openCodeGet(openCodeDb(this.home), this.openDb, id);
      return o && o.cwd ? { key, agent, id: o.id, file: openCodeDb(this.home), cwd: o.cwd, title: o.title || path.basename(o.cwd), project: path.basename(o.cwd), at: o.at } : null;
    }
    if (agent === 'grok') {
      const g = grokGet(this.home, id);
      return g ? { key, agent, id: g.id, file: g.file, cwd: g.cwd, title: g.title || path.basename(g.cwd), project: path.basename(g.cwd), at: g.at } : null;
    }
    const all = (agent === 'claude' ? this.claudeFiles() : this.codexFiles()).filter((f) => f.id === id); // an exact id, never a suffix
    for (const e of all) {
      const h = this.info(e);
      if (h.skip || !h.cwd) continue;
      return { key, agent, id: h.id || id, file: e.file, cwd: h.cwd, title: h.title || path.basename(h.cwd), project: path.basename(h.cwd), at: e.mtime };
    }
    return null;
  }
}

// ----------------------------------------------------------------- OpenCode
// One SQLite database (opened read-only): session_v2 lists the chats, session_message holds the messages in order.
function openCodeDb(home) {
  const base = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(base, 'opencode', 'opencode.db');
}

function openSqlite(file) {
  let Driver;
  try {
    Driver = require('better-sqlite3'); // optional, built for Electron (scripts/electron-sqlite.js)
  } catch {
    return null;
  }
  try {
    return new Driver(file, { readonly: true, fileMustExist: true, timeout: 2000 });
  } catch {
    return null;
  }
}

function openCodeMessages(rows) {
  const out = [];
  for (const r of rows) {
    let d;
    try {
      d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    } catch {
      continue;
    }
    if (!d) continue;
    const at = Number(d.time && d.time.created) || Number(r.time_created) || 0;
    if (r.type === 'user') {
      const t = String(d.text || '');
      if (t.trim() && !noise(t)) out.push({ role: 'user', text: clip(t), at });
    } else if (r.type === 'assistant' && Array.isArray(d.content)) {
      for (const b of d.content) {
        if (!b) continue;
        if (b.type === 'text' && String(b.text || '').trim()) out.push({ role: 'assistant', text: clip(b.text), at });
        else if (b.type === 'tool') out.push({ role: 'tool', text: toolLine(b.name || 'tool', b.state && b.state.input), at });
      }
    }
  }
  return out;
}

/** The newest chats (top-level, not archived): [{ id, cwd, title, at }]. */
function openCodeList(dbFile, openDb, limit) {
  const db = openDb(dbFile);
  if (!db) return [];
  try {
    return db
      .prepare('SELECT id, directory, title, time_updated FROM session_v2 WHERE parent_id IS NULL AND time_archived IS NULL ORDER BY time_updated DESC LIMIT ?')
      .all(limit)
      .map((r) => ({ id: String(r.id), cwd: String(r.directory || '').replace(/\//g, path.sep), title: String(r.title || ''), at: Number(r.time_updated) || 0 }));
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {}
  }
}

function openCodeGet(dbFile, openDb, id) {
  const db = openDb(dbFile);
  if (!db) return null;
  try {
    const r = db.prepare('SELECT id, directory, title, time_updated FROM session_v2 WHERE id = ? AND parent_id IS NULL').get(id);
    return r ? { id: String(r.id), cwd: String(r.directory || '').replace(/\//g, path.sep), title: String(r.title || ''), at: Number(r.time_updated) || 0 } : null;
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {}
  }
}

function openCodeRead(dbFile, openDb, id, limit) {
  const db = openDb(dbFile);
  if (!db) return { messages: [], more: false };
  try {
    const n = limit * 4 + 1;
    const rows = db.prepare('SELECT type, data, time_created FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT ?').all(id, n);
    const msgs = collapseTools(openCodeMessages(rows.slice(0, limit * 4).reverse()));
    return { messages: msgs.slice(-limit), more: rows.length >= n || msgs.length > limit };
  } catch {
    return { messages: [], more: false };
  } finally {
    try {
      db.close();
    } catch {}
  }
}

// ---------------------------------------------------------------------- Grok
// ~/.grok/sessions/<url-encoded folder>/<session id>/{summary.json, chat_history.jsonl}
function grokMessages(objs) {
  const out = [];
  for (const o of objs) {
    if (!o || o.synthetic_reason) continue;
    if (o.type === 'user' && Array.isArray(o.content)) {
      const t = o.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').replace(/^\s*<user_query>\s*/, '').replace(/\s*<\/user_query>\s*$/, '');
      if (t.trim() && !noise(t)) out.push({ role: 'user', text: clip(t), at: 0 });
    } else if (o.type === 'assistant') {
      if (typeof o.content === 'string' && o.content.trim()) out.push({ role: 'assistant', text: clip(o.content), at: 0 });
      for (const c of Array.isArray(o.tool_calls) ? o.tool_calls : []) if (c) out.push({ role: 'tool', text: toolLine(c.name || 'tool', c.arguments), at: 0 });
    }
  }
  return out;
}

/** One Grok session by id (its folder is named after it), without scanning the rest. */
function grokGet(home, id) {
  const root = path.join(home, '.grok', 'sessions');
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const dir = path.join(root, d, id);
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
      if (j && j.info && j.info.id === id && typeof j.info.cwd === 'string') return { id, cwd: j.info.cwd, title: String(j.generated_title || j.session_summary || ''), at: Date.parse(j.updated_at || j.last_active_at) || 0, file: path.join(dir, 'chat_history.jsonl') };
    } catch {}
  }
  return null;
}

function grokList(home, limit) {
  const root = path.join(home, '.grok', 'sessions');
  const found = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return [];
  }
  for (const d of dirs) {
    let subs = [];
    try {
      subs = fs.readdirSync(path.join(root, d));
    } catch {
      continue;
    }
    for (const s of subs) {
      const file = path.join(root, d, s, 'summary.json');
      try {
        found.push({ file, dir: path.join(root, d, s), mtime: fs.statSync(file).mtimeMs });
      } catch {}
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  for (const f of found.slice(0, limit)) {
    try {
      const j = JSON.parse(fs.readFileSync(f.file, 'utf8'));
      const id = j && j.info && j.info.id;
      const cwd = j && j.info && j.info.cwd;
      if (typeof id !== 'string' || typeof cwd !== 'string') continue;
      out.push({ id, cwd, title: String(j.generated_title || j.session_summary || ''), at: Date.parse(j.updated_at || j.last_active_at) || f.mtime, file: path.join(f.dir, 'chat_history.jsonl') });
    } catch {}
  }
  return out;
}

// ------------------------------------------------------------ model choices
function codexDefaultModel(home) {
  try {
    const m = /^\s*model\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'));
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/** { claude: { models, efforts }, codex: { models: [{ id, efforts }], default } }: the only values a phone may pick. */
function options({ home = os.homedir(), opencode = null } = {}) {
  const codex = { models: [], default: codexDefaultModel(home) };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'models_cache.json'), 'utf8'));
    for (const m of j.models || []) {
      if (!m || m.visibility !== 'list' || typeof m.slug !== 'string' || !/^[A-Za-z0-9._-]{1,60}$/.test(m.slug)) continue;
      const efforts = (m.supported_reasoning_levels || []).map((x) => x && x.effort).filter((x) => typeof x === 'string' && /^[a-z]{2,12}$/.test(x));
      codex.models.push({ id: m.slug, efforts, default: m.default_reasoning_level || '' });
    }
  } catch {}
  const agents = [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex', readOnly: true }];
  const out = { claude: { models: CLAUDE_MODELS, efforts: CLAUDE_EFFORTS }, codex };
  if (opencode) {
    agents.push({ id: 'opencode', name: 'OpenCode', readOnly: true });
    out.opencode = { models: (opencode.models || []).filter((m) => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(m)).slice(0, 200), efforts: OPENCODE_EFFORTS };
  }
  agents.push({ id: 'grok', name: 'Grok', chat: false }); // history only: its headless mode is not verified here
  return { agents, ...out };
}

/** Returns { model, effort } ('' = leave to the agent's own default) or null when a value is not on the lists. */
function choose(opts, agent, model, effort) {
  model = model == null ? '' : model;
  effort = effort == null ? '' : effort;
  if (typeof model !== 'string' || typeof effort !== 'string') return null;
  if (agent === 'claude' || agent === 'opencode') {
    const o = opts[agent];
    if (!o) return null;
    if (model && !o.models.includes(model)) return null;
    if (effort && !o.efforts.includes(effort)) return null;
    return { model, effort };
  }
  if (agent !== 'codex') return null;
  const m = model ? opts.codex.models.find((x) => x.id === model) : null;
  if (model && !m) return null;
  if (effort) {
    const base = m || opts.codex.models.find((x) => x.id === opts.codex.default); // no model picked: the agent's own default model
    const allowed = base ? base.efforts : [...new Set(opts.codex.models.flatMap((x) => x.efforts))];
    if (!allowed.includes(effort)) return null;
  }
  return { model, effort };
}

module.exports = { ChatIndex, readMessages, options, choose, claudeMessages, codexMessages, grokMessages, openCodeMessages, KEY, firstText, collapseTools };
