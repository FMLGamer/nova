import { anilistQuery } from '../lib/anilist.js';
import { cached } from '../lib/cache.js';
import { HttpError } from '../lib/http.js';
import { stripHtml } from '../lib/upstream.js';
import type {
  AiringEntry,
  CatalogDetail,
  CatalogItem,
  Character,
  Episode,
  Relation,
} from '../media/types.js';

const DAY = 24 * 60 * 60 * 1000;

interface AniTitle {
  romaji?: string | null;
  english?: string | null;
  native?: string | null;
}

interface AniMedia {
  id: number;
  title: AniTitle;
  description?: string | null;
  coverImage?: { large?: string | null; extraLarge?: string | null } | null;
  bannerImage?: string | null;
  averageScore?: number | null;
  genres?: string[] | null;
  seasonYear?: number | null;
  startDate?: { year?: number | null } | null;
  episodes?: number | null;
  duration?: number | null;
  format?: string | null;
  status?: string | null;
  studios?: { nodes?: { name: string }[] } | null;
  nextAiringEpisode?: { episode: number; airingAt: number } | null;
}

const MEDIA_FIELDS = `
  id
  title { romaji english native }
  description(asHtml: false)
  coverImage { large extraLarge }
  bannerImage
  averageScore
  genres
  seasonYear
  startDate { year }
  episodes
  duration
  format
  status
`;

async function anilist<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  return anilistQuery<T>(query, variables);
}

function mapAni(m: AniMedia): CatalogItem {
  return {
    id: `anime:${m.id}`,
    mediaType: 'anime',
    title: m.title.english || m.title.romaji || m.title.native || 'Untitled',
    year: m.seasonYear ?? m.startDate?.year ?? null,
    poster: m.coverImage?.extraLarge || m.coverImage?.large || null,
    backdrop: m.bannerImage ?? null,
    overview: stripHtml(m.description ?? ''),
    rating: m.averageScore != null ? m.averageScore / 10 : null,
    runtime: m.duration ?? null,
    genres: m.genres ?? [],
  };
}

function currentSeason(): { season: string; seasonYear: number } {
  const now = new Date();
  const m = now.getUTCMonth();
  const season = m < 3 ? 'WINTER' : m < 6 ? 'SPRING' : m < 9 ? 'SUMMER' : 'FALL';
  return { season, seasonYear: now.getUTCFullYear() };
}

async function page(sort: string, extra = ''): Promise<CatalogItem[]> {
  const query = `
    query ($sort: [MediaSort]) {
      Page(page: 1, perPage: 30) {
        media(type: ANIME, sort: $sort, isAdult: false${extra}) {
          ${MEDIA_FIELDS}
        }
      }
    }`;
  const data = await anilist<{ Page: { media: AniMedia[] } }>(query, { sort: [sort] });
  return data.Page.media.filter((m) => m.coverImage?.large).map(mapAni);
}

export const anilistRows = {
  trending: () => cached('anilist:trending', 6 * 60 * 60 * 1000, () => page('TRENDING_DESC')),
  popular: () => cached('anilist:popular', 6 * 60 * 60 * 1000, () => page('POPULARITY_DESC')),
  topRated: () => cached('anilist:top', DAY, () => page('SCORE_DESC')),
  seasonal: () =>
    cached('anilist:seasonal', 6 * 60 * 60 * 1000, () => {
      const { season, seasonYear } = currentSeason();
      return page('POPULARITY_DESC', `, season: ${season}, seasonYear: ${seasonYear}`);
    }),
};

export async function anilistSearch(query: string): Promise<CatalogItem[]> {
  const gql = `
    query ($q: String) {
      Page(page: 1, perPage: 30) {
        media(type: ANIME, search: $q, isAdult: false, sort: SEARCH_MATCH) {
          ${MEDIA_FIELDS}
          popularity
        }
      }
    }`;
  const data = await anilist<{ Page: { media: (AniMedia & { popularity?: number | null })[] } }>(gql, { q: query });
  return data.Page.media.filter((m) => m.coverImage?.large).map((m) => ({ ...mapAni(m), popularity: m.popularity ?? null }));
}

