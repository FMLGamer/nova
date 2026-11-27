import { db } from '../db/index.js';
import { cached } from '../lib/cache.js';
import { parseMediaId } from '../media/types.js';
import { anilistAiring, anilistDetail, warmAnime } from '../services/anilist.js';
import { tmdbDetail, tmdbEpisodes } from '../services/tmdb.js';
import { libraryEnabled } from './library.js';

export interface Followed {
  mediaId: string;
  mediaType: 'tv' | 'anime';
  title: string;
  poster: string | null;
  why: ('list' | 'watching' | 'library' | 'rule')[];
}

/** Series a profile follows: My List, currently watching, server library, auto-download rules. */
export function followedSeries(profileId: string, accountId: string): Followed[] {
  const out = new Map<string, Followed>();
  const add = (mediaId: string, title: string | null, poster: string | null, why: Followed['why'][number]) => {
    const type = mediaId.split(':')[0];
    if (type !== 'tv' && type !== 'anime') return;
    const f = out.get(mediaId) ?? { mediaId, mediaType: type, title: title ?? mediaId, poster, why: [] };
    if (!f.why.includes(why)) f.why.push(why);
    if (!f.poster && poster) f.poster = poster;
    out.set(mediaId, f);
  };
  for (const r of db.prepare('SELECT media_id, title, poster FROM my_list WHERE profile_id = ?').all(profileId) as {
    media_id: string;
    title: string | null;
    poster: string | null;
  }[]) {
    add(r.media_id, r.title, r.poster, 'list');
  }
  for (const r of db
    .prepare(
      `SELECT media_id, MAX(title) AS title, MAX(poster) AS poster FROM watch_progress
        WHERE profile_id = ? AND updated_at > datetime('now', '-60 days') GROUP BY media_id`,
    )
    .all(profileId) as { media_id: string; title: string | null; poster: string | null }[]) {
    add(r.media_id, r.title, r.poster, 'watching');
  }
  if (libraryEnabled()) {
    for (const r of db
      .prepare(
        `SELECT media_id, title, poster FROM library_items WHERE media_id IS NOT NULL AND kind IN ('tv','anime')
           AND (private_account_id IS NULL OR private_account_id = ?)`,
      )
      .all(accountId) as { media_id: string; title: string; poster: string | null }[]) {
      add(r.media_id, r.title, r.poster, 'library');
    }
  }
  for (const r of db.prepare('SELECT media_id, title, poster FROM download_rules WHERE account_id = ? AND enabled = 1').all(accountId) as {
    media_id: string;
    title: string;
    poster: string | null;
  }[]) {
    add(r.media_id, r.title, r.poster, 'rule');
  }
  return [...out.values()];
}

