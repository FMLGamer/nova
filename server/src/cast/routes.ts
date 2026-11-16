/**
 * Casting API. Devices found on this machine's network are driven from here
 * (Chromecast over Cast v2, DLNA over SOAP); a browser with its own Cast
 * button (Chrome/Edge) only asks for a stream URL and drives the TV itself.
 */
import express, { Router, type Request } from 'express';
import http from 'node:http';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { asyncHandler } from '../lib/async.js';
import { randomToken } from '../lib/crypto.js';
import { HttpError, parse, publicUrl } from '../lib/http.js';
import { Chromecast } from './castv2.js';
import { addressFacing, discoverDevices, knownDevice, lanAddresses, type CastDevice } from './discovery.js';
import { DlnaRenderer } from './dlna.js';
import { castMedia, createCastMedia, endCastMedia, type CastMedia, type CastSubtitle } from './media.js';

interface Controller {
  status: { playerState: string; currentTime: number; duration: number | null; volume: number; muted: boolean; idleReason?: string };
  play(): Promise<unknown>;
  pause(): Promise<unknown>;
  seek(sec: number): Promise<unknown>;
  setVolume(level: number): Promise<unknown>;
  stop(): Promise<unknown>;
  poll?(): Promise<unknown>;
}

interface CastSession {
  id: string;
  owner: string;
  device: CastDevice | null;
  media: CastMedia;
  controller: Controller | null;
  meta: { title: string; subtitle: string | null; image: string | null };
  source: string;
  audioTrack: number;
  subtitle: CastSubtitle | null;
  error: string | null;
  ended: boolean;
}

const sessions = new Map<string, CastSession>();

// ---------------------------------------------------------------- LAN listener (desktop app)

let lanServer: http.Server | null = null;
let lanPort = 0;

/** Where a TV on the network can fetch cast streams from this machine. */
async function lanBase(device: CastDevice): Promise<string> {
  let ip = addressFacing(device.host);
  if (!ip) {
    // Not on the TV's subnet (e.g. a server in a container): the TV has to come in the front door.
    if (config.publicUrl) return config.publicUrl.replace(/\/+$/, '');
    ip = lanAddresses()[0]?.address ?? null;
    if (!ip) throw new HttpError(503, 'This computer is not on a network the TV can reach');
  }
  if (!config.castPort) return `http://${ip}:${config.port}`;
  if (!lanServer) {
    const app = express();
    app.disable('x-powered-by');
    app.use('/cast', castMediaRouter);
    app.use((_req, res) => res.status(404).end());
    lanServer = http.createServer(app);
    lanPort = await new Promise<number>((resolve, reject) => {
      const tryListen = (port: number) => {
        lanServer!.once('error', (e: NodeJS.ErrnoException) => (e.code === 'EADDRINUSE' && port ? tryListen(0) : reject(e)));
        lanServer!.listen(port, '0.0.0.0', () => resolve((lanServer!.address() as { port: number }).port));
      };
      tryListen(config.castPort);
    });
  }
  return `http://${ip}:${lanPort}`;
}

// ---------------------------------------------------------------- media routes (no auth: the token is the capability)

export const castMediaRouter = Router();

const FILE = /^(index\.m3u8|video\.m3u8|subs\.m3u8|subs_\d+\.vtt|r\d+_\d{5}\.ts|media|stream\.ts|subs\.srt)$/;

castMediaRouter.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
  if (req.method === 'OPTIONS') return void res.status(204).end();
  next();
});

