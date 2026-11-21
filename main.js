'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { collect, AGENTS } = require('./sources');
const { Channel } = require('./channel');
const { UnreadTracker } = require('./unread');
const { FocusReader } = require('./focus');
const { codexUrl, exesOf, focusWindow } = require('./jump');
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
const UNREAD_FILE = path.join(DATA_DIR, 'unread.json');
const unread = new UnreadTracker((() => {
  try {
    const v = JSON.parse(fs.readFileSync(UNREAD_FILE, 'utf8'));
    return Array.isArray(v) ? v.filter((k) => typeof k === 'string').slice(0, 500) : [];
  } catch {
    return [];
  }
})());
const saveUnread = () => {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(UNREAD_FILE, JSON.stringify(unread.list()));
  } catch {}
};
const focus = new FocusReader();
// Questions the user dismissed in the dock: sessionId -> { askId, at }. Kept across restarts.
const DISMISSED_FILE = path.join(DATA_DIR, 'dismissed-asks.json');
const dismissed = new Map((() => {
  try {
    const v = JSON.parse(fs.readFileSync(DISMISSED_FILE, 'utf8'));
    return Array.isArray(v) ? v.filter((e) => Array.isArray(e) && typeof e[0] === 'string' && e[1] && typeof e[1].askId === 'string').slice(-200) : [];
  } catch {
    return [];
  }
})());
const saveDismissed = () => {
  try {
    while (dismissed.size > 200) dismissed.delete(dismissed.keys().next().value);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DISMISSED_FILE, JSON.stringify([...dismissed]));
  } catch {}
};
// A question stops waiting when dismissed here, or when the chat was opened in the Claude app after it was asked.
const skipAsk = (sessionId, ask, d) => {
  const rec = dismissed.get(sessionId);
  if (rec && rec.askId === ask.id) return true;
  return !!(ask.at && d && typeof d.hostSessionId === 'string' && focus.lastFocused(d.hostSessionId) >= ask.at);
};
const demoRead = new Set(); // demo mode only: agents whose finished work the user clicked
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
let lastTip = '';
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
  const out = [
    withAsk(mk('claude', [['sub2api site', 'waiting', 2], ['docs review', 'waiting', 4], ['agent-hud', 'working', 6], ['image pipeline', 'done', 40]]), demoAsk),
    mk('codex', [['canvas', 'working', 3], ['ops', 'done', 20]]),
    mk('opencode', [[null, 'done', 3, 'open']]),
    mk('cursor', [[null, 'working', 0, 'open']]),
    mk('gemini', [[null, 'done', 50, 'recent']]),
    mk('copilot', [[null, 'done', 9, 'open']]),
    mk('grok', [[null, 'working', 0, 'open']]),
    mk('kimi', [[null, 'done', 12, 'recent']]),
  ];
  const finish = (session, agent, text) => {
    if (demoRead.has(agent) || demoRead.has(agent + ':' + session.id)) return;
    session.unread = true; // finished and not looked at yet
    session.reply = { text, at: DEMO_T0, id: 'reply:' + session.id };
  };
  finish(out[0].sessions.find((x) => x.label === 'image pipeline'), 'claude', 'Rendered the 12 frames and uploaded them to the shared folder. Two of them still show the old logo, so I regenerated those.');
  finish(out[1].sessions.find((x) => x.label === 'ops'), 'codex', 'Rotated the certificates on both servers and restarted the proxy. Everything answers on the new ones.');
  out[2].sessions[0].unread = !demoRead.has('opencode') && !demoRead.has('opencode:' + out[2].sessions[0].id);
  return out;
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
  return { agents: list, onTop: cfg.onTop !== false, autostart: autostartOn(), lang: lang(), jump: cfg.jump !== false, plugin: { installed: !!pluginInstall.installed(), loaded: channel.loaded().size, busy: pluginBusy } };
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
  if (typeof p.jump === 'boolean') patchConfig({ jump: p.jump });
  if (p.lang === 'en' || p.lang === 'zh') {
    patchConfig({ lang: p.lang });
    if (tray) tray.setContextMenu(menu());
  }
  if (p.reset) resetLayout();
  if (p.quit) app.quit();
  return settingsView();
}

