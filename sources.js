'use strict';
// Read-only state readers. Nothing here writes to any agent's config.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { OTHERS, otherSessions } = require('./agents');
const { inspectSession, fullText } = require('./asks');
const { OpenCodeReader } = require('./opencode');

const MIN = 60 * 1000;
const PRIORITY = { waiting: 0, working: 1, done: 2 };

const DONE_DIM_AFTER = 30 * MIN; // finished a while ago: shown dimmed
const CODEX_STALE_RUNNING = 30 * MIN; // "running" but the log went silent
const CODEX_HIDE_DONE_AFTER = 2 * 60 * MIN;
const CODEX_MAX_AGE = 12 * 60 * MIN;
const TAIL_BYTES = 256 * 1024;

const label = (name, cwd) => (name && String(name).trim()) || (cwd ? path.basename(cwd) : null);

// ---------------------------------------------------------------- Claude Code
// ~/.claude/sessions/<pid>.json: status is "busy" | "waiting" | "idle".
function pidAlive(pid) {
  if (!Number.isInteger(pid)) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function claudeSessions({ dir, now = Date.now(), alive = pidAlive, asks, inspect = inspectSession } = {}) {
  dir = dir || path.join(os.homedir(), '.claude', 'sessions');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    let d;
    try {
      d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    if (!d || (d.kind && d.kind !== 'interactive')) continue;
    if (!alive(d.pid)) continue;
    let state = { busy: 'working', waiting: 'waiting', idle: 'done' }[d.status];
    if (!state) continue;
    let since = Number(d.statusUpdatedAt || d.updatedAt) || now;
    // An idle session can still wait for the user: a next-step box in the Claude desktop app.
    let ask = null;
    let reply = null;
    if (state === 'done' && d.sessionId) {
      const info = asks ? { ask: asks(d.sessionId, d.cwd) } : inspect(d.sessionId, d.cwd);
      ask = info.ask;
      reply = info.reply || null;
      if (ask) {
        state = 'waiting';
        since = Math.max(since, ask.at || 0);
      }
    }
    out.push({
      agent: 'claude',
      id: d.sessionId || f,
      label: label(d.name, d.cwd),
      state,
      since,
      dim: state === 'done' && now - since > DONE_DIM_AFTER,
      // The Claude desktop app's own id for this session; its claude://code/continue link only takes this form.
      ...(typeof d.hostSessionId === 'string' && /^local_[A-Za-z0-9-]{1,64}$/.test(d.hostSessionId) ? { host: d.hostSessionId } : {}),
      ...(ask ? { ask } : {}),
      ...(state === 'done' && reply ? { reply } : {}),
    });
  }
  return out;
}

// --------------------------------------------------------------------- Codex
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, one JSON event per line.
const ASK_EVENT = /approval_request|request_user_input|request_permissions/;
const ASK_CALL = /^request_user_input/;

/** Reduce rollout lines (oldest first) to the last known turn state. */
function codexReduce(lines) {
  let running = false;
  let asking = false;
  let at = 0;
  let message = null;
  const open = new Map(); // call_id -> tool name
  for (const raw of lines) {
    let v;
    try {
      v = JSON.parse(raw);
    } catch {
      continue;
    }
    const ts = Date.parse(v.timestamp) || 0;
    const p = v.payload || {};
    if (v.type === 'event_msg') {
      const t = p.type || '';
      if (t === 'task_started') {
        running = true;
        asking = false;
        open.clear();
        message = null;
        at = ts || at;
      } else if (t === 'task_complete' || t === 'turn_aborted') {
        running = false;
        asking = false;
        open.clear();
        at = ts || at;
        message = t === 'task_complete' && typeof p.last_agent_message === 'string' && p.last_agent_message.trim() ? fullText(p.last_agent_message) : null;
      } else if (ASK_EVENT.test(t)) {
        asking = true;
        at = ts || at;
      } else if (t !== 'token_count' && t !== 'thread_settings_applied') {
        asking = false; // anything else means the agent moved on
      }
    } else if (v.type === 'response_item') {
      const t = p.type || '';
      if (/_call$/.test(t) && p.call_id) open.set(p.call_id, p.name || '');
      else if (/_call_output$/.test(t) && p.call_id) open.delete(p.call_id);
      if (/_call_output$/.test(t)) asking = false;
    }
  }
  const questioned = [...open.values()].some((n) => ASK_CALL.test(n));
  return { running, waiting: running && (asking || questioned), at, message };
}

function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // partial first line
    return lines.filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const nl = buf.indexOf(10);
    const first = buf.toString('utf8', 0, nl === -1 ? n : nl);
    return JSON.parse(first);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

const pad = (n) => String(n).padStart(2, '0');
function dayDirs(root, now) {
  return [0, 1].map((back) => {
    const d = new Date(now - back * 24 * 60 * MIN);
    return path.join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  });
}

const codexCache = new Map(); // file -> { mtime, size, session }

// `open`: the Codex app/CLI process is running. Then the row stays even when
// every session finished long ago (it shows the newest one, dimmed).
function codexSessions({ root, now = Date.now(), open = false } = {}) {
  root = root || path.join(os.homedir(), '.codex', 'sessions');
  const out = [];
  let newestHidden = null;
  for (const dir of dayDirs(root, now)) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(dir, f);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (now - st.mtimeMs > (open ? 2 * CODEX_MAX_AGE : CODEX_MAX_AGE)) continue;
      let hit = codexCache.get(file);
      if (!hit || hit.mtime !== st.mtimeMs || hit.size !== st.size) {
        try {
          const head = readHead(file);
          const meta = head && head.type === 'session_meta' ? head.payload || {} : {};
          const sub = meta.source && meta.source.subagent;
          hit = {
            mtime: st.mtimeMs,
            size: st.size,
            skip: !!sub,
            id: meta.id || f,
            label: label(meta.thread_name || meta.name, meta.cwd),
            r: codexReduce(readTail(file, TAIL_BYTES)),
          };
        } catch {
          continue;
        }
        codexCache.set(file, hit);
      }
      if (hit.skip) continue;
      const silent = now - st.mtimeMs;
      let state;
      let since = hit.r.at || st.mtimeMs;
      if (hit.r.running && (hit.r.waiting || silent <= CODEX_STALE_RUNNING)) state = hit.r.waiting ? 'waiting' : 'working';
      else {
        state = 'done';
        if (hit.r.running) since = st.mtimeMs; // abandoned mid-turn
      }
      const session = {
        agent: 'codex',
        id: hit.id,
        label: hit.label,
        state,
        since,
        dim: state === 'done' && now - since > DONE_DIM_AFTER,
        ...(state === 'done' && hit.r.running ? { abandoned: true } : {}), // went silent mid-turn: not a finished turn
        ...(state === 'done' && !hit.r.running && hit.r.message ? { reply: { text: hit.r.message, at: since, id: 'reply:' + hit.id + ':' + since } } : {}),
      };
      if (state === 'done' && now - since > CODEX_HIDE_DONE_AFTER) {
        if (!newestHidden || since > newestHidden.since) newestHidden = session;
        continue;
      }
      out.push(session);
    }
  }
  if (open && !out.length) {
    out.push(newestHidden || { agent: 'codex', id: 'codex', label: null, labelKey: 'open', state: 'done', since: now, dim: false });
  }
  return out;
}

