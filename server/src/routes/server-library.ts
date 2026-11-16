import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireAuth, requireProfile } from '../auth/middleware.js';
import { config } from '../config.js';
import { asyncHandler } from '../lib/async.js';
import { HttpError, parse } from '../lib/http.js';
import {
  applyMatch,
  deleteItem,
  filesForMedia,
  findCandidates,
  getItem,
  lastScan,
  libraryEnabled,
  listItems,
  refreshMetadata,
  scanLibrary,
  setOverrides,
  setPrivate,
  storageStats,
} from '../library/library.js';
import {
  approveDownload,
  cancelDownload,
  listDownloads,
  requestDownload,
  retryDownload,
} from '../library/downloads.js';
import { missingEpisodes } from '../library/followed.js';
import {
  deleteQualityProfile,
  deleteRule,
  listQualityProfiles,
  listRules,
  runRule,
  saveQualityProfile,
  upsertRule,
} from '../library/rules.js';
import { lookupRelease } from '../plugins/sources.js';
import { librarySource } from '../streaming/source.js';
import type { LibraryKind } from '../library/naming.js';

export const serverLibraryRouter = Router();
serverLibraryRouter.use(requireAuth);

const isAdmin = (req: { account?: { is_admin: number } }) => req.account?.is_admin === 1;

serverLibraryRouter.get('/status', (_req, res) => {
  res.json({ enabled: libraryEnabled(), storage: storageStats(), lastScan });
});

serverLibraryRouter.get('/items', (req, res) => {
  res.json({
    items: listItems(req.account!.id, {
      kind: typeof req.query.kind === 'string' ? req.query.kind : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      q: typeof req.query.q === 'string' ? req.query.q : undefined,
    }),
  });
});

serverLibraryRouter.get('/items/:id', (req, res) => {
  res.json({ item: getItem(req.params.id, req.account!.id) });
});

/** Files on the server for one catalogue title (title page: "On this server"). */
serverLibraryRouter.get('/media/:mediaId', (req, res) => {
  const files = filesForMedia(decodeURIComponent(req.params.mediaId), req.account!.id).map((f) => ({
    ...f,
    stream: `/stream/l/${f.id}`,
    src: `l/${f.id}`,
  }));
  res.json({ files });
});

serverLibraryRouter.get('/files/:fileId/source', (req, res) => {
  const src = librarySource(req.params.fileId);
  if (!src) throw new HttpError(404, 'File missing');
  res.json({ source: { kind: 'l', a: req.params.fileId, path: `/stream/l/${req.params.fileId}`, name: src.name, size: src.size, mime: src.mime, files: [], link: '' } });
});

const overrideSchema = z.object({
  title: z.string().max(300).nullable().optional(),
  year: z.number().int().nullable().optional(),
  overview: z.string().max(5000).nullable().optional(),
  poster: z.string().url().max(1000).nullable().optional(),
  backdrop: z.string().url().max(1000).nullable().optional(),
});

serverLibraryRouter.patch('/items/:id', requireAdmin, (req, res) => {
  setOverrides(req.params.id, parse(overrideSchema, req.body));
  res.json({ item: getItem(req.params.id, req.account!.id) });
});

serverLibraryRouter.post('/items/:id/private', (req, res) => {
  const { on } = parse(z.object({ on: z.boolean() }), req.body);
  setPrivate(req.params.id, req.account!.id, on);
  res.json({ item: getItem(req.params.id, req.account!.id) });
});

serverLibraryRouter.post(
  '/items/:id/refresh',
  requireAdmin,
  asyncHandler(async (req, res) => {
    await refreshMetadata(req.params.id);
    res.json({ item: getItem(req.params.id, req.account!.id) });
  }),
);

serverLibraryRouter.delete('/items/:id', requireAdmin, (req, res) => {
  deleteItem(req.params.id, req.query.files === '1');
  res.status(204).end();
});

serverLibraryRouter.post(
  '/scan',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json({ result: await scanLibrary() });
  }),
);

// ---- match review
serverLibraryRouter.get('/review', requireAdmin, (req, res) => {
  res.json({ items: listItems(req.account!.id, { status: 'review' }) });
});

serverLibraryRouter.get(
  '/candidates',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const kind = String(req.query.kind ?? 'movie') as LibraryKind;
    const year = req.query.year ? Number(req.query.year) : null;
    res.json({ candidates: await findCandidates(kind, String(req.query.q ?? ''), year) });
  }),
);

const matchSchema = z.object({ mediaId: z.string().min(3), siblings: z.boolean().default(false) });

