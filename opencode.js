'use strict';
// OpenCode keeps one row per chat in its own database (`session_v2`) with the app's own busy / idle / viewed
// timestamps, so its state is exact instead of a guess from file activity. Read-only.
//
//   busy:   time_busy is newer than time_idle (or there is no time_idle yet)
//   viewed: time_viewed is the last time the chat was looked at in the app; a finished turn is unread until then
//
// The database is read with better-sqlite3 (an optional dependency built for Electron, see scripts/electron-sqlite.js).
// Without it this reader reports "unavailable" and the dock falls back to the file-activity guess in agents.js.
const os = require('os');
const path = require('path');

const MIN = 60 * 1000;
const RECENT_WITHIN = 6 * 60 * MIN; // a finished chat older than this is hidden
const DIM_AFTER = 30 * MIN;
const MAX_CHATS = 8;
const STALE_BUSY = 3 * 60 * MIN; // "busy" for this long with no app running: the run was cut off

const defaultDb = () => path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');

function loadDriver() {
  try {
    return require('better-sqlite3');
  } catch {
    return null;
  }
}

const label = (title, dir) => {
  const t = title && String(title).trim();
  if (t && !/^untitled$/i.test(t)) return t;
  return dir ? path.basename(String(dir).replace(/[\\/]+$/, '')) || null : null;
};

/** Turn rows of session_v2 into dock sessions. `kids`: chat id -> { n, since } for subagent chats still running under it. */
function toSessions(rows, { now = Date.now(), open = false, kids = new Map() } = {}) {
  const out = [];
  for (const r of rows) {
    const busyAt = Number(r.time_busy) || 0;
    const idleAt = Number(r.time_idle) || 0;
    let state = busyAt && busyAt > idleAt ? 'working' : 'done';
    const sub = state === 'done' ? kids.get(String(r.id)) : null;
    if (sub) state = 'working'; // its own turn is over but a subagent it started is still busy
    let abandoned = false;
    if (state === 'working' && !open && now - busyAt > STALE_BUSY) {
      state = 'done'; // the app is gone and never wrote the idle mark
      abandoned = true;
    }
    const since = sub ? sub.since : state === 'working' ? busyAt : idleAt || Number(r.time_updated) || now;
    if (state === 'done' && now - since > RECENT_WITHIN) continue;
    out.push({
      agent: 'opencode',
      id: String(r.id),
      label: label(r.title, r.directory),
      title: r.title ? String(r.title) : '', // the tab's own name
      state,
      since,
      dim: state === 'done' && now - since > DIM_AFTER,
      exact: true, // the busy mark is the app's own, not a guess
      ...(sub ? { subagents: sub.n } : {}),
      viewedAt: Number(r.time_viewed) || 0,
      ...(abandoned ? { abandoned: true } : {}),
    });
  }
  return out;
}

const SQL = `select id, title, directory, time_busy, time_idle, time_viewed, time_updated
  from session_v2
  where parent_id is null and time_archived is null
  order by max(coalesce(time_busy, 0), coalesce(time_idle, 0), time_updated) desc
  limit ${MAX_CHATS * 3}`;

// Subagents are chats of their own (parent_id set) that carry the same busy / idle marks.
const BUSY_KIDS = `select id, parent_id, time_busy from session_v2
  where parent_id is not null and time_archived is null and time_busy > ? and (time_idle is null or time_busy > time_idle)`;
const PARENT = 'select parent_id from session_v2 where id = ?';

/** Top-level chat id -> { n, since } for the busy subagent chats below it (a subagent can start its own). */
function busyKids(db, now) {
  const kids = new Map();
  const up = db.prepare(PARENT);
  for (const k of db.prepare(BUSY_KIDS).all(now - STALE_BUSY)) {
    let root = k.parent_id;
    for (let i = 0; i < 6 && root; i++) {
      const p = up.get(root);
      if (!p || !p.parent_id) break;
      root = p.parent_id;
    }
    if (!root) continue;
    const cur = kids.get(String(root)) || { n: 0, since: Infinity };
    cur.n++;
    cur.since = Math.min(cur.since, Number(k.time_busy));
    kids.set(String(root), cur);
  }
  return kids;
}

class OpenCodeReader {
  constructor({ file, driver } = {}) {
    this.file = file;
    this.driver = driver; // undefined: load on first use
    this.db = null;
    this.failedAt = 0;
  }

  /** Dock sessions, or null when the database cannot be read (the caller then falls back to guessing). */
  sessions({ now = Date.now(), open = false } = {}) {
    const Driver = this.driver === undefined ? (this.driver = loadDriver()) : this.driver;
    if (!Driver) return null;
    if (!this.db) {
      if (now - this.failedAt < 10 * 1000) return null;
      try {
        this.db = new Driver(this.file || defaultDb(), { readonly: true, fileMustExist: true, timeout: 200 });
      } catch {
        this.failedAt = now;
        return null;
      }
    }
    try {
      const list = toSessions(this.db.prepare(SQL).all(), { now, open, kids: busyKids(this.db, now) });
      return list.slice(0, MAX_CHATS);
    } catch {
      try {
        this.db.close();
      } catch {}
      this.db = null; // reopen on the next call (the file may have been replaced, or the schema is a different version)
      this.failedAt = now;
      return null;
    }
  }
}

module.exports = { OpenCodeReader, toSessions, busyKids, label };
