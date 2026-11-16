import { Router, type Request, type Response } from 'express';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { requireAdmin, requireAuth, requireProfile } from '../auth/middleware.js';
import { config } from '../config.js';
import { asyncHandler } from '../lib/async.js';
import { signToken, verifyToken } from '../lib/crypto.js';
import { HttpError, parse } from '../lib/http.js';
import { getAccountSettings } from '../services/entitlements.js';
import {
  addDirectoryChannels,
  addSource,
  airingsFor,
  catchupUrl,
  deleteSource,
  getChannel,
  guide,
  iptvBrowse,
  iptvDirectory,
  listChannels,
  listSources,
  livePlugins,
  publicSource,
  refreshEpg,
  refreshSource,
  setChannelHidden,
  sourceOf,
  toggleFavorite,
  updateSource,
  type LiveSourceKind,
} from '../services/live.js';
import { stalkerHeaders, stalkerLink } from '../services/stalker.js';

export const liveRouter = Router();
liveRouter.use(requireAuth, (req, _res, next) => {
  if (!getAccountSettings(req.account!.id, req.account!.is_admin === 1).liveTvEnabled) {
    throw new HttpError(403, 'Live TV is not enabled for this account');
  }
  next();
});

function playable(url: string, headers?: Record<string, string>): { url: string; type: 'hls' | 'mpegts'; remux: string; transcode: string } {
  const token = signToken({ u: url, h: headers }, 12 * 3600);
  const isTs = /\.(ts|mpg|mpeg)(\?|$)|\/auto\/v\d/i.test(url);
  return {
    url: `/live/p/${token}`,
    type: isTs ? 'mpegts' : 'hls',
    remux: `/live/remux/${token}`,
    transcode: `/live/transcode/${token}`,
  };
}

liveRouter.get('/channels', requireProfile, (req, res) => {
  res.json({
    channels: listChannels({ profileId: req.profile!.id, includeHidden: req.query.all === '1' && req.account!.is_admin === 1 }).map((c) => ({
      id: c.id,
      name: c.name,
      number: c.number,
      logo: c.logo,
      group: c.group,
      epgId: c.epgId,
      catchup: Boolean(c.catchup),
      catchupDays: c.catchup?.days ?? null,
      favorite: c.favorite,
      hidden: c.hidden,
      sourceId: c.sourceId,
    })),
  });
});

liveRouter.get('/guide', requireProfile, (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const from = Number(req.query.from) || now - 3600;
  const to = Math.min(from + 36 * 3600, Number(req.query.to) || now + 6 * 3600);
  const channels = listChannels({ profileId: req.profile!.id });
  const ids = [...new Set(channels.map((c) => c.epgId).filter((x): x is string => Boolean(x)))];
  res.json({ from, to, programmes: guide(from, to, ids) });
});

liveRouter.post('/channels/:id/favorite', requireProfile, (req, res) => {
  const { on } = parse(z.object({ on: z.boolean() }), req.body);
  toggleFavorite(req.profile!.id, req.params.id, on);
  res.json({ ok: true });
});

liveRouter.get(
  '/channels/:id/play',
  asyncHandler(async (req, res) => {
    const ch = getChannel(req.params.id);
    if (ch.url.startsWith('stalker:')) {
      const src = sourceOf(ch);
      const cfg = { portal: src.config.portal!, mac: src.config.mac! };
      const url = await stalkerLink(cfg, ch.url.slice('stalker:'.length)).catch((err: Error) => {
        throw new HttpError(502, err.message);
      });
      res.json({ ...playable(url, stalkerHeaders(cfg)), name: ch.name, logo: ch.logo });
      return;
    }
    res.json({ ...playable(ch.url), name: ch.name, logo: ch.logo });
  }),
);

liveRouter.get('/channels/:id/catchup', (req, res) => {
  const ch = getChannel(req.params.id);
  const start = Number(req.query.start);
  const stop = Number(req.query.stop);
  if (!start || !stop) throw new HttpError(400, 'start and stop are required');
  res.json({ ...playable(catchupUrl(ch, start, stop, sourceOf(ch))), name: ch.name, logo: ch.logo });
});

