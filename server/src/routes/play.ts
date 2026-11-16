import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireAuth, requireProfile } from '../auth/middleware.js';
import { asyncHandler } from '../lib/async.js';
import { HttpError, parse, publicUrl } from '../lib/http.js';
import { openSse } from '../lib/sse.js';
import { lookupRelease, searchSources, type SourceSearch } from '../plugins/sources.js';
import { getAccountSettings } from '../services/entitlements.js';
import { getPreferences } from '../services/profiles.js';
import { subtitleProgress } from '../services/subtitleCache.js';
import { cachedItemKeys, listCache, torrentStatus } from '../services/torrentEngine.js';
import { prepareFromLink, prepareFromRelease } from '../streaming/play.js';
import { probeTracks, resolveSource } from '../streaming/source.js';
import { externalUrl } from './stream.js';

export const playRouter = Router();
playRouter.use(requireAuth);

const kindSchema = z.enum(['video', 'audio', 'book', 'comic']);

function assertKindAllowed(req: Request, kind: string): void {
  if (kind === 'video') return;
  const s = getAccountSettings(req.account!.id, req.account!.is_admin === 1);
  if (!s.musicBooksEnabled) throw new HttpError(403, 'Music and books are not enabled for this account');
}

function publicSearch(s: SourceSearch) {
  return {
    id: s.id,
    done: s.done,
    noDub: s.noDub,
    runs: s.runs,
    releases: s.releases,
    context: { title: s.context.title, year: s.context.year, kind: s.context.kind, ids: s.context.ids },
  };
}

const searchQuery = z.object({
  mediaId: z.string().min(1),
  season: z.coerce.number().int().optional(),
  episode: z.coerce.number().int().optional(),
  kind: kindSchema.optional(),
  title: z.string().max(300).optional(),
  creator: z.string().max(200).optional(),
});

/** Streams source results as each plugin answers (Server-Sent Events). */
playRouter.get(
  '/sources',
  requireProfile,
  asyncHandler(async (req, res) => {
    const q = parse(searchQuery, req.query);
    assertKindAllowed(req, q.kind ?? 'video');
    const prefs = getPreferences(req.profile!.id);
    const sse = openSse(req, res);
    try {
      const final = await searchSources(q, prefs, (s) => sse.send('update', publicSearch(s)));
      sse.send('done', publicSearch(final));
    } catch (err) {
      sse.send('error', { error: err instanceof Error ? err.message : 'Source search failed' });
    } finally {
      sse.close();
    }
  }),
);

playRouter.post(
  '/sources',
  requireProfile,
  asyncHandler(async (req, res) => {
    const q = parse(searchQuery, req.body);
    assertKindAllowed(req, q.kind ?? 'video');
    res.json(publicSearch(await searchSources(q, getPreferences(req.profile!.id))));
  }),
);

const prepareSchema = z.object({
  releaseId: z.string().min(1).optional(),
  link: z.string().min(1).optional(),
  /** A .torrent file (base64) when there is no magnet. */
  torrent: z.string().max(4_000_000).optional(),
  /** Which episode to pick out of a season pack. */
  episode: z
    .object({ kind: z.enum(['tv', 'anime']), season: z.number().int().nullable(), episode: z.number().int().nullable() })
    .nullish(),
  itemKey: z.string().max(200).nullish(),
  title: z.string().max(300).nullish(),
  kind: kindSchema.default('video'),
});

playRouter.post(
  '/prepare',
  asyncHandler(async (req, res) => {
    const body = parse(prepareSchema, req.body);
    assertKindAllowed(req, body.kind);
    const owner = { accountId: req.account!.id, itemKey: body.itemKey ?? null, title: body.title ?? null };
    if (body.releaseId) {
      const hit = lookupRelease(body.releaseId);
      if (!hit) throw new HttpError(410, 'That source expired; search again');
      const source = await prepareFromRelease(hit.release, hit.context, owner, body.kind).catch((err: Error) => {
        throw new HttpError(502, err.message);
      });
      res.json({ source, release: hit.release });
      return;
    }
    if (body.link || body.torrent) {
      const hint = { episode: body.episode ?? null, torrent: body.torrent ? Buffer.from(body.torrent, 'base64') : null };
      const source = await prepareFromLink(body.link ?? '', owner, body.kind, hint).catch((err: Error) => {
        throw new HttpError(409, err.message);
      });
      res.json({ source, release: null });
      return;
    }
    throw new HttpError(400, 'Nothing to play');
  }),
);

function srcFrom(req: Request) {
  const raw = String(req.query.src ?? '');
  const [kind, a, b] = raw.split('/');
  const src = kind && a ? resolveSource(kind, a, b) : null;
  if (!src) throw new HttpError(404, 'Source not prepared');
  return { src, kind: kind!, a: a!, b };
}

playRouter.get(
  '/tracks',
  asyncHandler(async (req, res) => {
    const { src } = srcFrom(req);
    res.json({ tracks: await probeTracks(src) });
  }),
);

playRouter.get('/status', (req, res) => {
  const { kind, a, src } = srcFrom(req);
  if (kind === 't') {
    res.json({ status: torrentStatus(a.toLowerCase()) });
    return;
  }
  res.json({ status: { ready: true, progress: src.progress() ?? 1, downloadSpeed: 0, numPeers: 0 } });
});

playRouter.get('/subtitle-progress', (req, res) => {
  const { src } = srcFrom(req);
  res.json({ progress: subtitleProgress(src.key, Number(req.query.track) || 0) });
});

// Which items this account can resume straight from the scratch cache.
playRouter.get('/cached', (req, res) => {
  res.json({ itemKeys: cachedItemKeys(req.account!.id), entries: listCache(req.account!.id) });
});

const externalSchema = z.object({
  src: z.string().min(3),
  filename: z.string().max(300),
  itemKey: z.string().max(200).nullish(),
  mediaId: z.string().max(200).nullish(),
  mediaType: z.string().max(20).nullish(),
  season: z.number().int().nullish(),
  episode: z.number().int().nullish(),
  title: z.string().max(300).nullish(),
  duration: z.number().nullish(),
});

/** A cookie-less, expiring URL for mpv / VLC / IINA (progress is tracked from byte offsets). */
playRouter.post('/external', requireProfile, (req, res) => {
  const body = parse(externalSchema, req.body);
  const [k, a, b] = body.src.split('/');
  if (!k || !a || !resolveSource(k, a, b)) throw new HttpError(404, 'Source not prepared');
  const path = externalUrl(
    {
      k,
      a,
      b,
      acc: req.account!.id,
      p: req.profile!.id,
      ik: body.itemKey ?? undefined,
      mid: body.mediaId ?? undefined,
      mt: body.mediaType ?? undefined,
      se: body.season ?? null,
      ep: body.episode ?? null,
      d: body.duration ?? null,
      ti: body.title ?? undefined,
    },
    body.filename,
  );
  const url = new URL(path, publicUrl(req)).toString();
  res.json({
    url,
    vlc: `vlc://${url}`,
    iina: `iina://weblink?url=${encodeURIComponent(url)}`,
    mpv: `mpv://${encodeURIComponent(url)}`,
    playlist: `#EXTM3U\n#EXTINF:-1,${(body.title ?? body.filename).replace(/[\r\n]/g, ' ')}\n${url}\n`,
  });
});
