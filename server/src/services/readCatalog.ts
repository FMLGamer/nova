/**
 * The Read tab's own catalogue, so there is always something to browse: manga, manhwa, manhua and light
 * novels from AniList, books from Open Library. Reading itself comes from the library, reading folders
 * and plugins (the title page looks for the title there).
 */
import { cached } from '../lib/cache.js';
import { HttpError } from '../lib/http.js';
import { fetchJson, stripHtml } from '../lib/upstream.js';

const ANILIST = 'https://graphql.anilist.co';
const OPENLIB = 'https://openlibrary.org';
const COVERS = 'https://covers.openlibrary.org/b/id';
const GUTENDEX = 'https://gutendex.com';
const HOUR = 3600_000;

export type ReadFormat = 'manga' | 'manhwa' | 'manhua' | 'novel' | 'oneshot' | 'book';

export interface ReadItem {
  /** "manga:<AniList id>" or "book:<Open Library work id>". */
  id: string;
  format: ReadFormat;
  title: string;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
  overview: string;
  rating: number | null;
  genres: string[];
  author: string | null;
}

export interface ReadDetail extends ReadItem {
  status: string | null;
  chapters: number | null;
  volumes: number | null;
  altTitles: string[];
  links: { label: string; url: string }[];
  related: (Pick<ReadItem, 'id' | 'title' | 'poster' | 'format'> & { relation: string })[];
  anilistId: number | null;
  malId: number | null;
}

export const MANGA_GENRES = [
  'Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy', 'Horror', 'Mahou Shoujo', 'Mecha', 'Music',
  'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller',
];
export const BOOK_GENRES = [
  'Fantasy', 'Science fiction', 'Mystery', 'Thriller', 'Romance', 'Horror', 'Historical fiction', 'Young adult',
  'Classics', 'Poetry', 'Biography', 'History', 'Science', 'Philosophy', 'Children',
];

// ---------------------------------------------------------------- AniList (manga & novels)

interface AniManga {
  id: number;
  idMal?: number | null;
  title: { romaji?: string | null; english?: string | null; native?: string | null };
  synonyms?: string[] | null;
  description?: string | null;
  coverImage?: { large?: string | null; extraLarge?: string | null } | null;
  bannerImage?: string | null;
  averageScore?: number | null;
  genres?: string[] | null;
  startDate?: { year?: number | null } | null;
  format?: string | null;
  countryOfOrigin?: string | null;
  status?: string | null;
  chapters?: number | null;
  volumes?: number | null;
  siteUrl?: string | null;
  staff?: { edges?: { role?: string | null; node?: { name?: { full?: string | null } } | null }[] } | null;
}

const FIELDS = `id idMal title { romaji english native } description(asHtml: false) coverImage { large extraLarge } bannerImage
  averageScore genres startDate { year } format countryOfOrigin status chapters volumes siteUrl
  staff(sort: RELEVANCE, perPage: 3) { edges { role node { name { full } } } }`;

async function anilist<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const r = await fetchJson<{ data: T }>(ANILIST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
    timeoutMs: 12_000,
  });
  return r.data;
}

const formatOf = (m: AniManga): ReadFormat =>
  m.format === 'NOVEL' ? 'novel' : m.format === 'ONE_SHOT' ? 'oneshot' : m.countryOfOrigin === 'KR' ? 'manhwa' : m.countryOfOrigin === 'CN' || m.countryOfOrigin === 'TW' ? 'manhua' : 'manga';

function mapManga(m: AniManga): ReadItem {
  const author = m.staff?.edges?.find((e) => /story|original/i.test(e.role ?? ''))?.node?.name?.full ?? m.staff?.edges?.[0]?.node?.name?.full ?? null;
  return {
    id: `manga:${m.id}`,
    format: formatOf(m),
    title: m.title.english || m.title.romaji || m.title.native || 'Untitled',
    year: m.startDate?.year ?? null,
    poster: m.coverImage?.extraLarge || m.coverImage?.large || null,
    backdrop: m.bannerImage ?? null,
    overview: stripHtml(m.description ?? ''),
    rating: m.averageScore != null ? m.averageScore / 10 : null,
    genres: m.genres ?? [],
    author,
  };
}

const ANI_SORT: Record<string, string> = { trending: 'TRENDING_DESC', popular: 'POPULARITY_DESC', top: 'SCORE_DESC', new: 'START_DATE_DESC' };

