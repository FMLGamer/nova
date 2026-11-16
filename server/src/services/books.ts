import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/upstream.js';

/**
 * Book and audiobook metadata.
 *
 *  - Open Library  : catalogue + covers for everything (free, no key).
 *  - Project Gutenberg (via Gutendex): public-domain titles we can legally read
 *    or download directly, no torrent needed.
 *  - LibriVox       : public-domain audiobooks, streamed straight from source.
 *
 * Anything not covered by the two public-domain libraries is acquired through
 * source plugins like the rest of the app.
 */
const OPENLIB = 'https://openlibrary.org';
const COVERS = 'https://covers.openlibrary.org/b/id';
const GUTENDEX = 'https://gutendex.com';
const LIBRIVOX = 'https://librivox.org/api/feed';
const DAY = 24 * 60 * 60 * 1000;

export interface Book {
  id: string; // "ol:<key>" | "gutenberg:<id>" | "librivox:<id>"
  title: string;
  author: string;
  year: number | null;
  cover: string | null;
  kind: 'ebook' | 'audiobook';
  /** Readable/streamable straight from a public-domain library. */
  freeUrl: string | null;
  format: string | null;
}

interface OlDoc {
  key: string;
  title: string;
  author_name?: string[];
  first_publish_year?: number;
  cover_i?: number;
  ia?: string[];
}

function mapOl(d: OlDoc): Book {
  return {
    id: `ol:${d.key.replace('/works/', '')}`,
    title: d.title,
    author: d.author_name?.[0] ?? 'Unknown author',
    year: d.first_publish_year ?? null,
    cover: d.cover_i ? `${COVERS}/${d.cover_i}-L.jpg` : null,
    kind: 'ebook',
    freeUrl: null,
    format: null,
  };
}

interface GutenDoc {
  id: number;
  title: string;
  authors?: { name: string }[];
  formats?: Record<string, string>;
}

function mapGutenberg(d: GutenDoc): Book {
  const f = d.formats ?? {};
  const epub = f['application/epub+zip'] ?? null;
  const cover = f['image/jpeg'] ?? null;
  return {
    id: `gutenberg:${d.id}`,
    title: d.title,
    // Gutenberg stores authors "Surname, First".
    author: (d.authors?.[0]?.name ?? 'Unknown author').split(',').reverse().join(' ').trim(),
    year: null,
    cover,
    kind: 'ebook',
    freeUrl: epub,
    format: epub ? 'epub' : null,
  };
}

interface LibriBook {
  id: string;
  title: string;
  authors?: { first_name?: string; last_name?: string }[];
  url_zip_file?: string;
  url_rss?: string;
}

function mapLibrivox(b: LibriBook): Book {
  const a = b.authors?.[0];
  return {
    id: `librivox:${b.id}`,
    title: b.title,
    author: [a?.first_name, a?.last_name].filter(Boolean).join(' ') || 'Unknown author',
    year: null,
    cover: null,
    kind: 'audiobook',
    freeUrl: b.url_rss ?? null,
    format: 'mp3',
  };
}

/**
 * Remembers which provider/query pairs recently failed or timed out, so a slow
 * source is skipped for a while instead of costing every search its full
 * timeout. Successes are cached separately and for much longer.
 */
const recentMiss = new Map<string, number>();
const MISS_TTL = 10 * 60 * 1000;

function recentlyMissed(key: string): boolean {
  const until = recentMiss.get(key);
  if (until && until > Date.now()) return true;
  if (until) recentMiss.delete(key);
  return false;
}

function withFallback<T>(key: string, work: Promise<T>, fallback: T): Promise<T> {
  return work.catch(() => {
    recentMiss.set(key, Date.now() + MISS_TTL);
    return fallback;
  });
}

