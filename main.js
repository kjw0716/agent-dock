'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { collect, AGENTS } = require('./sources');
const { Channel } = require('./channel');
const pluginInstall = require('./plugin-install');
const { installedIds } = require('./agents');

const DEMO = process.argv.includes('--demo');
const DATA_DIR = process.env.AGENT_DOCK_DATA || process.env.AGENT_HUD_DATA || path.join(os.homedir(), '.agent-dock');
// Renamed from agent-hud-win: carry the old settings folder over once.
if (DATA_DIR === path.join(os.homedir(), '.agent-dock') && !fs.existsSync(DATA_DIR)) {
  const old = path.join(os.homedir(), '.agent-hud-win');
  try {
    if (fs.existsSync(old)) fs.cpSync(old, DATA_DIR, { recursive: true });
  } catch {}
}
const CONFIG = path.join(DATA_DIR, 'config.json');
const channel = new Channel(path.join(DATA_DIR, 'channel'));
const sent = new Map(); // sessionId -> { askId, promptId }: the answer the user clicked for the ask that is open
let pluginBusy = false;
const DEFAULT_W = 312; // 288 panel + 12 transparent margin each side
const MARGIN = 12;
const MIN_W = 100;
const MIN_H = 90;
const MAX_W = 760;
const EXPAND_W = 330; // wide enough for the full row layout with the session list
const POLL_MS = 1000;
const DETECT = {
  claude: path.join(os.homedir(), '.claude', 'sessions'),
  codex: path.join(os.homedir(), '.codex', 'sessions'),
};

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win;
let tray;
let lastJson = '';
let lastSig = '';
let allRows = []; // before the agent filter
let contentH = 100; // natural content height, css px
let resizeTimer = null;
let dragStart = null;
let fitted = false; // auto-sized to show everything; `restore` holds the size to go back to
let restore = null;
let running = new Set(); // lowercase executable names currently running

// ---------------------------------------------------------------- config
const readConfig = () => {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch {
    return {};
  }
};
const writeConfig = (c) => {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify(c));
  } catch {}
};
const patchConfig = (p) => writeConfig({ ...readConfig(), ...p });
const agentOn = (cfg, id) => !(cfg.agents && cfg.agents[id] === false);

// ------------------------------------------------------------- autostart
const startupFile = () =>
  path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'agent-dock.vbs');
