import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireProfile } from '../auth/middleware.js';
import { asyncHandler } from '../lib/async.js';
import { parse } from '../lib/http.js';
import { detailFor } from '../services/catalog.js';
import { trackStarted, trackWatched } from '../services/trackers.js';
import { getPreferences } from '../services/profiles.js';
import {
  addToList,
  continueWatching,
  deleteProgress,
  getProgress,
  listMyList,
  progressForMedia,
  removeFromList,
  upsertProgress,
  watchedSummaries,
} from '../services/library.js';

export const progressRouter = Router();
progressRouter.use(requireAuth, requireProfile);

const progressSchema = z.object({
  itemKey: z.string().min(1),
  mediaType: z.enum(['movie', 'tv', 'anime']),
  mediaId: z.string().min(1),
  season: z.number().int().nullish(),
  episode: z.number().int().nullish(),
  positionSeconds: z.number().min(0),
  durationSeconds: z.number().min(0).nullish(),
  finished: z.boolean().optional(),
  title: z.string().nullish(),
  poster: z.string().nullish(),
  backdrop: z.string().nullish(),
  year: z.number().int().nullish(),
  sourceLink: z.string().nullish(),
});

progressRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const items = continueWatching(req.profile!.id);
    // Backfill the release year for older records so cards show it consistently.
    await Promise.all(
      items.map(async (it) => {
        if (it.year == null) {
          try {
            it.year = (await detailFor(it.mediaId)).year;
          } catch {
            /* leave null */
          }
        }
      }),
    );
    res.json({ items });
  }),
);

// Compact per-title watch state for the catalogue badges. Declared before the
// generic /:itemKey route so "summary" is not read as an item key.
progressRouter.get('/summary', (req, res) => {
  res.json({ items: watchedSummaries(req.profile!.id) });
});

// Every episode record for one title (the episode list progress bars).
progressRouter.get('/media/:mediaId', (req, res) => {
  res.json({ items: progressForMedia(req.profile!.id, decodeURIComponent(req.params.mediaId)) });
});

progressRouter.get('/:itemKey', (req, res) => {
  res.json({ progress: getProgress(req.profile!.id, req.params.itemKey) });
});

progressRouter.put('/', (req, res) => {
  const body = parse(progressSchema, req.body);
  res.json({ progress: upsertProgress(req.profile!.id, body) });
  // Connected AniList / MyAnimeList lists follow along (in the background; never blocks the save).
  if (body.mediaType === 'anime' && body.episode != null) {
    const { anime } = getPreferences(req.profile!.id);
    const share = body.durationSeconds ? body.positionSeconds / body.durationSeconds : 0;
    if (body.finished || share >= anime.trackAt / 100) void trackWatched(req.profile!.id, body.mediaId, body.episode).catch(() => undefined);
    else if (anime.trackAutoAdd && body.positionSeconds >= 60) void trackStarted(req.profile!.id, body.mediaId).catch(() => undefined);
  }
});

progressRouter.delete('/:itemKey', (req, res) => {
  deleteProgress(req.profile!.id, req.params.itemKey);
  res.status(204).end();
});

export const listRouter = Router();
listRouter.use(requireAuth, requireProfile);

const listSchema = z.object({
  mediaType: z.enum(['movie', 'tv', 'anime']),
  mediaId: z.string().min(1),
  title: z.string().nullish(),
  poster: z.string().nullish(),
  year: z.number().int().nullish(),
});

listRouter.get('/', (req, res) => {
  res.json({ items: listMyList(req.profile!.id) });
});

listRouter.post('/', (req, res) => {
  const body = parse(listSchema, req.body);
  addToList(req.profile!.id, body);
  res.status(201).json({ ok: true });
});

listRouter.delete('/:mediaType/:mediaId', (req, res) => {
  const { mediaType, mediaId } = req.params;
  // Rows store the full id ("movie:tt0111161"); older clients sent only the part after the colon.
  removeFromList(req.profile!.id, mediaType, mediaId.includes(':') ? mediaId : `${mediaType}:${mediaId}`);
  res.status(204).end();
});
