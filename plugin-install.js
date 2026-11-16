'use strict';
// Installs and removes Agent Dock's Claude Code plugin (claude-plugin/) with Claude's own CLI,
// only when the user flips the switch in Settings. Nothing else in Claude's settings is touched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const NAME = 'agent-dock';
const PLUGIN_ID = `${NAME}@${NAME}`;
const TEMPLATE = path.join(__dirname, 'claude-plugin');
const PLACEHOLDER = '__AGENT_DOCK_CHANNEL_JSON__';

const claudeHome = (env = process.env, home = os.homedir()) => env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');

/** Copy the plugin template to <dataDir>/claude-plugin with the channel folder's absolute path filled in. */
function prepare(dataDir, { template = TEMPLATE } = {}) {
  const target = path.join(dataDir, 'claude-plugin');
  const channel = path.join(dataDir, 'channel').replace(/\\/g, '/');
  fs.rmSync(target, { recursive: true, force: true });
  const copy = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, e.name);
      const b = path.join(to, e.name);
      if (e.isDirectory()) copy(a, b);
      else {
        const body = fs.readFileSync(a, 'utf8');
        fs.writeFileSync(b, body.split(PLACEHOLDER).join(JSON.stringify(channel)));
      }
    }
  };
  copy(template, target);
  return target;
}

/** The installed record of the plugin, or null. */
function installed(opts = {}) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(claudeHome(opts.env, opts.home), 'plugins', 'installed_plugins.json'), 'utf8'));
    const rec = d.plugins && d.plugins[PLUGIN_ID];
    return Array.isArray(rec) && rec.length ? rec[0] : null;
  } catch {
    return null;
  }
}

/** The full path of the claude command on PATH: claude.exe, or an npm-style claude.cmd. */
function resolveClaude({ env = process.env, fsx = fs, platform = process.platform } = {}) {
  if (platform !== 'win32') return 'claude';
  const dirs = String(env.PATH || env.Path || '').split(';').filter(Boolean);
  for (const name of ['claude.exe', 'claude.cmd', 'claude.bat']) {
    for (const d of dirs) {
      const f = path.join(d, name);
      if (fsx.existsSync(f)) return f;
    }
  }
  return null;
}

/** Arguments for a .cmd launcher, which Windows only runs through cmd.exe: quote each one, refuse any quote inside. */
const cmdLine = (file, args) => {
  if ([file, ...args].some((a) => String(a).includes('"'))) throw new Error('Unsafe argument');
  const q = (a) => (/^[A-Za-z0-9_@.:\\/-]+$/.test(a) ? a : `"${a}"`);
  return `""${file}" ${args.map(q).join(' ')}"`; // /s strips only this outer pair, so quotes inside survive
};

const run = (args, { timeout = 120000, exec, file: given } = {}) =>
  new Promise((resolve) => {
    const opts = { windowsHide: true, timeout, maxBuffer: 1024 * 1024 };
    const done = (err, stdout, stderr) => {
      const tail = String(stdout || '').trim().split(/\r?\n/).slice(-3).join(' ') || String(stderr || '').trim().slice(-300);
      const reason = err ? (err.code === 'ENOENT' ? 'The claude command was not found on PATH' : String(err.message).split('\n')[0]) : null;
      resolve({ ok: !err, output: tail, error: reason });
    };
    if (exec) return exec('claude', args, opts, done); // tests
    const file = given || resolveClaude();
    if (!file) return done(Object.assign(new Error('not found'), { code: 'ENOENT' }), '', '');
    if (/\.(cmd|bat)$/i.test(file)) {
      try {
        return execFile(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmdLine(file, args)], { ...opts, windowsVerbatimArguments: true }, done);
      } catch (e) {
        return done(e, '', '');
      }
    }
    return execFile(file, args, opts, done);
  });

async function install(dataDir, opts = {}) {
  const folder = prepare(dataDir, opts);
  const steps = [
    ['plugin', 'validate', folder],
    ['plugin', 'marketplace', 'add', folder],
    ['plugin', 'install', PLUGIN_ID, '--scope', 'user'],
  ];
  for (const args of steps) {
    const r = await run(args, opts);
    // A marketplace that is already added is fine.
    if (!r.ok && !(args[2] === 'add' && /already/i.test(r.output + r.error))) return { ok: false, step: args.slice(0, 3).join(' '), error: r.error, output: r.output };
  }
  return { ok: true };
}

async function uninstall(opts = {}) {
  const a = await run(['plugin', 'uninstall', PLUGIN_ID, '--scope', 'user'], opts);
  const b = await run(['plugin', 'marketplace', 'remove', NAME], opts);
  const ok = (a.ok || /not installed|not found/i.test(a.output + a.error)) && (b.ok || /not found|no marketplace/i.test(b.output + b.error));
  return { ok, error: ok ? null : a.error || b.error, output: a.output || b.output };
}

module.exports = { prepare, installed, install, uninstall, resolveClaude, cmdLine, run, PLUGIN_ID, claudeHome };
