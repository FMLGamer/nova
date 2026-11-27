/**
 * Movies and shows without an API key: Cinemeta, the open IMDb-based catalogue
 * Stremio itself runs on (posters, backdrops, cast, trailers and every episode
 * with stills). Used whenever no TMDB key is configured; titles are addressed by
 * their IMDb id ("movie:tt0111161", "tv:tt0944947").
 */
import { cached } from '../lib/cache.js';
import { HttpError } from '../lib/http.js';
import { fetchJson } from '../lib/upstream.js';
import type { CatalogDetail, CatalogItem, Episode, Season } from '../media/types.js';

const BASE = 'https://v3-cinemeta.strem.io';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PAGE = 50;

type Kind = 'movie' | 'tv';

interface CmVideo {
  id?: string;
  season?: number;
  episode?: number;
  number?: number;
  name?: string;
  title?: string;
  overview?: string;
  description?: string;
  thumbnail?: string;
  released?: string;
  firstAired?: string;
}

interface CmMeta {
  id?: string;
  imdb_id?: string;
  type?: string;
  name?: string;
  poster?: string;
  background?: string;
  description?: string;
  releaseInfo?: string;
  year?: string | number;
  released?: string;
  runtime?: string;
  genres?: string[];
  genre?: string[];
  imdbRating?: string;
  cast?: string[];
  trailers?: { source?: string; type?: string }[];
  videos?: CmVideo[];
  status?: string;
}

export const isImdbId = (id: string): boolean => /^tt\d{5,10}$/.test(id);

const stremioType = (kind: Kind) => (kind === 'movie' ? 'movie' : 'series');

