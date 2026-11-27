import { integration } from './integrations.js';
import {
  cinemetaBrowse,
  cinemetaDetail,
  cinemetaEpisodes,
  cinemetaFindByImdb,
  cinemetaGenres,
  cinemetaRows,
  cinemetaSearch,
  cinemetaTvSeasons,
  isImdbId,
} from './cinemeta.js';
import { HttpError } from '../lib/http.js';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/upstream.js';
import type {
  CatalogDetail,
  CatalogItem,
  Episode,
  Relation,
  Season,
  Trailer,
} from '../media/types.js';

const BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';
const DAY = 24 * 60 * 60 * 1000;

/**
 * TMDB needs a personal API key. Without one, movies and shows come from
 * Cinemeta (keyless, IMDb ids); titles with IMDb ids always do.
 */
const keyless = () => !integration('tmdbApiKey');

interface TmdbListItem {
  id: number;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  vote_average?: number;
  genre_ids?: number[];
}

interface TmdbList {
  page: number;
  total_pages: number;
  results: TmdbListItem[];
}

interface TmdbGenre {
  id: number;
  name: string;
}

interface TmdbCredits {
  cast?: { name: string; character: string; profile_path?: string | null }[];
}

interface TmdbVideo {
  site?: string;
  type?: string;
  key?: string;
  official?: boolean;
}

interface TmdbExternalIds {
  imdb_id?: string | null;
}

interface TmdbMovieDetail extends TmdbListItem {
  tagline?: string;
  runtime?: number;
  status?: string;
  genres?: TmdbGenre[];
  credits?: TmdbCredits;
  production_companies?: { name: string }[];
  videos?: { results?: TmdbVideo[] };
  external_ids?: TmdbExternalIds;
  belongs_to_collection?: { id: number; name: string } | null;
  recommendations?: { results?: TmdbListItem[] };
}

interface TmdbTvDetail extends TmdbListItem {
  tagline?: string;
  status?: string;
  genres?: TmdbGenre[];
  credits?: TmdbCredits;
  number_of_episodes?: number;
  episode_run_time?: number[];
  seasons?: { season_number: number; name: string; episode_count: number; air_date?: string | null }[];
  production_companies?: { name: string }[];
  videos?: { results?: TmdbVideo[] };
  external_ids?: TmdbExternalIds;
  recommendations?: { results?: TmdbListItem[] };
}

interface TmdbSeason {
  episodes?: {
    id: number;
    season_number: number;
    episode_number: number;
    name?: string;
    overview?: string;
    still_path?: string | null;
    air_date?: string | null;
    runtime?: number | null;
  }[];
}

function img(path: string | null | undefined, size: string): string | null {
  return path ? `${IMG}/${size}${path}` : null;
}

function requireKey(): string {
  const key = integration('tmdbApiKey');
  if (!key) throw new HttpError(503, 'TMDB is not configured (Server → Advanced → Integrations)');
  return key;
}

async function tmdb<T>(pathname: string, params: Record<string, string | number> = {}): Promise<T> {
  const url = new URL(`${BASE}${pathname}`);
  url.searchParams.set('api_key', requireKey());
  url.searchParams.set('language', 'en-US');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  return fetchJson<T>(url.toString());
}

async function genreMap(kind: 'movie' | 'tv'): Promise<Map<number, string>> {
  return cached(`tmdb:genres:${kind}`, 7 * DAY, async () => {
    const data = await tmdb<{ genres: TmdbGenre[] }>(`/genre/${kind}/list`);
    return new Map(data.genres.map((g) => [g.id, g.name]));
  });
}

function mapItem(raw: TmdbListItem, kind: 'movie' | 'tv', genres: Map<number, string>): CatalogItem {
  const isMovie = kind === 'movie';
  const date = isMovie ? raw.release_date : raw.first_air_date;
  return {
    id: `${kind}:${raw.id}`,
    mediaType: kind,
    title: (isMovie ? raw.title : raw.name) ?? raw.title ?? raw.name ?? 'Untitled',
    year: date ? Number(date.slice(0, 4)) || null : null,
    poster: img(raw.poster_path, 'w500'),
    backdrop: img(raw.backdrop_path, 'w1280'),
    overview: raw.overview ?? '',
    rating: raw.vote_average ?? null,
    runtime: null,
    genres: (raw.genre_ids ?? []).map((id) => genres.get(id)).filter((g): g is string => Boolean(g)),
  };
}

async function mapList(data: TmdbList, kind: 'movie' | 'tv'): Promise<CatalogItem[]> {
  const genres = await genreMap(kind);
  return data.results
    .filter((r) => r.poster_path)
    .map((r) => mapItem(r, kind, genres));
}

async function list(kind: 'movie' | 'tv', pathname: string, cacheKey: string): Promise<CatalogItem[]> {
  const data = await cached(cacheKey, 6 * 60 * 60 * 1000, () => tmdb<TmdbList>(pathname));
  return mapList(data, kind);
}

