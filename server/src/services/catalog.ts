import { HttpError } from '../lib/http.js';
import type { CatalogDetail, CatalogItem, Episode, Row } from '../media/types.js';
import { parseMediaId, stripAnimeSeason } from '../media/types.js';
import { anilistDetail, anilistEpisodes, anilistRows, anilistSearch } from './anilist.js';
import { aniZip, toEpisode, zipEpisodes } from './anizip.js';
import { fillerMarks } from './filler.js';
import { tmdbDetail, tmdbEpisodes, tmdbFindTv, tmdbRows, tmdbSearch, tmdbTvSeasons } from './tmdb.js';

async function settledRow(
  id: string,
  title: string,
  fn: () => Promise<CatalogItem[]>,
): Promise<Row | null> {
  try {
    const items = await fn();
    return items.length ? { id, title, items } : null;
  } catch {
    return null; // a missing/failing provider just drops its row
  }
}

export async function homeRows(): Promise<Row[]> {
  const defs: [string, string, () => Promise<CatalogItem[]>][] = [
    ['trending-movies', 'Trending movies', tmdbRows.trendingMovies],
    ['trending-tv', 'Trending shows', tmdbRows.trendingTv],
    ['trending-anime', 'Trending anime', anilistRows.trending],
    ['now-playing', 'New in cinemas', tmdbRows.nowPlaying],
    ['popular-tv', 'Popular shows', tmdbRows.popularTv],
    ['seasonal-anime', 'This season in anime', anilistRows.seasonal],
    ['top-movies', 'Top rated movies', tmdbRows.topRatedMovies],
    ['on-the-air', 'Airing now', tmdbRows.onTheAir],
  ];
  const rows = await Promise.all(defs.map(([id, title, fn]) => settledRow(id, title, fn)));
  return rows.filter((r): r is Row => r !== null);
}

export async function detailFor(id: string): Promise<CatalogDetail> {
  const { mediaType, providerId } = parseMediaId(id);
  if (mediaType === 'anime') return anilistDetail(providerId);
  return tmdbDetail(mediaType, providerId);
}

export async function episodesFor(id: string, season: number): Promise<Episode[]> {
  const { mediaType, providerId } = parseMediaId(id);
  if (mediaType === 'tv') return tmdbEpisodes(providerId, season);
  if (mediaType === 'anime') return animeEpisodes(providerId);
  throw new HttpError(400, 'Movies do not have episodes');
}

/**
 * Anime episode data: prefer TMDB (real stills, overviews, runtimes) by matching
 * the anime to a TMDB TV series, and fall back to AniList when there's no good match.
 */
/** Map an AniList anime (each season is its own entry) to the matching TMDB
 *  season by air year, since TMDB groups all seasons under one series. */
export function pickTmdbSeason(
  seasons: { season: number; episodeCount: number; year: number | null }[],
  year: number | null,
  count: number,
): number | null {
  if (!seasons.length || year == null) return null;
  const byYear = seasons.filter((s) => s.year === year);
  if (!byYear.length) return null;
  const near = (s: { episodeCount: number }) => (count > 0 ? Math.abs(s.episodeCount - count) : 0);
  return byYear.reduce((b, s) => (near(s) < near(b) ? s : b)).season;
}

async function animeEpisodes(providerId: string): Promise<Episode[]> {
  const list = await animeEpisodeList(providerId);
  // Filler only matters for long shows; mark it when MyAnimeList knows.
  if (list.length < 20) return list;
  const malId = (await anilistDetail(providerId).catch(() => null))?.malId;
  const marks = malId ? await fillerMarks(malId) : null;
  return marks?.size ? list.map((e) => (marks.has(e.episode) ? { ...e, filler: marks.get(e.episode)! } : e)) : list;
}

async function animeEpisodeList(providerId: string): Promise<Episode[]> {
  const [aniList, zip] = await Promise.all([anilistEpisodes(providerId).catch(() => [] as Episode[]), aniZip(providerId)]);
  const zipped = zipEpisodes(zip);
  if (zipped.size) {
    const count = Math.max(aniList.length, ...zipped.keys());
    const out: Episode[] = [];
    for (let n = 1; n <= count; n++) {
      const z = zipped.get(n);
      const a = aniList[n - 1];
      if (z) {
        const e = toEpisode(providerId, n, z);
        out.push(a && !z.image ? { ...e, still: a.still } : e);
      } else if (a) out.push(a);
    }
    if (out.length) return out;
  }
  return animeEpisodesFromTmdb(providerId, aniList);
}

async function animeEpisodesFromTmdb(providerId: string, aniList: Episode[]): Promise<Episode[]> {
  try {
    const detail = await anilistDetail(providerId);
    const tmdbId = await tmdbFindTv(stripAnimeSeason(detail.title), detail.year);
    if (!tmdbId) return aniList;
    const seasons = (await tmdbTvSeasons(tmdbId)).sort((a, b) => a.season - b.season);
    if (!seasons.length) return aniList;
    const isSequel = detail.relations.some((r) => r.relationType === 'PREQUEL');
    const maxSeason = Math.max(...seasons.map((s) => s.episodeCount));

    const build = (tmdbEps: Episode[]): Episode[] => {
      const count = Math.max(aniList.length, tmdbEps.length) || tmdbEps.length;
      const out: Episode[] = [];
      for (let i = 0; i < count; i++) {
        const t = tmdbEps[i];
        if (t) out.push({ ...t, id: `anime:${providerId}:e${i + 1}`, season: 1, episode: i + 1 });
        else if (aniList[i]) out.push(aniList[i]!);
      }
      return out;
    };

    // Long-runner: one AniList entry spanning many TMDB seasons (e.g. One Piece)
    // -> concatenate every season into a single absolute episode list.
    if (aniList.length > maxSeason + 4) {
      const abs = (
        await Promise.all(seasons.map((s) => tmdbEpisodes(tmdbId, s.season).catch(() => [] as Episode[])))
      ).flat();
      if (abs.length > maxSeason) {
        const out = build(abs);
        if (out.length) return out;
      }
    }

    // Otherwise map to a single TMDB season by air year (sequels / single-cour).
    let season = pickTmdbSeason(seasons, detail.year, aniList.length);
    if (season == null && !isSequel && seasons.some((s) => s.season === 1)) season = 1;
    if (season == null) return aniList;
    const tv = await tmdbEpisodes(tmdbId, season);
    if (!tv.length) return aniList;
    // A sequel mapped onto a big combined-cour season is ambiguous -> AniList.
    if (isSequel && aniList.length > 0 && tv.length > aniList.length + 4) return aniList;
    const count = aniList.length > 0 ? aniList.length : tv.length;
    const out: Episode[] = [];
    for (let i = 0; i < count; i++) {
      const t = tv[i];
      if (t) out.push({ ...t, id: `anime:${providerId}:e${i + 1}`, season: 1, episode: i + 1 });
      else if (aniList[i]) out.push(aniList[i]!);
    }
    return out.length ? out : aniList;
  } catch {
    return aniList;
  }
}

export async function searchAll(
  q: string,
): Promise<{ movies: CatalogItem[]; shows: CatalogItem[]; anime: CatalogItem[] }> {
  const [movies, shows, anime] = await Promise.all([
    tmdbSearch('movie', q).catch(() => [] as CatalogItem[]),
    tmdbSearch('tv', q).catch(() => [] as CatalogItem[]),
    anilistSearch(q).catch(() => [] as CatalogItem[]),
  ]);
  return { movies, shows, anime };
}
