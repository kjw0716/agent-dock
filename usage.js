'use strict';
// Token usage, read from the transcripts the agents already write (read-only):
//   Claude  ~/.claude/projects/**/*.jsonl        one `message.usage` per assistant line (sub-agent files included)
//   Codex   ~/.codex/sessions/**/rollout-*.jsonl `token_usage_record` (newer) or `token_count` events (older)
//   OpenCode  ~/.local/share/opencode/opencode.db, table session_message (assistant rows: tokens, model, cost), read-only;
//             needs the optional better-sqlite3 build for Electron, without it OpenCode is left out
//   Grok    ~/.grok/sessions/**/updates.jsonl `turn_completed` (usage per model, and Grok's own cost)
//   Kilo, MiMo Code  SQLite `message` table (OpenCode's older layout), same reader as OpenCode
//   Gemini CLI  ~/.gemini/tmp/*/chats/*.jsonl, Qwen Code  ~/.qwen/projects/*/chats/*.jsonl
//   Pi, Oh My Pi  ~/.pi|.omp/agent/sessions/**.jsonl (usage per message, with cost), Kimi CLI  ~/.kimi/sessions/*/*/wire.jsonl
// Kilo, MiMo, Gemini, Qwen, Pi, Oh My Pi and Kimi are written from the projects' own source, not tested against real data of those agents.
//
// A first pass over a few GB would stall the dock, so the index is incremental: for every file it remembers how far
// it has read, and only complete lines are consumed. The result is kept in memory and in <data>/usage-index.json.
// Run it off the main thread (usage-worker.js).
//
// Numbers are normalised to four counters (all in tokens):
//   i  new input     cr  cache read     cw  cache write (cw1: the part written with the 1-hour lifetime)     o  output
// Codex counts cached input inside `input_tokens` and reasoning inside `output_tokens`; they are not counted twice.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const VERSION = 3;
const CHUNK = 16 * 1024 * 1024;
const MAX_SEEN = 2000000;
const MAX_MODELS_PER_SESSION = 6;

const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
const day = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const short = (id) => crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 10);

const SEEN = new WeakMap(); // index -> Set of short message-id hashes (kept in memory; written out by save)

function emptyIndex() {
  return { version: VERSION, files: {}, seen: [], days: {}, sessions: {}, titles: {}, sources: {} };
}

// ------------------------------------------------------------------ add
function addTo(bucket, u) {
  bucket.i = (bucket.i || 0) + u.i;
  bucket.o = (bucket.o || 0) + u.o;
  bucket.cr = (bucket.cr || 0) + u.cr;
  bucket.cw = (bucket.cw || 0) + u.cw;
  bucket.cw1 = (bucket.cw1 || 0) + (u.cw1 || 0);
  bucket.n = (bucket.n || 0) + 1;
  if (Number.isFinite(u.cost)) {
    // what the agent itself says the call cost (0 for a local or free model)
    bucket.rc = (bucket.rc || 0) + u.cost;
    bucket.rn = (bucket.rn || 0) + 1;
  }
}