export interface AiredEpisode {
  season: number;
  episode: number;
  title: string;
  airDate: string | null;
  still: string | null;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Every episode that has aired so far (TV: per TMDB season; anime: per AniList entry). */
export async function airedEpisodes(mediaId: string): Promise<AiredEpisode[]> {
  return cached(`aired:${mediaId}`, 3 * 60 * 60_000, async () => {
    const { mediaType, providerId } = parseMediaId(mediaId);
    if (mediaType === 'tv') {
      const d = await tmdbDetail('tv', providerId);
      const out: AiredEpisode[] = [];
      for (const s of d.seasons) {
        const eps = await tmdbEpisodes(providerId, s.season).catch(() => []);
        for (const e of eps) {
          if (e.airDate && e.airDate <= today()) {
            out.push({ season: e.season, episode: e.episode, title: e.title, airDate: e.airDate, still: e.still });
          }
        }
      }
      return out;
    }
    if (mediaType === 'anime') {
      const d = await anilistDetail(providerId);
      const aired = d.nextAiring ? d.nextAiring.episode - 1 : d.status === 'NOT_YET_RELEASED' ? 0 : d.totalEpisodes ?? 0;
      return Array.from({ length: aired }, (_, i) => ({ season: 1, episode: i + 1, title: `Episode ${i + 1}`, airDate: null, still: null }));
    }
    return [];
  });
}

export interface MissingSeries {
  mediaId: string;
  title: string;
  poster: string | null;
  aired: number;
  have: number;
  missing: AiredEpisode[];
}

/** Aired episodes that are not in the server library, for every followed series. */
export async function missingEpisodes(profileId: string, accountId: string): Promise<MissingSeries[]> {
  if (!libraryEnabled()) return [];
  const out: MissingSeries[] = [];
  const series = followedSeries(profileId, accountId);
  await warmAnime(series.map((f) => f.mediaId));
  for (const f of series) {
    try {
      const aired = await airedEpisodes(f.mediaId);
      if (!aired.length) continue;
      const have = new Set(
        (db
          .prepare(
            `SELECT f.season, f.episode FROM library_files f JOIN library_items i ON i.id = f.item_id
              WHERE i.media_id = ? AND f.episode IS NOT NULL`,
          )
          .all(f.mediaId) as { season: number | null; episode: number }[]).map((r) => `${r.season ?? 1}:${r.episode}`),
      );
      const queued = new Set(
        (db
          .prepare(
            "SELECT season, episode FROM downloads WHERE media_id = ? AND status IN ('pending','queued','downloading')",
          )
          .all(f.mediaId) as { season: number | null; episode: number | null }[]).map((r) => `${r.season ?? 1}:${r.episode}`),
      );
      const missing = aired.filter((e) => !have.has(`${e.season}:${e.episode}`) && !queued.has(`${e.season}:${e.episode}`));
      if (missing.length) out.push({ mediaId: f.mediaId, title: f.title, poster: f.poster, aired: aired.length, have: have.size, missing });
    } catch {
      /* a provider hiccup drops just this series */
    }
  }
  return out.sort((a, b) => b.missing.length - a.missing.length);
}

export interface CalendarEntry {
  mediaId: string;
  mediaType: 'tv' | 'anime';
  title: string;
  poster: string | null;
  backdrop: string | null;
  season: number | null;
  episode: number;
  episodeTitle: string | null;
  airsAt: number;
  /** TMDB gives dates only; AniList gives exact times. */
  allDay: boolean;
}

/** Upcoming (and recent) episodes for followed series between two unix times. */
export async function calendar(profileId: string, accountId: string, fromSec: number, toSec: number, scope: 'followed' | 'list' | 'watching'): Promise<CalendarEntry[]> {
  let followed = followedSeries(profileId, accountId);
  if (scope === 'list') followed = followed.filter((f) => f.why.includes('list'));
  if (scope === 'watching') followed = followed.filter((f) => f.why.includes('watching'));
  const out: CalendarEntry[] = [];
  const anime = followed.filter((f) => f.mediaType === 'anime').map((f) => parseMediaId(f.mediaId).providerId);
  const [airing] = await Promise.all([anilistAiring(anime, fromSec, toSec).catch(() => [])]);
  for (const a of airing) {
    out.push({
      mediaId: a.item.id,
      mediaType: 'anime',
      title: a.item.title,
      poster: a.item.poster,
      backdrop: a.item.backdrop,
      season: null,
      episode: a.episode,
      episodeTitle: null,
      airsAt: a.airingAt,
      allDay: false,
    });
  }
  const from = new Date(fromSec * 1000).toISOString().slice(0, 10);
  const to = new Date(toSec * 1000).toISOString().slice(0, 10);
  await Promise.all(
    followed
      .filter((f) => f.mediaType === 'tv')
      .map(async (f) => {
        try {
          const id = parseMediaId(f.mediaId).providerId;
          const d = await tmdbDetail('tv', id);
          if (d.status === 'Ended' || d.status === 'Canceled') return;
          const recent = d.seasons.slice(-2);
          for (const s of recent) {
            const eps = await tmdbEpisodes(id, s.season).catch(() => []);
            for (const e of eps) {
              if (!e.airDate || e.airDate < from || e.airDate > to) continue;
              out.push({
                mediaId: f.mediaId,
                mediaType: 'tv',
                title: d.title,
                poster: d.poster,
                backdrop: d.backdrop,
                season: e.season,
                episode: e.episode,
                episodeTitle: e.title,
                airsAt: Math.floor(Date.parse(`${e.airDate}T12:00:00Z`) / 1000),
                allDay: true,
              });
            }
          }
        } catch {
          /* skip */
        }
      }),
  );
  return out.sort((a, b) => a.airsAt - b.airsAt);
}