function aniFilter(format: ReadFormat): { format?: string; country?: string } {
  if (format === 'novel') return { format: 'NOVEL' };
  if (format === 'oneshot') return { format: 'ONE_SHOT' };
  return { format: 'MANGA', country: format === 'manhwa' ? 'KR' : format === 'manhua' ? 'CN' : 'JP' };
}

async function mangaBrowse(format: ReadFormat, sort: string, genre: string | undefined, page: number): Promise<ReadItem[]> {
  const f = aniFilter(format);
  return cached(`read:ani:${format}:${sort}:${genre ?? ''}:${page}`, 6 * HOUR, async () => {
    const data = await anilist<{ Page: { media: AniManga[] } }>(
      `query ($page: Int, $sort: [MediaSort], $genre: String, $format: MediaFormat, $country: CountryCode) {
        Page(page: $page, perPage: 30) {
          media(type: MANGA, sort: $sort, genre: $genre, format: $format, countryOfOrigin: $country, isAdult: false, status_not: NOT_YET_RELEASED) { ${FIELDS} }
        }
      }`,
      { page, sort: [ANI_SORT[sort] ?? 'TRENDING_DESC'], genre: genre || undefined, format: f.format, country: f.country },
    );
    return data.Page.media.filter((m) => m.coverImage?.large).map(mapManga);
  });
}

async function mangaDetail(id: string): Promise<ReadDetail> {
  return cached(`read:ani:detail:${id}`, 12 * HOUR, async () => {
    type Detail = AniManga & {
      relations?: { edges?: { relationType?: string | null; node?: AniManga & { type?: string | null } }[] } | null;
      recommendations?: { nodes?: { mediaRecommendation?: AniManga | null }[] } | null;
    };
    const { Media: m } = await anilist<{ Media: Detail }>(
      `query ($id: Int) { Media(id: $id, type: MANGA) { ${FIELDS} synonyms
        relations { edges { relationType node { id type format countryOfOrigin title { romaji english native } coverImage { large } } } }
        recommendations(sort: RATING_DESC, perPage: 12) { nodes { mediaRecommendation { id format countryOfOrigin title { romaji english native } coverImage { large } } } } } }`,
      { id: Number(id) },
    );
    const base = mapManga(m);
    const rel = (r: AniManga, relation: string) => ({ id: `manga:${r.id}`, title: r.title.english || r.title.romaji || 'Untitled', poster: r.coverImage?.large ?? null, format: formatOf(r), relation });
    return {
      ...base,
      status: m.status ?? null,
      chapters: m.chapters ?? null,
      volumes: m.volumes ?? null,
      altTitles: [...new Set([m.title.romaji, m.title.english, m.title.native, ...(m.synonyms ?? [])].filter((t): t is string => Boolean(t) && t !== base.title))].slice(0, 6),
      links: [
        { label: 'AniList', url: m.siteUrl ?? `https://anilist.co/manga/${m.id}` },
        ...(m.idMal ? [{ label: 'MyAnimeList', url: `https://myanimelist.net/manga/${m.idMal}` }] : []),
      ],
      related: [
        ...(m.relations?.edges ?? [])
          .filter((e) => e.node && e.node.type === 'MANGA' && e.relationType && ['PREQUEL', 'SEQUEL', 'SIDE_STORY', 'SPIN_OFF', 'ALTERNATIVE', 'PARENT'].includes(e.relationType))
          .map((e) => rel(e.node!, e.relationType!)),
        ...(m.recommendations?.nodes ?? []).filter((n) => n.mediaRecommendation).map((n) => rel(n.mediaRecommendation!, 'RECOMMENDATION')),
      ].filter((r) => r.poster),
      anilistId: m.id,
      malId: m.idMal ?? null,
    };
  });
}

// ---------------------------------------------------------------- Open Library (books)

interface OlDoc {
  key: string;
  title: string;
  author_name?: string[];
  first_publish_year?: number;
  cover_i?: number;
  subject?: string[];
  ratings_average?: number;
}

function mapBook(d: OlDoc): ReadItem {
  return {
    id: `book:${d.key.replace('/works/', '')}`,
    format: 'book',
    title: d.title,
    year: d.first_publish_year ?? null,
    poster: d.cover_i ? `${COVERS}/${d.cover_i}-L.jpg` : null,
    backdrop: null,
    overview: '',
    rating: d.ratings_average ? Math.round(d.ratings_average * 20) / 10 : null,
    genres: (d.subject ?? []).filter((s) => BOOK_GENRES.some((g) => g.toLowerCase() === s.toLowerCase())).slice(0, 4),
    author: d.author_name?.[0] ?? null,
  };
}

