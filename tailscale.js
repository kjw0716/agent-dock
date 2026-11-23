'use strict';
// Talks to the Tailscale command line (never through a shell). Agent Dock only ever uses `tailscale serve`
// (reachable inside your tailnet), never `funnel` (reachable from the whole internet).
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const CANDIDATES = () => [
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tailscale', 'tailscale.exe'),
];

/** Absolute path of tailscale.exe, or 'tailscale' if it is on PATH, or null. */
function find({ fsx = fs, candidates = CANDIDATES(), onPath = () => false } = {}) {
  for (const c of candidates) {
    try {
      if (fsx.statSync(c).isFile()) return c;
    } catch {}
  }
  return onPath() ? 'tailscale' : null;
}

/** Default runner: execFile with a timeout, resolves { code, stdout, stderr }. */
function runner(exe, { timeout = 15000 } = {}) {
  return (args) =>
    new Promise((resolve) => {
      execFile(exe, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err && err.code === 'ENOENT' ? 'ENOENT' : '' });
      });
    });
}

const firstLine = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';

/**
 * { installed, state, host, https, error }
 *   state: 'Running' | 'NeedsLogin' | 'Stopped' | ... (Tailscale's BackendState)
 *   host: this computer's name in the tailnet (what the phone opens), https: HTTPS certificates are enabled for the tailnet
 */
async function status(run) {
  const r = await run(['status', '--json']);
  if (r.error === 'ENOENT') return { installed: false };
  let j = null;
  try {
    j = JSON.parse(r.stdout);
  } catch {}
  if (!j) return { installed: true, state: 'Unknown', error: firstLine(r.stderr) || 'no answer' };
  const dns = j.Self && typeof j.Self.DNSName === 'string' ? j.Self.DNSName.replace(/\.$/, '') : '';
  return {
    installed: true,
    state: j.BackendState || 'Unknown',
    host: dns,
    https: Array.isArray(j.CertDomains) && j.CertDomains.length > 0,
  };
}

/** Publish 127.0.0.1:port on HTTPS 443 inside the tailnet. */
async function serve(run, port) {
  const r = await run(['serve', '--bg', '--https=443', `http://127.0.0.1:${Number(port)}`]);
  return r.code === 0 ? { ok: true } : { ok: false, error: firstLine(r.stderr) || firstLine(r.stdout) || 'failed' };
}

async function unserve(run) {
  const r = await run(['serve', '--https=443', 'off']);
  return r.code === 0 ? { ok: true } : { ok: false, error: firstLine(r.stderr) || firstLine(r.stdout) || 'failed' };
}

/** Whether the port is currently served (by us). */
async function serving(run, port) {
  const r = await run(['serve', 'status']);
  return r.code === 0 && r.stdout.includes(`127.0.0.1:${Number(port)}`);
}

/**
 * Whether something other than our port already uses HTTPS 443 on this machine's tailnet name ('funnel' when it is public,
 * true for any other service, false when 443 is free or already ours). `tailscale serve --https=443` would replace it.
 */
async function otherOn443(run, port) {
  const r = await run(['serve', 'status', '--json']);
  if (r.code !== 0) return false;
  let j;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    return false;
  }
  if (!j || typeof j !== 'object') return false;
  const funnel = j.AllowFunnel && Object.values(j.AllowFunnel).some(Boolean);
  const web = j.Web && typeof j.Web === 'object' ? Object.values(j.Web) : [];
  const handlers = web.flatMap((w) => Object.values((w && w.Handlers) || {}));
  const ours = (h) => h && typeof h.Proxy === 'string' && h.Proxy.includes(`127.0.0.1:${Number(port)}`);
  if (funnel) return 'funnel';
  if (!handlers.length) return false;
  return handlers.every(ours) ? false : true;
}

module.exports = { find, runner, status, serve, unserve, serving, otherOn443 };
