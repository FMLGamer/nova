/**
 * "For you": recommendations from a profile's own history, worked out on the server (nothing leaves it).
 *
 * 1. Seeds: the titles the profile cares about most. Finished > started > only saved, and recent
 *    activity counts more (half-life of two months).
 * 2. Candidates from each seed's own recommendations and follow-ups (AniList / TMDB). A title several
 *    seeds point to rises; a sequel to something you finished rises more.
 * 3. A genre profile (time-weighted) adds the best-liked titles in your favourite genres, so it also
 *    works without a TMDB key (Cinemeta has no recommendations of its own).
 * Anything you've watched, saved, dismissed or have on your AniList / MyAnimeList lists is left out.
 */
import { db } from '../db/index.js';
import { cached } from '../lib/cache.js';
import type { CatalogItem, Relation } from '../media/types.js';
import { anilistBrowse } from './anilist.js';
import { detailFor } from './catalog.js';
import { tmdbBrowse, tmdbGenres } from './tmdb.js';
import { trackedLists, trackerStatus } from './trackers.js';

export interface Recommendation {
  item: CatalogItem;
  reason: string;
}

const HALF_LIFE_DAYS = 60;
const REL_WEIGHT: Record<string, number> = { SEQUEL: 1.3, RECOMMENDATION: 1, RELATED: 1, SIDE_STORY: 0.7, SPIN_OFF: 0.7, PARENT: 0.6, PREQUEL: 0.5, ALTERNATIVE: 0.3, SUMMARY: 0.1, CHARACTER: 0.2 };

const age = (sqlite: string) => Math.max(0, (Date.now() - Date.parse(`${sqlite.replace(' ', 'T')}Z`)) / 86_400_000);
const decay = (days: number) => 0.5 ** (days / HALF_LIFE_DAYS);

function relationItem(r: Relation): CatalogItem {
  return { id: r.id, mediaType: r.id.split(':')[0] as CatalogItem['mediaType'], title: r.title, year: null, poster: r.poster, backdrop: null, overview: '', rating: null, runtime: null, genres: [] };
}

interface Seed {
  mediaId: string;
  title: string;
  weight: number;
}

function seeds(profileId: string): { seeds: Seed[]; seen: Set<string> } {
  const rows = db.prepare('SELECT media_id, title, position_seconds, duration_seconds, finished, updated_at FROM watch_progress WHERE profile_id = ?').all(profileId) as {
    media_id: string;
    title: string | null;
    position_seconds: number;
    duration_seconds: number | null;
    finished: number;
    updated_at: string;
  }[];
  const list = db.prepare('SELECT media_id, title, added_at FROM my_list WHERE profile_id = ?').all(profileId) as { media_id: string; title: string | null; added_at: string }[];
  const by = new Map<string, Seed>();
  const add = (mediaId: string, title: string | null, w: number) => {
    const s = by.get(mediaId) ?? { mediaId, title: title ?? 'this', weight: 0 };
    s.weight += w;
    if (title) s.title = title;
    by.set(mediaId, s);
  };
  for (const r of rows) {
    const share = r.duration_seconds ? r.position_seconds / r.duration_seconds : 0;
    add(r.media_id, r.title, (r.finished ? 3 : share >= 0.3 ? 1.5 : 0.4) * decay(age(r.updated_at)));
  }
  for (const l of list) add(l.media_id, l.title, 1.5 * decay(age(l.added_at)));
  // A long series shouldn't drown everything else.
  for (const s of by.values()) s.weight = Math.min(s.weight, 8);
  const seen = new Set([...rows.map((r) => r.media_id), ...list.map((l) => l.media_id)]);
  return { seeds: [...by.values()].sort((a, b) => b.weight - a.weight).slice(0, 14), seen };
}

async function genreFill(kind: 'movie' | 'tv' | 'anime', genre: string): Promise<CatalogItem[]> {
  if (kind === 'anime') return anilistBrowse({ genre, sort: 'top' }).catch(() => []);
  const all = await tmdbGenres(kind).catch(() => []);
  const g = all.find((x) => x.name.toLowerCase() === genre.toLowerCase());
  return g ? tmdbBrowse(kind, { genre: String(g.id), sort: 'vote_average.desc' }).catch(() => []) : [];
}