const OL_SORT: Record<string, string> = { trending: 'trending', popular: 'readinglog', top: 'rating', new: 'new' };

async function bookBrowse(sort: string, genre: string | undefined, page: number): Promise<ReadItem[]> {
  return cached(`read:ol:${sort}:${genre ?? ''}:${page}`, 6 * HOUR, async () => {
    const q = new URLSearchParams({
      q: `subject:"${(genre || 'fiction').toLowerCase()}"`,
      sort: OL_SORT[sort] ?? 'trending',
      limit: '30',
      offset: String((page - 1) * 30),
      fields: 'key,title,author_name,first_publish_year,cover_i,subject,ratings_average',
    });
    const r = await fetchJson<{ docs?: OlDoc[] }>(`${OPENLIB}/search.json?${q}`, { timeoutMs: 15_000 });
    return (r.docs ?? []).filter((d) => d.cover_i).map(mapBook);
  });
}

async function bookDetail(id: string): Promise<ReadDetail> {
  return cached(`read:ol:detail:${id}`, 12 * HOUR, async () => {
    const work = await fetchJson<{
      title: string;
      description?: string | { value: string };
      subjects?: string[];
      covers?: number[];
      first_publish_date?: string;
      authors?: { author?: { key?: string } }[];
    }>(`${OPENLIB}/works/${id}.json`, { timeoutMs: 15_000 });
    const authors = await Promise.all(
      (work.authors ?? []).slice(0, 2).map((a) =>
        a.author?.key ? fetchJson<{ name?: string }>(`${OPENLIB}${a.author.key}.json`, { timeoutMs: 8000 }).then((x) => x.name ?? null).catch(() => null) : null,
      ),
    );
    const author = authors.filter(Boolean).join(', ') || null;
    const year = Number(/\d{4}/.exec(work.first_publish_date ?? '')?.[0]) || null;
    const description = typeof work.description === 'string' ? work.description : (work.description?.value ?? '');
    return {
      id: `book:${id}`,
      format: 'book',
      title: work.title,
      year,
      poster: work.covers?.[0] ? `${COVERS}/${work.covers[0]}-L.jpg` : null,
      backdrop: null,
      overview: description.replace(/\r/g, '').split(/\n-{3,}|\n\[source\]|\(\[source\]/i)[0]!.trim(),
      rating: null,
      genres: (work.subjects ?? []).slice(0, 6),
      author,
      status: null,
      chapters: null,
      volumes: null,
      altTitles: [],
      links: [{ label: 'Open Library', url: `${OPENLIB}/works/${id}` }],
      related: [],
      anilistId: null,
      malId: null,
    };
  });
}

/** A public-domain edition on Project Gutenberg (Gutendex is slow, so this is asked for separately). */
export function freeEdition(title: string, author: string | null): Promise<string | null> {
  const q = `${title} ${author ?? ''}`.trim();
  return cached(`read:gutenberg:${q.toLowerCase()}`, 24 * HOUR, async () => {
    const g = await fetchJson<{ results?: { title?: string; formats?: Record<string, string> }[] }>(`${GUTENDEX}/books?search=${encodeURIComponent(q)}`, { timeoutMs: 20_000 });
    const want = title.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const hit = g.results?.find((r) => (r.title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '').startsWith(want.slice(0, 12)));
    return hit?.formats?.['application/epub+zip'] ?? null;
  }).catch(() => null);
}

// ---------------------------------------------------------------- entry points

export function readBrowse(opts: { format?: string; sort?: string; genre?: string; page?: number }): Promise<ReadItem[]> {
  const format = (['manga', 'manhwa', 'manhua', 'novel', 'oneshot', 'book'] as const).find((f) => f === opts.format) ?? 'manga';
  const page = Math.max(1, Math.min(50, opts.page ?? 1));
  return format === 'book' ? bookBrowse(opts.sort ?? 'trending', opts.genre, page) : mangaBrowse(format, opts.sort ?? 'trending', opts.genre, page);
}

export function readGenres(format: string | undefined): string[] {
  return format === 'book' ? BOOK_GENRES : MANGA_GENRES;
}

export function readDetail(kind: string, id: string): Promise<ReadDetail> {
  if (kind === 'manga' && /^\d+$/.test(id)) return mangaDetail(id);
  if (kind === 'book' && /^OL\d+W$/i.test(id)) return bookDetail(id);
  throw new HttpError(404, 'Unknown title');
}
