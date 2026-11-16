'use strict';
// When did the user last open a session in the Claude desktop app? The app keeps one registry file per
// chat (`local_<id>.json`) and writes `lastFocusedAt` into it whenever the chat is brought up. A finished
// turn that was opened there after it finished has been seen, even if the dock itself was never clicked.
// Read-only.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MISS_FOR = 15 * 1000; // how long a "no such registry file" answer is trusted
const HOST_ID = /^local_[A-Za-z0-9-]{1,64}$/;

/** Folders that may hold the registry: the packaged app's data folder(s) and the classic roaming one. */
function defaultRoots({ env = process.env, home = os.homedir(), fsx = fs } = {}) {
  const roots = [];
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  try {
    const data = path.join(local, 'Claude-Data');
    for (const d of fsx.readdirSync(data)) roots.push(path.join(data, d, 'claude-code-sessions'));
  } catch {}
  roots.push(path.join(roaming, 'Claude', 'claude-code-sessions'));
  return roots;
}

class FocusReader {
  constructor({ roots, fsx = fs } = {}) {
    this.roots = roots; // undefined: look them up on demand
    this.fsx = fsx;
    this.files = new Map(); // host id -> [paths of its registry file]
    this.missed = new Map(); // host id -> when nothing was found
    this.values = new Map(); // path -> { mtime, at }
  }

  locate(host, now) {
    const known = this.files.get(host);
    if (known) return known;
    const missed = this.missed.get(host);
    if (missed !== undefined && now - missed < MISS_FOR) return [];
    const found = [];
    for (const root of this.roots || defaultRoots({ fsx: this.fsx })) {
      let outer = [];
      try {
        outer = this.fsx.readdirSync(root); // <account>/<organisation>/local_<id>.json
      } catch {
        continue;
      }
      for (const a of outer) {
        let inner = [];
        try {
          inner = this.fsx.readdirSync(path.join(root, a));
        } catch {
          continue;
        }
        for (const b of inner) {
          const p = path.join(root, a, b, host + '.json');
          if (this.fsx.existsSync(p)) found.push(p);
        }
      }
    }
    if (found.length) this.files.set(host, found);
    else this.missed.set(host, now);
    return found;
  }

  /** When the session was last brought up in the desktop app (ms), or 0 when unknown. */
  lastFocused(host, now = Date.now()) {
    if (!HOST_ID.test(String(host))) return 0;
    let best = 0;
    for (const p of this.locate(host, now)) {
      let st;
      try {
        st = this.fsx.statSync(p);
      } catch {
        continue;
      }
      let hit = this.values.get(p);
      if (!hit || hit.mtime !== st.mtimeMs) {
        let at = 0;
        try {
          at = Number(JSON.parse(this.fsx.readFileSync(p, 'utf8')).lastFocusedAt) || 0;
        } catch {}
        hit = { mtime: st.mtimeMs, at };
        this.values.set(p, hit);
      }
      best = Math.max(best, hit.at);
    }
    return best;
  }
}

module.exports = { FocusReader, defaultRoots };