// -------------------------------------------------------------------- Summary
const AGENTS = [
  { id: 'claude', name: 'Claude' },
  { id: 'codex', name: 'Codex' },
  ...OTHERS.map((a) => ({ id: a.id, name: a.name })),
];

/** One row per agent that has live sessions; state = waiting > working > done. */
function summarize(sessions) {
  const seen = new Set();
  sessions = sessions.filter((s) => {
    const k = s.agent + ':' + s.id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const rows = [];
  for (const a of AGENTS) {
    const list = sessions
      .filter((s) => s.agent === a.id)
      .sort((x, y) => PRIORITY[x.state] - PRIORITY[y.state] || y.since - x.since);
    if (!list.length) continue;
    rows.push({ id: a.id, name: a.name, state: list[0].state, top: list[0], sessions: list });
  }
  return rows;
}

const opencode = new OpenCodeReader();

// OpenCode: its own database says busy / idle / viewed. null when it cannot be read: then agents.js guesses from file activity.
function opencodeRows(others = {}) {
  if (others.only && !others.only.has('opencode')) return [];
  const running = others.running || new Set();
  const open = ['opencode.exe', 'opencode-cli.exe'].some((e) => running.has(e));
  const list = opencode.sessions({ now: others.now, open });
  if (list && !list.length && open) {
    const now = others.now || Date.now();
    list.push({ agent: 'opencode', id: 'opencode', label: null, labelKey: 'open', state: 'done', since: now, dim: false });
  }
  return list;
}

function collect(opts = {}) {
  const oc = opencodeRows(opts.others);
  const others = oc ? { ...opts.others, skip: new Set(['opencode']) } : opts.others;
  return summarize([...claudeSessions(opts.claude), ...codexSessions({ ...opts.codex, open: !!(opts.others && opts.others.running && opts.others.running.has('codex.exe')) }), ...(oc || []), ...otherSessions(others)]);
}

module.exports = { claudeSessions, codexSessions, codexReduce, summarize, collect, AGENTS };