export const tmdbRows = {
  trendingMovies: () => (keyless() ? cinemetaRows.popularMovies() : list('movie', '/trending/movie/week', 'tmdb:trending:movie')),
  trendingTv: () => (keyless() ? cinemetaRows.popularTv() : list('tv', '/trending/tv/week', 'tmdb:trending:tv')),
  popularMovies: () => (keyless() ? cinemetaRows.popularMovies() : list('movie', '/movie/popular', 'tmdb:popular:movie')),
  popularTv: () => (keyless() ? cinemetaRows.featuredTv() : list('tv', '/tv/popular', 'tmdb:popular:tv')),
  topRatedMovies: () => (keyless() ? cinemetaRows.featuredMovies() : list('movie', '/movie/top_rated', 'tmdb:toprated:movie')),
  nowPlaying: () => (keyless() ? cinemetaRows.newMovies() : list('movie', '/movie/now_playing', 'tmdb:nowplaying:movie')),
  onTheAir: () => (keyless() ? cinemetaRows.newTv() : list('tv', '/tv/on_the_air', 'tmdb:ontheair:tv')),
};

export async function tmdbGenres(kind: 'movie' | 'tv'): Promise<{ id: number | string; name: string }[]> {
  if (keyless()) return cinemetaGenres(kind);
  const map = await genreMap(kind);
  return [...map.entries()].map(([id, name]) => ({ id, name }));
}

export async function tmdbBrowse(
  kind: 'movie' | 'tv',
  opts: { genre?: string; sort?: string; page?: number },
): Promise<CatalogItem[]> {
  if (keyless()) return cinemetaBrowse(kind, opts);
  const params: Record<string, string | number> = {
    page: opts.page ?? 1,
    sort_by: opts.sort ?? 'popularity.desc',
    include_adult: 'false',
    'vote_count.gte': 50,
  };
  if (opts.genre) params.with_genres = opts.genre;
  const data = await tmdb<TmdbList>(`/discover/${kind}`, params);
  return mapList(data, kind);
}

export async function tmdbSearch(kind: 'movie' | 'tv', query: string): Promise<CatalogItem[]> {
  if (keyless()) return cinemetaSearch(kind, query);
  const data = await tmdb<TmdbList>(`/search/${kind}`, { query, include_adult: 'false' });
  return mapList(data, kind);
}

/** IMDb id -> Nova media id ('movie:603' / 'tv:1399', or 'movie:tt…' without a TMDB key). */
export async function tmdbFindByImdb(imdbId: string, hint?: 'movie' | 'tv'): Promise<string | null> {
  if (keyless()) return cinemetaFindByImdb(imdbId, hint);
  return cached(`tmdb:find:${imdbId}`, 7 * DAY, async () => {
    const data = await tmdb<{ movie_results?: { id: number }[]; tv_results?: { id: number }[] }>(`/find/${imdbId}`, {
      external_source: 'imdb_id',
    });
    if (data.movie_results?.[0]) return `movie:${data.movie_results[0].id}`;
    if (data.tv_results?.[0]) return `tv:${data.tv_results[0].id}`;
    return null;
  });
}

/** Best-effort map of an anime title to a TMDB TV id, for richer episode data. */
export async function tmdbFindTv(title: string, year?: number | null): Promise<string | null> {
  if (!integration('tmdbApiKey')) return null;
  return cached(`tmdb:findtv:${title.toLowerCase()}:${year ?? ''}`, DAY, async () => {
    const data = await tmdb<TmdbList>('/search/tv', { query: title, include_adult: 'false' });
    const results = data.results ?? [];
    if (!results.length) return null;
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const nt = norm(title);
    const exactYear =
      year != null
        ? results.find(
            (r) => norm(r.name ?? '') === nt && (r.first_air_date ?? '').startsWith(String(year)),
          )
        : undefined;
    const pick = exactYear ?? results.find((r) => norm(r.name ?? '') === nt) ?? results[0];
    return pick ? String(pick.id) : null;
  });
}

function pickTrailer(videos: { results?: TmdbVideo[] } | undefined): Trailer | null {
  const list = (videos?.results ?? []).filter(
    (v) => v.site === 'YouTube' && v.key && (v.type === 'Trailer' || v.type === 'Teaser'),
  );
  const best =
    list.find((v) => v.type === 'Trailer' && v.official) ??
    list.find((v) => v.type === 'Trailer') ??
    list[0];
  return best?.key ? { site: 'youtube', key: best.key } : null;
}

/**
 * Related titles for TMDB media. Movies in a franchise collection become proper
 * PREQUEL/SEQUEL entries ordered by release date; everything else falls back to
 * TMDB's own recommendations so the row is still useful.
 */
