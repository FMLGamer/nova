import express, { type NextFunction, type Request, type Response } from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { config } from './config.js';
import { bootstrapAdmin } from './bootstrap.js';
import { authRouter } from './routes/auth.js';
import { profilesRouter } from './routes/profiles.js';
import { invitesRouter } from './routes/invites.js';
import { adminRouter } from './routes/admin.js';
import { catalogRouter } from './routes/catalog.js';
import { libraryRouter } from './routes/library-media.js';
import { playRouter } from './routes/play.js';
import { streamRouter } from './routes/stream.js';
import { progressRouter, listRouter } from './routes/library.js';
import { adminPluginsRouter, pluginsRouter } from './routes/plugins.js';
import { serverLibraryRouter } from './routes/server-library.js';
import { meRouter } from './routes/me.js';
import { liveProxyRouter, liveRouter } from './routes/live.js';
import { readingRouter } from './routes/reading.js';
import { roomsRouter } from './routes/rooms.js';
import { guestRouter, sharesRouter } from './routes/shares.js';
import { assistantRouter } from './routes/assistant.js';
import { subtitleToolsRouter } from './routes/subtitle-tools.js';
import { HttpError } from './lib/http.js';
import { every } from './lib/scheduler.js';
import { bootPlugins, checkAllUpdates } from './plugins/manager.js';
import { startPluginJobs } from './plugins/jobs.js';
import { pumpDownloads, recoverDownloads } from './library/downloads.js';
import { libraryEnabled, scanLibrary } from './library/library.js';
import { runAllRules } from './library/rules.js';
import { refreshAllEpg, refreshAllLive } from './services/live.js';
import { scheduleBackups } from './services/backups.js';
import { seedLocalProvider } from './services/assistant/providers.js';
import { handleRoomUpgrade } from './services/rooms.js';
import { VERSION, engineGateway, engineRouter, pairingsRouter, systemRouter } from './routes/system.js';
import { castMediaRouter, castRouter } from './cast/routes.js';

// A torrent-library hiccup must never take down the whole server for all users.
process.on('uncaughtException', (err) => console.error('[nova] uncaughtException:', err));
process.on('unhandledRejection', (reason) => console.error('[nova] unhandledRejection:', reason));

bootstrapAdmin();
seedLocalProvider();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.mode === 'desktop' ? false : 1);

// The desktop app only answers to its own loopback address: a page that rebinds
// some domain to 127.0.0.1 (DNS rebinding) gets nothing.
if (config.mode === 'desktop') {
  const allowed = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
  app.use((req, res, next) => {
    if (!allowed.has(String(req.headers.host ?? ''))) {
      res.status(421).end();
      return;
    }
    next();
  });
  // Before helmet/compression: the gateway re-dispatches with the inner path.
  app.use('/engine/:token', engineGateway(app));
}

// Client-mode web apps talk to the viewer's local Nova engine and WebTorrent trackers.
const engineHosts = config.torrentMode === 'client' ? [`http://127.0.0.1:${config.enginePort}`, `http://localhost:${config.enginePort}`] : [];
const trackerHosts = config.torrentMode === 'client' ? ['wss:'] : [];

// CSP tuned for the SPA: self-hosted code, posters from any HTTPS host, media
// from our origin (torrent/library/live proxies) or blob: (offline copies).
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'img-src': ["'self'", 'data:', 'blob:', 'https:'],
        'media-src': ["'self'", 'blob:', 'data:', ...engineHosts],
        'script-src': ["'self'", "'wasm-unsafe-eval'", 'https://www.gstatic.com'],
        'style-src': ["'self'", "'unsafe-inline'"],
        'font-src': ["'self'", 'data:'],
        'connect-src': ["'self'", 'blob:', ...engineHosts, ...trackerHosts],
        'worker-src': ["'self'", 'blob:'],
        'frame-src': ["'self'", 'https://www.youtube-nocookie.com', 'https://www.youtube.com'],
        'frame-ancestors': ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
  }),
);
// Never gzip media, subtitle pipes or event streams: buffering them delays (or
// with a live ffmpeg pipe, indefinitely withholds) the bytes the client needs.
app.use(
  compression({
    filter: (req, res) => {
      if (req.path.startsWith('/stream/') || req.path.startsWith('/live/') || req.path.startsWith('/cast/')) return false;
      if (String(res.getHeader('Content-Type') ?? '').includes('text/event-stream')) return false;
      return compression.filter(req, res);
    },
  }),
);
app.use(express.json({ limit: '30mb' }));
app.use(cookieParser());

app.get(['/healthz', '/readyz'], (_req, res) => {
  res.json({ ok: true, version: VERSION });
});

app.use('/api', systemRouter);
app.use('/api/engine', engineRouter);
app.use('/api/engine-pairings', pairingsRouter);
app.use('/api/auth', authRouter);
app.use('/api/profiles', profilesRouter);
app.use('/api/invites', invitesRouter);
app.use('/api/admin/plugins', adminPluginsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/catalog', catalogRouter);
app.use('/api/library', libraryRouter);
app.use('/api/play', playRouter);
app.use('/api/progress', progressRouter);
app.use('/api/list', listRouter);
app.use('/api/plugins', pluginsRouter);
app.use('/api/server-library', serverLibraryRouter);
app.use('/api/me', meRouter);
app.use('/api/live', liveRouter);
app.use('/api/reading', readingRouter);
app.use('/api/rooms', roomsRouter);
app.use('/api/shares', sharesRouter);
app.use('/api/share', guestRouter);
app.use('/api/assistant', assistantRouter);
app.use('/api/subtitles', subtitleToolsRouter);
app.use('/api/cast', castRouter);

// Large binary responses live outside /api.
app.use('/stream', streamRouter);
app.use('/live', liveProxyRouter);
// What TVs fetch while casting (capability URLs, no cookies).
app.use('/cast', castMediaRouter);

// Any unmatched /api path is a genuine 404 (never fall through to the SPA).
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Serve the built SPA (present in the container image; absent during local
// backend-only dev, where Vite serves the frontend and proxies /api).
if (fs.existsSync(config.webDir)) {
  app.use(
    express.static(config.webDir, {
      index: false,
      setHeaders: (res, file) => {
        res.setHeader(
          'Cache-Control',
          file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    }),
  );
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(config.webDir, 'index.html'));
  });
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'Malformed JSON' });
    return;
  }
  console.error('[nova] unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  if (!handleRoomUpgrade(req, socket, head)) socket.destroy();
});
server.listen(config.port, config.host, () => {
  console.log(`[nova] listening on ${config.host}:${config.port} (${config.nodeEnv}, ${config.mode}, torrents: ${config.torrentMode})`);
});

// ---------------------------------------------------------------- background work
void bootPlugins().catch((err) => console.error('[plugins] boot failed:', err));
startPluginJobs();
every('plugin-updates', 24 * 3600_000, checkAllUpdates, { initialDelayMs: 10 * 60_000 });
if (config.torrentMode === 'server') {
  recoverDownloads();
  every('downloads', 10_000, pumpDownloads, { initialDelayMs: 5_000 });
  every('auto-download-rules', 30 * 60_000, runAllRules, { initialDelayMs: 2 * 60_000 });
}
if (libraryEnabled()) every('library-scan', config.library.scanIntervalMinutes * 60_000, scanLibrary, { initialDelayMs: 60_000 });
every('live-refresh', 6 * 3600_000, refreshAllLive, { initialDelayMs: 3 * 60_000 });
every('epg-refresh', 12 * 3600_000, refreshAllEpg, { initialDelayMs: 4 * 60_000 });
scheduleBackups();