serverLibraryRouter.post(
  '/items/:id/match',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parse(matchSchema, req.body);
    const n = await applyMatch(req.params.id, body.mediaId, body.siblings);
    res.json({ matched: n });
  }),
);

const bulkSchema = z.object({ matches: z.array(z.object({ itemId: z.string(), mediaId: z.string() })).max(500) });

serverLibraryRouter.post(
  '/review/bulk',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parse(bulkSchema, req.body);
    let n = 0;
    for (const m of body.matches) n += await applyMatch(m.itemId, m.mediaId, false).catch(() => 0);
    res.json({ matched: n });
  }),
);

// ---- missing episodes
serverLibraryRouter.get(
  '/missing',
  requireProfile,
  asyncHandler(async (req, res) => {
    res.json({ series: await missingEpisodes(req.profile!.id, req.account!.id) });
  }),
);

// ---- downloads
serverLibraryRouter.get('/downloads', (req, res) => {
  const all = req.query.all === '1' && isAdmin(req);
  res.json({ downloads: listDownloads(all ? {} : { accountId: req.account!.id }) });
});

const requestSchema = z.object({
  releaseId: z.string().min(1),
  itemKey: z.string().max(200).nullish(),
  poster: z.string().max(1000).nullish(),
});

serverLibraryRouter.post('/downloads', requireProfile, (req, res) => {
  if (config.torrentMode === 'client') throw new HttpError(409, 'This server never downloads torrents; use Save offline on your device instead');
  const body = parse(requestSchema, req.body);
  const hit = lookupRelease(body.releaseId);
  if (!hit) throw new HttpError(410, 'That source expired; search again');
  const dl = requestDownload({
    accountId: req.account!.id,
    profileId: req.profile!.id,
    release: hit.release,
    context: hit.context,
    itemKey: body.itemKey ?? null,
    poster: body.poster ?? null,
  });
  res.status(201).json({ download: dl });
});

serverLibraryRouter.post('/downloads/:id/approve', requireAdmin, (req, res) => {
  const { approve } = parse(z.object({ approve: z.boolean() }), req.body);
  approveDownload(req.params.id, req.account!.id, approve);
  res.json({ ok: true });
});

serverLibraryRouter.post('/downloads/:id/retry', (req, res) => {
  retryDownload(req.params.id);
  res.json({ ok: true });
});

serverLibraryRouter.delete('/downloads/:id', (req, res) => {
  cancelDownload(req.params.id, req.account!.id, isAdmin(req));
  res.status(204).end();
});

// ---- auto-download rules
serverLibraryRouter.get('/rules', (req, res) => {
  res.json({ rules: listRules(isAdmin(req) && req.query.all === '1' ? undefined : req.account!.id) });
});

const ruleSchema = z.object({
  mediaId: z.string().min(3),
  title: z.string().min(1).max(300),
  poster: z.string().max(1000).nullish(),
  qualityProfileId: z.string().nullish(),
  mode: z.enum(['new', 'missing']).default('new'),
  enabled: z.boolean().default(true),
  runNow: z.boolean().default(false),
});

serverLibraryRouter.post(
  '/rules',
  requireProfile,
  asyncHandler(async (req, res) => {
    const body = parse(ruleSchema, req.body);
    const rule = upsertRule({
      accountId: req.account!.id,
      profileId: req.profile!.id,
      mediaId: body.mediaId,
      title: body.title,
      poster: body.poster ?? null,
      qualityProfileId: body.qualityProfileId ?? null,
      mode: body.mode,
      enabled: body.enabled,
    });
    const queued = body.runNow ? await runRule(rule).catch(() => 0) : 0;
    res.json({ rule, queued });
  }),
);

serverLibraryRouter.delete('/rules/:id', (req, res) => {
  deleteRule(req.params.id, req.account!.id, isAdmin(req));
  res.status(204).end();
});

// ---- quality profiles
serverLibraryRouter.get('/quality-profiles', (_req, res) => {
  res.json({ profiles: listQualityProfiles() });
});

const qpSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(80),
  isDefault: z.boolean().optional(),
  torrent: z.record(z.unknown()).optional(),
  anime: z.object({ audioLanguages: z.array(z.string()), preferEmbeddedSubs: z.boolean() }).optional(),
});

serverLibraryRouter.post('/quality-profiles', requireAdmin, (req, res) => {
  const body = parse(qpSchema, req.body);
  res.json({ profile: saveQualityProfile(body as Parameters<typeof saveQualityProfile>[0]) });
});

serverLibraryRouter.delete('/quality-profiles/:id', requireAdmin, (req, res) => {
  deleteQualityProfile(req.params.id);
  res.status(204).end();
});
