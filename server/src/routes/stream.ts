import { Router, type NextFunction, type Request, type Response } from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { accountFromRequest, guestFromRequest } from '../auth/middleware.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { signToken, verifyToken } from '../lib/crypto.js';
import { HttpError } from '../lib/http.js';
import { getAccountSettings } from '../services/entitlements.js';
import { upsertProgress } from '../services/library.js';
import { cachedSubtitle, extractSubtitle } from '../services/subtitleCache.js';
import { embeddedTrackVtt, mkvInfo, streamEmbeddedTrack } from '../services/embeddedSubs.js';
import { isFont } from '../media/matroska.js';
import { ffInput, probeTracks, resolveSource, type MediaSource } from '../streaming/source.js';
import { wireCastMedia } from '../cast/media.js';

export const streamRouter = Router();

// Concurrent software transcodes (MAX_TRANSCODES; each one can saturate a couple of cores).
let activeTranscodes = 0;

const internalToken = signToken({ k: 'internal' }, 10 * 365 * 24 * 3600);

/** Sources a share guest prepared; guests may stream nothing else. */
const guestSources = new Map<string, Set<string>>();
export function allowGuestSource(shareId: string, sourceKey: string): void {
  let set = guestSources.get(shareId);
  if (!set) guestSources.set(shareId, (set = new Set()));
  set.add(sourceKey);
}

interface StreamCtx {
  src: MediaSource;
  kind: string;
  a: string;
  b?: string;
}

/** Loopback URL ffmpeg can range-request, which makes torrent seeking fast. */
function internalUrl(kind: string, a: string, b?: string): string {
  return `http://127.0.0.1:${config.port}/stream/${kind}/${a}${b !== undefined ? `/${b}` : ''}?it=${internalToken}`;
}

function sourceFor(req: Request): StreamCtx {
  const { kind, a, b } = req.params as { kind: string; a: string; b?: string };
  const src = resolveSource(kind, a, b);
  if (!src) throw new HttpError(404, 'Source not prepared');
  if (kind === 'l') {
    const row = db
      .prepare('SELECT i.private_account_id AS owner FROM library_files f JOIN library_items i ON i.id = f.item_id WHERE f.id = ?')
      .get(a) as { owner: string | null } | undefined;
    if (row?.owner && row.owner !== req.account?.id) throw new HttpError(404, 'Source not found');
  }
  if (req.guest && !guestSources.get(req.guest.shareId)?.has(src.key)) {
    throw new HttpError(403, 'Not part of this share');
  }
  return { src, kind, a, b };
}

