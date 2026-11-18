'use strict';
// Nova for desktop: runs the Nova server on this computer (single user, no sign-in)
// and shows it in a window. The same server doubles as a local streaming engine
// for Nova websites whose servers leave torrents to their viewers.
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, screen, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { DiscordPresence, toActivity } = require('./discord.cjs');

const ENGINE_PORT = 11471;
const isMac = process.platform === 'darwin';
const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

const resources = app.isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, 'app');
// Portable builds keep everything next to the .exe; installed builds use the system's app-data folder.
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
const dataRoot = portableDir ? path.join(portableDir, 'Nova Data') : app.getPath('userData');
if (portableDir) app.setPath('userData', path.join(dataRoot, 'shell'));

let server = null;
let win = null;
let tray = null;
let port = 0;
let quitting = false;

function readJson(file, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------- app settings

const settingsFile = path.join(dataRoot, 'desktop-settings.json');
const DEFAULT_SETTINGS = { autoUpdate: true, discord: false, port: null };
let settings = readJson(settingsFile, DEFAULT_SETTINGS);

function buildInfo() {
  return readJson(path.join(resources, 'build-info.json'), { discordClientId: '' });
}

function persistentSecret() {
  const file = path.join(dataRoot, 'secret.key');
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch {
    /* first run */
  }
  const s = crypto.randomBytes(48).toString('hex');
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(file, s);
  return s;
}

function portFree(p) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** The port chosen in Settings, else the engine port Nova websites look for, else any free one. */
async function pickPort() {
  const wanted = Number.isInteger(settings.port) ? settings.port : ENGINE_PORT;
  if (await portFree(wanted)) return wanted;
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function waitHealthy(timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Nova did not start in time');
}

function pairingsExist() {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataRoot, 'data', 'engine-pairings.json'), 'utf8')).length > 0;
  } catch {
    return false;
  }
}

