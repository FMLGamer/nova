import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/upstream.js';
import { parseMediaId, stripAnimeSeason } from '../media/types.js';
import type { MediaContext } from '../plugins/protocol.js';
import { anilistDetail, anilistTitles } from '../services/anilist.js';
import { pickTmdbSeason } from '../services/catalog.js';
import { tmdbDetail, tmdbFindTv, tmdbTvSeasons } from '../services/tmdb.js';

const WEEK = 7 * 24 * 60 * 60 * 1000;

interface ArmIds {
  anilist?: number | null;
  kitsu?: number | null;
  myanimelist?: number | null;
  imdb?: string | null;
  themoviedb?: number | null;
  thetvdb?: number | null;
}

/** Cross-database anime ids (anilist -> kitsu/mal/imdb/tmdb), from the public ARM service. */
async function armIds(anilistId: string): Promise<ArmIds> {
  return cached(`arm:${anilistId}`, WEEK, async () => {
    try {
      return await fetchJson<ArmIds>(`https://arm.haglund.dev/api/v2/ids?source=anilist&id=${anilistId}`, {
        timeoutMs: 6000,
      });
    } catch {
      return {};
    }
  });
}

async function kitsuFromMal(malId: number): Promise<string | null> {
  return cached(`kitsu:mal:${malId}`, WEEK, async () => {
    for (const base of ['https://kitsu.app/api/edge', 'https://kitsu.io/api/edge']) {
      try {
        const data = await fetchJson<{ data?: { relationships?: { item?: { data?: { id?: string } } } }[] }>(
          `${base}/mappings?filter[externalSite]=myanimelist/anime&filter[externalId]=${malId}&include=item`,
          { timeoutMs: 6000, headers: { Accept: 'application/vnd.api+json' } },
        );
        const id = data.data?.[0]?.relationships?.item?.data?.id;
        if (id) return id;
      } catch {
        /* try the next mirror */
      }
    }
    return null;
  });
}

/** Maps an episode of an AniList entry onto TMDB's season/episode numbering. */
async function animeTvCoordinates(
  tmdbId: string,
  year: number | null,
  totalEpisodes: number | null,
  isSequel: boolean,
  episode: number,
): Promise<{ season: number; episode: number } | null> {
  try {
    const seasons = (await tmdbTvSeasons(tmdbId)).sort((a, b) => a.season - b.season);
    if (!seasons.length) return null;
    const maxSeason = Math.max(...seasons.map((s) => s.episodeCount));
    if ((totalEpisodes ?? 0) > maxSeason + 4) {
      // Long runner: one AniList entry spans many TMDB seasons.
      let left = episode;
      for (const s of seasons) {
        if (left <= s.episodeCount) return { season: s.season, episode: left };
        left -= s.episodeCount;
      }
      return null;
    }
    let season = pickTmdbSeason(seasons, year, totalEpisodes ?? 0);
    if (season == null && !isSequel && seasons.some((s) => s.season === 1)) season = 1;
    return season == null ? null : { season, episode };
  } catch {
    return null;
  }
}

/** Everything Nova knows about a title, in the shape plugins receive. */
export async function mediaContext(
  mediaId: string,
  season: number | null,
  episode: number | null,
): Promise<MediaContext> {
  const { mediaType, providerId } = parseMediaId(mediaId);
  if (mediaType === 'movie' || mediaType === 'tv') {
    const d = await tmdbDetail(mediaType, providerId);
    return {
      kind: mediaType,
      mediaId,
      title: d.title,
      altTitles: d.title.includes(':') || d.title.includes('-') ? [d.title.replace(/[-:._]/g, ' ').replace(/\s+/g, ' ').trim()] : [],
      year: d.year,
      season: mediaType === 'tv' ? season ?? 1 : null,
      episode: mediaType === 'tv' ? episode ?? 1 : null,
      absoluteEpisode: episode,
      ids: { tmdb: providerId, imdb: d.imdbId ?? undefined },
      tvSeason: season,
      tvEpisode: episode,
      format: mediaType === 'movie' ? 'MOVIE' : 'TV',
    };
  }

  const [d, titles, arm] = await Promise.all([
    anilistDetail(providerId),
    anilistTitles(providerId).catch(() => null),
    armIds(providerId),
  ]);
  const malId = d.malId ?? arm.myanimelist ?? null;
  const kitsu = arm.kitsu ? String(arm.kitsu) : malId ? await kitsuFromMal(malId) : null;
  const isMovie = (titles?.format ?? '') === 'MOVIE';
  const ep = isMovie ? null : episode ?? 1;

  let tmdbId = arm.themoviedb ? String(arm.themoviedb) : null;
  if (!tmdbId && !isMovie) tmdbId = await tmdbFindTv(stripAnimeSeason(d.title), d.year).catch(() => null);
  const isSequel = d.relations.some((r) => r.relationType === 'PREQUEL');
  const tv = tmdbId && ep ? await animeTvCoordinates(tmdbId, d.year, d.totalEpisodes, isSequel, ep) : null;

  const alt = new Set<string>();
  for (const t of [titles?.romaji, titles?.english, stripAnimeSeason(d.title), ...(titles?.synonyms ?? [])]) {
    if (t && t !== d.title) alt.add(t);
  }
  return {
    kind: 'anime',
    mediaId,
    title: d.title,
    altTitles: [...alt],
    year: d.year,
    season: 1,
    episode: ep,
    absoluteEpisode: ep,
    ids: {
      anilist: providerId,
      mal: malId ? String(malId) : undefined,
      kitsu: kitsu ?? undefined,
      imdb: arm.imdb ?? undefined,
      tmdb: tmdbId ?? undefined,
      tvdb: arm.thetvdb ? String(arm.thetvdb) : undefined,
    },
    tvSeason: tv?.season ?? null,
    tvEpisode: tv?.episode ?? null,
    format: titles?.format ?? null,
  };
}