export async function anilistDetail(id: string): Promise<CatalogDetail> {
  const m = await anilistMedia(id);
  const total = m.episodes ?? (m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : null);

  const trailer = m.trailer?.site === 'youtube' && m.trailer.id ? { site: 'youtube', key: m.trailer.id } : null;

  const characters: Character[] = (m.characters?.edges ?? [])
    .filter((e) => e.node?.name?.full)
    .map((e) => {
      const va = e.voiceActors?.[0];
      return {
        name: e.node!.name!.full!,
        role: (e.role ?? '').toLowerCase(),
        image: e.node!.image?.medium ?? null,
        voiceActor: va?.name?.full ?? null,
        voiceActorImage: va?.image?.medium ?? null,
      };
    });

  const RELEVANT = new Set(['PREQUEL', 'SEQUEL', 'SIDE_STORY', 'PARENT', 'ALTERNATIVE', 'SPIN_OFF']);
  const relations: Relation[] = (m.relations?.edges ?? [])
    .filter((e) => e.node?.type === 'ANIME' && e.relationType && RELEVANT.has(e.relationType) && e.node?.id)
    .map((e) => ({
      id: `anime:${e.node!.id}`,
      relationType: e.relationType!,
      title: e.node!.title?.english || e.node!.title?.romaji || 'Related',
      format: e.node!.format ?? null,
      poster: e.node!.coverImage?.large ?? e.node!.coverImage?.medium ?? null,
    }));

  return {
    ...mapAni(m),
    tagline: null,
    runtime: m.duration ?? null,
    status: m.status ?? null,
    seasons: [],
    cast: [],
    studios: (m.studios?.nodes ?? []).map((s) => s.name),
    totalEpisodes: total && total > 0 ? total : null,
    trailer,
    characters,
    relations,
    malId: m.idMal ?? null,
    imdbId: null,
    nextAiring: m.nextAiringEpisode ?? null,
  };
}

export async function anilistEpisodes(id: string): Promise<Episode[]> {
  const m = await anilistMedia(id);
  const airs = new Map((m.airingSchedule?.nodes ?? []).map((s) => [s.episode, new Date(s.airingAt * 1000).toISOString()]));
  const streaming = m.streamingEpisodes ?? [];
  // AniList's streamingEpisodes are unordered; map each to its real episode
  // number parsed from the title (e.g. "Episode 12 - ...") and fall back to order.
  const byNumber = new Map<number, { title: string | null; thumbnail: string | null }>();
  streaming.forEach((se) => {
    const n = Number(se.title?.match(/episode\s*(\d+)/i)?.[1]);
    if (Number.isFinite(n) && !byNumber.has(n)) byNumber.set(n, se);
  });
  const aired = m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : 0;
  const total = m.episodes ?? (aired > 0 ? aired : streaming.length);
  const count = total > 0 ? total : streaming.length;
  const cover = m.coverImage?.large ?? null;
  const episodes: Episode[] = [];
  for (let i = 0; i < count; i++) {
    const n = i + 1;
    const se = byNumber.get(n) ?? streaming[i];
    const cleaned = se?.title?.replace(/^\s*Episode\s*\d+\s*[-:]\s*/i, '').trim();
    episodes.push({
      id: `anime:${id}:e${n}`,
      season: 1,
      episode: n,
      title: cleaned && cleaned.length ? cleaned : `Episode ${n}`,
      overview: '',
      still: se?.thumbnail ?? cover,
      airDate: airs.get(n) ?? null,
      runtime: null,
    });
  }
  return episodes;
}

/** Every name an anime goes by — indexers often only know the romaji one. */
export async function anilistTitles(id: string): Promise<{
  romaji: string | null;
  english: string | null;
  native: string | null;
  synonyms: string[];
  format: string | null;
  seasonYear: number | null;
}> {
  const m = await anilistMedia(id);
  return {
    romaji: m.title.romaji ?? null,
    english: m.title.english ?? null,
    native: m.title.native ?? null,
    synonyms: (m.synonyms ?? []).filter((s) => /^[\x20-\x7e]+$/.test(s)).slice(0, 6),
    format: m.format ?? null,
    seasonYear: m.seasonYear ?? null,
  };
}

/*
 * Everything Nova shows about one anime — detail, episode names and thumbnails, upcoming air times and every
 * title it goes by — comes from a single cached copy of its AniList entry. Titles asked for at about the same
 * time (a page of recommendations, stats, Up next) are fetched together: AniList answers up to 50 of them in one
 * request, and every request counts against its rate limit no matter how much it returns.
 */
interface FullMedia extends AniMedia {
  idMal?: number | null;
  synonyms?: string[] | null;
  trailer?: { id?: string | null; site?: string | null } | null;
  streamingEpisodes?: { title: string | null; thumbnail: string | null }[] | null;
  airingSchedule?: { nodes?: { episode: number; airingAt: number }[] | null } | null;
  characters?: {
    edges?: {
      role?: string | null;
      node?: { name?: { full?: string | null }; image?: { medium?: string | null } } | null;
      voiceActors?: { name?: { full?: string | null }; image?: { medium?: string | null } }[] | null;
    }[];
  } | null;
  relations?: {
    edges?: {
      relationType?: string | null;
      node?: {
        id?: number;
        type?: string | null;
        format?: string | null;
        title?: { romaji?: string | null; english?: string | null };
        coverImage?: { medium?: string | null; large?: string | null } | null;
      } | null;
    }[];
  } | null;
}

