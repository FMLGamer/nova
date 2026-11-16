import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/upstream.js';

/**
 * Music metadata from MusicBrainz with artwork from the Cover Art Archive.
 * Both are free, need no API key and ask only for a descriptive User-Agent.
 * Acquisition itself still goes through source plugins like everything else.
 */
const MB = 'https://musicbrainz.org/ws/2';
const CAA = 'https://coverartarchive.org';
const UA = 'Nova/2 ( https://github.com/FMLGamer/nova )';
const DAY = 24 * 60 * 60 * 1000;

const headers = { 'User-Agent': UA, Accept: 'application/json' };

/**
 * MusicBrainz allows roughly one request per second per client and answers 503
 * when that is exceeded, so every call goes through a single-file queue that
 * paces requests and backs off when it is still told to slow down. Results are
 * cached hard on top of this.
 */
let chain: Promise<unknown> = Promise.resolve();
let lastCall = 0;

const MIN_GAP = 1200;
const BACKOFF = [2_000, 5_000, 9_000];

function throttled(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  // upstream.ts maps any non-404 failure to 502, so treat that as retryable too.
  return status === 502 || status === 503 || status === 429;
}

function mbFetch<T>(url: string): Promise<T> {
  const run = async (): Promise<T> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= BACKOFF.length; attempt++) {
      const gap = attempt === 0 ? MIN_GAP : BACKOFF[attempt - 1];
      const wait = Math.max(0, gap - (Date.now() - lastCall));
      if (wait) await new Promise((r) => setTimeout(r, wait));
      lastCall = Date.now();
      try {
        return await fetchJson<T>(url, { headers, timeoutMs: 15_000 });
      } catch (err) {
        lastErr = err;
        lastCall = Date.now();
        if (!throttled(err)) throw err;
      }
    }
    throw lastErr;
  };
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next;
}

export interface Album {
  id: string; // MusicBrainz release-group id
  title: string;
  artist: string;
  artistId: string | null;
  year: number | null;
  cover: string | null;
  primaryType: string | null;
}

export interface Track {
  id: string;
  title: string;
  position: number;
  lengthMs: number | null;
}

export interface AlbumDetail extends Album {
  tracks: Track[];
  totalMs: number | null;
}

interface MbReleaseGroup {
  id: string;
  title: string;
  score?: number;
  'first-release-date'?: string;
  'primary-type'?: string | null;
  'artist-credit'?: { name: string; artist?: { id: string; name: string } }[];
}

function coverUrl(releaseGroupId: string, size: 250 | 500 = 500): string {
  return `${CAA}/release-group/${releaseGroupId}/front-${size}`;
}

function mapGroup(g: MbReleaseGroup): Album {
  const credit = g['artist-credit']?.[0];
  const date = g['first-release-date'] ?? '';
  return {
    id: g.id,
    title: g.title,
    artist: credit?.artist?.name ?? credit?.name ?? 'Unknown artist',
    artistId: credit?.artist?.id ?? null,
    year: date ? Number(date.slice(0, 4)) || null : null,
    cover: coverUrl(g.id),
    primaryType: g['primary-type'] ?? null,
  };
}

export async function searchAlbums(query: string, limit = 40): Promise<Album[]> {
  const q = query.trim();
  if (!q) return [];
  return cached(`mb:search:${q.toLowerCase()}:${limit}`, 6 * 60 * 60 * 1000, async () => {
    const url =
      `${MB}/release-group?query=${encodeURIComponent(q)}` +
      `&limit=${limit}&fmt=json`;
    const data = await mbFetch<{ 'release-groups'?: MbReleaseGroup[] }>(url);
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (data['release-groups'] ?? [])
      .filter((g) => g['primary-type'] !== 'Other')
      .map((g) => {
        const album = mapGroup(g);
        const artist = album.artist.toLowerCase();
        const title = album.title.toLowerCase();
        // Raw MusicBrainz score favours novelty releases whose long titles happen
        // to contain every query word, so weight an actual artist match heavily
        // and prefer titles close in length to what was typed.
        const artistHits = words.filter((w) => artist.includes(w)).length;
        const titleHits = words.filter((w) => title.includes(w)).length;
        const covered = (artistHits + titleHits) / (words.length || 1);
        const brevity = Math.min(1, (words.join(' ').length + 8) / (`${artist} ${title}`.length || 1));
        const rank =
          (g.score ?? 0) * (1 + Math.min(1, covered)) * (0.4 + 0.6 * brevity) +
          (artistHits > 0 ? 400 : 0) +
          (album.primaryType === 'Album' ? 60 : 0);
        return { album, rank };
      })
      .sort((a, b) => b.rank - a.rank)
      .map((r) => r.album);
  });
}

/** Albums by an artist, newest first — the artist page. */
export async function artistAlbums(artistId: string): Promise<Album[]> {
  return cached(`mb:artist:${artistId}`, DAY, async () => {
    const url =
      `${MB}/release-group?artist=${encodeURIComponent(artistId)}` +
      `&type=album|ep&limit=100&fmt=json`;
    const data = await mbFetch<{ 'release-groups'?: MbReleaseGroup[] }>(url);
    return (data['release-groups'] ?? [])
      .map(mapGroup)
      .sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
  });
}

interface MbRelease {
  id: string;
  media?: { tracks?: { id: string; title: string; position: number; length?: number | null }[] }[];
}

export async function albumDetail(releaseGroupId: string): Promise<AlbumDetail> {
  return cached(`mb:rg:${releaseGroupId}`, DAY, async () => {
    const group = await mbFetch<MbReleaseGroup & { releases?: { id: string }[] }>(
      `${MB}/release-group/${releaseGroupId}?inc=artist-credits+releases&fmt=json`,
    );
    const base = mapGroup(group);

    // The release group has no tracklist of its own; take the first release's.
    let tracks: Track[] = [];
    const releaseId = group.releases?.[0]?.id;
    if (releaseId) {
      try {
        const rel = await mbFetch<MbRelease>(
          `${MB}/release/${releaseId}?inc=recordings&fmt=json`,
        );
        tracks = (rel.media ?? []).flatMap((m) =>
          (m.tracks ?? []).map((t) => ({
            id: t.id,
            title: t.title,
            position: t.position,
            lengthMs: t.length ?? null,
          })),
        );
      } catch {
        /* tracklist is best-effort */
      }
    }
    const totalMs = tracks.reduce((n, t) => n + (t.lengthMs ?? 0), 0) || null;
    return { ...base, tracks, totalMs };
  });
}

/** A browsable front page: a few well-known genre tags, each with top albums. */
export async function musicHome(): Promise<{ id: string; title: string; items: Album[] }[]> {
  const tags = ['rock', 'electronic', 'hip hop'];
  const rows: { id: string; title: string; items: Album[] }[] = [];
  // Sequential on purpose: the queue serialises these anyway and the whole page
  // is cached for a day.
  for (const tag of tags) {
    try {
      const items = await cached(`mb:tag:${tag}`, DAY, async () => {
        const url =
          `${MB}/release-group?query=${encodeURIComponent(`tag:${tag} AND primarytype:album`)}` +
          `&limit=20&fmt=json`;
        const data = await mbFetch<{ 'release-groups'?: MbReleaseGroup[] }>(url);
        return (data['release-groups'] ?? []).map(mapGroup);
      });
      if (items.length) {
        rows.push({ id: tag, title: tag.replace(/\b\w/g, (c) => c.toUpperCase()), items });
      }
    } catch {
      /* one bad row should not empty the page */
    }
  }
  return rows;
}
