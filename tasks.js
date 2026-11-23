'use strict';
// New tasks started from the phone: a headless `claude -p` or `codex exec` in a folder the dock already knows.
//
// Safety rules, all enforced here:
//  - off unless the user switched it on on THIS computer (the phone can never switch it on);
//  - the folder must be one of the allowed ones (known projects, resolved to their real path), never a path from the phone as is;
//  - the prompt goes in on STDIN, never on the command line, and nothing runs through a shell;
//  - the permission level is the user's own setting: 'edits' (Claude: only the file tools, no shell, no MCP servers; Codex: read-only sandbox) or 'full' (no prompts at all);
//  - at most four tasks at once, a time limit, and every child is killed with its whole process tree.
const { spawn: nodeSpawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const MAX_PROMPT = 8000;
const MAX_RUNNING = 4;
const MAX_KEPT = 30;
const TIME_LIMIT = 60 * 60 * 1000;
const MAX_TEXT = 4000;

const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const real = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
};

/** A real, existing local directory (absolute, never a network path), or null. */
function localDir(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return null;
  const sep = (c) => c === '/' || c === '\\';
  const unc = (x) => sep(x[0]) && sep(x[1]); // \\server\share and \\?\UNC\...
  if (process.platform === 'win32' && (unc(p) || !/^[A-Za-z]:/.test(p) || !sep(p[2]))) return null;
  const r = real(p);
  if (!r) return null;
  if (process.platform === 'win32' && unc(r) && !(r.slice(2, 4) === '?\\' && /^[A-Za-z]:/.test(r.slice(4)))) return null;
  try {
    return fs.statSync(r).isDirectory() ? r : null;
  } catch {
    return null;
  }
}

const inside = (root, p) => {
  const a = process.platform === 'win32' ? root.toLowerCase() : root;
  const b = process.platform === 'win32' ? p.toLowerCase() : p;
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
};

