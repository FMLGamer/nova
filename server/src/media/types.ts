// Shared, provider-agnostic media shapes returned to the frontend. TMDB and
// AniList results are both normalised into these so the UI has one model.

export type MediaType = 'movie' | 'tv' | 'anime';

export interface CatalogItem {
  id: string; // "movie:603" | "tv:1399" | "anime:21"
  mediaType: MediaType;
  title: string;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
  overview: string;
  rating: number | null; // 0..10
  runtime: number | null; // minutes, when known
  genres: string[];
}

export interface Episode {
  id: string;
  season: number;
  episode: number;
  title: string;
  overview: string;
  still: string | null;
  airDate: string | null;
  runtime: number | null;
  /** Anime: known filler or recap episode. */
  filler?: 'filler' | 'recap' | null;
}

export interface Season {
  season: number;
  name: string;
  episodeCount: number;
}

export interface CastMember {
  name: string;
  character: string;
  photo: string | null;
}

export interface Trailer {
  site: string; // 'youtube'
  key: string;
}

export interface Character {
  name: string;
  role: string;
  image: string | null;
  voiceActor: string | null;
  voiceActorImage: string | null;
}

export interface Relation {
  id: string;
  relationType: string; // PREQUEL | SEQUEL | SIDE_STORY | ...
  title: string;
  format: string | null;
  poster: string | null;
}

export interface CatalogDetail extends CatalogItem {
  tagline: string | null;
  runtime: number | null;
  status: string | null;
  seasons: Season[];
  cast: CastMember[];
  studios: string[];
  totalEpisodes: number | null;
  trailer: Trailer | null;
  characters: Character[];
  relations: Relation[];
  malId: number | null; // anime — for MAL + AniSkip
  imdbId: string | null; // movie/tv — for subtitles
  /** Anime still airing: the next episode and when (unix seconds). */
  nextAiring?: { episode: number; airingAt: number } | null;
}

export interface Row {
  id: string;
  title: string;
  items: CatalogItem[];
}

export interface AiringEntry {
  item: CatalogItem;
  episode: number;
  airingAt: number; // unix seconds
  weekday: number; // 0=Mon .. 6=Sun
}

export function parseMediaId(id: string): { mediaType: MediaType; providerId: string } {
  const [type, providerId] = id.split(':');
  if ((type !== 'movie' && type !== 'tv' && type !== 'anime') || !providerId) {
    throw new Error(`Invalid media id: ${id}`);
  }
  return { mediaType: type, providerId };
}

/** Strip season/part suffixes so torrent + TMDB lookups use the base series title. */
export function stripAnimeSeason(title: string): string {
  const base = title
    .replace(/\s*[:\-]?\s*\b(the\s+)?final\s+season\b.*$/i, '')
    .replace(/\s+\d+(st|nd|rd|th)\s+season\b.*$/i, '')
    .replace(/\s+season\s*\d+\b.*$/i, '')
    .replace(/\s+part\s*\d+\b.*$/i, '')
    .replace(/\s+(2nd|3rd|4th|second|third|fourth)\s+season\b.*$/i, '')
    .trim();
  return base.length >= 2 ? base : title;
}