castMediaRouter.get(
  '/:token/:file',
  asyncHandler(async (req, res) => {
    const m = castMedia(req.params.token);
    if (!m || !FILE.test(req.params.file)) throw new HttpError(404, 'Not found');
    const f = req.params.file;
    const m3u8 = (body: string) => {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      res.send(body);
    };
    if (f === 'index.m3u8') return m3u8(m.masterPlaylist());
    if (f === 'video.m3u8') return m3u8(m.videoPlaylist());
    if (f === 'subs.m3u8') return m3u8(m.subsPlaylist());
    if (f.startsWith('subs_')) {
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      return void res.send(m.subsSegment(Number(/\d+/.exec(f)![0])));
    }
    if (f === 'subs.srt') {
      res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
      return void res.send(m.srt());
    }
    if (f === 'media') return m.serveDirect(req, res, m.hasText ? `${req.protocol}://${req.get('host')}${req.baseUrl}/${m.token}/subs.srt` : null);
    if (f === 'stream.ts') return void (await m.streamTs(req, res));
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(f, { root: m.dir }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  }),
);

// ---------------------------------------------------------------- API

export const castRouter = Router();
castRouter.use(requireAuth);

castRouter.get(
  '/devices',
  asyncHandler(async (req, res) => {
    const devices = await discoverDevices(req.query.refresh === '1');
    res.json({ devices: devices.map(({ id, name, kind, model }) => ({ id, name, kind, model })) });
  }),
);

const subtitleSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('embedded'), track: z.number().int().min(0) }),
    z.object({ kind: z.literal('text'), vtt: z.string().max(4_000_000), language: z.string().max(20).nullish(), label: z.string().max(200).nullish() }),
  ])
  .nullable();

const startSchema = z.object({
  device: z.string().min(1).max(200),
  source: z.string().regex(/^[tlu]\/[^/]+(\/[^/]+)?$/),
  audioTrack: z.number().int().min(0).max(64).default(0),
  start: z.number().min(0).default(0),
  subtitle: subtitleSchema.default(null),
  title: z.string().max(300),
  subtitleLine: z.string().max(300).nullish(),
  image: z.string().url().max(2000).nullish(),
});

function ownSession(req: Request): CastSession {
  const s = sessions.get(req.params.id!);
  if (!s || s.owner !== req.account!.id) throw new HttpError(404, 'No such cast session');
  return s;
}

async function connectDevice(s: CastSession, base: string): Promise<void> {
  const d = s.device!;
  const m = s.media;
  if (d.kind === 'chromecast') {
    // Keep the TV's media app open when only the stream changes (a seek far ahead).
    const open = s.controller instanceof Chromecast && !s.controller.closed ? s.controller : null;
    const cc = open ?? new Chromecast(d.host, d.port);
    if (!open) {
      cc.on('closed', (e: Error) => {
        if (s.controller === cc && !s.ended) s.error = e.message;
      });
      await cc.connect();
    }
    await cc.load({
      url: `${base}/cast/${m.token}/index.m3u8`,
      contentType: 'application/x-mpegURL',
      hls: true,
      duration: m.duration ? m.duration - (m.firstPts ?? m.start) : null,
      title: s.meta.title,
      subtitle: s.meta.subtitle,
      image: s.meta.image,
      enableManifestText: m.hasText,
    });
    s.controller = cc;
    return;
  }
  const tv = new DlnaRenderer(d);
  await tv.load({
    url: `${base}/cast/${m.token}/${m.direct ? 'media' : 'stream.ts'}`,
    mime: m.direct ? m.src.mime : 'video/mpeg',
    title: s.meta.title,
    subtitleUrl: m.hasText ? `${base}/cast/${m.token}/subs.srt` : null,
    streaming: !m.direct,
  });
  if (m.direct && m.start > 5) await tv.seek(m.start).catch(() => undefined);
  s.controller = tv;
}

castRouter.post(
  '/start',
  asyncHandler(async (req, res) => {
    const body = parse(startSchema, req.body);
    const owner = req.account!.id;
    for (const [id, old] of sessions) {
      if (old.owner === owner) {
        old.ended = true;
        await old.controller?.stop().catch(() => undefined);
        endCastMedia(old.media.token);
        sessions.delete(id);
      }
    }
    const viaBrowser = body.device === 'browser';
    const device = viaBrowser ? null : knownDevice(body.device);
    if (!viaBrowser && !device) throw new HttpError(404, 'That device is gone; search again');
    // Same rule as /stream: a private library title is only its owner's.
    const [kind, ref] = body.source.split('/');
    if (kind === 'l') {
      const row = db
        .prepare('SELECT i.private_account_id AS owner FROM library_files f JOIN library_items i ON i.id = f.item_id WHERE f.id = ?')
        .get(ref) as { owner: string | null } | undefined;
      if (!row || (row.owner && row.owner !== owner)) throw new HttpError(404, 'Source not found');
    }
    const media = await createCastMedia({
      owner,
      source: body.source,
      audioTrack: body.audioTrack,
      start: body.start,
      subtitle: body.subtitle,
      target: device?.kind === 'dlna' ? 'dlna' : 'hls',
    });
    const s: CastSession = {
      id: randomToken(16),
      owner,
      device,
      media,
      controller: null,
      meta: { title: body.title, subtitle: body.subtitleLine ?? null, image: body.image ?? null },
      source: body.source,
      audioTrack: body.audioTrack,
      subtitle: body.subtitle,
      error: null,
      ended: false,
    };
    sessions.set(s.id, s);
    try {
      if (device) await connectDevice(s, await lanBase(device));
    } catch (e) {
      sessions.delete(s.id);
      endCastMedia(media.token);
      throw new HttpError(502, e instanceof Error ? e.message : 'The TV did not accept the stream');
    }
    res.json({
      id: s.id,
      offset: media.firstPts ?? media.start,
      duration: media.duration,
      ...(viaBrowser
        ? { url: `${publicUrl(req)}/cast/${media.token}/index.m3u8`, contentType: 'application/x-mpegURL', subtitles: media.hasText }
        : {}),
    });
  }),
);

castRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const s = ownSession(req);
    const c = s.controller;
    if (c?.poll) await c.poll().catch(() => undefined);
    const offset = s.media.direct ? 0 : (s.media.firstPts ?? s.media.start);
    s.media.lastAccess = Date.now();
    res.json({
      device: s.device ? { name: s.device.name, kind: s.device.kind } : null,
      state: s.error ? 'error' : (c?.status.playerState ?? 'IDLE'),
      idleReason: c?.status.idleReason ?? null,
      position: offset + (c?.status.currentTime ?? 0),
      duration: s.media.duration,
      produced: s.media.produced,
      volume: c?.status.volume ?? 1,
      muted: c?.status.muted ?? false,
      error: s.error ?? s.media.error,
    });
  }),
);

const controlSchema = z.object({
  action: z.enum(['play', 'pause', 'seek', 'volume']),
  value: z.number().optional(),
});

castRouter.post(
  '/:id/control',
  asyncHandler(async (req, res) => {
    const s = ownSession(req);
    const { action, value } = parse(controlSchema, req.body);
    const c = s.controller;
    if (!c) throw new HttpError(400, 'This cast is controlled from your browser');
    if (action === 'play') await c.play();
    else if (action === 'pause') await c.pause();
    else if (action === 'volume') await c.setVolume(value ?? 1);
    else if (action === 'seek') {
      const target = Math.max(0, value ?? 0);
      const m = s.media;
      const offset = m.direct ? 0 : (m.firstPts ?? m.start);
      // Inside what's already been produced the TV seeks itself; elsewhere the stream restarts there.
      if (m.direct || (target >= offset && target <= m.produced - 2)) await c.seek(target - offset);
      else {
        const old = m;
        // DLNA TVs get a fresh URL; a Chromecast keeps its session and just loads the new stream.
        if (!(c instanceof Chromecast)) await c.stop().catch(() => undefined);
        const media = await createCastMedia({ owner: s.owner, source: s.source, audioTrack: s.audioTrack, start: target, subtitle: s.subtitle, target: m.target });
        s.media = media;
        s.error = null;
        await connectDevice(s, await lanBase(s.device!));
        if (old !== media) endCastMedia(old.token);
      }
    }
    res.json({ ok: true });
  }),
);

/** Browser-driven casts: a new stream from another position (the TV is told by the browser). */
castRouter.post(
  '/:id/restart',
  asyncHandler(async (req, res) => {
    const s = ownSession(req);
    const { start } = parse(z.object({ start: z.number().min(0) }), req.body);
    const media = await createCastMedia({ owner: s.owner, source: s.source, audioTrack: s.audioTrack, start, subtitle: s.subtitle, target: 'hls' });
    s.media = media;
    res.json({ url: `${publicUrl(req)}/cast/${media.token}/index.m3u8`, offset: media.firstPts ?? media.start, contentType: 'application/x-mpegURL' });
  }),
);

castRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const s = ownSession(req);
    s.ended = true;
    await s.controller?.stop().catch(() => undefined);
    endCastMedia(s.media.token);
    sessions.delete(s.id);
    res.status(204).end();
  }),
);