/** Metahub serves the same art in several sizes; cards and backdrops want bigger ones than "small". */
function art(url: string | undefined, size: 'medium' | 'large'): string | null {
  if (!url) return null;
  return url.replace(/(images\.metahub\.space\/(?:poster|background|logo)\/)(small|medium|large)\//, `$1${size}/`);
}

function yearOf(m: CmMeta): number | null {
  const y = Number(String(m.year ?? m.releaseInfo ?? m.released ?? '').slice(0, 4));
  return Number.isFinite(y) && y > 1800 ? y : null;
}

function mapItem(m: CmMeta, kind: Kind): CatalogItem | null {
  const id = m.imdb_id ?? m.id;
  if (!id || !isImdbId(id) || !m.name) return null;
  const runtime = Number(/(\d+)\s*min/i.exec(m.runtime ?? '')?.[1]);
  const rating = Number(m.imdbRating);
  return {
    id: `${kind}:${id}`,
    mediaType: kind,
    title: m.name,
    year: yearOf(m),
    poster: art(m.poster, 'medium'),
    backdrop: art(m.background, 'large'),
    overview: m.description ?? '',
    rating: Number.isFinite(rating) && rating > 0 ? rating : null,
    runtime: Number.isFinite(runtime) && runtime > 0 ? runtime : null,
    genres: m.genres ?? m.genre ?? [],
  };
}

async function catalog(kind: Kind, id: string, extra: Record<string, string | number> = {}): Promise<CatalogItem[]> {
  const parts = Object.entries(extra).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  const url = `${BASE}/catalog/${stremioType(kind)}/${id}${parts.length ? `/${parts.join('&')}` : ''}.json`;
  const data = await cached(`cinemeta:${url}`, 6 * HOUR, () => fetchJson<{ metas?: CmMeta[] }>(url, { timeoutMs: 12_000 }));
  return (data.metas ?? []).map((m) => mapItem(m, kind)).filter((i): i is CatalogItem => i !== null && Boolean(i.poster));
}

const thisYear = () => new Date().getUTCFullYear();

export const cinemetaRows = {
  popularMovies: () => catalog('movie', 'top'),
  popularTv: () => catalog('tv', 'top'),
  featuredMovies: () => catalog('movie', 'imdbRating'),
  featuredTv: () => catalog('tv', 'imdbRating'),
  newMovies: () => catalog('movie', 'year', { genre: thisYear() }),
  newTv: () => catalog('tv', 'year', { genre: thisYear() }),
};

export async function cinemetaGenres(kind: Kind): Promise<{ id: string; name: string }[]> {
  return cached(`cinemeta:genres:${kind}`, 7 * DAY, async () => {
    const m = await fetchJson<{ catalogs?: { type: string; id: string; extra?: { name: string; options?: string[] }[] }[] }>(`${BASE}/manifest.json`);
    const cat = m.catalogs?.find((c) => c.type === stremioType(kind) && c.id === 'top');
    return (cat?.extra?.find((e) => e.name === 'genre')?.options ?? []).map((g) => ({ id: g, name: g }));
  });
}

export async function cinemetaBrowse(kind: Kind, opts: { genre?: string; sort?: string; page?: number }): Promise<CatalogItem[]> {
  const skip = Math.max(0, ((opts.page ?? 1) - 1) * PAGE);
  const extra = (genre?: string | number): Record<string, string | number> => {
    const out: Record<string, string | number> = {};
    if (genre != null && genre !== '') out.genre = genre;
    if (skip) out.skip = skip;
    return out;
  };
  const sort = opts.sort ?? '';
  if (/vote_average/.test(sort)) return catalog(kind, 'imdbRating', extra(opts.genre));
  if (/date/.test(sort)) {
    if (!opts.genre) return catalog(kind, 'year', extra(thisYear()));
    const items = await catalog(kind, 'top', extra(opts.genre));
    return items.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
  }
  return catalog(kind, 'top', extra(opts.genre));
}

export function cinemetaSearch(kind: Kind, query: string): Promise<CatalogItem[]> {
  return catalog(kind, 'top', { search: query });
}

async function meta(kind: Kind, imdbId: string): Promise<CmMeta> {
  if (!isImdbId(imdbId)) throw new HttpError(503, 'Movie and show details need a TMDB key (Server → Advanced → Integrations)');
  return cached(`cinemeta:meta:${kind}:${imdbId}`, DAY, async () => {
    const data = await fetchJson<{ meta?: CmMeta | null }>(`${BASE}/meta/${stremioType(kind)}/${imdbId}.json`, { timeoutMs: 12_000 });
    if (!data.meta?.name) throw new HttpError(404, 'Title not found');
    return data.meta;
  });
}

function episodeOf(imdbId: string, v: CmVideo): Episode | null {
  const season = v.season ?? 0;
  const episode = v.episode ?? v.number;
  if (episode == null) return null;
  const date = (v.released ?? v.firstAired ?? '').slice(0, 10);
  return {
    id: `tv:${imdbId}:s${season}e${episode}`,
    season,
    episode,
    title: v.name || v.title || `Episode ${episode}`,
    overview: v.overview ?? v.description ?? '',
    still: v.thumbnail ?? null,
    airDate: date || null,
    runtime: null,
  };
}

function seasonsOf(imdbId: string, m: CmMeta): (Season & { year: number | null })[] {
  const by = new Map<number, { count: number; year: number | null }>();
  for (const v of m.videos ?? []) {
    const e = episodeOf(imdbId, v);
    if (!e || e.season <= 0) continue;
    const s = by.get(e.season) ?? { count: 0, year: null };
    s.count++;
    const y = e.airDate ? Number(e.airDate.slice(0, 4)) : null;
    if (y && (s.year == null || y < s.year)) s.year = y;
    by.set(e.season, s);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([season, s]) => ({ season, name: `Season ${season}`, episodeCount: s.count, year: s.year }));
}

export async function cinemetaDetail(kind: Kind, imdbId: string): Promise<CatalogDetail> {
  const m = await meta(kind, imdbId);
  const base = mapItem(m, kind);
  if (!base) throw new HttpError(404, 'Title not found');
  const seasons = kind === 'tv' ? seasonsOf(imdbId, m) : [];
  const trailer = m.trailers?.find((t) => t.type === 'Trailer' && t.source) ?? m.trailers?.find((t) => t.source);
  return {
    ...base,
    tagline: null,
    status: m.status ?? null,
    seasons: seasons.map(({ season, name, episodeCount }) => ({ season, name, episodeCount })),
    cast: (m.cast ?? []).slice(0, 12).map((name) => ({ name, character: '', photo: null })),
    studios: [],
    totalEpisodes: kind === 'tv' ? seasons.reduce((n, s) => n + s.episodeCount, 0) || null : null,
    trailer: trailer?.source ? { site: 'youtube', key: trailer.source } : null,
    characters: [],
    relations: [],
    malId: null,
    imdbId,
  };
}

export async function cinemetaEpisodes(imdbId: string, season: number): Promise<Episode[]> {
  const m = await meta('tv', imdbId);
  return (m.videos ?? [])
    .map((v) => episodeOf(imdbId, v))
    .filter((e): e is Episode => e !== null && e.season === season)
    .sort((a, b) => a.episode - b.episode);
}

export async function cinemetaTvSeasons(imdbId: string): Promise<{ season: number; episodeCount: number; year: number | null }[]> {
  return seasonsOf(imdbId, await meta('tv', imdbId)).map(({ season, episodeCount, year }) => ({ season, episodeCount, year }));
}

/** Which kind an IMDb id is ('movie:tt…' or 'tv:tt…'). */
export async function cinemetaFindByImdb(imdbId: string, hint?: 'movie' | 'tv'): Promise<string | null> {
  if (!isImdbId(imdbId)) return null;
  if (hint) return `${hint}:${imdbId}`;
  for (const kind of ['movie', 'tv'] as const) {
    try {
      await meta(kind, imdbId);
      return `${kind}:${imdbId}`;
    } catch {
      /* try the other kind */
    }
  }
  return null;
}