liveRouter.get('/airings', (req, res) => {
  const title = String(req.query.title ?? '').trim();
  res.json({ airings: title.length >= 2 ? airingsFor(title) : [] });
});

// ---------------------------------------------------------------- admin: inputs
liveRouter.get('/sources', requireAdmin, (_req, res) => {
  res.json({ sources: listSources().map(publicSource), plugins: livePlugins() });
});

const sourceSchema = z.object({
  kind: z.enum(['m3u', 'xtream', 'hdhomerun', 'stalker', 'plugin']),
  name: z.string().min(1).max(80),
  config: z.record(z.string().max(2000)),
  epgUrl: z.string().url().max(2000).nullish(),
});

liveRouter.post(
  '/sources',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parse(sourceSchema, req.body);
    const s = await addSource({ kind: body.kind as LiveSourceKind, name: body.name, config: body.config, epgUrl: body.epgUrl ?? null });
    res.status(201).json({ source: publicSource(s) });
  }),
);

liveRouter.patch('/sources/:id', requireAdmin, (req, res) => {
  const body = parse(z.object({ name: z.string().max(80).optional(), enabled: z.boolean().optional(), epgUrl: z.string().max(2000).nullish() }), req.body);
  res.json({ source: publicSource(updateSource(req.params.id, { ...body, epgUrl: body.epgUrl === undefined ? undefined : body.epgUrl || null })) });
});

liveRouter.delete('/sources/:id', requireAdmin, (req, res) => {
  deleteSource(req.params.id);
  res.status(204).end();
});

liveRouter.post(
  '/sources/:id/refresh',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const s = await refreshSource(req.params.id);
    const programmes = s.epgUrl ? await refreshEpg(req.params.id).catch(() => 0) : 0;
    res.json({ source: publicSource(s), programmes });
  }),
);

liveRouter.post('/channels/:id/hidden', requireAdmin, (req, res) => {
  const { hidden } = parse(z.object({ hidden: z.boolean() }), req.body);
  setChannelHidden(req.params.id, hidden);
  res.json({ ok: true });
});

liveRouter.get(
  '/directory',
  asyncHandler(async (_req, res) => {
    res.json(await iptvDirectory());
  }),
);

liveRouter.get(
  '/directory/:by/:code',
  asyncHandler(async (req, res) => {
    const by = (['countries', 'categories', 'languages'] as const).find((b) => b === req.params.by);
    if (!by) throw new HttpError(400, 'Unknown list');
    const entries = await iptvBrowse(by, req.params.code);
    res.json({
      channels: entries.map((e) => ({ ...e, preview: playable(e.url) })),
    });
  }),
);

const addSchema = z.object({
  entries: z
    .array(
      z.object({
        name: z.string().max(200),
        url: z.string().url().max(2000),
        tvgId: z.string().max(200).nullish(),
        logo: z.string().max(2000).nullish(),
        group: z.string().max(200).nullish(),
        country: z.string().max(10).nullish(),
      }),
    )
    .max(5000),
});

liveRouter.post('/directory/add', requireAdmin, (req, res) => {
  const { entries } = parse(addSchema, req.body);
  const added = addDirectoryChannels(
    entries.map((e) => ({
      name: e.name,
      url: e.url,
      tvgId: e.tvgId ?? null,
      logo: e.logo ?? null,
      group: e.group ?? null,
      number: null,
      country: e.country ?? null,
      catchup: null,
    })),
  );
  res.json({ added });
});

// ================================================================ stream proxy (/live)

export const liveProxyRouter = Router();
liveProxyRouter.use(requireAuth);

interface LiveClaims extends Record<string, unknown> {
  u: string;
  h?: Record<string, string>;
}

