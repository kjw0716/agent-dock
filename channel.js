'use strict';
// The folder Agent Dock and its Claude Code plugin share (<data>/channel):
//   sessions/<sessionId>.json        written by the plugin every 5 s: "this session can take an answer"
//   prompts/<sessionId>/<id>.json    written here: an answer the user clicked; the plugin submits it when idle
//   prompts/<sessionId>/<id>.cancel  written here: withdraw a prompt the plugin has not claimed yet
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CHECK_IN_LIFETIME = 20 * 1000; // a session that has not checked in for this long does not run the plugin
const PROMPT_LIFETIME = 2 * 60 * 1000; // a click acts at once; one the session cannot take in two minutes lapses
const KEEP_FILES = 60 * 60 * 1000;
const MAX_TEXT = 2000;
const SESSION_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PROMPT_ID = /^[0-9a-f]{16}$/;

const validSession = (id) => typeof id === 'string' && SESSION_ID.test(id);

/** Strip what must never reach the session as words: escape sequences and control characters. */
function clean(text) {
  return String(text)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-_]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim();
}

/** Why `text` may not be sent, or null. A leading / ! or # would run a command, bash mode or a memory note. */
function refusal(text) {
  const t = clean(text);
  if (!t) return 'The answer is empty';
  if (t.length > MAX_TEXT) return 'The answer is too long';
  if (/^[\/!#]/.test(t)) return 'An answer cannot start with / ! or #';
  return null;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file); // the plugin never reads half a file
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

class Channel {
  constructor(dir) {
    this.dir = dir;
  }

  prepare() {
    fs.mkdirSync(path.join(this.dir, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(this.dir, 'prompts'), { recursive: true });
  }

  /** Session ids that checked in recently and have not ended. */
  loaded(now = Date.now()) {
    const out = new Set();
    let names = [];
    try {
      names = fs.readdirSync(path.join(this.dir, 'sessions'));
    } catch {
      return out;
    }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const id = n.slice(0, -5);
      if (!validSession(id)) continue;
      const file = path.join(this.dir, 'sessions', n);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (now - st.mtimeMs >= CHECK_IN_LIFETIME) continue;
      const v = readJson(file);
      if (v && v.ended === undefined) out.add(id);
    }
    return out;
  }

  promptFile(sessionId, id) {
    return path.join(this.dir, 'prompts', sessionId, `${id}.json`);
  }

  /** Leave words for a session. Returns { ok, id } or { ok: false, error }. */
  leave({ sessionId, askId, text, now = Date.now(), id = crypto.randomBytes(8).toString('hex') }) {
    if (!validSession(sessionId)) return { ok: false, error: 'Unknown session' };
    const why = refusal(text);
    if (why) return { ok: false, error: why };
    if (!this.loaded(now).has(sessionId)) return { ok: false, error: 'This session has not loaded the Agent Dock plugin' };
    writeJson(this.promptFile(sessionId, id), { id, askId: String(askId || ''), text: clean(text), at: now, expiresAt: now + PROMPT_LIFETIME });
    return { ok: true, id };
  }

  /** Where a prompt stands: waiting, taken, started, refused, cancelled or expired (gone = null). */
  state(sessionId, id, now = Date.now()) {
    if (!validSession(sessionId) || !PROMPT_ID.test(String(id))) return null;
    const v = readJson(this.promptFile(sessionId, id));
    if (!v) return null;
    if (v.refused !== undefined) return { state: 'refused', reason: String(v.refused) };
    if (v.cancelledAt !== undefined) return { state: 'cancelled' };
    if (v.expiredAt !== undefined || (v.startedAt === undefined && v.takenAt === undefined && typeof v.expiresAt === 'number' && v.expiresAt <= now)) return { state: 'expired' };
    if (v.startedAt !== undefined) return { state: 'started' };
    if (v.takenAt !== undefined) return { state: 'taken' };
    return { state: 'waiting' };
  }

  /** Withdraw a prompt the plugin has not claimed; harmless for one it has. */
  cancel(sessionId, id) {
    if (!validSession(sessionId) || !PROMPT_ID.test(String(id))) return;
    try {
      fs.writeFileSync(this.promptFile(sessionId, id).slice(0, -5) + '.cancel', '1');
    } catch {}
  }

  /** Delete old prompt and check-in files. */
  cleanup(now = Date.now()) {
    const old = (file) => {
      try {
        return now - fs.statSync(file).mtimeMs > KEEP_FILES;
      } catch {
        return false;
      }
    };
    const walk = (dir) => {
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const n of names) {
        const f = path.join(dir, n);
        let st;
        try {
          st = fs.statSync(f);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          walk(f);
          try {
            fs.rmdirSync(f); // only succeeds when empty
          } catch {}
        } else if (old(f)) {
          try {
            fs.rmSync(f, { force: true });
          } catch {}
        }
      }
    };
    walk(path.join(this.dir, 'prompts'));
    walk(path.join(this.dir, 'sessions'));
  }
}

module.exports = { Channel, clean, refusal, validSession, CHECK_IN_LIFETIME, PROMPT_LIFETIME, MAX_TEXT };