const FULL_FIELDS = `
  ${MEDIA_FIELDS}
  idMal
  synonyms
  studios(isMain: true) { nodes { name } }
  nextAiringEpisode { episode airingAt }
  trailer { id site }
  streamingEpisodes { title thumbnail }
  airingSchedule(notYetAired: true, perPage: 12) { nodes { episode airingAt } }
  characters(sort: [ROLE, RELEVANCE], perPage: 12) {
    edges {
      role
      node { name { full } image { medium } }
      voiceActors(language: JAPANESE, sort: RELEVANCE) { name { full } image { medium } }
    }
  }
  relations {
    edges {
      relationType
      node { id type format title { romaji english } coverImage { medium large } }
    }
  }
`;
const BATCH = 50;
const GATHER_MS = 30;
const queued = new Map<number, { resolve: (m: FullMedia) => void; reject: (e: unknown) => void }[]>();
let gathering: NodeJS.Timeout | null = null;

async function flushMedia(): Promise<void> {
  gathering = null;
  const batch = [...queued.entries()].slice(0, BATCH);
  for (const [id] of batch) queued.delete(id);
  if (queued.size) gathering = setTimeout(() => void flushMedia(), 0);
  try {
    const data = await anilist<{ Page: { media: FullMedia[] } }>(
      `query ($ids: [Int]) { Page(perPage: ${BATCH}) { media(id_in: $ids, type: ANIME) { ${FULL_FIELDS} } } }`,
      { ids: batch.map(([id]) => id) },
    );
    const byId = new Map(data.Page.media.map((m) => [m.id, m]));
    for (const [id, waiters] of batch) {
      const m = byId.get(id);
      for (const w of waiters) {
        if (m) w.resolve(m);
        else w.reject(new HttpError(404, 'Not found on AniList'));
      }
    }
  } catch (err) {
    for (const [, waiters] of batch) for (const w of waiters) w.reject(err);
  }
}

function fetchMedia(id: number): Promise<FullMedia> {
  if (!Number.isInteger(id) || id <= 0) return Promise.reject(new HttpError(404, 'Not found on AniList'));
  return new Promise((resolve, reject) => {
    const waiters = queued.get(id) ?? [];
    waiters.push({ resolve, reject });
    queued.set(id, waiters);
    gathering ??= setTimeout(() => void flushMedia(), GATHER_MS);
  });
}

function anilistMedia(id: string): Promise<FullMedia> {
  return cached(`anilist:media:${id}`, 12 * 60 * 60 * 1000, () => fetchMedia(Number(id)));
}

/** Fetches (in as few requests as possible) every anime in `mediaIds` that isn't cached yet; others are ignored. */
export async function warmAnime(mediaIds: string[]): Promise<void> {
  const ids = [...new Set(mediaIds.filter((m) => m.startsWith('anime:')).map((m) => m.slice(6)))];
  await Promise.all(ids.map((id) => anilistMedia(id).catch(() => null)));
}

export async function anilistBrowse(opts: { genre?: string; sort?: string; page?: number; format?: string }): Promise<CatalogItem[]> {
  const sort = { trending: 'TRENDING_DESC', popular: 'POPULARITY_DESC', top: 'SCORE_DESC', new: 'START_DATE_DESC' }[
    opts.sort ?? 'popular'
  ] ?? 'POPULARITY_DESC';
  const key = `anilist:browse:${opts.genre ?? ''}:${sort}:${opts.page ?? 1}:${opts.format ?? ''}`;
  return cached(key, 6 * 60 * 60 * 1000, async () => {
    const gql = `
      query ($page: Int, $sort: [MediaSort], $genre: String, $format: MediaFormat) {
        Page(page: $page, perPage: 30) {
          media(type: ANIME, sort: $sort, genre: $genre, format: $format, isAdult: false, status_not: NOT_YET_RELEASED) {
            ${MEDIA_FIELDS}
          }
        }
      }`;
    const data = await anilist<{ Page: { media: AniMedia[] } }>(gql, {
      page: opts.page ?? 1,
      sort: [sort],
      genre: opts.genre || undefined,
      format: opts.format || undefined,
    });
    return data.Page.media.filter((m) => m.coverImage?.large).map(mapAni);
  });
}

export const ANIME_GENRES = [
  'Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy', 'Horror', 'Mahou Shoujo', 'Mecha', 'Music',
  'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller',
];