// ------------------------------------------------------------------ poll
// Whether each open card (a question, or the brief reply of a finished turn) can be answered from here,
// and how the answer the user clicked is going.
function decorateCards(rows) {
  const loaded = channel.loaded();
  const installed = !!pluginInstall.installed();
  const open = new Map();
  for (const r of rows) {
    for (const s of r.sessions) {
      const key = s.ask ? 'ask' : s.unread && s.reply ? 'reply' : null;
      if (!key) {
        delete s.reply; // only what is still unread is shown, and only in memory
        continue;
      }
      const card = s[key];
      open.set(s.id, card.id);
      // Only Claude has a way to take words from the dock (the plugin); Codex and the rest can only be dismissed.
      const can = r.id === 'claude';
      const note = !can ? 'no-channel' : DEMO || loaded.has(s.id) ? 'ready' : installed ? 'not-loaded' : 'not-installed';
      s[key] = { ...card, note, canAnswer: note === 'ready' };
      const rec = sent.get(s.id);
      if (rec && rec.askId === card.id) {
        const st = DEMO ? null : channel.state(s.id, rec.promptId);
        if (st) s[key].sent = st.state === 'waiting' || st.state === 'taken' ? { state: 'sending' } : st.state === 'started' ? { state: 'sent' } : st.state === 'refused' ? { state: 'failed', reason: st.reason } : st.state === 'expired' ? { state: 'failed', reason: 'expired' } : undefined;
      }
    }
  }
  // An answer for a card that is no longer the open one must not be delivered later.
  for (const [sid, rec] of sent) {
    if (open.get(sid) !== rec.askId) {
      const st = channel.state(sid, rec.promptId);
      if (st && st.state === 'waiting') channel.cancel(sid, rec.promptId);
      sent.delete(sid);
    }
  }
}
// Open the chat of a session in its own app; resolves true only when it really opened (see jump.js).
// Claude: the desktop app's claude://code/continue link, which takes the app's own `local_...` session id
// (registry hostSessionId; checked against Claude's own pattern). Codex: codex://threads/<id>.
// OpenCode: its window and then the chat's tab. Everything else: the window of the app or of its terminal.
const LOCAL_ID = /^local_[A-Za-z0-9-]{1,64}$/;
async function openChat(agentId, session) {
  if (agentId === 'claude') {
    if (!session || !LOCAL_ID.test(String(session.host))) return false; // a terminal session has no desktop chat
    try {
      await shell.openExternal('claude://code/continue?session=' + session.host);
      return true;
    } catch {
      return false;
    }
  }
  if (agentId === 'codex') {
    const url = session && codexUrl(session.id);
    if (url) {
      try {
        await shell.openExternal(url);
        return true;
      } catch {}
    }
    return focusWindow(exesOf('codex'));
  }
  const title = agentId === 'opencode' && session && session.title ? session.title : '';
  return focusWindow(exesOf(agentId), title);
}
// An answer the user just sent waits for the plugin to pick it up; marking its card read now would withdraw it.
const isSending = (sessionId) => {
  const rec = sent.get(sessionId);
  if (!rec) return false;
  const st = channel.state(sessionId, rec.promptId);
  return !!st && (st.state === 'waiting' || st.state === 'taken');
};
const findSession = (id) => {
  for (const r of allRows) for (const s of r.sessions) if (s.id === id) return s;
  return null;
};

function tick() {
  let rows;
  let scanned = true;
  try {
    const cfg0 = readConfig();
    const only = new Set(AGENTS.filter((a) => agentOn(cfg0, a.id)).map((a) => a.id));
    rows = DEMO ? demoRows() : collect({ claude: { skipAsk }, others: { running, only } });
  } catch {
    rows = [];
    scanned = false; // a failed scan says nothing about what is unread
  }
  if (!DEMO && scanned) {
    const sessions = rows.flatMap((r) => r.sessions);
    // Claude and Codex report their state exactly; for the other agents "working" is a guess from file activity, so a run must last a while to count.
    if (unread.update(sessions, Date.now(), (agent, s) => (agent === 'claude' || agent === 'codex' || s.exact ? 0 : 30000))) saveUnread();
    // Opening a chat in the Claude desktop app after it finished counts as reading it, same as a click in the dock.
    let seen = false;
    for (const s of sessions) {
      if (!unread.has(s) || isSending(s.id)) continue;
      const dis = dismissed.get(s.id);
      if (dis && s.since <= dis.at) { seen = unread.readSession(s.agent, s.id) || seen; continue; } // dismissed its question: nothing new to look at
      // Claude: the chat was brought up in the desktop app; OpenCode: the app marked the chat viewed.
      const at = s.agent === 'claude' ? (s.host ? focus.lastFocused(s.host) : 0) : s.viewedAt || 0;
      if (at && at >= s.since) seen = unread.readSession(s.agent, s.id) || seen;
    }
    if (seen) saveUnread();
    for (const s of sessions) if (unread.has(s)) s.unread = true;
  }
  decorateCards(rows);
  allRows = rows;
  const cfg = readConfig();
  rows = rows.filter((r) => agentOn(cfg, r.id));
  for (const r of rows) r.jump = r.id === 'claude' || r.id === 'codex' || exesOf(r.id).length > 0; // the dock knows how to open its chat or window
  const countAll = (pred) => rows.reduce((n, r) => n + r.sessions.filter(pred).length, 0);
  const waitingTotal = countAll((s) => s.state === 'waiting');
  const unreadTotal = countAll((s) => s.unread);
  const zh = cfg.lang === 'zh';
  const parts = [waitingTotal && `${waitingTotal} ${zh ? '个在等你' : 'waiting for you'}`, unreadTotal && `${unreadTotal} ${zh ? '个未读' : 'unread'}`].filter(Boolean);
  const tip = parts.length ? `Agent Dock · ${parts.join(' · ')}` : 'Agent Dock';
  if (tray && tip !== lastTip) {
    lastTip = tip; // setting an unchanged tooltip every second can make it flicker
    tray.setToolTip(tip);
  }
  const json = JSON.stringify(rows.map((r) => ({ ...r, top: { ...r.top, since: Math.floor(r.top.since / 1000) } })));
  if (json === lastJson) return;
  lastJson = json;
  if (win && !win.isDestroyed()) win.webContents.send('rows', rows);
  if (!DEMO) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(DATA_DIR, 'state.json'), JSON.stringify({ at: new Date().toISOString(), rows: rows.map((r) => ({ ...r, top: undefined, sessions: r.sessions.map((s) => ({ ...s, ask: s.ask ? { pending: true } : undefined, reply: undefined })) })) }, null, 1));
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

