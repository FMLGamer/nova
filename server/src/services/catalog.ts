import { cached } from '../lib/cache.js';
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
  // Filler only matters for long shows; mark it when MyAnimeList is already known to say so (never waits:
  // Jikan can take many seconds for a long show, and the title page fetches the marks on its own).
  if (list.length < 20) return list;
  const malId = (await anilistDetail(providerId).catch(() => null))?.malId;
  const marks = malId ? await fillerMarks(malId) : null;
  return marks?.size ? list.map((e) => (marks.has(e.episode) ? { ...e, filler: marks.get(e.episode)! } : e)) : list;
}

/** Sources disagree on air dates (advance screenings, time zones): the earliest one is the safest bet. */
function earliest(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a || !b) return a || b || null;
  return Date.parse(a) <= Date.parse(b) ? a : b;
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
        out.push({ ...e, still: a && !z.image ? a.still : e.still, airDate: earliest(e.airDate, a?.airDate) });
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
        if (t) out.push({ ...t, id: `anime:${providerId}:e${i + 1}`, season: 1, episode: i + 1, airDate: earliest(t.airDate, aniList[i]?.airDate) });
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
      if (t) out.push({ ...t, id: `anime:${providerId}:e${i + 1}`, season: 1, episode: i + 1, airDate: earliest(t.airDate, aniList[i]?.airDate) });
      else if (aniList[i]) out.push(aniList[i]!);
    }
    return out.length ? out : aniList;
  } catch {
    return aniList;
  }
}

const normTitle = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * How well a result answers the query: the title itself beats a title that starts with it, which beats one that
 * merely contains it; long titles around a short query (reaction videos, fan edits) and unknown years sink.
 * `rank` is the result's place in its source's own list.
 */
export function searchScore(item: CatalogItem, query: string, rank: number): number {
  const q = normTitle(query);
  const t = normTitle(item.title);
  if (!q || !t) return 0;
  const words = q.split(' ');
  const match = t === q ? 1 : t.startsWith(`${q} `) ? 0.75 : ` ${t} `.includes(` ${q} `) ? 0.55 : words.every((w) => t.includes(w)) ? 0.4 : 0.15;
  const tightness = Math.min(1, q.length / t.length);
  // Well-liked and widely followed titles first; nobody rated it at all: most likely an obscure namesake.
  const liked = item.rating ? (item.rating / 10) * 0.2 : -0.12;
  const followed = item.popularity ? Math.max(0, Math.min(0.3, (Math.log10(item.popularity) - 4) * 0.15)) : 0;
  return match + 0.25 * tightness - Math.min(0.3, rank * 0.03) - (item.year ? 0 : 0.15) - (item.poster ? 0 : 0.2) + liked + followed;
}

export async function searchAll(
  q: string,
): Promise<{ top: CatalogItem[]; movies: CatalogItem[]; shows: CatalogItem[]; anime: CatalogItem[] }> {
  const [movies, shows, anime] = await Promise.all([
    tmdbSearch('movie', q).catch(() => [] as CatalogItem[]),
    tmdbSearch('tv', q).catch(() => [] as CatalogItem[]),
    cached(`anilist:find:${q.toLowerCase()}`, 60 * 60_000, () => anilistSearch(q)).catch(() => [] as CatalogItem[]),
  ]);
  const scored = (list: CatalogItem[]) => list.map((item, rank) => ({ item, score: searchScore(item, q, rank) })).sort((a, b) => b.score - a.score);
  const [m, s, a] = [scored(movies), scored(shows), scored(anime)];
  // The same title as an anime and a show (AniList and TMDB both list it): keep the better-placed one.
  const seen = new Set<string>();
  const top = [...m, ...s, ...a]
    .sort((x, y) => y.score - x.score)
    .filter(({ item }) => {
      const k = `${normTitle(item.title)}|${item.year ?? ''}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 12)
    .map((x) => x.item);
  return { top, movies: m.map((x) => x.item), shows: s.map((x) => x.item), anime: a.map((x) => x.item) };
}
