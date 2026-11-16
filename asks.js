'use strict';
// Pending questions of Claude sessions, read from the session's transcript (read-only).
//
// The Claude desktop app ends many turns with a "next step" box: a tool call of
// `mcp__ccd_turn__wrap_up` carrying a question (`ask`) and up to two answers (`actions`).
// A session offer (`mcp__ccd_session__start_session` with initiation "offer") is a similar box.
// Both wait for the user although the session itself is idle, so the registry file alone
// cannot tell. They stay pending until the user's next real message.
const fs = require('fs');
const os = require('os');
const path = require('path');

const WRAP_UP = 'mcp__ccd_turn__wrap_up';
const START_SESSION = 'mcp__ccd_session__start_session';
const TAIL_BYTES = 512 * 1024;
const MAX_TEXT = 600;

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const clip = (s, n = MAX_TEXT) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Claude Code's folder name for a working directory: everything but letters and digits becomes "-". */
function projectFolder(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

const missing = new Map(); // session id -> when a full search found nothing
const MISS_FOR = 30 * 1000;

function transcriptPath(sessionId, cwd, { home = os.homedir(), fsx = fs, now = Date.now() } = {}) {
  if (!/^[0-9a-f-]{8,64}$/i.test(String(sessionId))) return null;
  if (missing.has(sessionId) && now - missing.get(sessionId) < MISS_FOR) return null;
  const root = path.join(home, '.claude', 'projects');
  const direct = path.join(root, projectFolder(cwd || ''), `${sessionId}.jsonl`);
  if (fsx.existsSync(direct)) return direct;
  try {
    for (const d of fsx.readdirSync(root)) {
      const p = path.join(root, d, `${sessionId}.jsonl`);
      if (fsx.existsSync(p)) return p;
    }
  } catch {}
  missing.set(sessionId, now);
  return null;
}

// --- parsing one tool call -------------------------------------------------

const APP_ACTIONS = { commit: 'Commit', create_pr: 'Create PR', merge: 'Merge', fix_ci: 'Fix CI', address_comments: 'Address comments', resolve_conflicts: 'Resolve conflicts', verify: 'Verify', archive: 'Archive' };

/** A button of the next-step box: a plain reply (`label` + optional `message`) or one of the app's own actions. */
function button(action) {
  if (!action || typeof action !== 'object') return null;
  if (action.action) {
    const label = APP_ACTIONS[action.action];
    // The app's own actions run inside the app; the dock cannot trigger them, only show them.
    return label ? { label, appAction: action.action } : null;
  }
  const label = text(action.label);
  if (!label) return null;
  const message = text(action.message);
  return { label: clip(label, 80), message: message ? clip(message, 2000) : null };
}

function fromToolUse(block, at) {
  const input = block.input || {};
  if (block.name === WRAP_UP) {
    const recap = text(input.recap) || text(input.outcome);
    const question = text(input.ask) || text(input.next_ask) || text(input.next_brief);
    if (!recap || !question) return null;
    const raw = Array.isArray(input.actions) ? input.actions : Array.isArray(input.next_actions) ? input.next_actions : [];
    const needsUser = input.blocked === true || input.blocked === 'true' || !!text(input.needs_user);
    const options = raw.slice(0, 2).map(button).filter(Boolean);
    if (!needsUser && !options.length) return null;
    return { id: block.id, kind: 'next_step', question: clip(question), recap: clip(recap), options, at };
  }
  if (block.name === START_SESSION && input.initiation === 'offer') {
    const title = text(input.title);
    if (!title) return null;
    return { id: block.id, kind: 'offer', question: clip(title), recap: '', options: [{ label: 'New session', appAction: 'new_session' }, { label: 'Do it here', message: 'Do it here' }], at };
  }
  return null;
}

// --- finding the pending one -----------------------------------------------

const INJECTED = /^<(system-reminder|task-notification|local-command|command-name|ide_)/;
const isRealUserTurn = (entry) => {
  if (entry.type !== 'user' || entry.isMeta) return false;
  const c = entry.message && entry.message.content;
  if (typeof c === 'string') return text(c).length > 0 && !INJECTED.test(text(c));
  if (!Array.isArray(c)) return false;
  return c.some((b) => b && b.type === 'text' && text(b.text) && !INJECTED.test(text(b.text)));
};

/**
 * Reduce transcript lines (oldest first) to the pending ask, or null.
 * Pending = the newest next-step box / offer of the last turn, with no real user message after it.
 */
function pendingFromLines(lines) {
  let found = null;
  for (const raw of lines) {
    let e;
    try {
      e = JSON.parse(raw);
    } catch {
      continue;
    }
    if (isRealUserTurn(e)) {
      found = null; // the user spoke: whatever was open is answered
      continue;
    }
    if (e.type !== 'assistant') continue;
    const content = e.message && e.message.content;
    if (!Array.isArray(content)) continue;
    const at = Date.parse(e.timestamp) || 0;
    for (const block of content) {
      if (block && block.type === 'tool_use') {
        const ask = fromToolUse(block, at);
        if (ask) found = ask;
      }
    }
  }
  return found;
}

function readTailLines(file, bytes = TAIL_BYTES, fsx = fs) {
  const fd = fsx.openSync(file, 'r');
  try {
    const size = fsx.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fsx.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // partial first line
    return lines.filter(Boolean);
  } finally {
    fsx.closeSync(fd);
  }
}

const cache = new Map(); // file -> { mtime, size, ask }

/** The pending ask of a session, or null. Cached by the transcript's size and modification time. */
function pendingAsk(sessionId, cwd, opts = {}) {
  const file = transcriptPath(sessionId, cwd, opts);
  if (!file) return null;
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.ask;
  let ask = null;
  try {
    ask = pendingFromLines(readTailLines(file));
  } catch {}
  cache.set(file, { mtime: st.mtimeMs, size: st.size, ask });
  return ask;
}

module.exports = { pendingAsk, pendingFromLines, transcriptPath, projectFolder, fromToolUse, WRAP_UP };