/** Free-text context for music and books (no catalogue id mapping exists). */
export function textContext(kind: 'music' | 'book' | 'comic', title: string, creator: string | null, mediaId: string): MediaContext {
  return {
    kind,
    mediaId,
    title,
    altTitles: [],
    year: null,
    season: null,
    episode: null,
    absoluteEpisode: null,
    ids: {},
    creator,
  };
}

/**
 * Picks the Stremio (type, id) pair a plugin understands for this context, or
 * null when the plugin can't address it (e.g. an IMDb-only addon and an anime
 * that has no IMDb mapping).
 */
export function stremioTarget(
  ctx: MediaContext,
  prefixes: string[] | undefined,
  types: string[],
): { type: string; id: string } | null {
  const accepts = (p: string) => !prefixes || prefixes.length === 0 || prefixes.some((x) => x === p || x.startsWith(p));
  const typeOk = (t: string) => types.length === 0 || types.includes(t);

  if (ctx.kind === 'movie') {
    if (ctx.ids.imdb && accepts('tt') && typeOk('movie')) return { type: 'movie', id: ctx.ids.imdb };
    if (ctx.ids.tmdb && accepts('tmdb') && typeOk('movie')) return { type: 'movie', id: `tmdb:${ctx.ids.tmdb}` };
    return null;
  }
  if (ctx.kind === 'tv') {
    const s = ctx.season ?? 1;
    const e = ctx.episode ?? 1;
    if (ctx.ids.imdb && accepts('tt') && typeOk('series')) return { type: 'series', id: `${ctx.ids.imdb}:${s}:${e}` };
    if (ctx.ids.tmdb && accepts('tmdb') && typeOk('series')) return { type: 'series', id: `tmdb:${ctx.ids.tmdb}:${s}:${e}` };
    return null;
  }
  if (ctx.kind === 'anime') {
    const isMovie = ctx.format === 'MOVIE';
    const type = isMovie ? 'movie' : 'series';
    const ep = ctx.episode ?? 1;
    if (!typeOk(type) && !typeOk('anime')) return null;
    const t = typeOk(type) ? type : 'anime';
    if (ctx.ids.kitsu && prefixes?.some((p) => p.startsWith('kitsu'))) {
      return { type: t, id: isMovie ? `kitsu:${ctx.ids.kitsu}` : `kitsu:${ctx.ids.kitsu}:${ep}` };
    }
    if (ctx.ids.anilist && prefixes?.some((p) => p.startsWith('anilist'))) {
      return { type: t, id: isMovie ? `anilist:${ctx.ids.anilist}` : `anilist:${ctx.ids.anilist}:${ep}` };
    }
    if (ctx.ids.mal && prefixes?.some((p) => p.startsWith('mal'))) {
      return { type: t, id: isMovie ? `mal:${ctx.ids.mal}` : `mal:${ctx.ids.mal}:${ep}` };
    }
    if (ctx.ids.imdb && accepts('tt')) {
      if (isMovie) return { type: 'movie', id: ctx.ids.imdb };
      if (ctx.tvSeason && ctx.tvEpisode) return { type: 'series', id: `${ctx.ids.imdb}:${ctx.tvSeason}:${ctx.tvEpisode}` };
    }
    return null;
  }
  return null;
}
