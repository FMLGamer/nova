import { db } from '../db/index.js';

export interface ProgressInput {
  itemKey: string;
  mediaType: string;
  mediaId: string;
  season?: number | null;
  episode?: number | null;
  positionSeconds: number;
  durationSeconds?: number | null;
  finished?: boolean;
  title?: string | null;
  poster?: string | null;
  backdrop?: string | null;
  year?: number | null;
  sourceLink?: string | null;
}

export interface ProgressDTO {
  itemKey: string;
  mediaType: string;
  mediaId: string;
  season: number | null;
  episode: number | null;
  positionSeconds: number;
  durationSeconds: number | null;
  finished: boolean;
  title: string | null;
  poster: string | null;
  backdrop: string | null;
  year: number | null;
  sourceLink: string | null;
  updatedAt: string;
}

interface ProgressRow {
  item_key: string;
  media_type: string;
  media_id: string;
  season: number | null;
  episode: number | null;
  position_seconds: number;
  duration_seconds: number | null;
  finished: number;
  title: string | null;
  poster: string | null;
  backdrop: string | null;
  year: number | null;
  source_link: string | null;
  updated_at: string;
}

function progressToDTO(r: ProgressRow): ProgressDTO {
  return {
    itemKey: r.item_key,
    mediaType: r.media_type,
    mediaId: r.media_id,
    season: r.season,
    episode: r.episode,
    positionSeconds: r.position_seconds,
    durationSeconds: r.duration_seconds,
    finished: r.finished === 1,
    title: r.title,
    poster: r.poster,
    backdrop: r.backdrop,
    year: r.year,
    sourceLink: r.source_link,
    updatedAt: r.updated_at,
  };
}

export function upsertProgress(profileId: string, input: ProgressInput): ProgressDTO {
  db.prepare(
    `INSERT INTO watch_progress
       (profile_id, item_key, media_type, media_id, season, episode, position_seconds,
        duration_seconds, finished, title, poster, backdrop, year, source_link, updated_at)
     VALUES
       (@profile_id, @item_key, @media_type, @media_id, @season, @episode, @position_seconds,
        @duration_seconds, @finished, @title, @poster, @backdrop, @year, @source_link, datetime('now'))
     ON CONFLICT(profile_id, item_key) DO UPDATE SET
        position_seconds = excluded.position_seconds,
        duration_seconds = excluded.duration_seconds,
        finished         = excluded.finished,
        season           = excluded.season,
        episode          = excluded.episode,
        title            = excluded.title,
        poster           = excluded.poster,
        backdrop         = excluded.backdrop,
        year             = COALESCE(excluded.year, watch_progress.year),
        source_link      = COALESCE(excluded.source_link, watch_progress.source_link),
        updated_at       = excluded.updated_at`,
  ).run({
    profile_id: profileId,
    item_key: input.itemKey,
    media_type: input.mediaType,
    media_id: input.mediaId,
    season: input.season ?? null,
    episode: input.episode ?? null,
    position_seconds: input.positionSeconds,
    duration_seconds: input.durationSeconds ?? null,
    finished: input.finished ? 1 : 0,
    title: input.title ?? null,
    poster: input.poster ?? null,
    backdrop: input.backdrop ?? null,
    year: input.year ?? null,
    source_link: input.sourceLink ?? null,
  });
  return getProgress(profileId, input.itemKey)!;
}

export function getProgress(profileId: string, itemKey: string): ProgressDTO | null {
  const row = db
    .prepare('SELECT * FROM watch_progress WHERE profile_id = ? AND item_key = ?')
    .get(profileId, itemKey) as ProgressRow | undefined;
  return row ? progressToDTO(row) : null;
}

export function continueWatching(profileId: string, limit = 20): ProgressDTO[] {
  const rows = db
    .prepare('SELECT * FROM watch_progress WHERE profile_id = ? AND finished = 0 ORDER BY updated_at DESC')
    .all(profileId) as ProgressRow[];
  const seen = new Set<string>();
  const out: ProgressDTO[] = [];
  for (const r of rows) {
    if (seen.has(r.media_id)) continue; // one card per title (latest episode)
    seen.add(r.media_id);
    out.push(progressToDTO(r));
    if (out.length >= limit) break;
  }
  return out;
}