// Running executables. Spawning `tasklist` every few seconds from Electron's main process leaked ~23 KB of native
// memory per spawn (>1 GB after a few days), so one cmd loop prints the list every ~5 s instead. The loop ends by
// itself after ~1 h (and is then restarted), so a crash of the dock can never leave it running forever.
let procWatcher = null;
function pollProcesses() {
  if (DEMO || procWatcher) return;
  const loop = 'for /l %i in (1,1,720) do @(tasklist /fo csv /nh & echo @@END@@ & ping -n 6 127.0.0.1 >nul)';
  let child;
  try {
    child = spawn('cmd.exe', ['/d', '/c', loop], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return;
  }
  procWatcher = child;
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('@@END@@')) !== -1) {
      const names = new Set();
      for (const line of buf.slice(0, i).split('\n')) {
        const m = /^"([^"]+)"/.exec(line);
        if (m) names.add(m[1].toLowerCase());
      }
      if (names.size) running = names;
      buf = buf.slice(i + 7);
    }
    if (buf.length > 1048576) buf = ''; // never grow without a marker
  });
  const ended = () => {
    if (procWatcher !== child) return;
    procWatcher = null;
    if (!quitting) setTimeout(pollProcesses, 5000);
  };
  child.on('error', ended);
  child.on('exit', ended);
}
let quitting = false;
app.on('before-quit', () => {
  quitting = true;
  if (procWatcher) {
    try {
      procWatcher.kill();
      execFile('taskkill', ['/pid', String(procWatcher.pid), '/t', '/f'], { windowsHide: true }, () => {});
    } catch {}
  }
});

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
  const markRead = (agent, id) => {
    if (DEMO) {
      demoRead.add(agent + ':' + id);
      return;
    }
    if (isSending(id)) return; // keep the card until the message has been taken
    if (unread.readSession(agent, id)) saveUnread();
  };
  ipcMain.on('dismiss', (_e, req) => {
    // "No reply": this session's finished turn is read.
    const { agent, id, askId } = req || {};
    if (typeof agent !== 'string' || typeof id !== 'string' || !AGENTS.some((a) => a.id === agent)) return;
    if (typeof askId === 'string' && agent === 'claude') {
      dismissed.delete(id); // re-insert so the newest stay when trimmed
      dismissed.set(id, { askId, at: Date.now() });
      saveDismissed();
    }
    markRead(agent, id);
    lastJson = '';
    tick();
  });
  ipcMain.handle('open', async (_e, req) => {
    const { agent, id } = req || {};
    if (typeof agent !== 'string' || typeof id !== 'string' || !AGENTS.some((a) => a.id === agent)) return false;
    const ok = DEMO ? true : await openChat(agent, findSession(id));
    if (ok) {
      markRead(agent, id);
      lastJson = '';
      tick();
    }
    return ok;
  });
  ipcMain.on('read', (_e, agentId) => {
    // A click on an agent's row: what it finished is read now.
    if (typeof agentId !== 'string' || !AGENTS.some((a) => a.id === agentId)) return;
    if (DEMO) {
      demoRead.add(agentId);
    } else {
      for (const r of allRows) if (r.id === agentId) for (const s of r.sessions) if (s.unread) markRead(agentId, s.id);
    }
    lastJson = '';
    tick();
  });
  ipcMain.handle('answer', (_e, req) => {
    const { sessionId, askId, option, custom } = req || {};
    const s = findSession(sessionId);
    const isReply = req && req.kind === 'reply';
    const card = s && (isReply ? s.reply : s.ask);
    if (!card || card.id !== askId) return { ok: false, error: 'closed' };
    if (!card.canAnswer) return { ok: false, error: card.note };
    if (isReply && typeof custom !== 'string') return { ok: false, error: 'text-only' }; // a finished turn has no buttons to send
    const prev = sent.get(sessionId);
    if (prev && prev.askId === askId) {
      const st = channel.state(sessionId, prev.promptId);
      if (st && ['waiting', 'taken', 'started'].includes(st.state)) return { ok: false, error: 'already-sent' }; // one answer per question
    }
    let text;
    if (typeof custom === 'string') text = custom;
    else {
      const o = card.options && card.options[Number(option)];
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
  tick();
  setInterval(tick, POLL_MS);
});

app.on('window-all-closed', () => app.quit());
app.on('second-instance', () => win && win.show());
