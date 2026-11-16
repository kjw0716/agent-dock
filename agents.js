'use strict';
// Registry of the other coding agents (everything except Claude Code and Codex,
// which have their own readers in sources.js).
//
// There is no passive "waiting for you" signal for these, so each agent only
// ever reports working (its session files were written a moment ago) or done
// (its app is open, or it was active recently). Paths come from the upstream
// agent-hud-open discovery tables; only OpenCode has been checked on a real
// machine, the rest are unverified (see README).
const fs = require('fs');
const os = require('os');
const path = require('path');

const MIN = 60 * 1000;
const WORKING_WITHIN = 12 * 1000; // session store written this recently => working
const RECENT_WITHIN = 6 * 60 * MIN; // without a running app, hide after this
const DIM_AFTER = 30 * MIN;

const H = (...p) => ({ home: p });
const A = (...p) => ({ appData: p });
const D = (...p) => ({ dataHome: p }); // XDG-style ~/.local/share, as opencode uses on Windows

/** id, name, files/dirs written while the agent works, extra "installed" evidence, executables. */
const firstSeen = new Map(); // agent id -> when it was first noticed open with no file activity
const OTHERS = [
  { id: 'opencode', name: 'OpenCode', watch: [D('opencode', 'opencode.db-wal'), D('opencode', 'opencode.db'), D('opencode', 'storage', 'message')], installed: [D('opencode')], exe: ['opencode.exe', 'opencode-cli.exe'], verified: true },
  { id: 'kilo', name: 'Kilo Code', watch: [D('kilo', 'kilo.db-wal'), D('kilo', 'kilo.db')], installed: [D('kilo')], exe: ['kilo.exe', 'kilocode.exe'] },
  { id: 'mimo', name: 'MiMo Code', watch: [D('mimocode', 'mimocode.db-wal'), D('mimocode', 'mimocode.db')], installed: [D('mimocode')], exe: [] },
  { id: 'cursor', name: 'Cursor', watch: [H('.cursor', 'chats'), H('.cursor', 'projects')], installed: [H('.cursor'), A('Cursor')], exe: ['cursor.exe'] },
  { id: 'copilot', name: 'Copilot', watch: [H('.copilot', 'session-state'), H('.copilot', 'session-store.db')], installed: [H('.copilot')], exe: [] },
  { id: 'gemini', name: 'Gemini CLI', watch: [H('.gemini', 'tmp')], installed: [H('.gemini')], exe: ['gemini.exe'] },
  { id: 'antigravity', name: 'Antigravity', watch: [H('.gemini', 'antigravity', 'conversations'), H('.gemini', 'antigravity-cli', 'conversations')], installed: [H('.gemini', 'antigravity'), H('.gemini', 'antigravity-cli')], exe: ['antigravity.exe', 'agy.exe'] },
  { id: 'grok', name: 'Grok', watch: [H('.grok', 'sessions')], installed: [H('.grok')], exe: ['grok.exe'] },
  { id: 'deepseek', name: 'DeepSeek', watch: [H('.dsh', 'sessions')], installed: [H('.dsh')], exe: ['dsh.exe'] },
  { id: 'kimi', name: 'Kimi', watch: [H('.kimi-code', 'sessions'), H('.kimi', 'sessions')], installed: [H('.kimi-code'), H('.kimi')], exe: ['kimi.exe'] },
  { id: 'pi', name: 'Pi', watch: [H('.pi', 'agent', 'sessions')], installed: [H('.pi')], exe: [] },
  { id: 'omp', name: 'Oh My Pi', watch: [H('.omp', 'agent', 'sessions')], installed: [H('.omp')], exe: [] },
  { id: 'openclaw', name: 'OpenClaw', watch: [H('.openclaw', 'agents'), H('.clawdbot', 'agents')], installed: [H('.openclaw'), H('.clawdbot')], exe: ['openclaw.exe'] },
  { id: 'hermes', name: 'Hermes', watch: [H('.hermes', 'state.db-wal'), H('.hermes', 'state.db')], installed: [H('.hermes')], exe: [] },
  { id: 'droid', name: 'Droid', watch: [H('.factory', 'sessions')], installed: [H('.factory')], exe: ['droid.exe'] },
  { id: 'trae', name: 'TRAE', watch: [], installed: [A('Trae'), A('TRAE'), H('.trae')], exe: ['trae.exe'] },
  { id: 'qoder', name: 'Qoder', watch: [H('.qoder', 'projects'), A('Qoder', 'SharedClientCache', 'cli', 'projects')], installed: [H('.qoder'), A('Qoder')], exe: ['qoder.exe', 'qodercli.exe'] },
  { id: 'zcode', name: 'ZCode', watch: [H('.zcode', 'cli', 'db', 'db.sqlite-wal'), H('.zcode', 'cli', 'db', 'db.sqlite')], installed: [H('.zcode')], exe: ['zcode.exe'] },
  { id: 'codebuddy', name: 'CodeBuddy', watch: [H('.codebuddy', 'projects')], installed: [H('.codebuddy'), A('CodeBuddy')], exe: ['codebuddy.exe'] },
  { id: 'workbuddy', name: 'WorkBuddy', watch: [H('.workbuddy', 'projects')], installed: [H('.workbuddy'), A('WorkBuddy')], exe: ['workbuddy.exe'] },
  { id: 'qwen', name: 'Qwen Code', watch: [H('.qwen', 'projects')], installed: [H('.qwen')], exe: [] },
  { id: 'devin', name: 'Devin', watch: [D('devin', 'cli', 'sessions.db')], installed: [D('devin')], exe: ['devin.exe'] },
  { id: 'cline', name: 'Cline', watch: [A('Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks'), H('.cline', 'data', 'sessions')], installed: [H('.cline'), A('Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev')], exe: [] },
  { id: 'roo', name: 'Roo Code', watch: [A('Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'tasks')], installed: [A('Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline')], exe: [] },
  { id: 'goose', name: 'Goose', watch: [A('Block', 'goose', 'data', 'sessions'), D('goose', 'sessions')], installed: [A('Block', 'goose'), D('goose')], exe: ['goose.exe'] },
];

function resolve(loc, env = {}) {
  const home = env.home || os.homedir();
  const appData = env.appData || process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  if (loc.home) return path.join(home, ...loc.home);
  if (loc.appData) return path.join(appData, ...loc.appData);
  if (loc.dataHome) return path.join(home, '.local', 'share', ...loc.dataHome);
  return null;
}

/** Newest modification time under a file or directory (depth-limited, entry-capped). */
function newest(target, { depth = 3, cap = 250, fsx = fs } = {}) {
  let best = 0;
  let seen = 0;
  const walk = (p, d) => {
    if (seen++ > cap) return;
    let st;
    try {
      st = fsx.statSync(p);
    } catch {
      return;
    }
    if (st.mtimeMs > best) best = st.mtimeMs;
    if (!st.isDirectory() || d <= 0) return;
    let names = [];
    try {
      names = fsx.readdirSync(p);
    } catch {
      return;
    }
    for (const n of names) walk(path.join(p, n), d - 1);
  };
  walk(target, depth);
  return best;
}

function exists(p, fsx = fs) {
  try {
    fsx.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Which of the registry's agents look installed on this machine. */
function installedIds(env, fsx = fs) {
  return OTHERS.filter((a) => a.installed.some((l) => exists(resolve(l, env), fsx))).map((a) => a.id);
}

/**
 * One pseudo-session per agent that is open or was active recently.
 * `running` is a Set of lowercase executable names currently running.
 */
function otherSessions({ now = Date.now(), env = {}, running = new Set(), fsx = fs, only, skip } = {}) {
  const out = [];
  for (const a of OTHERS) {
    if (only && !only.has(a.id)) continue;
    if (skip && skip.has(a.id)) continue; // read exactly elsewhere
    let at = 0;
    for (const w of a.watch) at = Math.max(at, newest(resolve(w, env), { fsx }));
    const open = a.exe.some((e) => running.has(e.toLowerCase()));
    if (!open && !(at && now - at <= RECENT_WITHIN)) {
      firstSeen.delete(a.id);
      continue;
    }
    const age = at ? now - at : Infinity;
    const state = age <= WORKING_WITHIN ? 'working' : 'done';
    if (!firstSeen.has(a.id)) firstSeen.set(a.id, now);
    const since = at || firstSeen.get(a.id);
    out.push({
      agent: a.id,
      id: a.id,
      label: null,
      labelKey: open ? 'open' : 'recent',
      state,
      since,
      dim: state === 'done' && age > DIM_AFTER,
    });
  }
  return out;
}

module.exports = { OTHERS, resolve, newest, installedIds, otherSessions, WORKING_WITHIN };