export async function recommendations(profileId: string): Promise<{ forYou: Recommendation[]; because: { seed: { mediaId: string; title: string }; items: CatalogItem[] }[] }> {
  const { seeds: local, seen } = seeds(profileId);
  const dismissed = new Set((db.prepare('SELECT media_id FROM rec_dismissed WHERE profile_id = ?').all(profileId) as { media_id: string }[]).map((r) => r.media_id));
  // Whatever is on the connected AniList / MyAnimeList lists is known already (only "Plan to watch" is still welcome),
  // and what was finished or is being watched there says what the profile likes.
  const status = trackerStatus(profileId);
  const tracked = status.anilist.connected || status.mal.connected ? await trackedLists(profileId).catch(() => []) : [];
  const bySeed = new Map(local.map((s) => [s.mediaId, s]));
  for (const t of tracked) {
    if (t.status === 'planning') continue;
    seen.add(t.mediaId);
    if (t.status === 'dropped' || bySeed.has(t.mediaId)) continue;
    const liked = t.score ? t.score / 7 : 1;
    const days = t.updatedAt ? Math.max(0, (Date.now() - t.updatedAt * 1000) / 86_400_000) : HALF_LIFE_DAYS;
    bySeed.set(t.mediaId, { mediaId: t.mediaId, title: t.title, weight: (t.status === 'completed' ? 2 : 1) * liked * decay(days) });
  }
  const top = [...bySeed.values()].sort((a, b) => b.weight - a.weight).slice(0, 14);
  // Recomputed when the history changes, otherwise reused for half an hour.
  const version = top.map((s) => `${s.mediaId}:${s.weight.toFixed(1)}`).join(',') + `|${dismissed.size}|${seen.size}`;
  return cached(`recs:${profileId}:${version}`, 30 * 60_000, async () => {
    const scores = new Map<string, { item: CatalogItem; score: number; reason: string; best: number }>();
    const genres = new Map<string, number>();
    const kinds = new Map<string, number>();
    const because: { seed: { mediaId: string; title: string }; items: CatalogItem[] }[] = [];
    const bump = (item: CatalogItem, score: number, reason: string) => {
      if (seen.has(item.id) || dismissed.has(item.id) || !item.poster) return;
      const c = scores.get(item.id) ?? { item, score: 0, reason, best: 0 };
      c.score += score;
      // The strongest single reason is the one shown.
      if (score > c.best) {
        c.best = score;
        c.reason = reason;
      }
      scores.set(item.id, c);
    };

    const details = await Promise.all(top.map((s) => detailFor(s.mediaId).catch(() => null)));
    top.forEach((s, i) => {
      const d = details[i];
      if (!d) return;
      kinds.set(d.mediaType, (kinds.get(d.mediaType) ?? 0) + s.weight);
      for (const g of d.genres) genres.set(`${d.mediaType}|${g}`, (genres.get(`${d.mediaType}|${g}`) ?? 0) + s.weight);
      const rels = d.relations.filter((r) => r.poster);
      rels.forEach((r, rank) => bump(relationItem(r), s.weight * (REL_WEIGHT[r.relationType] ?? 0.5) * (1 / (1 + rank * 0.12)), `Because you watched ${d.title}`));
      if (because.length < 3 && s.weight >= 1.5) {
        const items = rels.filter((r) => !seen.has(r.id) && !dismissed.has(r.id)).map(relationItem);
        if (items.length >= 4) because.push({ seed: { mediaId: s.mediaId, title: d.title }, items: items.slice(0, 20) });
      }
    });

    // Favourite genres per kind: the best-rated titles there, weaker than direct recommendations.
    const favourite = [...genres.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const max = favourite[0]?.[1] ?? 1;
    const fills = await Promise.all(favourite.map(([key]) => genreFill(key.split('|')[0] as 'movie' | 'tv' | 'anime', key.split('|')[1]!)));
    favourite.forEach(([key, w], i) => {
      const genre = key.split('|')[1]!;
      (fills[i] ?? []).slice(0, 20).forEach((item, rank) => bump(item, 1.2 * (w / max) * (1 / (1 + rank * 0.1)), `Because you like ${genre}`));
    });

    const forYou = [...scores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)
      .map(({ item, reason }) => ({ item, reason }));
    return { forYou, because };
  });
}

export function dismiss(profileId: string, mediaId: string): void {
  db.prepare('INSERT OR IGNORE INTO rec_dismissed (profile_id, media_id) VALUES (?, ?)').run(profileId, mediaId);
}