export function deleteProgress(profileId: string, itemKey: string): void {
  db.prepare('DELETE FROM watch_progress WHERE profile_id = ? AND item_key = ?').run(profileId, itemKey);
}

/** Every episode record for one title, so the episode list can show progress. */
export function progressForMedia(profileId: string, mediaId: string): ProgressDTO[] {
  const rows = db
    .prepare(
      'SELECT * FROM watch_progress WHERE profile_id = ? AND media_id = ? ORDER BY season, episode',
    )
    .all(profileId, mediaId) as ProgressRow[];
  return rows.map(progressToDTO);
}

export interface WatchedSummary {
  mediaId: string;
  /** Episodes with a saved position (or the movie itself). */
  started: number;
  /** Episodes watched: marked finished, or played to (nearly) the end. */
  finished: number;
  /** Their episode numbers (anime: the schedule marks these). */
  watchedEpisodes: number[];
  /** Fraction of the most recent item, for the movie/one-off progress bar. */
  lastPercent: number;
  lastSeason: number | null;
  lastEpisode: number | null;
  updatedAt: string;
}

const WATCHED_SHARE = 0.9;
const isWatched = (r: ProgressRow) => r.finished === 1 || (r.duration_seconds != null && r.duration_seconds > 0 && r.position_seconds / r.duration_seconds >= WATCHED_SHARE);

/** One row per title the profile has touched — drives the catalogue badges. */
export function watchedSummaries(profileId: string): WatchedSummary[] {
  const rows = db
    .prepare('SELECT * FROM watch_progress WHERE profile_id = ? ORDER BY updated_at DESC')
    .all(profileId) as ProgressRow[];
  const byMedia = new Map<string, WatchedSummary>();
  for (const r of rows) {
    let entry = byMedia.get(r.media_id);
    if (!entry) {
      const pct =
        r.duration_seconds && r.duration_seconds > 0
          ? Math.min(1, r.position_seconds / r.duration_seconds)
          : 0;
      entry = {
        mediaId: r.media_id,
        started: 0,
        finished: 0,
        watchedEpisodes: [],
        lastPercent: r.finished ? 1 : pct,
        lastSeason: r.season,
        lastEpisode: r.episode,
        updatedAt: r.updated_at,
      };
      byMedia.set(r.media_id, entry);
    }
    entry.started++;
    if (isWatched(r)) {
      entry.finished++;
      if (r.episode != null) entry.watchedEpisodes.push(r.episode);
    }
  }
  return [...byMedia.values()];
}

export interface MyListInput {
  mediaType: string;
  mediaId: string;
  title?: string | null;
  poster?: string | null;
  year?: number | null;
}

export interface MyListDTO {
  mediaType: string;
  mediaId: string;
  title: string | null;
  poster: string | null;
  year: number | null;
  addedAt: string;
}

interface MyListRow {
  media_type: string;
  media_id: string;
  title: string | null;
  poster: string | null;
  year: number | null;
  added_at: string;
}

function listToDTO(r: MyListRow): MyListDTO {
  return {
    mediaType: r.media_type,
    mediaId: r.media_id,
    title: r.title,
    poster: r.poster,
    year: r.year,
    addedAt: r.added_at,
  };
}

export function addToList(profileId: string, input: MyListInput): void {
  db.prepare(
    `INSERT INTO my_list (profile_id, media_type, media_id, title, poster, year, added_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(profile_id, media_type, media_id) DO UPDATE SET
        title = excluded.title, poster = excluded.poster, year = excluded.year`,
  ).run(profileId, input.mediaType, input.mediaId, input.title ?? null, input.poster ?? null, input.year ?? null);
}

export function removeFromList(profileId: string, mediaType: string, mediaId: string): void {
  db.prepare('DELETE FROM my_list WHERE profile_id = ? AND media_type = ? AND media_id = ?').run(
    profileId,
    mediaType,
    mediaId,
  );
}

export function listMyList(profileId: string): MyListDTO[] {
  const rows = db
    .prepare('SELECT * FROM my_list WHERE profile_id = ? ORDER BY added_at DESC')
    .all(profileId) as MyListRow[];
  return rows.map(listToDTO);
}