const autostartOn = () => fs.existsSync(startupFile());
function setAutostart(on) {
  try {
    fs.rmSync(path.join(path.dirname(startupFile()), 'agent-hud-win.vbs'), { force: true }); // old name
    if (!on) return fs.rmSync(startupFile(), { force: true });
    const q = (s) => s.replace(/"/g, '""');
    fs.writeFileSync(
      startupFile(),
      `Set sh = CreateObject("WScript.Shell")\r\nsh.CurrentDirectory = "${q(__dirname)}"\r\nsh.Run """${q(process.execPath)}"" .", 0, False\r\n`,
    );
  } catch {}
}

// ----------------------------------------------------------------- demo
const DEMO_T0 = Date.now();
const withAsk = (row, ask) => {
  row.sessions[0].ask = ask;
  return row;
};
function demoRows() {
  const now = DEMO_T0;
  const s = (agent, label, state, ago, labelKey) => ({ agent, id: agent + (label || labelKey), label, labelKey, state, since: now - ago * 60000, dim: false });
  const row = (id, name, list) => {
    const order = { waiting: 0, working: 1, done: 2 };
    list.sort((x, y) => order[x.state] - order[y.state]);
    return { id, name, state: list[0].state, top: list[0], sessions: list };
  };
  const names = Object.fromEntries(AGENTS.map((a) => [a.id, a.name]));
  const demoAsk = { id: 'demo-ask', kind: 'next_step', question: 'Ship the release now?', recap: 'The tests pass and the build is ready to publish.', options: [{ label: 'Ship it', message: 'Yes, ship it' }, { label: 'Wait', message: 'Hold on, wait' }], at: now };
  const mk = (id, list) => row(id, names[id], list.map(([l, st, ago, k]) => s(id, l, st, ago, k)));
  return [
    withAsk(mk('claude', [['sub2api site', 'waiting', 2], ['agent-hud', 'working', 6], ['image pipeline', 'done', 40]]), demoAsk),
    mk('codex', [['canvas', 'working', 3], ['ops', 'done', 20]]),
    mk('opencode', [[null, 'done', 3, 'open']]),
    mk('cursor', [[null, 'working', 0, 'open']]),
    mk('gemini', [[null, 'done', 50, 'recent']]),
    mk('copilot', [[null, 'done', 9, 'open']]),
    mk('grok', [[null, 'working', 0, 'open']]),
    mk('kimi', [[null, 'done', 12, 'recent']]),
  ];
}

// -------------------------------------------------------------- tray icon
const ASSETS = path.join(__dirname, 'assets');
const trayIcon = () => nativeImage.createFromPath(path.join(ASSETS, 'icon-64.png')).resize({ width: 16, height: 16, quality: 'best' });

// ----------------------------------------------------------------- window
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// The user controls the width; the height always follows the content (never cut off,
// never a blank area), limited to the screen's work area.
function applySize() {
  if (!win || win.isDestroyed()) return;
  const cur = win.getBounds();
  const wa = screen.getDisplayMatching(cur).workArea;
  let w;
  if (resizeTimer) w = cur.width; // being dragged
  else if (fitted) w = clamp(Math.max(restore.width, EXPAND_W), MIN_W, Math.min(MAX_W, wa.width - 16));
  else w = clamp(Number(readConfig().w) || DEFAULT_W, MIN_W, MAX_W);
  const h = clamp(contentH + MARGIN * 2, MIN_H, wa.height - 16);
  const x = fitted ? clamp(cur.x, wa.x, Math.max(wa.x, wa.x + wa.width - w)) : cur.x;
  const y = clamp(cur.y, wa.y, Math.max(wa.y, wa.y + wa.height - h));
  if (cur.x !== x || cur.y !== y || cur.width !== w || cur.height !== h) win.setBounds({ x, y, width: w, height: h });
}

function place() {
  const cfg = readConfig();
  const { workArea } = screen.getPrimaryDisplay();
  const w = clamp(Number(cfg.w) || DEFAULT_W, MIN_W, MAX_W);
  const x = Number.isFinite(cfg.x) ? cfg.x : workArea.x + workArea.width - w - 8;
  const y = Number.isFinite(cfg.y) ? cfg.y : workArea.y + 96;
  win.setPosition(Math.round(x), Math.round(y));
}

function createWindow() {
  const cfg = readConfig();
  win = new BrowserWindow({
    width: clamp(Number(cfg.w) || DEFAULT_W, MIN_W, MAX_W), height: 160,
    frame: false, transparent: true, resizable: false, icon: path.join(ASSETS, 'icon-256.png'),
    alwaysOnTop: cfg.onTop !== false, skipTaskbar: true, hasShadow: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  if (cfg.onTop !== false) win.setAlwaysOnTop(true, 'screen-saver');
  place();
  win.loadFile('index.html');
  win.once('ready-to-show', () => win.show());
  let t;
  win.on('move', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      if (fitted) return;
      const [x, y] = win.getPosition();
      patchConfig({ x, y });
    }, 400);
  });
  win.webContents.on('context-menu', () => menu().popup({ window: win }));
}

// Expanded: the window grows to show the opened rows' sessions; closing them again goes
// back to exactly the previous bounds.
function setFitted(on, goBack = true) {
  if (on === fitted) return fitted;
  if (on) {
    restore = win.getBounds();
    fitted = true;
    applySize();
  } else {
    fitted = false;
    if (goBack && restore) win.setBounds(restore); // exactly where and how big it was
    restore = null;
  }
  return fitted;
}

const resetLayout = () => {
  setFitted(false, false);
  patchConfig({ x: undefined, y: undefined, w: undefined, h: undefined, custom: undefined });
  place();
  applySize();
};

const MENU = { en: { reset: 'Reset position & size', quit: 'Quit' }, zh: { reset: '重置位置与大小', quit: '退出' } };
const lang = () => (readConfig().lang === 'zh' ? 'zh' : 'en'); // English is the default
const menu = () =>
  Menu.buildFromTemplate([
    { label: MENU[lang()].reset, click: resetLayout },
    { type: 'separator' },
    { label: MENU[lang()].quit, click: () => app.quit() },
  ]);

// -------------------------------------------------------------- settings
function settingsView() {
  const cfg = readConfig();
  const installed = new Set(installedIds({}));
  const detected = (id) => DEMO || (DETECT[id] ? fs.existsSync(DETECT[id]) : installed.has(id));
  const list = AGENTS.map((a, i) => {
    const row = allRows.find((r) => r.id === a.id);
    return { id: a.id, name: a.name, on: agentOn(cfg, a.id), found: detected(a.id), count: row ? row.sessions.length : 0, i };
  });
  list.sort((x, y) => Number(y.found) - Number(x.found) || x.i - y.i);
  return { agents: list, onTop: cfg.onTop !== false, autostart: autostartOn(), lang: lang(), plugin: { installed: !!pluginInstall.installed(), loaded: channel.loaded().size, busy: pluginBusy } };
}

