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
const KEY = /^(claude|codex):([A-Za-z0-9][A-Za-z0-9_-]{6,80})$/;

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
    const v = o.description || o.command || o.cmd || o.file_path || o.path || o.pattern || o.query || o.url || o.prompt || '';
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

const extractor = (agent) => (agent === 'claude' ? claudeMessages : codexMessages);

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
  constructor({ home = os.homedir(), now = () => Date.now(), limit = 40 } = {}) {
    this.home = home;
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
  list() {
    if (this.cache && this.now() - this.at < LIST_TTL) return this.cache;
    const all = [...this.claudeFiles(), ...this.codexFiles()].sort((a, b) => b.mtime - a.mtime);
    const out = [];
    for (const e of all) {
      if (out.length >= this.limit) break;
      const h = this.info(e);
      if (h.skip || !h.cwd) continue;
      const id = h.id || e.id;
      if (!KEY.test(`${e.agent}:${id}`)) continue;
      out.push({ key: `${e.agent}:${id}`, agent: e.agent, id, file: e.file, cwd: h.cwd, title: h.title || path.basename(h.cwd), project: path.basename(h.cwd) || h.cwd, at: e.mtime });
    }
    this.cache = out;
    this.at = this.now();
    return out;
  }

  /**
   * Whether something on this computer may be writing the conversation right now: a Claude session that has this id and a live
   * process, or a transcript that changed in the last few minutes (the only signal Codex gives). Never trusts the phone.
   */
  live(e, { alive = pidAlive, recent = RECENT_MS, ownEnd = 0 } = {}) {
    let touched = 0;
    try {
      touched = fs.statSync(e.file).mtimeMs;
    } catch {}
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
    let hit = this.list().find((c) => c.key === key);
    if (!hit) {
      this.cache = null; // a conversation started a moment ago must be found
      hit = this.list().find((c) => c.key === key) || this.findDeep(key);
    }
    return hit;
  }

  // A session older than the newest `limit` ones is still resolvable, by id, through the same scan.
  findDeep(key) {
    const [agent, id] = key.split(':');
    const all = (agent === 'claude' ? this.claudeFiles() : this.codexFiles()).filter((f) => f.id === id); // an exact id, never a suffix
    for (const e of all) {
      const h = this.info(e);
      if (h.skip || !h.cwd) continue;
      return { key, agent, id: h.id || id, file: e.file, cwd: h.cwd, title: h.title || path.basename(h.cwd), project: path.basename(h.cwd), at: e.mtime };
    }
    return null;
  }
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
function options({ home = os.homedir() } = {}) {
  const codex = { models: [], default: codexDefaultModel(home) };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'models_cache.json'), 'utf8'));
    for (const m of j.models || []) {
      if (!m || m.visibility !== 'list' || typeof m.slug !== 'string' || !/^[A-Za-z0-9._-]{1,60}$/.test(m.slug)) continue;
      const efforts = (m.supported_reasoning_levels || []).map((x) => x && x.effort).filter((x) => typeof x === 'string' && /^[a-z]{2,12}$/.test(x));
      codex.models.push({ id: m.slug, efforts, default: m.default_reasoning_level || '' });
    }
  } catch {}
  return { claude: { models: CLAUDE_MODELS, efforts: CLAUDE_EFFORTS }, codex };
}

/** Returns { model, effort } ('' = leave to the agent's own default) or null when a value is not on the lists. */
function choose(opts, agent, model, effort) {
  model = model == null ? '' : model;
  effort = effort == null ? '' : effort;
  if (typeof model !== 'string' || typeof effort !== 'string') return null;
  if (agent === 'claude') {
    if (model && !opts.claude.models.includes(model)) return null;
    if (effort && !opts.claude.efforts.includes(effort)) return null;
    return { model, effort };
  }
  const m = model ? opts.codex.models.find((x) => x.id === model) : null;
  if (model && !m) return null;
  if (effort) {
    const base = m || opts.codex.models.find((x) => x.id === opts.codex.default); // no model picked: the agent's own default model
    const allowed = base ? base.efforts : [...new Set(opts.codex.models.flatMap((x) => x.efforts))];
    if (!allowed.includes(effort)) return null;
  }
  return { model, effort };
}

module.exports = { ChatIndex, readMessages, options, choose, claudeMessages, codexMessages, KEY, firstText };