/** Search across Open Library, Gutenberg and LibriVox at once. */
export async function searchBooks(query: string): Promise<Book[]> {
  const q = query.trim();
  if (!q) return [];
  const key = q.toLowerCase();
  const SIX_HOURS = 6 * 60 * 60 * 1000;

  const olKey = `books:ol:${key}`;
  const gutKey = `books:gut:${key}`;
  const lvKey = `books:lv:${key}`;

  const openLibrary = recentlyMissed(olKey)
    ? Promise.resolve({ docs: [] as OlDoc[] })
    : withFallback(
        olKey,
        cached(olKey, SIX_HOURS, () =>
          fetchJson<{ docs?: OlDoc[] }>(
            `${OPENLIB}/search.json?q=${encodeURIComponent(q)}&limit=30&fields=key,title,author_name,first_publish_year,cover_i,ia`,
            { timeoutMs: 8_000 },
          ),
        ),
        { docs: [] as OlDoc[] },
      );

  // Gutendex full-text search is often slow; keep the budget tight so the search
  // box stays responsive and let a later search pick up what we missed.
  const gutenberg = recentlyMissed(gutKey)
    ? Promise.resolve({ results: [] as GutenDoc[] })
    : withFallback(
        gutKey,
        cached(gutKey, SIX_HOURS, () =>
          fetchJson<{ results?: GutenDoc[] }>(
            `${GUTENDEX}/books?search=${encodeURIComponent(q)}`,
            { timeoutMs: 7_000 },
          ),
        ),
        { results: [] as GutenDoc[] },
      );

  const librivox = recentlyMissed(lvKey)
    ? Promise.resolve({ books: [] as LibriBook[] })
    : withFallback(
        lvKey,
        cached(lvKey, SIX_HOURS, () =>
          fetchJson<{ books?: LibriBook[] }>(
            `${LIBRIVOX}/audiobooks/?title=^${encodeURIComponent(q)}&format=json&limit=15`,
            { timeoutMs: 7_000 },
          ),
        ),
        { books: [] as LibriBook[] },
      );

  const [ol, gut, lib] = await Promise.all([openLibrary, gutenberg, librivox]);

  const free = (gut.results ?? []).map(mapGutenberg).filter((b) => b.freeUrl);
  const audio = (lib.books ?? []).map(mapLibrivox);
  const catalogue = (ol.docs ?? []).map(mapOl);

  // Titles we can open immediately come first.
  const seen = new Set<string>();
  const out: Book[] = [];
  for (const b of [...free, ...audio, ...catalogue]) {
    const dedupe = `${b.title.toLowerCase()}|${b.author.toLowerCase()}|${b.kind}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(b);
  }
  return out.slice(0, 60);
}

export interface BookDetail extends Book {
  description: string | null;
  subjects: string[];
  /** Audiobook chapters, when the source exposes them. */
  chapters: { title: string; url: string; seconds: number | null }[];
}

export async function bookDetail(id: string): Promise<BookDetail> {
  const [source, rest] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  return cached(`books:detail:${id}`, DAY, async () => {
    if (source === 'gutenberg') {
      const d = await fetchJson<GutenDoc & { subjects?: string[] }>(`${GUTENDEX}/books/${rest}`, {
        timeoutMs: 15_000,
      });
      return { ...mapGutenberg(d), description: null, subjects: d.subjects ?? [], chapters: [] };
    }
    if (source === 'librivox') {
      const data = await fetchJson<{ books?: (LibriBook & { description?: string; sections?: { title: string; listen_url: string; playtime: string }[] })[] }>(
        `${LIBRIVOX}/audiobooks/?id=${rest}&format=json&extended=1`,
        { timeoutMs: 20_000 },
      );
      const b = data.books?.[0];
      if (!b) throw new Error('Audiobook not found');
      return {
        ...mapLibrivox(b),
        description: b.description ? b.description.replace(/<[^>]+>/g, '').trim() : null,
        subjects: [],
        chapters: (b.sections ?? []).map((s) => ({
          title: s.title,
          url: s.listen_url,
          seconds: Number(s.playtime) || null,
        })),
      };
    }
    const work = await fetchJson<{
      title: string;
      description?: string | { value: string };
      subjects?: string[];
      covers?: number[];
    }>(`${OPENLIB}/works/${rest}.json`, { timeoutMs: 15_000 });
    const desc =
      typeof work.description === 'string' ? work.description : (work.description?.value ?? null);
    return {
      id,
      title: work.title,
      author: 'Unknown author',
      year: null,
      cover: work.covers?.[0] ? `${COVERS}/${work.covers[0]}-L.jpg` : null,
      kind: 'ebook',
      freeUrl: null,
      format: null,
      description: desc,
      subjects: (work.subjects ?? []).slice(0, 12),
      chapters: [],
    };
  });
}

/** Front page rows built from Gutenberg's most-downloaded public-domain titles. */
export async function booksHome(): Promise<{ id: string; title: string; items: Book[] }[]> {
  const defs: { id: string; title: string; topic?: string }[] = [
    { id: 'popular', title: 'Popular on Gutenberg' },
    { id: 'fiction', title: 'Fiction', topic: 'fiction' },
    { id: 'adventure', title: 'Adventure', topic: 'adventure' },
  ];
  const out: { id: string; title: string; items: Book[] }[] = [];
  // Sequential: Gutendex is slow and gets slower under parallel load.
  for (const r of defs) {
    try {
      const items = await cached(`books:row:${r.id}`, DAY, async () => {
        const url = r.topic
          ? `${GUTENDEX}/books?topic=${encodeURIComponent(r.topic)}&sort=popular`
          : `${GUTENDEX}/books?sort=popular`;
        const data = await fetchJson<{ results?: GutenDoc[] }>(url, { timeoutMs: 25_000 });
        return (data.results ?? []).map(mapGutenberg).filter((b) => b.cover);
      });
      if (items.length) out.push({ id: r.id, title: r.title, items });
    } catch {
      /* one slow row should not empty the page */
    }
  }
  return out;
}