function setSettings(p) {
  if (p.agent && AGENTS.some((a) => a.id === p.agent.id)) {
    const cfg = readConfig();
    patchConfig({ agents: { ...(cfg.agents || {}), [p.agent.id]: !!p.agent.on } });
    lastJson = '';
    tick();
  }
  if (typeof p.onTop === 'boolean') {
    patchConfig({ onTop: p.onTop });
    win.setAlwaysOnTop(p.onTop, p.onTop ? 'screen-saver' : 'normal');
  }
  if (typeof p.autostart === 'boolean') setAutostart(p.autostart);
  if (p.lang === 'en' || p.lang === 'zh') {
    patchConfig({ lang: p.lang });
    if (tray) tray.setContextMenu(menu());
  }
  if (p.reset) resetLayout();
  if (p.quit) app.quit();
  return settingsView();
}

// ------------------------------------------------------------------ poll
// Whether each open question can be answered from here, and how the answer the user clicked is going.
function decorateAsks(rows) {
  const loaded = channel.loaded();
  const installed = !!pluginInstall.installed();
  const open = new Map();
  for (const r of rows) {
    for (const s of r.sessions) {
      if (!s.ask) continue;
      open.set(s.id, s.ask.id);
      const note = DEMO || loaded.has(s.id) ? 'ready' : installed ? 'not-loaded' : 'not-installed';
      s.ask = { ...s.ask, note, canAnswer: note === 'ready' };
      const rec = sent.get(s.id);
      if (rec && rec.askId === s.ask.id) {
        const st = DEMO ? null : channel.state(s.id, rec.promptId);
        if (st) s.ask.sent = st.state === 'waiting' || st.state === 'taken' ? { state: 'sending' } : st.state === 'started' ? { state: 'sent' } : st.state === 'refused' ? { state: 'failed', reason: st.reason } : st.state === 'expired' ? { state: 'failed', reason: 'expired' } : undefined;
      }
    }
  }
  // An answer for a question that is no longer the open one must not be delivered later.
  for (const [sid, rec] of sent) {
    if (open.get(sid) !== rec.askId) {
      const st = channel.state(sid, rec.promptId);
      if (st && st.state === 'waiting') channel.cancel(sid, rec.promptId);
      sent.delete(sid);
    }
  }
}
const findSession = (id) => {
  for (const r of allRows) for (const s of r.sessions) if (s.id === id) return s;
  return null;
};

function tick() {
  let rows;
  try {
    const cfg0 = readConfig();
    const only = new Set(AGENTS.filter((a) => agentOn(cfg0, a.id)).map((a) => a.id));
    rows = DEMO ? demoRows() : collect({ others: { running, only } });
  } catch {
    rows = [];
  }
  decorateAsks(rows);
  allRows = rows;
  const cfg = readConfig();
  rows = rows.filter((r) => agentOn(cfg, r.id));
  const json = JSON.stringify(rows.map((r) => ({ ...r, top: { ...r.top, since: Math.floor(r.top.since / 1000) } })));
  if (json === lastJson) return;
  lastJson = json;
  if (win && !win.isDestroyed()) win.webContents.send('rows', rows);
  if (!DEMO) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(DATA_DIR, 'state.json'), JSON.stringify({ at: new Date().toISOString(), rows: rows.map((r) => ({ ...r, top: undefined, sessions: r.sessions.map((s) => ({ ...s, ask: s.ask ? { pending: true } : undefined })) })) }, null, 1));
    } catch {}
  }
  shot(rows);
}