/** claude.exe: on PATH or in the usual places. Never a .cmd shim (those need a shell). */
function findClaude({ env = process.env, exists = (p) => fs.existsSync(p) } = {}) {
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links'), path.join(env.USERPROFILE || '', '.local', 'bin'));
  for (const d of dirs) {
    const f = path.join(d, process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (exists(f)) return f;
  }
  return null;
}

/** Codex: its node script from the global npm folder (the .cmd/.ps1 shims need a shell). */
function findCodex({ env = process.env, exists = (p) => fs.existsSync(p) } = {}) {
  const roots = [path.join(env.APPDATA || '', 'npm', 'node_modules'), path.join(env.ProgramFiles || '', 'nodejs', 'node_modules')];
  for (const r of roots) {
    const f = path.join(r, '@openai', 'codex', 'bin', 'codex.js');
    if (exists(f)) return f;
  }
  return null;
}

function cleanEnv(base, extra = {}) {
  const env = { ...base, ...extra };
  for (const k of Object.keys(env)) if (/^AGENT_DOCK_/i.test(k)) delete env[k];
  return env;
}

class TaskRunner {
  /**
   * opts: { mode() -> 'edits' | 'full', dirs() -> [absolute paths], spawn?, claude?, codex?, now?, kill? }
   */
  constructor({ mode, dirs, spawn = nodeSpawn, claude = () => findClaude(), codex = () => findCodex(), now = () => Date.now(), kill = killTree, onEnd = () => {} }) {
    this.onEnd = onEnd;
    this.mode = mode;
    this.dirs = dirs;
    this.spawn = spawn;
    this.claude = claude;
    this.codex = codex;
    this.now = now;
    this.kill = kill;
    this.tasks = [];
    this.seq = 0;
  }

  /** The allowed folders as [{ path, name }]. */
  folders() {
    const seen = new Set();
    const out = [];
    for (const d of this.dirs() || []) {
      const r = typeof d === 'string' ? real(d) : null;
      if (!r || seen.has(r.toLowerCase())) continue;
      try {
        if (!fs.statSync(r).isDirectory()) continue;
      } catch {
        continue;
      }
      seen.add(r.toLowerCase());
      out.push({ path: r, name: path.basename(r) || r });
    }
    return out;
  }

  list() {
    return this.tasks.map((t) => ({ id: t.id, agent: t.agent, session: t.session, from: t.from, fork: t.fork, dir: t.dirName, status: t.status, startedAt: t.startedAt, endedAt: t.endedAt, text: t.text, error: t.error, prompt: t.prompt.slice(0, 200) }));
  }

  running() {
    return this.tasks.filter((t) => t.status === 'running').length;
  }

  /** A new conversation in one of the allowed folders. */
  start({ agent, dir, prompt, model, effort }) {
    const folder = typeof dir === 'string' ? this.folders().find((f) => same(f.path, dir)) : null; // exact match only: the phone's string never reaches the file system
    if (!folder) return { ok: false, error: 'folder' };
    return this.launch({ agent, prompt, model, effort, cwd: folder.path, name: folder.name });
  }

  /**
   * One more message in an existing conversation. `session` and `cwd` come from the PC-side index (never from the phone);
   * `fork` continues it as a copy (`--fork-session` / `codex exec fork`), used when something else may hold the session.
   */
  resume({ agent, session, cwd, prompt, model, effort, fork }) {
    if (typeof session !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{6,80}$/.test(session)) return { ok: false, error: 'session' };
    const dir = localDir(cwd);
    if (!dir) return { ok: false, error: 'folder' };
    // Without full permissions a task stays inside the folders chosen on this computer.
    if (this.mode() !== 'full' && !this.folders().some((f) => inside(f.path, dir))) return { ok: false, error: 'outside' };
    if (this.tasks.some((t) => t.status === 'running' && (t.session === session || t.from === session))) return { ok: false, error: 'busy' };
    return this.launch({ agent, prompt, model, effort, cwd: dir, name: path.basename(dir) || dir, session, fork: !!fork });
  }

  launch({ agent, prompt, model, effort, cwd, name, session, fork }) {
    if (agent !== 'claude' && agent !== 'codex') return { ok: false, error: 'agent' };
    if (typeof prompt !== 'string' || !prompt.trim()) return { ok: false, error: 'prompt' };
    if (prompt.length > MAX_PROMPT || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt)) return { ok: false, error: 'prompt' };
    const word = /^[A-Za-z0-9._-]{1,60}$/;
    if ((model && !word.test(model)) || (effort && !/^[a-z]{2,12}$/.test(effort))) return { ok: false, error: 'model' };
    if (this.running() >= MAX_RUNNING) return { ok: false, error: 'busy' };
    const mode = this.mode() === 'full' ? 'full' : 'edits';

    let cmd;
    let args;
    let env = cleanEnv(process.env);
    let id = session || '';
    if (agent === 'claude') {
      cmd = this.claude();
      if (!cmd) return { ok: false, error: 'not installed' };
      if (!session || fork) id = randomUUID(); // a copy gets its own id up front, so the phone can follow it
      args = ['-p', '--output-format', 'stream-json', '--verbose', ...(session ? ['--resume', session, ...(fork ? ['--fork-session', '--session-id', id] : [])] : ['--session-id', id]), ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []), ...(mode === 'full' ? ['--dangerously-skip-permissions'] : ['--permission-mode', 'acceptEdits', '--tools', 'Read,Edit,Write,Glob,Grep', '--strict-mcp-config', '--restricted'])];
    } else {
      const script = this.codex();
      if (!script) return { ok: false, error: 'not installed' };
      cmd = process.execPath;
      env = cleanEnv(process.env, { ELECTRON_RUN_AS_NODE: '1' }); // Electron's own node runs codex's script
      const common = ['--json', '--skip-git-repo-check', ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : [])];
      if (session) args = [script, 'exec', fork ? 'fork' : 'resume', ...common, ...(mode === 'full' ? ['--dangerously-bypass-approvals-and-sandbox'] : ['-c', 'sandbox_mode="read-only"']), session, '-'];
      else args = [script, 'exec', ...common, '-C', cwd, ...(mode === 'full' ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--sandbox', 'read-only']), '-'];
      id = session && !fork ? session : ''; // a Codex copy learns its id from the thread.started event
    }
    if (agent === 'claude') delete env.ELECTRON_RUN_AS_NODE;
    const folder = { path: cwd, name };

    const task = { id: 't' + ++this.seq, agent, session: id, fork: !!fork, from: session || '', dirName: folder.name, status: 'running', startedAt: this.now(), endedAt: 0, text: '', error: '', prompt: prompt.trim(), child: null, buf: '' };
    let child;
    try {
      child = this.spawn(cmd, args, { cwd: folder.path, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      return { ok: false, error: 'spawn' };
    }
    task.child = child;
    this.tasks.push(task);
    if (this.tasks.length > MAX_KEPT) {
      const i = this.tasks.findIndex((t) => t.status !== 'running');
      if (i >= 0) this.tasks.splice(i, 1);
    }
    const settle = (status, error) => {
      if (task.status !== 'running') return;
      task.status = status;
      task.error = error || task.error;
      task.endedAt = this.now();
      clearTimeout(task.timer);
      try {
        this.onEnd(task);
      } catch {}
    };
    child.stdout.on('data', (d) => this.onOutput(task, agent, String(d)));
    child.stderr.on('data', (d) => {
      if (!task.error) task.error = String(d).split(/\r?\n/).find((l) => l.trim())?.slice(0, 300) || '';
    });
    child.on('error', () => settle('failed', 'spawn'));
    child.on('exit', (code) => {
      if (task.buf) this.line(task, agent, task.buf);
      if (task.status === 'running') settle(code === 0 && !task.failed ? 'done' : 'failed', code === 0 && !task.failed ? '' : task.error || 'exit ' + code);
    });
    task.timer = setTimeout(() => {
      settle('failed', 'time limit');
      this.kill(child);
    }, TIME_LIMIT);
    if (task.timer.unref) task.timer.unref();
    try {
      child.stdin.on('error', () => {});
      child.stdin.end(prompt.trim());
    } catch {}
    return { ok: true, id: task.id, session: task.session };
  }

  onOutput(task, agent, chunk) {
    task.buf += chunk;
    let i;
    while ((i = task.buf.indexOf('\n')) !== -1) {
      const line = task.buf.slice(0, i);
      task.buf = task.buf.slice(i + 1);
      this.line(task, agent, line);
    }
    if (task.buf.length > 1048576) task.buf = '';
  }

  line(task, agent, line) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    if (!o || typeof o !== 'object') return;
    const text = (v) => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : '');
    if (agent === 'claude') {
      if (o.type === 'result') {
        if (text(o.result)) task.text = text(o.result);
        if (o.is_error) {
          task.failed = true;
          task.error = text(o.result) || task.error || 'error';
        }
      } else if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
        const t = o.message.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
        if (t) task.text = text(t);
      }
    } else if (o.type === 'thread.started' && typeof o.thread_id === 'string' && /^[A-Za-z0-9_-]{7,81}$/.test(o.thread_id)) {
      if (!task.session) task.session = o.thread_id;
    } else if (o.item && o.item.type === 'agent_message' && text(o.item.text)) task.text = text(o.item.text);
    else if (o.type === 'turn.failed' || o.type === 'error') {
      task.failed = true;
      task.error = text(o.error && o.error.message) || text(o.message) || task.error || 'error';
    }
  }

  stop(id) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t || t.status !== 'running') return false;
    t.status = 'stopped';
    t.endedAt = this.now();
    clearTimeout(t.timer);
    this.kill(t.child);
    return true;
  }

  stopAll() {
    for (const t of this.tasks) if (t.status === 'running') this.stop(t.id);
  }
}

/** Kill a child and everything it started (Windows has no process groups to signal). */
function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {});
  else {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}

module.exports = { localDir, inside, TaskRunner, findClaude, findCodex, killTree, MAX_PROMPT, MAX_RUNNING };
