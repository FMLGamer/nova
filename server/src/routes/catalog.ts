import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../lib/async.js';
import type { CatalogItem } from '../media/types.js';
import { detailFor, episodesFor, homeRows, searchAll } from '../services/catalog.js';
import { tmdbBrowse, tmdbFindByImdb, tmdbGenres } from '../services/tmdb.js';
import { ANIME_GENRES, anilistBrowse, anilistRecent, anilistRows, anilistSchedule } from '../services/anilist.js';
import { getSkipTimes } from '../services/aniskip.js';
import { downloadSubtitleVtt, searchSubtitles, subtitlesConfigured } from '../services/subtitles.js';
import { activePlugins } from '../plugins/manager.js';
import { pluginSubtitleVtt, pluginSubtitles } from '../plugins/subtitles.js';
import { HttpError } from '../lib/http.js';

export const catalogRouter = Router();
catalogRouter.use(requireAuth);

const MEDIA_TYPES = new Set(['movie', 'tv', 'anime']);
const q = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

catalogRouter.get(
  '/home',
  asyncHandler(async (_req, res) => {
    res.json({ rows: await homeRows() });
  }),
);

catalogRouter.get(
  '/genres/:kind',
  asyncHandler(async (req, res) => {
    const kind = req.params.kind === 'tv' ? 'tv' : 'movie';
    res.json({ genres: await tmdbGenres(kind) });
  }),
);

catalogRouter.get(
  '/movies',
  asyncHandler(async (req, res) => {
    const items = await tmdbBrowse('movie', {
      genre: q(req.query.genre),
      sort: q(req.query.sort),
      page: Number(req.query.page) || 1,
    });
    res.json({ items });
  }),
);

catalogRouter.get(
  '/shows',
  asyncHandler(async (req, res) => {
    const items = await tmdbBrowse('tv', {
      genre: q(req.query.genre),
      sort: q(req.query.sort),
      page: Number(req.query.page) || 1,
    });
    res.json({ items });
  }),
);

catalogRouter.get(
  '/anime/recent',
  asyncHandler(async (_req, res) => {
    res.json({ items: await anilistRecent() });
  }),
);

catalogRouter.get(
  '/anime/schedule',
  asyncHandler(async (req, res) => {
    res.json({ schedule: await anilistSchedule(Number(req.query.week) || 0) });
  }),
);

catalogRouter.get(
  '/anime/genres',
  (_req, res) => {
    res.json({ genres: ANIME_GENRES.map((g) => ({ id: g, name: g })) });
  },
);

catalogRouter.get(
  '/anime/browse',
  asyncHandler(async (req, res) => {
    const items = await anilistBrowse({
      genre: q(req.query.genre),
      sort: q(req.query.sort),
      page: Number(req.query.page) || 1,
      format: q(req.query.format),
    });
    res.json({ items });
  }),
);

/** "Because you watched X": the title's own recommendations as cards. */
catalogRouter.get(
  '/because/:mediaType/:id',
  asyncHandler(async (req, res) => {
    const d = await detailFor(`${req.params.mediaType}:${req.params.id}`);
    const items: CatalogItem[] = d.relations
      .filter((r) => r.poster)
      .map((r) => ({
        id: r.id,
        mediaType: r.id.split(':')[0] as CatalogItem['mediaType'],
        title: r.title,
        year: null,
        poster: r.poster,
        backdrop: null,
        overview: '',
        rating: null,
        runtime: null,
        genres: [],
      }));
    res.json({ title: d.title, items });
  }),
);

catalogRouter.get(
  '/anime',
  asyncHandler(async (req, res) => {
    const rows: Record<string, () => Promise<CatalogItem[]>> = {
      trending: anilistRows.trending,
      popular: anilistRows.popular,
      top: anilistRows.topRated,
      seasonal: anilistRows.seasonal,
    };
    const fn = rows[q(req.query.sort) ?? 'trending'] ?? anilistRows.trending;
    res.json({ items: await fn() });
  }),
);

catalogRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const query = String(req.query.q ?? '').trim();
    if (!query) {
      res.json({ movies: [], shows: [], anime: [] });
      return;
    }
    res.json(await searchAll(query));
  }),
);

catalogRouter.get(
  '/aniskip/:malId/:episode',
  asyncHandler(async (req, res) => {
    const malId = Number(req.params.malId);
    const episode = Number(req.params.episode);
    if (!malId || !episode) {
      res.json({ op: null, ed: null });
      return;
    }
    res.json(await getSkipTimes(malId, episode));
  }),
);

/** Maps a Stremio-style id from a plugin catalog (tt…, tmdb:…, anilist:…) to a Nova media id. */
catalogRouter.get(
  '/resolve',
  asyncHandler(async (req, res) => {
    const id = String(req.query.id ?? '').trim();
    const type = String(req.query.type ?? '');
    let mediaId: string | null = null;
    const imdb = /^(tt\d{5,10})(?::|$)/.exec(id);
    if (imdb) mediaId = await tmdbFindByImdb(imdb[1]!, type === 'movie' ? 'movie' : type === 'series' ? 'tv' : undefined).catch(() => null);
    else if (/^anilist:\d+/.test(id)) mediaId = `anime:${id.split(':')[1]}`;
    else if (/^tmdb:\d+/.test(id)) mediaId = `${type === 'movie' ? 'movie' : 'tv'}:${id.split(':')[1]}`;
    res.json({ mediaId });
  }),
);

catalogRouter.get('/subtitles/status', (_req, res) => {
  res.json({ configured: subtitlesConfigured(), plugins: activePlugins('subtitles').length });
});

/** Subtitles offered by subtitle plugins (OpenSubtitles v3 and friends) for a title or episode. */
catalogRouter.get(
  '/subtitles/sources',
  asyncHandler(async (req, res) => {
    const mediaId = String(req.query.mediaId ?? '');
    if (!/^(movie|tv|anime):[\w-]+$/.test(mediaId)) throw new HttpError(400, 'mediaId is required');
    const num = (v: unknown) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
    res.json({ subtitles: await pluginSubtitles(mediaId, num(req.query.season), num(req.query.episode)) });
  }),
);

catalogRouter.get(
  '/subtitles/plugin/:token',
  asyncHandler(async (req, res) => {
    const vtt = await pluginSubtitleVtt(req.params.token);
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(vtt);
  }),
);

catalogRouter.get(
  '/subtitles/file/:fileId',
  asyncHandler(async (req, res) => {
    const vtt = await downloadSubtitleVtt(Number(req.params.fileId));
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.send(vtt);
  }),
);

catalogRouter.get(
  '/subtitles',
  asyncHandler(async (req, res) => {
    const subtitles = await searchSubtitles({
      imdbId: q(req.query.imdbId),
      query: q(req.query.query),
      season: req.query.season ? Number(req.query.season) : undefined,
      episode: req.query.episode ? Number(req.query.episode) : undefined,
      languages: q(req.query.languages),
      kind: q(req.query.kind) === 'episode' ? 'episode' : q(req.query.kind) === 'movie' ? 'movie' : undefined,
    });
    res.json({ subtitles });
  }),
);

catalogRouter.get(
  '/:mediaType/:id/episodes',
  asyncHandler(async (req, res, next) => {
    if (!MEDIA_TYPES.has(req.params.mediaType)) return next();
    const season = Number(req.query.season) || 1;
    const episodes = await episodesFor(`${req.params.mediaType}:${req.params.id}`, season);
    res.json({ episodes });
  }),
);

catalogRouter.get(
  '/:mediaType/:id',
  asyncHandler(async (req, res, next) => {
    if (!MEDIA_TYPES.has(req.params.mediaType)) return next();
    const detail = await detailFor(`${req.params.mediaType}:${req.params.id}`);
    res.json({ detail });
  }),
);