async function onServerMessage(msg) {
  if (msg?.type !== 'pair-request') return;
  if (win) {
    if (!win.isVisible()) win.show();
    win.focus();
  }
  const { response } = await dialog.showMessageBox(win ?? undefined, {
    type: 'question',
    buttons: ['Allow', "Don't allow"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: 'Stream for a website?',
    message: `${msg.origin} wants to stream torrents on this computer.`,
    detail:
      'Videos you play on that Nova site will be downloaded and played by this app. Only allow Nova servers you know and trust. You can remove it later under Settings → Account & sharing.',
  });
  server?.send({ type: 'pair-response', id: msg.id, allow: response === 0 });
}

async function startServer() {
  const key = crypto.randomBytes(32).toString('hex');
  const logDir = path.join(dataRoot, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'server.log');
  try {
    if (fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, `${logFile}.1`);
  } catch {
    /* no log yet */
  }
  const log = fs.createWriteStream(logFile, { flags: 'a' });
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    NOVA_MODE: 'desktop',
    HOST: '127.0.0.1',
    PORT: String(port),
    DATA_DIR: path.join(dataRoot, 'data'),
    TORRENT_DIR: path.join(dataRoot, 'cache'),
    LIBRARY_DIR: process.env.NOVA_LIBRARY_DIR || path.join(app.getPath('videos'), 'Nova'),
    WEB_DIR: path.join(resources, 'web'),
    SESSION_SECRET: persistentSecret(),
    ADMIN_USERNAME: 'owner',
    FFMPEG_PATH: path.join(resources, 'bin', exe('ffmpeg')),
    FFPROBE_PATH: path.join(resources, 'bin', exe('ffprobe')),
    MAX_TRANSCODES: '2',
    CACHE_TOTAL_MB: '20480',
    NOVA_DESKTOP_KEY: key,
  };
  server = spawn(path.join(resources, 'runtime', exe('node')), [path.join(resources, 'server', 'dist', 'index.js')], {
    cwd: path.join(resources, 'server'),
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  server.on('message', (m) => void onServerMessage(m));
  server.on('exit', (code) => {
    server = null;
    if (!quitting) {
      dialog.showErrorBox('Nova stopped', `The Nova server exited (code ${code}). Details are in:\n${logFile}`);
      app.quit();
    }
  });

  await waitHealthy();
  const res = await fetch(`http://127.0.0.1:${port}/api/desktop/session`, { method: 'POST', headers: { 'X-Nova-Desktop-Key': key } });
  if (!res.ok) throw new Error(`Sign-in failed (${res.status})`);
  const { token, maxAge } = await res.json();
  await session.defaultSession.cookies.set({
    url: `http://127.0.0.1:${port}`,
    name: 'stream_session',
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    expirationDate: Math.floor(Date.now() / 1000) + maxAge,
  });
}

function icon() {
  return nativeImage.createFromPath(path.join(resources, 'icon.png'));
}

/** Shown the moment the app opens, while the server starts behind it. */
function splashUrl() {
  let logo = '';
  try {
    logo = `data:image/png;base64,${fs.readFileSync(path.join(resources, 'icon.png')).toString('base64')}`;
  } catch {
    /* no icon staged */
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Nova</title><style>
    html,body{margin:0;height:100%;background:#07070b;color:#a7a7b8;font:15px system-ui,sans-serif;overflow:hidden}
    body{display:grid;place-items:center;-webkit-app-region:drag}div{text-align:center}
    img{width:96px;height:96px;animation:p 1.6s ease-in-out infinite}
    p{margin-top:22px;letter-spacing:.04em}@keyframes p{50%{opacity:.55;transform:scale(.96)}}
  </style></head><body><div>${logo ? `<img src="${logo}" alt="">` : ''}<p>Starting Nova…</p></div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

// ---------------------------------------------------------------- window

const stateFile = path.join(dataRoot, 'window-state.json');

/** Last size, place and zoom; the first start fills the screen (maximized, still a window). */
function windowState() {
  const s = readJson(stateFile, { maximized: true, zoom: 0 });
  const fits =
    Number.isFinite(s.x) &&
    Number.isFinite(s.y) &&
    s.width >= 640 &&
    s.height >= 400 &&
    screen.getAllDisplays().some(({ workArea: a }) => s.x < a.x + a.width - 80 && s.x + s.width > a.x + 80 && s.y >= a.y - 10 && s.y < a.y + a.height - 80);
  return { bounds: fits ? { x: s.x, y: s.y, width: s.width, height: s.height } : null, maximized: s.maximized !== false, zoom: Number(s.zoom) || 0 };
}

function saveWindowState() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  const b = win.getNormalBounds();
  writeJson(stateFile, { ...b, maximized: win.isMaximized(), zoom: win.webContents.getZoomLevel() });
}

let saveTimer = null;
const saveSoon = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveWindowState, 500);
};

const origin = () => `http://127.0.0.1:${port}`;
/** Only Nova's own pages may use the desktop API. */
const trusted = (e) => {
  try {
    return new URL(e.senderFrame?.url ?? '').origin === origin();
  } catch {
    return false;
  }
};

function createWindow(splash = false) {
  const state = windowState();
  win = new BrowserWindow({
    ...(state.bounds ?? { width: 1440, height: 900 }),
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#07070b',
    title: 'Nova',
    icon: icon(),
    show: false,
    autoHideMenuBar: true,
    // Nova draws its own top bar; the system keeps only its window buttons on top of it.
    ...(isMac ? { titleBarStyle: 'hiddenInset' } : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#e6e6ee', height: 40 } }),
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false, preload: path.join(__dirname, 'preload.cjs') },
  });
  win.once('ready-to-show', () => {
    if (state.maximized) win.maximize();
    win.show();
  });
  win.webContents.on('did-finish-load', () => win?.webContents.setZoomLevel(state.zoom));
  win.webContents.on('zoom-changed', (_e, dir) => {
    win.webContents.setZoomLevel(Math.max(-3, Math.min(4, win.webContents.getZoomLevel() + (dir === 'in' ? 0.5 : -0.5))));
    state.zoom = win.webContents.getZoomLevel();
    saveSoon();
  });
  // No app menu means no default shortcuts: bring back zoom, reload and full screen.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const mod = isMac ? input.meta : input.control;
    const wc = win.webContents;
    if (mod && (input.key === '=' || input.key === '+')) wc.setZoomLevel(Math.min(4, wc.getZoomLevel() + 0.5));
    else if (mod && input.key === '-') wc.setZoomLevel(Math.max(-3, wc.getZoomLevel() - 0.5));
    else if (mod && input.key === '0') wc.setZoomLevel(0);
    else if ((mod && input.key.toLowerCase() === 'r') || input.key === 'F5') wc.reload();
    else if (input.key === 'F11') win.setFullScreen(!win.isFullScreen());
    else return;
    e.preventDefault();
    state.zoom = wc.getZoomLevel();
    saveSoon();
  });
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, saveSoon);
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin())) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });
  // With websites streaming through this computer, closing keeps the engine running in the tray.
  win.on('close', (e) => {
    saveWindowState();
    if (quitting || !pairingsExist()) return;
    e.preventDefault();
    win.hide();
    ensureTray();
  });
  win.on('closed', () => {
    win = null;
    void presence?.set(null);
  });
  void win.loadURL(splash ? splashUrl() : `${origin()}/`);
}

// ---------------------------------------------------------------- updates

let updater = null;
let updateState = { supported: false, status: 'idle' };

/** Installed (NSIS) and AppImage builds update themselves; portable, zip and macOS builds link to the download. */
function canSelfUpdate() {
  if (!app.isPackaged || portableDir) return false;
  if (!fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) return false;
  if (process.platform === 'win32') return fs.readdirSync(path.dirname(process.execPath)).some((f) => /^Uninstall .*\.exe$/i.test(f));
  return process.platform === 'linux' && Boolean(process.env.APPIMAGE);
}

function setUpdate(s) {
  updateState = { supported: true, ...s };
  win?.webContents.send('nova:update', updateState);
}