async function tmdbRelations(
  kind: 'movie' | 'tv',
  id: string,
  self: { year: number | null },
  collectionId: number | null,
  recommendations: { results?: TmdbListItem[] } | undefined,
): Promise<Relation[]> {
  const out: Relation[] = [];
  if (kind === 'movie' && collectionId) {
    try {
      const col = await tmdb<{ parts?: TmdbListItem[] }>(`/collection/${collectionId}`);
      const parts = (col.parts ?? [])
        .filter((p) => String(p.id) !== String(id))
        .sort((a, b) => (a.release_date ?? '').localeCompare(b.release_date ?? ''));
      for (const p of parts) {
        const year = p.release_date ? Number(p.release_date.slice(0, 4)) : null;
        const rel =
          self.year != null && year != null ? (year < self.year ? 'PREQUEL' : 'SEQUEL') : 'RELATED';
        out.push({
          id: `movie:${p.id}`,
          relationType: rel,
          title: p.title ?? p.name ?? 'Untitled',
          format: 'MOVIE',
          poster: p.poster_path ? `${IMG}/w342${p.poster_path}` : null,
        });
      }
    } catch {
      /* collection lookup is best-effort */
    }
  }
  for (const r of (recommendations?.results ?? []).slice(0, 12)) {
    const rid = `${kind}:${r.id}`;
    if (out.some((o) => o.id === rid)) continue;
    out.push({
      id: rid,
      relationType: 'RELATED',
      title: r.title ?? r.name ?? 'Untitled',
      format: kind === 'movie' ? 'MOVIE' : 'TV',
      poster: r.poster_path ? `${IMG}/w342${r.poster_path}` : null,
    });
  }
  return out.slice(0, 20);
}

export async function tmdbDetail(kind: 'movie' | 'tv', id: string): Promise<CatalogDetail> {
  if (isImdbId(id) || keyless()) return cinemetaDetail(kind, id);
  return cached(`tmdb:detail:${kind}:${id}`, DAY, async () => {
    const genres = await genreMap(kind);
    if (kind === 'movie') {
      const m = await tmdb<TmdbMovieDetail>(`/movie/${id}`, {
        append_to_response: 'credits,videos,external_ids,recommendations',
      });
      const base = mapItem(m, 'movie', genres);
      return {
        ...base,
        genres: (m.genres ?? []).map((g) => g.name),
        tagline: m.tagline || null,
        runtime: m.runtime ?? null,
        status: m.status ?? null,
        seasons: [],
        cast: mapCast(m.credits),
        studios: (m.production_companies ?? []).map((c) => c.name),
        totalEpisodes: null,
        trailer: pickTrailer(m.videos),
        characters: [],
        relations: await tmdbRelations(
          'movie',
          id,
          { year: base.year },
          m.belongs_to_collection?.id ?? null,
          m.recommendations,
        ),
        malId: null,
        imdbId: m.external_ids?.imdb_id ?? null,
      };
    }
    const t = await tmdb<TmdbTvDetail>(`/tv/${id}`, {
      append_to_response: 'credits,videos,external_ids,recommendations',
    });
    const seasons: Season[] = (t.seasons ?? [])
      .filter((s) => s.season_number > 0)
      .map((s) => ({ season: s.season_number, name: s.name, episodeCount: s.episode_count }));
    const baseTv = mapItem(t, 'tv', genres);
    return {
      ...baseTv,
      genres: (t.genres ?? []).map((g) => g.name),
      tagline: t.tagline || null,
      runtime: t.episode_run_time?.[0] ?? null,
      status: t.status ?? null,
      seasons,
      cast: mapCast(t.credits),
      studios: (t.production_companies ?? []).map((c) => c.name),
      totalEpisodes: t.number_of_episodes ?? null,
      trailer: pickTrailer(t.videos),
      characters: [],
      relations: await tmdbRelations('tv', id, { year: baseTv.year }, null, t.recommendations),
      malId: null,
      imdbId: t.external_ids?.imdb_id ?? null,
    };
  });
}

export async function tmdbEpisodes(id: string, season: number): Promise<Episode[]> {
  if (isImdbId(id)) return cinemetaEpisodes(id, season);
  return cached(`tmdb:season:${id}:${season}`, DAY, async () => {
    const data = await tmdb<TmdbSeason>(`/tv/${id}/season/${season}`);
    return (data.episodes ?? []).map((e) => ({
      id: `tv:${id}:s${e.season_number}e${e.episode_number}`,
      season: e.season_number,
      episode: e.episode_number,
      title: e.name ?? `Episode ${e.episode_number}`,
      overview: e.overview ?? '',
      still: img(e.still_path, 'w300'),
      airDate: e.air_date ?? null,
      runtime: e.runtime ?? null,
    }));
  });
}

export async function tmdbTvSeasons(
  id: string,
): Promise<{ season: number; episodeCount: number; year: number | null }[]> {
  if (isImdbId(id)) return cinemetaTvSeasons(id);
  return cached(`tmdb:seasons:${id}`, DAY, async () => {
    const t = await tmdb<TmdbTvDetail>(`/tv/${id}`);
    return (t.seasons ?? [])
      .filter((s) => s.season_number > 0)
      .map((s) => ({
        season: s.season_number,
        episodeCount: s.episode_count,
        year: s.air_date ? Number(String(s.air_date).slice(0, 4)) || null : null,
      }));
  });
}

function mapCast(credits: TmdbCredits | undefined): CatalogDetail['cast'] {
  return (credits?.cast ?? []).slice(0, 12).map((c) => ({
    name: c.name,
    character: c.character,
    photo: img(c.profile_path, 'w185'),
  }));
}