// Optional: AGENT_DOCK_SHOT_DIR saves a screenshot of the real window whenever the set of states changes.
function shot(rows) {
  const dir = process.env.AGENT_DOCK_SHOT_DIR || process.env.AGENT_HUD_SHOT_DIR;
  if (!dir || !win) return;
  const sig = rows.map((r) => `${r.id}-${r.state}`).join('_') || 'empty';
  if (sig === lastSig) return;
  lastSig = sig;
  setTimeout(async () => {
    try {
      const img = await win.webContents.capturePage();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${sig}.png`), img.toPNG());
    } catch {}
  }, 600);
}

// Running executables, listed asynchronously so the resize timer never waits on it.
function pollProcesses() {
  if (DEMO) return;
  execFile('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
    if (err) return;
    const names = new Set();
    for (const line of out.split('\n')) {
      const m = /^"([^"]+)"/.exec(line);
      if (m) names.add(m[1].toLowerCase());
    }
    running = names;
  });
}

// ------------------------------------------------------------------ app
app.whenReady().then(() => {
  if (!gotLock) return;
  createWindow();
  tray = new Tray(trayIcon());
  tray.setToolTip('Agent Dock');
  tray.setContextMenu(menu());
  tray.on('click', () => (win.isVisible() ? win.hide() : win.show()));

  ipcMain.on('size', (_e, h) => {
    if (!Number.isFinite(h)) return;
    contentH = h;
    applySize();
  });
  ipcMain.on('ready', () => {
    lastJson = '';
    tick();
  });
  ipcMain.on('expand', (_e, on) => {
    setFitted(!!on);
  });
  ipcMain.handle('settings:get', () => settingsView());
  ipcMain.handle('settings:set', (_e, p) => setSettings(p || {}));
  ipcMain.handle('answer', (_e, req) => {
    const { sessionId, askId, option, custom } = req || {};
    const s = findSession(sessionId);
    if (!s || !s.ask || s.ask.id !== askId) return { ok: false, error: 'closed' };
    if (!s.ask.canAnswer) return { ok: false, error: s.ask.note };
    const prev = sent.get(sessionId);
    if (prev && prev.askId === askId) {
      const st = channel.state(sessionId, prev.promptId);
      if (st && ['waiting', 'taken', 'started'].includes(st.state)) return { ok: false, error: 'already-sent' }; // one answer per question
    }
    let text;
    if (typeof custom === 'string') text = custom;
    else {
      const o = s.ask.options[Number(option)];
      if (!o || (o.appAction && !o.message)) return { ok: false, error: 'app-only' }; // runs inside the Claude app
      text = o.message || o.label;
    }
    const r = DEMO ? { ok: true, id: 'demo' } : channel.leave({ sessionId, askId, text });
    if (r.ok) {
      sent.set(sessionId, { askId, promptId: r.id });
      lastJson = '';
      tick();
    }
    return r;
  });
  // Install or remove the Claude plugin (the user's click in Settings; it runs Claude's own CLI).
  ipcMain.handle('plugin:set', async (_e, on) => {
    if (pluginBusy) return { ok: false, error: 'busy' };
    pluginBusy = true;
    try {
      if (on) channel.prepare();
      const r = on ? await pluginInstall.install(DATA_DIR) : await pluginInstall.uninstall();
      return r;
    } finally {
      pluginBusy = false;
      lastJson = '';
      tick();
    }
  });

  // Width resize from the left or right edge: follow the cursor in the main process (a
  // transparent window has no native resize border on Windows). The height is not the
  // user's to set: it follows the content (see applySize).
  const finishDrag = () => {
    if (!resizeTimer) return;
    clearInterval(resizeTimer);
    resizeTimer = null;
    const b = win.getBounds();
    const moved = !dragStart || b.x !== dragStart.x || b.width !== dragStart.width;
    if (!moved) return; // a plain click on an edge changes nothing
    if (fitted) setFitted(false, false); // the user sized it by hand
    patchConfig({ x: b.x, y: b.y, w: b.width });
  };
  ipcMain.on('resize', (_e, dir, on) => {
    if (!on) return finishDrag();
    if (dir !== 'e' && dir !== 'w') return;
    finishDrag();
    const start = screen.getCursorScreenPoint();
    const b0 = win.getBounds();
    dragStart = b0;
    const began = Date.now();
    resizeTimer = setInterval(() => {
      if (Date.now() - began > 60000 || !win || win.isDestroyed()) return finishDrag(); // safety: a lost mouse-up must not leave it following the cursor
      const dx = screen.getCursorScreenPoint().x - start.x;
      let width;
      let x = b0.x;
      if (dir === 'e') width = clamp(b0.width + dx, MIN_W, MAX_W);
      else {
        width = clamp(b0.width - dx, MIN_W, MAX_W);
        x = b0.x + b0.width - width;
      }
      const cur = win.getBounds();
      if (cur.x !== x || cur.width !== width) win.setBounds({ x, y: cur.y, width, height: cur.height });
    }, 16);
  });

  if (pluginInstall.installed()) channel.prepare();
  channel.cleanup();
  setInterval(() => channel.cleanup(), 3600 * 1000);
  pollProcesses();
  setInterval(pollProcesses, 5000);
  tick();
  setInterval(tick, POLL_MS);
});

app.on('window-all-closed', () => app.quit());
app.on('second-instance', () => win && win.show());
