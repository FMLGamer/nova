import { db } from '../db/index.js';
import { cached } from '../lib/cache.js';
import { warmAnime } from './anilist.js';
import { detailFor, episodesFor } from './catalog.js';

export interface UpNext {
  mediaId: string;
  mediaType: 'tv' | 'anime';
  title: string;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
  season: number;
  episode: number;
  episodeTitle: string;
  still: string | null;
  runtime: number | null;
  itemKey: string;
}

interface Row {
  media_id: string;
  media_type: string;
  season: number | null;
  episode: number | null;
  position_seconds: number;
  duration_seconds: number | null;
  finished: number;
  updated_at: string;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The next aired, unstarted episode of every series this profile finished an
 * episode of recently. Continue Watching covers half-watched ones.
 */
export async function upNext(profileId: string): Promise<UpNext[]> {
  return cached(`upnext:${profileId}:${Math.floor(Date.now() / 300_000)}`, 300_000, async () => {
    const rows = db
      .prepare(
        `SELECT media_id, media_type, season, episode, position_seconds, duration_seconds, finished, updated_at
           FROM watch_progress WHERE profile_id = ? AND media_type IN ('tv','anime')
            AND updated_at > datetime('now', '-90 days')
          ORDER BY updated_at DESC`,
      )
      .all(profileId) as Row[];
    const byMedia = new Map<string, Row[]>();
    for (const r of rows) {
      const list = byMedia.get(r.media_id) ?? [];
      list.push(r);
      byMedia.set(r.media_id, list);
    }
    const out: UpNext[] = [];
    const candidates = [...byMedia.entries()].slice(0, 24);
    await warmAnime(candidates.map(([mediaId]) => mediaId));
    for (const [mediaId, list] of candidates) {
      const done = (r: Row) => r.finished === 1 || (r.duration_seconds ? r.position_seconds / r.duration_seconds > 0.9 : false);
      // Skip series with a half-watched episode: that one belongs to Continue Watching.
      if (list.some((r) => !done(r) && r.position_seconds > 30)) continue;
      const last = list
        .filter(done)
        .sort((a, b) => (b.season ?? 1) - (a.season ?? 1) || (b.episode ?? 0) - (a.episode ?? 0))[0];
      if (!last) continue;
      try {
        const mediaType = mediaId.startsWith('anime:') ? 'anime' : 'tv';
        let season = last.season ?? 1;
        let eps = await episodesFor(mediaId, season);
        let next = eps.find((e) => e.episode === (last.episode ?? 0) + 1);
        if (!next && mediaType === 'tv') {
          season += 1;
          eps = await episodesFor(mediaId, season).catch(() => []);
          next = eps.find((e) => e.episode === 1);
        }
        if (!next) continue;
        if (next.airDate && next.airDate > today()) continue;
        const watchedNext = list.some((r) => (r.season ?? 1) === next!.season && r.episode === next!.episode);
        if (watchedNext) continue;
        const d = await detailFor(mediaId);
        if (mediaType === 'anime' && d.nextAiring && next.episode >= d.nextAiring.episode) continue;
        out.push({
          mediaId,
          mediaType,
          title: d.title,
          year: d.year,
          poster: d.poster,
          backdrop: d.backdrop,
          season: next.season,
          episode: next.episode,
          episodeTitle: next.title,
          still: next.still,
          runtime: next.runtime ?? d.runtime,
          itemKey: next.id,
        });
      } catch {
        /* provider hiccup: skip this one */
      }
      if (out.length >= 16) break;
    }
    return out;
  });
}