function claims(req: Request): LiveClaims {
  const c = verifyToken<LiveClaims>(req.params.token!);
  if (!c) throw new HttpError(401, 'This stream link expired');
  return c;
}

function rewritePlaylist(text: string, base: string, headers: Record<string, string> | undefined): string {
  const wrap = (uri: string) => `/live/p/${signToken({ u: new URL(uri, base).toString(), h: headers }, 12 * 3600)}`;
  return text
    .split('\n')
    .map((line) => {
      const l = line.trim();
      if (!l) return line;
      if (l.startsWith('#')) return l.replace(/URI="([^"]+)"/g, (_m, uri: string) => `URI="${wrap(uri)}"`);
      return wrap(l);
    })
    .join('\n');
}

liveProxyRouter.get(
  '/p/:token',
  asyncHandler(async (req, res) => {
    const c = claims(req);
    const headers: Record<string, string> = { 'User-Agent': 'Mozilla/5.0 (Nova)', ...(c.h ?? {}) };
    if (req.headers.range) headers.Range = req.headers.range;
    const ctrl = new AbortController();
    req.on('close', () => ctrl.abort());
    const upstream = await fetch(c.u, { headers, signal: ctrl.signal, redirect: 'follow' }).catch(() => null);
    if (!upstream || (!upstream.ok && upstream.status !== 206)) {
      res.status(502).json({ error: 'Channel unavailable' });
      return;
    }
    const type = upstream.headers.get('content-type') ?? '';
    const looksPlaylist = /mpegurl|m3u/i.test(type) || /\.m3u8?(\?|$)/i.test(new URL(upstream.url || c.u).pathname);
    if (looksPlaylist) {
      const text = await upstream.text();
      if (text.trimStart().startsWith('#EXTM3U')) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-store');
        res.send(rewritePlaylist(text, upstream.url || c.u, c.h));
        return;
      }
      res.status(502).json({ error: 'Not a playlist' });
      return;
    }
    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', 'no-store');
    if (!upstream.body) {
      res.end();
      return;
    }
    const body = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream);
    body.on('error', () => res.destroy());
    body.pipe(res);
  }),
);

function ffmpegLive(req: Request, res: Response, url: string, headers: Record<string, string> | undefined, transcode: boolean): void {
  const h = headers ? ['-headers', Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')] : [];
  const video = transcode ? ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '23', '-vf', "scale=-2:'min(720,ih)'"] : ['-c:v', 'copy'];
  const ff = spawn(config.ffmpegPath, [
    '-loglevel', 'error',
    '-fflags', '+genpts',
    ...h,
    '-i', url,
    '-map', '0:v:0?',
    '-map', '0:a:0?',
    ...video,
    '-c:a', 'aac',
    '-b:a', '160k',
    '-ac', '2',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1',
  ]);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  ff.stdout.pipe(res);
  ff.stderr.on('data', () => undefined);
  ff.on('error', () => res.destroy());
  ff.on('close', () => res.end());
  req.on('close', () => ff.kill('SIGKILL'));
}

// MPEG-TS (HDHomeRun, Xtream .ts) -> fragmented MP4 for browsers without MSE TS support.
liveProxyRouter.get('/remux/:token', (req, res) => {
  const c = claims(req);
  ffmpegLive(req, res, c.u, c.h, false);
});

// MPEG-2 broadcast video (ATSC/DVB tuners) needs a real transcode.
let liveTranscodes = 0;
liveProxyRouter.get('/transcode/:token', (req, res) => {
  if (!getAccountSettings(req.account!.id, req.account!.is_admin === 1).transcodingEnabled) {
    throw new HttpError(403, 'Transcoding is not enabled for this account');
  }
  if (liveTranscodes >= config.maxTranscodes) throw new HttpError(503, 'The server is already transcoding');
  liveTranscodes++;
  req.on('close', () => (liveTranscodes = Math.max(0, liveTranscodes - 1)));
  const c = claims(req);
  ffmpegLive(req, res, c.u, c.h, true);
});