/** One model call: `u` = { i, o, cr, cw, cw1 }, `at` ms, `ctx` the size of the prompt it saw. */
function record(index, { agent, sessionId, project, model, at, u, ctx, sub, cost }) {
  if (!Number.isFinite(at)) return; // a row without a usable time cannot be put on a day
  model = String(model || '?').replace(/\|/g, '/'); // '|' separates the fields of a group key
  project = project ? String(project).replace(/\|/g, '/') : project;
  if (Number.isFinite(cost)) u = { ...u, cost };
  if (!u.i && !u.o && !u.cr && !u.cw) return;
  const d = day(at);
  const days = index.days[d] || (index.days[d] = {});
  const key = [agent, model || '?', project || ''].join('|');
  addTo(days[key] || (days[key] = {}), u);

  const sk = agent + ':' + sessionId;
  const s = index.sessions[sk] || (index.sessions[sk] = { a: agent, id: String(sessionId), p: project || '', first: at, last: at, m: {}, i: 0, o: 0, cr: 0, cw: 0, cw1: 0, n: 0, sub: 0, ctx: 0, ctxMax: 0 });
  s.first = Math.min(s.first, at);
  if (at >= s.last) {
    s.last = at;
    if (ctx) s.ctx = ctx;
  }
  if (project && !s.p) s.p = project;
  const mk = model || '?';
  if (s.m[mk] || Object.keys(s.m).length < MAX_MODELS_PER_SESSION) s.m[mk] = (s.m[mk] || 0) + 1;
  s.i += u.i;
  s.o += u.o;
  s.cr += u.cr;
  s.cw += u.cw;
  s.cw1 += u.cw1 || 0;
  s.n += 1;
  if (Number.isFinite(u.cost)) {
    s.rc = (s.rc || 0) + u.cost;
    s.rn = (s.rn || 0) + 1;
  }
  if (sub) s.sub += u.i + u.o + u.cr + u.cw;
  if (ctx > s.ctxMax) s.ctxMax = ctx;
}

const MAX_TITLES = 20000;
function setTitle(index, agent, sessionId, title) {
  const t = String(title).trim().slice(0, 120);
  if (!t) return;
  const k = agent + ':' + sessionId;
  if (!index.titles) index.titles = {};
  if (!(k in index.titles) && Object.keys(index.titles).length >= MAX_TITLES) return;
  index.titles[k] = t;
}

// -------------------------------------------------------------- parsers
/** Claude Code: a transcript line -> usage, or null. */
function claudeUsage(obj) {
  const m = obj && obj.message;
  const usage = m && m.usage;
  if (!usage || typeof usage !== 'object') return null;
  const model = typeof m.model === 'string' ? m.model : '';
  if (!model || model.startsWith('<')) return null; // <synthetic>: not a model call
  const cc = usage.cache_creation || {};
  const cw = num(usage.cache_creation_input_tokens);
  const u = { i: num(usage.input_tokens), o: num(usage.output_tokens), cr: num(usage.cache_read_input_tokens), cw, cw1: Math.min(cw, num(cc.ephemeral_1h_input_tokens)) };
  return { model, id: typeof m.id === 'string' ? m.id : '', u, ctx: u.i + u.cr + u.cw };
}

/** Codex usage block ({ input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens }) -> counters. */
function codexUsage(x) {
  if (!x || typeof x !== 'object') return null;
  const input = num(x.input_tokens);
  const cached = Math.min(input, num(x.cached_input_tokens));
  const cw = Math.min(input - cached, num(x.cache_write_input_tokens));
  return { u: { i: input - cached - cw, o: num(x.output_tokens), cr: cached, cw, cw1: 0 }, ctx: input };
}

// ---------------------------------------------------------------- files
function walk(root, accept, out = []) {
  let list;
  try {
    list = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of list) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) walk(p, accept, out);
    else if (e.isFile() && accept(e.name, p)) out.push(p);
  }
  return out;
}

/** Read the complete lines after `from`. Returns { lines, next }: `next` is the offset after the last newline. */
function readLines(file, from, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const lines = [];
    let pos = from;
    let carry = Buffer.alloc(0);
    while (pos < size) {
      const len = Math.min(CHUNK, size - pos);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      pos += len;
      const all = carry.length ? Buffer.concat([carry, buf]) : buf;
      const cut = all.lastIndexOf(10);
      if (cut === -1) {
        carry = all;
        continue;
      }
      for (const l of all.subarray(0, cut).toString('utf8').split('\n')) if (l) lines.push(l);
      carry = all.subarray(cut + 1);
      if (lines.length > 200000) return { lines, next: pos - carry.length }; // keep memory bounded; the next scan continues
    }
    return { lines, next: pos - carry.length };
  } finally {
    fs.closeSync(fd);
  }
}