function setupUpdater() {
  if (!canSelfUpdate()) return;
  try {
    updater = require('electron-updater').autoUpdater;
  } catch {
    return;
  }
  updateState = { supported: true, status: 'idle' };
  updater.logger = null;
  updater.autoDownload = true;
  // Minimal fuss: a downloaded update installs the next time Nova closes (or right away from Settings).
  updater.autoInstallOnAppQuit = true;
  updater.on('checking-for-update', () => setUpdate({ status: 'checking' }));
  updater.on('update-available', (i) => setUpdate({ status: 'downloading', version: i.version, progress: 0 }));
  updater.on('update-not-available', () => setUpdate({ status: 'none', checkedAt: Date.now() }));
  updater.on('download-progress', (p) => setUpdate({ status: 'downloading', version: updateState.version, progress: p.percent / 100 }));
  updater.on('update-downloaded', (i) => setUpdate({ status: 'ready', version: i.version }));
  updater.on('error', (err) => setUpdate({ status: 'error', error: String(err?.message ?? err).slice(0, 300) }));
  setTimeout(() => settings.autoUpdate && checkForUpdates(), 20_000);
  setInterval(() => settings.autoUpdate && checkForUpdates(), 6 * 3600_000).unref();
}

function checkForUpdates() {
  if (!updater || updateState.status === 'downloading' || updateState.status === 'ready') return;
  updater.checkForUpdates().catch(() => undefined);
}

// ---------------------------------------------------------------- Discord

let presence = null;
let pendingActivity = null;
let activityTimer = null;
let lastSent = 0;

function discord() {
  const id = process.env.NOVA_DISCORD_CLIENT_ID || buildInfo().discordClientId;
  if (!settings.discord || !id) {
    presence?.close();
    presence = null;
    return null;
  }
  if (!presence || presence.clientId !== id) presence = new DiscordPresence(id);
  return presence;
}

/** Discord accepts about five updates per 20 seconds: send the latest one at most every 4s. */
function queueActivity(a) {
  pendingActivity = a;
  if (activityTimer) return;
  activityTimer = setTimeout(
    () => {
      activityTimer = null;
      lastSent = Date.now();
      void discord()?.set(toActivity(pendingActivity));
    },
    Math.max(0, lastSent + 4000 - Date.now()),
  );
}

ipcMain.handle('nova:info', (e) => {
  if (!trusted(e)) return null;
  return { version: app.getVersion(), platform: process.platform, settings, port, update: updateState, discordAvailable: Boolean(process.env.NOVA_DISCORD_CLIENT_ID || buildInfo().discordClientId) };
});
ipcMain.handle('nova:settings', (e, patch) => {
  if (!trusted(e) || !patch || typeof patch !== 'object') return settings;
  if (typeof patch.autoUpdate === 'boolean') settings.autoUpdate = patch.autoUpdate;
  if (typeof patch.discord === 'boolean') settings.discord = patch.discord;
  if (patch.port === null || (Number.isInteger(patch.port) && patch.port >= 1024 && patch.port <= 65535)) settings.port = patch.port;
  writeJson(settingsFile, settings);
  if (!settings.discord) discord();
  if (settings.autoUpdate) checkForUpdates();
  return settings;
});
ipcMain.handle('nova:relaunch', (e) => {
  if (!trusted(e)) return false;
  quitting = true;
  app.relaunch();
  app.quit();
  return true;
});
ipcMain.handle('nova:update:check', (e) => {
  if (!trusted(e)) return null;
  checkForUpdates();
  return updateState;
});
ipcMain.handle('nova:update:install', (e) => {
  if (!trusted(e) || updateState.status !== 'ready') return false;
  quitting = true;
  server?.kill();
  setImmediate(() => updater.quitAndInstall(true, true));
  return true;
});
ipcMain.on('nova:activity', (e, a) => {
  if (trusted(e) && settings.discord) queueActivity(a);
});

function ensureTray() {
  if (tray) return;
  tray = new Tray(icon().resize({ width: 16, height: 16 }));
  tray.setToolTip('Nova is streaming for your Nova websites');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Nova', click: () => (win ? win.show() : createWindow()) },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('double-click', () => (win ? win.show() : createWindow()));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return createWindow();
    if (!win.isVisible()) win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  Menu.setApplicationMenu(null);

  app.whenReady().then(async () => {
    try {
      port = await pickPort();
      // Show something straight away; the server takes a moment to start.
      createWindow(true);
      await startServer();
      if (win) void win.loadURL(`${origin()}/`);
      else createWindow();
      if (pairingsExist()) ensureTray();
      setupUpdater();
    } catch (err) {
      dialog.showErrorBox('Nova could not start', String(err?.message ?? err));
      quitting = true;
      app.quit();
    }
  });

  // macOS keeps apps alive without windows; the Dock icon brings one back.
  app.on('activate', () => {
    if (!win && port && server) createWindow();
  });

  app.on('window-all-closed', () => {
    if (!tray && !isMac) {
      quitting = true;
      app.quit();
    }
  });

  app.on('before-quit', () => {
    quitting = true;
    presence?.close();
    server?.kill();
  });
}