/** Next airing episode per AniList id, for the calendar of followed anime. */
export async function anilistAiring(ids: string[], fromSec: number, toSec: number): Promise<AiringEntry[]> {
  if (!ids.length) return [];
  const key = `anilist:airing:${ids.slice().sort().join(',')}:${Math.floor(fromSec / 3600)}:${Math.floor(toSec / 3600)}`;
  return cached(key, 30 * 60 * 1000, async () => {
    const gql = `
      query ($ids: [Int], $from: Int, $to: Int, $page: Int) {
        Page(page: $page, perPage: 50) {
          pageInfo { hasNextPage }
          airingSchedules(mediaId_in: $ids, airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
            episode airingAt media { ${MEDIA_FIELDS} }
          }
        }
      }`;
    const out: AiringEntry[] = [];
    for (let p = 1; p <= 6; p++) {
      const data = await anilist<{
        Page: { pageInfo: { hasNextPage: boolean }; airingSchedules: { episode: number; airingAt: number; media: AniMedia }[] };
      }>(gql, { ids: ids.map(Number), from: fromSec, to: toSec, page: p });
      for (const s of data.Page.airingSchedules) {
        out.push({
          item: mapAni(s.media),
          episode: s.episode,
          airingAt: s.airingAt,
          weekday: (new Date(s.airingAt * 1000).getUTCDay() + 6) % 7,
        });
      }
      if (!data.Page.pageInfo.hasNextPage) break;
    }
    return out;
  });
}

const RECENT_PAGE = 24;

/** One at a time and only what has expired, so a refresh never competes with someone browsing. */
export async function warmCatalog(): Promise<void> {
  for (const job of [anilistRows.trending, anilistRows.seasonal, () => anilistSchedule(0), () => anilistSchedule(-1)]) await job().catch(() => undefined);
}

/** Titles with an episode out in the past week, newest first; `page` (1-based) of RECENT_PAGE. Built from the schedules. */
export async function anilistRecent(page = 1): Promise<CatalogItem[]> {
  const [last, current] = await Promise.all([anilistSchedule(-1), anilistSchedule(0)]);
  const now = Math.floor(Date.now() / 1000);
  const seen = new Set<string>();
  const all: CatalogItem[] = [];
  for (const e of [...last, ...current].filter((x) => x.airingAt <= now && x.airingAt > now - 7 * 86_400).sort((a, b) => b.airingAt - a.airingAt)) {
    if (seen.has(e.item.id)) continue;
    seen.add(e.item.id);
    all.push(e.item);
  }
  const from = (Math.max(1, Math.trunc(page)) - 1) * RECENT_PAGE;
  return all.slice(from, from + RECENT_PAGE);
}

export async function anilistSchedule(weekOffset = 0): Promise<AiringEntry[]> {
  const offset = Math.max(-8, Math.min(8, Math.trunc(weekOffset)));
  // Monday 00:00 UTC of the requested week .. the following Monday.
  const now = new Date();
  const day = (now.getUTCDay() + 6) % 7; // 0=Mon
  const monday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day + offset * 7);
  const start = Math.floor(monday / 1000);
  const end = start + 7 * 24 * 60 * 60;
  // A week that is over doesn't change any more; this week's times still move now and then.
  const ttl = end * 1000 < Date.now() ? 7 * DAY : offset === 0 ? 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
  return cached(`anilist:schedule:${new Date(monday).toISOString().slice(0, 10)}`, ttl, async () => {
    const gql = `
      query ($start: Int, $end: Int, $page: Int) {
        Page(page: $page, perPage: 50) {
          pageInfo { hasNextPage }
          airingSchedules(airingAt_greater: $start, airingAt_lesser: $end, sort: TIME) {
            episode
            airingAt
            media {
              ${MEDIA_FIELDS}
              isAdult
              countryOfOrigin
            }
          }
        }
      }`;

    const entries: AiringEntry[] = [];
    for (let p = 1; p <= 8; p++) {
      const data = await anilist<{
        Page: {
          pageInfo: { hasNextPage: boolean };
          airingSchedules: { episode: number; airingAt: number; media: AniMedia & { isAdult?: boolean; countryOfOrigin?: string } }[];
        };
      }>(gql, { start, end, page: p });

      for (const s of data.Page.airingSchedules) {
        if (s.media.isAdult || !s.media.coverImage?.large) continue;
        entries.push({
          item: mapAni(s.media),
          episode: s.episode,
          airingAt: s.airingAt,
          weekday: (new Date(s.airingAt * 1000).getUTCDay() + 6) % 7,
        });
      }
      if (!data.Page.pageInfo.hasNextPage) break;
    }
    return entries;
  });
}