const projectOf = (cwd) => (cwd ? String(cwd) : '');

function scanClaudeFile(index, seen, file, fst, size) {
  const { lines, next } = readLines(file, fst.offset, size);
  for (const line of lines) {
    if (line.includes('"custom-title"') && !line.includes('"usage"')) {
      try {
        const o = JSON.parse(line);
        if (o.type === 'custom-title' && o.sessionId && typeof o.customTitle === 'string') setTitle(index, 'claude', o.sessionId, o.customTitle);
      } catch {}
      continue;
    }
    if (!line.includes('"usage"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const cu = claudeUsage(obj);
    if (!cu) continue;
    if (cu.id) {
      const h = short(cu.id);
      if (seen.has(h)) continue; // one API response is written on several lines, and resumed chats copy old ones
      seen.add(h);
    }
    const at = Date.parse(obj.timestamp) || fst.mtimeMs;
    if (obj.cwd) fst.cwd = obj.cwd;
    record(index, {
      agent: 'claude',
      sessionId: obj.sessionId || path.basename(file, '.jsonl'),
      project: projectOf(obj.cwd || fst.cwd),
      model: cu.model,
      at,
      u: cu.u,
      ctx: obj.isSidechain ? 0 : cu.ctx,
      sub: !!obj.isSidechain,
    });
  }
  fst.offset = next;
}

function scanCodexFile(index, file, fst, size) {
  const { lines, next } = readLines(file, fst.offset, size);
  for (const line of lines) {
    const rec = line.includes('"token_usage_record"');
    const cnt = !rec && line.includes('"token_count"');
    const meta = !rec && !cnt && (line.includes('"session_meta"') || line.includes('"turn_context"'));
    if (!rec && !cnt && !meta) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const p = obj.payload || {};
    if (obj.type === 'session_meta') {
      if (p.id) fst.sessionId = p.id;
      if (p.cwd) fst.cwd = p.cwd;
      const name = p.thread_name || p.name;
      if (p.id && typeof name === 'string') setTitle(index, 'codex', p.id, name);
      continue;
    }
    if (obj.type === 'turn_context') {
      if (typeof p.model === 'string') fst.model = p.model;
      if (p.cwd) fst.cwd = p.cwd;
      continue;
    }
    const at = Date.parse(obj.timestamp) || fst.mtimeMs;
    let cu = null;
    if (obj.type === 'token_usage_record') {
      fst.mode = 'record';
      if (p.response_id && p.response_id === fst.lastResponse) continue;
      fst.lastResponse = p.response_id;
      cu = codexUsage(p.usage);
    } else if (obj.type === 'event_msg' && p.type === 'token_count') {
      if (fst.mode === 'record') continue; // the same call is already counted from its record
      const info = p.info;
      if (!info) continue;
      const total = num(info.total_token_usage && info.total_token_usage.total_tokens);
      if (total && total === fst.prevTotal) continue; // a repeated event
      fst.prevTotal = total;
      cu = codexUsage(info.last_token_usage);
    }
    if (!cu) continue;
    record(index, { agent: 'codex', sessionId: fst.sessionId || path.basename(file, '.jsonl'), project: projectOf(fst.cwd), model: fst.model || '?', at, u: cu.u, ctx: cu.ctx });
  }
  fst.offset = next;
}

/** Grok: `turn_completed` carries the usage of the turn per model (input includes the cached part) and its own cost. */
function scanGrokFile(index, file, fst, size) {
  const { lines, next } = readLines(file, fst.offset, size);
  if (!fst.metaRead) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'summary.json'), 'utf8'));
      if (m && m.info && m.info.cwd) fst.cwd = m.info.cwd;
      if (m && m.info && m.info.id && typeof m.session_summary === 'string') setTitle(index, 'grok', m.info.id, m.session_summary);
      fst.metaRead = true; // not before it was read: Grok writes summary.json a little after the first turn
    } catch {}
  }
  for (const line of lines) {
    if (!line.includes('"turn_completed"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const p = obj.params || {};
    const up = p.update || {};
    if (up.sessionUpdate !== 'turn_completed' || !up.usage || typeof up.usage !== 'object') continue;
    const at = Number(p._meta && p._meta.agentTimestampMs) || (Number(obj.timestamp) ? Number(obj.timestamp) * 1000 : fst.mtimeMs);
    const sessionId = p.sessionId || path.basename(path.dirname(file));
    const perModel = up.usage.modelUsage && typeof up.usage.modelUsage === 'object' ? Object.entries(up.usage.modelUsage) : [['grok', up.usage]];
    for (const [model, x] of perModel) {
      if (!x || typeof x !== 'object') continue;
      const input = num(x.inputTokens);
      const cached = Math.min(input, num(x.cachedReadTokens));
      const cw = Math.min(input - cached, num(x.cacheCreationTokens));
      const ticks = Number(x.costUsdTicks);
      record(index, {
        agent: 'grok', sessionId, project: projectOf(fst.cwd), model, at,
        u: { i: input - cached - cw, o: num(x.outputTokens), cr: cached, cw, cw1: 0 },
        ctx: input,
        cost: Number.isFinite(ticks) ? ticks / 1e10 : undefined, // 1 tick = 1e-10 USD
      });
    }
  }
  fst.offset = next;
}

/** SQLite databases are opened read-only. */
function openSqlite(file) {
  let Driver;
  try {
    Driver = require('better-sqlite3'); // optional, built for Electron (scripts/electron-sqlite.js)
  } catch {
    return null;
  }
  return new Driver(file, { readonly: true, fileMustExist: true });
}
// The SQLite agents of the OpenCode family. `layout` 'v2': rows of `session_message` (type = 'assistant'), OpenCode today;
// 'v1': rows of `message` (data.role = 'assistant'), Kilo and MiMo Code. Tokens are disjoint buckets in both.
const SQLITE_AGENTS = [
  { agent: 'opencode', layout: 'v2', files: [['.local', 'share', 'opencode', 'opencode.db']] },
  { agent: 'kilo', layout: 'v1', files: [['.local', 'share', 'kilo', 'kilo.db']] },
  { agent: 'mimo', layout: 'v1', files: [['.local', 'share', 'mimocode', 'mimocode.db'], ['AppData', 'Local', 'mimocode', 'mimocode.db']] },
];
const Q_COMMON =
  "json_extract(data,'$.cost') as cost, json_extract(data,'$.tokens.input') as ti, json_extract(data,'$.tokens.output') as tout, " +
  "json_extract(data,'$.tokens.reasoning') as tr, json_extract(data,'$.tokens.cache.read') as tcr, json_extract(data,'$.tokens.cache.write') as tcw ";
const Q_MESSAGES = {
  v2: "select id, session_id, time_updated, json_extract(data,'$.time.completed') as done, json_extract(data,'$.model.id') as model, " + Q_COMMON +
    "from session_message where type = 'assistant' and time_updated > ? order by time_updated",
  v1: "select id, session_id, time_updated, json_extract(data,'$.time.completed') as done, coalesce(json_extract(data,'$.modelID'), json_extract(data,'$.model.id')) as model, " + Q_COMMON +
    "from message where json_extract(data,'$.role') = 'assistant' and time_updated > ? order by time_updated",
};
const Q_SESSIONS = { v2: 'select id, title, directory from session_v2', v1: 'select id, title, directory from session' };

/** Returns how many calls were added. */
function scanSqliteAgent(index, seen, { home, openDb = openSqlite, agent, layout, files }) {
  const file = files.map((f) => path.join(home, ...f)).find((f) => fs.existsSync(f));
  if (!file) return 0;
  let db = null;
  try {
    db = openDb(file);
  } catch {
    return 0;
  }
  if (!db) return 0;
  let added = 0;
  try {
    const dirs = new Map();
    try {
      for (const r of db.prepare(Q_SESSIONS[layout]).all()) {
        dirs.set(r.id, r.directory || '');
        if (r.title) setTitle(index, agent, r.id, r.title);
      }
    } catch {
      // no session table in this version: calls are counted without titles
    }
    if (!index.sources) index.sources = {};
    const src = index.sources[agent] || (index.sources[agent] = { since: 0 });
    const rows = db.prepare(Q_MESSAGES[layout]).all(src.since);
    let maxUpdated = src.since;
    for (const r of rows) {
      maxUpdated = Math.max(maxUpdated, Number(r.time_updated) || 0);
      if (!r.done) continue; // still streaming: read again next time
      const h = short(agent + ':' + r.id);
      if (seen.has(h)) continue;
      seen.add(h);
      const u = { i: num(r.ti), o: num(r.tout) + num(r.tr), cr: num(r.tcr), cw: num(r.tcw), cw1: 0 }; // reasoning is billed as output
      record(index, {
        agent, sessionId: r.session_id, project: projectOf(dirs.get(r.session_id)), model: r.model || '?',
        at: Number(r.done), u, ctx: u.i + u.cr + u.cw, cost: r.cost == null ? undefined : Number(r.cost),
      });
      added++;
    }
    // a row is only final once it completed: stay two minutes behind the newest one (the seen set stops double counting)
    src.since = Math.max(src.since, maxUpdated - 120000);
  } catch {
    // an unreadable database leaves what was counted so far
  } finally {
    try {
      db.close();
    } catch {}
  }
  return added;
}

/** Gemini CLI: `gemini` messages carry tokens { input (cached included), output, cached, thoughts, tool, total }. */
function scanGeminiFile(index, seen, file, fst, size) {
  const { lines, next } = readLines(file, fst.offset, size);
  const sessionId = path.basename(file).replace(/\.jsonl?$/, '');
  for (const line of lines) {
    if (!line.includes('"tokens"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || o.type !== 'gemini' || !o.tokens || typeof o.tokens !== 'object') continue;
    if (o.id) {
      const h = short('gemini:' + sessionId + ':' + o.id);
      if (seen.has(h)) continue;
      seen.add(h);
    }
    const x = o.tokens;
    const input = num(x.input);
    const cached = Math.min(input, num(x.cached));
    const u = { i: input - cached + num(x.tool), o: num(x.output) + num(x.thoughts), cr: cached, cw: 0, cw1: 0 }; // thoughts are billed as output
    record(index, { agent: 'gemini', sessionId, project: path.basename(path.dirname(path.dirname(file))), model: o.model || '?', at: Date.parse(o.timestamp) || fst.mtimeMs, u, ctx: input });
  }
  fst.offset = next;
}

/** Qwen Code: `assistant` records carry the raw usageMetadata (prompt includes cached; candidates include thoughts). */
function scanQwenFile(index, seen, file, fst, size) {
  const { lines, next } = readLines(file, fst.offset, size);
  const sessionId = path.basename(file).replace(/\.jsonl?$/, '');
  for (const line of lines) {
    if (!line.includes('"usageMetadata"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const m = o && o.usageMetadata;
    if (!o || o.type !== 'assistant' || !m || typeof m !== 'object') continue;
    const key = o.uuid || o.id;
    if (key) {
      const h = short('qwen:' + sessionId + ':' + key);
      if (seen.has(h)) continue;
      seen.add(h);
    }
    const input = num(m.promptTokenCount);
    const cached = Math.min(input, num(m.cachedContentTokenCount));
    const u = { i: input - cached, o: num(m.candidatesTokenCount), cr: cached, cw: 0, cw1: 0 };
    record(index, { agent: 'qwen', sessionId: o.sessionId || sessionId, project: projectOf(o.cwd) || path.basename(path.dirname(path.dirname(file))), model: o.model || '?', at: Date.parse(o.timestamp) || fst.mtimeMs, u, ctx: input });
  }
  fst.offset = next;
}

/** Pi and Oh My Pi: assistant messages and `usage` entries carry usage { input (uncached), output (reasoning inside), cacheRead, cacheWrite, cost{total} }. */
function scanPiFile(index, agent, file, fst, size) {
  const { lines, next } = readLines(file, fst.offset, size);
  const sessionId = path.basename(file).replace(/\.jsonl$/, '').replace(/^[^_]*_/, '');
  const project = path.basename(path.dirname(file));
  for (const line of lines) {
    if (!line.includes('"usage"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    let usage = null;
    let model = '';
    let at = 0;
    if (o && o.type === 'message' && o.message && o.message.role === 'assistant') {
      usage = o.message.usage;
      model = o.message.model;
      at = Number(o.message.timestamp) || Date.parse(o.timestamp);
    } else if (o && (o.type === 'usage' || o.type === 'model_usage')) {
      usage = o.usage;
      model = o.model;
      at = Date.parse(o.timestamp) || 0;
    }
    if (!usage || typeof usage !== 'object') continue;
    const cw = num(usage.cacheWrite);
    const total = usage.cost && Number(usage.cost.total);
    record(index, {
      agent, sessionId, project, model: model || '?', at: at || fst.mtimeMs,
      u: { i: num(usage.input), o: num(usage.output), cr: num(usage.cacheRead), cw, cw1: Math.min(cw, num(usage.cacheWrite1h)) },
      ctx: num(usage.input) + num(usage.cacheRead) + cw,
      cost: Number.isFinite(total) ? total : undefined,
    });
  }
  fst.offset = next;
}

/** Kimi CLI: `StatusUpdate` messages of wire.jsonl carry token_usage { input_other, output, input_cache_read, input_cache_creation }. The model name is not recorded. */
function scanKimiFile(index, seen, file, fst, size) {
  const { lines, next } = readLines(file, fst.offset, size);
  const sessionId = path.basename(path.dirname(file));
  for (const line of lines) {
    if (!line.includes('"token_usage"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const p = o && o.message && o.message.type === 'StatusUpdate' ? o.message.payload : null;
    const x = p && p.token_usage;
    if (!x || typeof x !== 'object') continue;
    if (p.message_id) {
      const h = short('kimi:' + sessionId + ':' + p.message_id);
      if (seen.has(h)) continue;
      seen.add(h);
    }
    const u = { i: num(x.input_other), o: num(x.output), cr: num(x.input_cache_read), cw: num(x.input_cache_creation), cw1: 0 };
    record(index, { agent: 'kimi', sessionId, project: '', model: 'kimi', at: Number(o.timestamp) ? Number(o.timestamp) * 1000 : fst.mtimeMs, u, ctx: u.i + u.cr + u.cw });
  }
  fst.offset = next;
}

/**
 * Bring the index up to date. `onFile` is called after each file (for progress). Returns what changed.
 * A transcript that vanished keeps its counts (Claude Code deletes old ones after 30 days). One that shrank was rewritten,
 * so its old counts cannot be taken back: the index is then rebuilt from what is still on disk, which loses the counts of
 * transcripts that are gone.
 */
function scan(index, { home = os.homedir(), onFile, budgetMs = Infinity, now = Date.now(), openDb } = {}) {
  const sources = [
    { agent: 'claude', files: walk(path.join(home, '.claude', 'projects'), (n) => n.endsWith('.jsonl')) },
    { agent: 'codex', files: walk(path.join(home, '.codex', 'sessions'), (n) => n.startsWith('rollout-') && n.endsWith('.jsonl')) },
    { agent: 'grok', files: walk(path.join(home, '.grok', 'sessions'), (n) => n === 'updates.jsonl') },
    { agent: 'gemini', files: walk(path.join(home, '.gemini', 'tmp'), (n, p) => n.endsWith('.jsonl') && /[\\/]chats[\\/]/.test(p)) },
    { agent: 'qwen', files: walk(path.join(home, '.qwen', 'projects'), (n, p) => n.endsWith('.jsonl') && /[\\/]chats[\\/]/.test(p)) },
    { agent: 'pi', files: walk(path.join(home, '.pi', 'agent', 'sessions'), (n) => n.endsWith('.jsonl')) },
    { agent: 'omp', files: walk(path.join(home, '.omp', 'agent', 'sessions'), (n) => n.endsWith('.jsonl')) },
    { agent: 'kimi', files: [path.join(home, '.kimi', 'sessions'), path.join(home, '.kimi-code', 'sessions')].flatMap((d) => walk(d, (n) => n === 'wire.jsonl')) },
  ];
  const known = new Set(sources.flatMap((s) => s.files));
  let rebuilt = false;
  for (const f of Object.keys(index.files)) {
    let st = null;
    try {
      st = fs.statSync(f);
    } catch {}
    const gone = !st && !known.has(f);
    if (gone) continue; // an archived or deleted transcript keeps its counts
    if (st && st.size < index.files[f].offset) {
      Object.assign(index, emptyIndex());
      SEEN.delete(index);
      rebuilt = true;
      break;
    }
  }
  let seen = SEEN.get(index);
  if (!seen) {
    seen = new Set(index.seen);
    SEEN.set(index, seen);
  }
  const t0 = Date.now();
  let files = 0;
  let complete = true;
  for (const { agent, files: list } of sources) {
    for (const file of list) {
      if (Date.now() - t0 > budgetMs) {
        complete = false;
        break;
      }
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      const fst = index.files[file] || (index.files[file] = { offset: 0 });
      fst.mtimeMs = st.mtimeMs;
      if (st.size === fst.offset) continue;
      try {
        if (agent === 'claude') scanClaudeFile(index, seen, file, fst, st.size);
        else if (agent === 'grok') scanGrokFile(index, file, fst, st.size);
        else if (agent === 'gemini') scanGeminiFile(index, seen, file, fst, st.size);
        else if (agent === 'qwen') scanQwenFile(index, seen, file, fst, st.size);
        else if (agent === 'pi' || agent === 'omp') scanPiFile(index, agent, file, fst, st.size);
        else if (agent === 'kimi') scanKimiFile(index, seen, file, fst, st.size);
        else scanCodexFile(index, file, fst, st.size);
        files++;
      } catch {}
      if (onFile) onFile(file);
    }
    if (!complete) break;
  }
  if (complete) for (const sq of SQLITE_AGENTS) if (scanSqliteAgent(index, seen, { home, openDb, ...sq }) > 0) files++;
  index.scannedAt = now;
  return { files, rebuilt, complete };
}

// ----------------------------------------------------------------- store
function load(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (v && v.version === VERSION && v.files && v.days && v.sessions) return { ...emptyIndex(), ...v };
  } catch {}
  return emptyIndex();
}

function save(file, index) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const seen = SEEN.get(index);
    fs.writeFileSync(tmp, JSON.stringify(seen ? { ...index, seen: [...seen].slice(-MAX_SEEN) } : index));
    fs.renameSync(tmp, file);
  } catch {}
}

// ----------------------------------------------------------------- query
const sum = (b) => ({ i: b.i || 0, o: b.o || 0, cr: b.cr || 0, cw: b.cw || 0, cw1: b.cw1 || 0, n: b.n || 0, rc: b.rc || 0, rn: b.rn || 0 });
const addAll = (a, b) => {
  a.i += b.i || 0;
  a.o += b.o || 0;
  a.cr += b.cr || 0;
  a.cw += b.cw || 0;
  a.cw1 += b.cw1 || 0;
  a.n += b.n || 0;
  return a;
};
const zero = () => ({ i: 0, o: 0, cr: 0, cw: 0, cw1: 0, n: 0 });
// The cost of one bucket: the price table first; for a model it does not know, the cost the agent itself reported
// (only when it reported one for every call; a reported 0 counts as 0, which is right for a local model but is also what
// some agents write for a model they have no price for); otherwise null = unpriced.
const costOf = (price, agent, model, b) => {
  const c = price(agent, model, b);
  if (c !== null) return c;
  return b.rn && b.rn === b.n ? b.rc : null;
};
const total = (b) => b.i + b.o + b.cr + b.cw;

/**
 * Totals for the days from..to (YYYY-MM-DD, inclusive) grouped three ways. `price(agent, model, counters)` may
 * return a cost in USD, or null when the model has no price (then it counts as unpriced, never as free).
 */
function summary(index, { from, to, price = () => null, sessionsFrom, limit = 200 } = {}) {
  const all = zero();
  const byDay = {};
  const byAgent = {};
  const byModel = {};
  const byProject = {};
  const byAM = {}; // "agent|model"
  const byAP = {}; // "agent|project"
  let cost = 0;
  const unpriced = new Set();
  for (const d of Object.keys(index.days)) {
    if ((from && d < from) || (to && d > to)) continue;
    for (const [key, raw] of Object.entries(index.days[d])) {
      const [agent, model, project] = key.split('|');
      const b = sum(raw);
      addAll(all, b);
      const c = costOf(price, agent, model, b);
      if (c === null) unpriced.add(model);
      else cost += c;
      const slot = (map, k) => map[k] || (map[k] = { ...zero(), cost: 0 });
      for (const [map, k] of [[byAgent, agent], [byModel, model], [byProject, project || '?'], [byAM, agent + '|' + model], [byAP, agent + '|' + (project || '?')]]) {
        const s = slot(map, k);
        addAll(s, b);
        if (c !== null) s.cost += c;
        else s.unp = (s.unp || 0) + b.n; // calls with no price
      }
      const dd = byDay[d] || (byDay[d] = { total: 0, cost: 0, agents: {}, agentCost: {}, models: {}, projects: {} });
      dd.total += total(b);
      if (c !== null) {
        dd.cost += c;
        dd.agentCost[agent] = (dd.agentCost[agent] || 0) + c;
      }
      dd.agents[agent] = (dd.agents[agent] || 0) + total(b);
      dd.models[model] = (dd.models[model] || 0) + total(b);
      dd.projects[project || '?'] = (dd.projects[project || '?'] || 0) + total(b);
    }
  }
  const minTime = sessionsFrom || 0;
  const inRange = Object.values(index.sessions).filter((s) => s.last >= minTime);
  const sessionCount = inRange.length;
  const titles = index.titles || {};
  const sessions = inRange
    .sort((x, y) => y.last - x.last)
    .slice(0, limit)
    .map((s) => {
      let c = 0;
      let priced = true;
      for (const [model, n] of Object.entries(s.m)) {
        // a session's counters are not split per model: split them by call count, which is exact for one model
        const calls = Object.values(s.m).reduce((x, y) => x + y, 0) || 1;
        const share = n / calls;
        const v = costOf(price, s.a, model, { i: s.i * share, o: s.o * share, cr: s.cr * share, cw: s.cw * share, cw1: s.cw1 * share, n: s.n * share, rc: (s.rc || 0) * share, rn: (s.rn || 0) * share });
        if (v === null) priced = false;
        else c += v;
      }
      return { ...s, title: titles[s.a + ':' + s.id] || '', cost: priced ? c : null };
    });
  return { totals: { ...all, tokens: total(all), cost, unpriced: [...unpriced] }, sessionCount, byDay, byAgent, byModel, byProject, byAM, byAP, sessions, scannedAt: index.scannedAt || 0 };
}

module.exports = { scan, load, save, summary, emptyIndex, claudeUsage, codexUsage, record, day, VERSION };
