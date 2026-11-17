'use strict';
// Nova for Windows: runs the Nova server on this computer (single user, no sign-in)
// and shows it in a window. The same server doubles as a local streaming engine
// for Nova websites whose servers leave torrents to their viewers.
const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ENGINE_PORT = 11471;

const resources = app.isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, 'app');
// Portable builds keep everything next to the .exe; installed builds use %APPDATA%\Nova.
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
const dataRoot = portableDir ? path.join(portableDir, 'Nova Data') : app.getPath('userData');
if (portableDir) app.setPath('userData', path.join(dataRoot, 'shell'));

let server = null;
let win = null;
let tray = null;
let port = 0;
let quitting = false;

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

async function pickPort() {
  if (await portFree(ENGINE_PORT)) return ENGINE_PORT;
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
    FFMPEG_PATH: path.join(resources, 'bin', 'ffmpeg.exe'),
    FFPROBE_PATH: path.join(resources, 'bin', 'ffprobe.exe'),
    MAX_TRANSCODES: '2',
    CACHE_TOTAL_MB: '20480',
    NOVA_DESKTOP_KEY: key,
  };
  server = spawn(path.join(resources, 'runtime', 'node.exe'), [path.join(resources, 'server', 'dist', 'index.js')], {
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
    body{display:grid;place-items:center}div{text-align:center}
    img{width:96px;height:96px;animation:p 1.6s ease-in-out infinite}
    p{margin-top:22px;letter-spacing:.04em}@keyframes p{50%{opacity:.55;transform:scale(.96)}}
  </style></head><body><div>${logo ? `<img src="${logo}" alt="">` : ''}<p>Starting Nova…</p></div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function createWindow(splash = false) {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#07070b',
    title: 'Nova',
    icon: icon(),
    show: false,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false },
  });
  const origin = `http://127.0.0.1:${port}`;
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin)) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });
  // With websites streaming through this computer, closing keeps the engine running in the tray.
  win.on('close', (e) => {
    if (quitting || !pairingsExist()) return;
    e.preventDefault();
    win.hide();
    ensureTray();
  });
  win.on('closed', () => {
    win = null;
  });
  void win.loadURL(splash ? splashUrl() : `${origin}/`);
}

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
      if (win) void win.loadURL(`http://127.0.0.1:${port}/`);
      else createWindow();
      if (pairingsExist()) ensureTray();
    } catch (err) {
      dialog.showErrorBox('Nova could not start', String(err?.message ?? err));
      quitting = true;
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    if (!tray) {
      quitting = true;
      app.quit();
    }
  });

  app.on('before-quit', () => {
    quitting = true;
    server?.kill();
  });
}
