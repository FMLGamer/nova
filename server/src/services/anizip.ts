/**
 * ani.zip: free, keyless anime metadata keyed by AniList id. It has every
 * episode's title, synopsis, still, air date and its TVDB season/episode
 * numbers, plus the title's ids in every other database (IMDb, TMDB, Kitsu, MAL).
 */
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/upstream.js';
import type { Episode } from '../media/types.js';

interface ZipEpisode {
  episode?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  absoluteEpisodeNumber?: number;
  title?: Record<string, string | null> | null;
  overview?: string | null;
  summary?: string | null;
  image?: string | null;
  airDate?: string | null;
  airdate?: string | null;
  runtime?: number | null;
  length?: number | null;
}

export interface AniZip {
  episodes?: Record<string, ZipEpisode>;
  episodeCount?: number;
  mappings?: {
    imdb_id?: string | null;
    themoviedb_id?: string | number | null;
    kitsu_id?: number | null;
    mal_id?: number | null;
    thetvdb_id?: number | null;
  };
}

export function aniZip(anilistId: string): Promise<AniZip | null> {
  return cached(`anizip:${anilistId}`, 12 * 60 * 60 * 1000, async () => {
    try {
      return await fetchJson<AniZip>(`https://api.ani.zip/mappings?anilist_id=${encodeURIComponent(anilistId)}`, { timeoutMs: 10_000 });
    } catch {
      return null;
    }
  });
}

/** Regular episodes by number (specials, keyed "S1" etc., are left out). */
export function zipEpisodes(data: AniZip | null): Map<number, ZipEpisode> {
  const out = new Map<number, ZipEpisode>();
  for (const [key, e] of Object.entries(data?.episodes ?? {})) {
    const n = Number(key);
    if (Number.isInteger(n) && n > 0) out.set(n, e);
  }
  return out;
}

export function toEpisode(anilistId: string, n: number, e: ZipEpisode): Episode {
  // ani.zip writes apostrophes as backticks.
  const tidy = (s: string) => s.replace(/`/g, '\u2019').trim();
  const title = tidy(e.title?.en || e.title?.['x-jat'] || '');
  const overview = tidy((e.overview || e.summary || '').replace(/\n*\(?Source:[^\n]*\)?\s*$/i, ''));
  return {
    id: `anime:${anilistId}:e${n}`,
    season: 1,
    episode: n,
    title: title || `Episode ${n}`,
    overview,
    still: e.image ?? null,
    airDate: (e.airDate || e.airdate || '').slice(0, 10) || null,
    runtime: e.runtime || e.length || null,
  };
}