function viewer(req: Request, _res: Response, next: NextFunction): void {
  if (req.query.it === internalToken && (req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1')) {
    next();
    return;
  }
  const account = accountFromRequest(req);
  if (account) {
    req.account = account;
    next();
    return;
  }
  const guest = guestFromRequest(req);
  if (!guest) throw new HttpError(401, 'Not authenticated');
  req.guest = guest;
  next();
}

// ---------------------------------------------------------------- byte ranges

function parseRange(header: string | undefined, total: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /bytes=(\d*)-(\d*)/.exec(header);
  if (!m) return null;
  let start = m[1] ? parseInt(m[1], 10) : 0;
  let end = m[2] ? parseInt(m[2], 10) : total - 1;
  if (!m[1] && m[2]) {
    start = Math.max(0, total - parseInt(m[2], 10));
    end = total - 1;
  }
  if (Number.isNaN(start) || start < 0) start = 0;
  if (Number.isNaN(end) || end >= total) end = total - 1;
  if (start > end) return 'invalid';
  return { start, end };
}

async function proxyUrl(req: Request, res: Response, src: MediaSource): Promise<void> {
  const headers: Record<string, string> = { ...(src.headers ?? {}) };
  if (req.headers.range) headers.Range = req.headers.range;
  const upstream = await fetch(src.url!, { headers, redirect: 'follow' }).catch(() => null);
  if (!upstream || (!upstream.ok && upstream.status !== 206)) {
    res.status(502).json({ error: 'The remote source is unavailable' });
    return;
  }
  res.status(upstream.status);
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (!upstream.headers.get('content-type') || /octet-stream/.test(upstream.headers.get('content-type') ?? '')) {
    res.setHeader('Content-Type', src.mime);
  }
  if (req.method === 'HEAD' || !upstream.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream);
  body.on('error', () => res.destroy());
  req.on('close', () => body.destroy());
  body.pipe(res);
}

function serveRange(req: Request, res: Response, src: MediaSource, onRange?: (start: number) => void): void {
  if (src.url) {
    proxyUrl(req, res, src).catch(() => res.destroy());
    return;
  }
  const total = src.size;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', src.mime);
  const range = parseRange(req.headers.range, total);
  if (range === 'invalid') {
    res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? total - 1;
  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  } else res.status(200);
  res.setHeader('Content-Length', end - start + 1);
  onRange?.(start);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = src.createReadStream({ start, end });
  stream.on('error', () => res.destroy());
  req.on('close', () => stream.destroy());
  stream.pipe(res);
}

// ---------------------------------------------------------------- ffmpeg pipelines

wireCastMedia(internalUrl, serveRange);

function seekableInput(ctx: StreamCtx, startSec: number): { args: string[]; stdin: Readable | null } {
  if (startSec <= 0) return ffInput(ctx.src);
  const ss = ['-ss', startSec.toFixed(2)];
  if (ctx.src.diskPath) return { args: [...ss, '-i', ctx.src.diskPath], stdin: null };
  if (ctx.src.url) return { args: [...ss, ...ffInput(ctx.src).args], stdin: null };
  return { args: [...ss, '-i', internalUrl(ctx.kind, ctx.a, ctx.b)], stdin: null };
}

function runFfmpeg(req: Request, res: Response, args: string[], stdin: Readable | null, onClose?: () => void): void {
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  const ff = spawn(config.ffmpegPath, args);
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    stdin?.destroy();
    try {
      ff.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    onClose?.();
  };
  stdin?.on('error', cleanup);
  ff.on('error', () => res.destroy());
  ff.stderr.on('data', () => undefined);
  ff.stdin.on('error', () => undefined);
  if (stdin) stdin.pipe(ff.stdin);
  ff.stdout.pipe(res);
  ff.on('close', () => {
    cleanup();
    res.end();
  });
  req.on('close', cleanup);
}

const FMP4 = ['-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'];

async function audioFix(req: Request, res: Response, ctx: StreamCtx): Promise<void> {
  const track = Number(req.query.track) || 0;
  const start = Math.max(0, Number(req.query.start) || 0);
  // Browsers only accept HEVC in MP4 under the hvc1 tag.
  const tracks = await probeTracks(ctx.src).catch(() => null);
  const hevcTag = tracks?.video?.codec === 'hevc' ? ['-tag:v', 'hvc1'] : [];
  const input = seekableInput(ctx, start);
  runFfmpeg(
    req,
    res,
    [
      '-loglevel', 'error',
      ...input.args,
      '-map', '0:v:0?',
      '-map', `0:a:${track}?`,
      '-c:v', 'copy',
      ...hevcTag,
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ac', '2',
      ...FMP4,
    ],
    input.stdin,
  );
}

function transcode(req: Request, res: Response, ctx: StreamCtx): void {
  if (req.account && !getAccountSettings(req.account.id, req.account.is_admin === 1).transcodingEnabled) {
    res.status(403).json({ error: 'Transcoding is not enabled for this account' });
    return;
  }
  if (activeTranscodes >= config.maxTranscodes) {
    res.status(503).json({ error: 'The server is already transcoding another stream' });
    return;
  }
  const height = Math.min(1080, Math.max(360, Number(req.query.height) || 720));
  const track = Number(req.query.track) || 0;
  const start = Math.max(0, Number(req.query.start) || 0);
  const input = seekableInput(ctx, start);
  const vaapi = config.hwAccel === 'vaapi' && fs.existsSync(config.vaapiDevice);
  const video = vaapi
    ? ['-vf', `format=nv12,hwupload,scale_vaapi=w=-2:h='min(${height},ih)'`, '-c:v', 'h264_vaapi', '-qp', '23']
    : ['-vf', `scale=-2:'min(${height},ih)'`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high', '-level', '4.1'];
  const hw = vaapi ? ['-vaapi_device', config.vaapiDevice] : [];
  const pix = vaapi ? [] : ['-pix_fmt', 'yuv420p'];
  activeTranscodes++;
  runFfmpeg(
    req,
    res,
    [
      '-loglevel', 'error',
      ...hw,
      ...input.args,
      '-map', '0:v:0?',
      '-map', `0:a:${track}?`,
      ...video,
      ...pix,
      '-c:a', 'aac',
      '-b:a', '160k',
      '-ac', '2',
      ...FMP4,
    ],
    input.stdin,
    () => {
      activeTranscodes = Math.max(0, activeTranscodes - 1);
    },
  );
}

// An embedded subtitle track as WebVTT. Extracted once and cached: the first
// viewer gets cues as ffmpeg demuxes, later ones get the finished file (which
// is what makes seeking work). Every write is flushed; gzip is skipped for /stream.
function subtitle(req: Request, res: Response, ctx: StreamCtx): void {
  const track = Number(req.params.track) || 0;
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');

  const ready = cachedSubtitle(ctx.src.key, track);
  if (ready) {
    res.setHeader('X-Subtitle-Complete', '1');
    res.end(ready);
    return;
  }
  const stream = extractSubtitle(ctx.src.key, track, {
    size: ctx.src.size,
    createReadStream: () => ctx.src.createReadStream(),
    path: ctx.src.diskPath,
    url: ctx.src.url,
    headers: ctx.src.headers,
  });
  const flush = () => (res as Response & { flush?: () => void }).flush?.();
  if (stream.initial) {
    res.write(stream.initial);
    flush();
  }
  if (stream.done) {
    if (!stream.initial) res.write('WEBVTT\n\n');
    res.end();
    return;
  }
  const unsubscribe = stream.subscribe(
    (chunk) => {
      res.write(chunk);
      flush();
    },
    () => {
      if (!cachedSubtitle(ctx.src.key, track) && !stream.initial) res.write('WEBVTT\n\n');
      res.end();
    },
  );
  req.on('close', unsubscribe);
}

// ---------------------------------------------------------------- Matroska subtitles + fonts

/** NDJSON stream of one embedded subtitle track, starting near ?from= (seconds). */
async function embeddedSubs(req: Request, res: Response, ctx: StreamCtx): Promise<void> {
  const track = Number(req.params.track);
  const from = Math.max(0, Number(req.query.from) || 0);
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  const flush = () => (res as Response & { flush?: () => void }).flush?.();
  try {
    await streamEmbeddedTrack(
      ctx.src,
      track,
      from,
      (m) => {
        if (ctrl.signal.aborted) return;
        res.write(`${JSON.stringify(m)}\n`);
        flush();
      },
      ctrl.signal,
    );
  } catch (err) {
    if (!res.headersSent) throw err;
  }
  res.end();
}

async function embeddedVtt(req: Request, res: Response, ctx: StreamCtx): Promise<void> {
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());
  const vtt = await embeddedTrackVtt(ctx.src, Number(req.params.track), ctrl.signal);
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.end(vtt);
}

async function font(req: Request, res: Response, ctx: StreamCtx): Promise<void> {
  const info = await mkvInfo(ctx.src);
  const att = info?.attachments[Number(req.params.index)];
  if (!att || !isFont(att) || !att.size) throw new HttpError(404, 'No such font');
  res.setHeader('Content-Type', /otf|opentype/i.test(att.mime + att.name) ? 'font/otf' : 'font/ttf');
  res.setHeader('Content-Length', att.size);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  const s = ctx.src.createReadStream({ start: att.pos, end: att.pos + att.size - 1 });
  s.on('error', () => res.destroy());
  req.on('close', () => s.destroy());
  s.pipe(res);
}

// ---------------------------------------------------------------- external players

interface ExternalClaims extends Record<string, unknown> {
  k: string;
  a: string;
  b?: string;
  acc: string;
  p?: string;
  ik?: string;
  mid?: string;
  mt?: string;
  se?: number | null;
  ep?: number | null;
  d?: number | null;
  ti?: string;
}

/** A cookie-less URL for mpv/VLC/IINA or a device download; tracks progress from byte offsets. */
export function externalUrl(claims: ExternalClaims, filename: string): string {
  const token = signToken(claims, 24 * 60 * 60);
  return `/stream/x/${token}/${encodeURIComponent(filename.replace(/[/\\?#]/g, '_'))}`;
}

const lastExternalSave = new Map<string, number>();

streamRouter.get('/x/:token/:filename', (req, res) => {
  const c = verifyToken<ExternalClaims>(req.params.token);
  if (!c) throw new HttpError(401, 'This link has expired');
  const src = resolveSource(c.k, c.a, c.b);
  if (!src) throw new HttpError(404, 'Source is no longer available; reopen it in Nova');
  serveRange(req, res, src, (start) => {
    if (!c.p || !c.ik || !c.mid || !c.d || !src.size || start === 0) return;
    const key = `${c.p}:${c.ik}`;
    const now = Date.now();
    if (now - (lastExternalSave.get(key) ?? 0) < 20_000) return;
    lastExternalSave.set(key, now);
    const position = Math.floor((start / src.size) * c.d);
    try {
      upsertProgress(c.p, {
        itemKey: c.ik,
        mediaType: c.mt ?? 'movie',
        mediaId: c.mid,
        season: c.se ?? null,
        episode: c.ep ?? null,
        positionSeconds: position,
        durationSeconds: c.d,
        finished: position / c.d > 0.92,
        title: c.ti ?? null,
      });
    } catch {
      /* progress is best-effort for external players */
    }
  });
});

// ---------------------------------------------------------------- routes

streamRouter.use(viewer);

for (const prefix of ['/:kind(t)/:a/:b', '/:kind(l|u)/:a']) {
  streamRouter.get(prefix, (req, res) => serveRange(req, res, sourceFor(req).src));
  streamRouter.get(`${prefix}/audio`, (req, res, next) => audioFix(req, res, sourceFor(req)).catch(next));
  streamRouter.get(`${prefix}/transcode`, (req, res) => transcode(req, res, sourceFor(req)));
  streamRouter.get(`${prefix}/subtitle/:track`, (req, res) => subtitle(req, res, sourceFor(req)));
  streamRouter.get(`${prefix}/subs/:track`, (req, res, next) => embeddedSubs(req, res, sourceFor(req)).catch(next));
  streamRouter.get(`${prefix}/subs/:track/vtt`, (req, res, next) => embeddedVtt(req, res, sourceFor(req)).catch(next));
  streamRouter.get(`${prefix}/font/:index`, (req, res, next) => font(req, res, sourceFor(req)).catch(next));
}
