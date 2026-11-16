'use strict';
// better-sqlite3 (optional) must be the build for Electron's Node, not the system Node. This fetches that
// prebuilt binary after `npm install`. If anything fails, the dock still works: OpenCode's state then falls back
// to a guess from file activity (see opencode.js).
const { spawnSync } = require('child_process');
const path = require('path');

try {
  const root = path.join(__dirname, '..');
  const electron = require(path.join(root, 'node_modules', 'electron', 'package.json')).version;
  const dir = path.join(root, 'node_modules', 'better-sqlite3');
  const bin = path.join(root, 'node_modules', 'prebuild-install', 'bin.js');
  const r = spawnSync(process.execPath, [bin, '--runtime', 'electron', '--target', electron], { cwd: dir, stdio: 'inherit' });
  if (r.status !== 0) console.warn('agent-dock: could not fetch the SQLite build for Electron; OpenCode will use the file-activity guess.');
} catch (e) {
  console.warn('agent-dock: skipping the SQLite build for Electron (' + e.message + ')');
}
