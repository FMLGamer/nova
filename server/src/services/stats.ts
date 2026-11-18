/** "Your year in Nova": how much a profile watched and read, worked out from its own history. */
import { db } from '../db/index.js';
import { detailFor } from './catalog.js';

interface Row {
  media_type: string;
  media_id: string;
  title: string | null;
  poster: string | null;
  position_seconds: number;
  duration_seconds: number | null;
  finished: number;
  episode: number | null;
  updated_at: string;
}

const day = (sqlite: string) => sqlite.slice(0, 10);

export async function profileStats(profileId: string) {
  const rows = db.prepare('SELECT * FROM watch_progress WHERE profile_id = ?').all(profileId) as Row[];
  const seconds = (r: Row) => (r.finished ? (r.duration_seconds ?? r.position_seconds) : Math.min(r.position_seconds, r.duration_seconds ?? r.position_seconds));

  const types = new Map<string, { seconds: number; titles: Set<string> }>();
  const titles = new Map<string, { mediaId: string; mediaType: string; title: string; poster: string | null; seconds: number; episodes: number }>();
  const months = new Map<string, number>();
  const days = new Set<string>();
  let total = 0;
  let episodes = 0;
  let movies = 0;
  for (const r of rows) {
    const s = seconds(r);
    total += s;
    if (r.finished && r.episode != null) episodes++;
    if (r.finished && r.media_type === 'movie') movies++;
    const t = types.get(r.media_type) ?? { seconds: 0, titles: new Set<string>() };
    t.seconds += s;
    t.titles.add(r.media_id);
    types.set(r.media_type, t);
    const ti = titles.get(r.media_id) ?? { mediaId: r.media_id, mediaType: r.media_type, title: r.title ?? 'Untitled', poster: r.poster ?? null, seconds: 0, episodes: 0 };
    ti.seconds += s;
    if (r.finished && r.episode != null) ti.episodes++;
    ti.poster ??= r.poster ?? null;
    titles.set(r.media_id, ti);
    const m = r.updated_at.slice(0, 7);
    months.set(m, (months.get(m) ?? 0) + s);
    days.add(day(r.updated_at));
  }

  // The last twelve months, oldest first, including empty ones.
  const now = new Date();
  const monthList = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + i, 1));
    const key = d.toISOString().slice(0, 7);
    return { month: key, seconds: Math.round(months.get(key) ?? 0) };
  });

  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    if (days.has(d)) streak++;
    else if (i > 0) break;
  }
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const activeDays = [...days].filter((d) => d >= since).length;

  const top = [...titles.values()].sort((a, b) => b.seconds - a.seconds);
  // Genres weighted by time, from the most-watched titles (metadata is cached).
  const genres = new Map<string, number>();
  await Promise.all(
    top.slice(0, 30).map(async (t) => {
      const d = await detailFor(t.mediaId).catch(() => null);
      for (const g of d?.genres ?? []) genres.set(g, (genres.get(g) ?? 0) + t.seconds);
      if (d && !t.poster) t.poster = d.poster;
    }),
  );

  const reading = db.prepare('SELECT kind, percent FROM reading_progress WHERE profile_id = ?').all(profileId) as { kind: string; percent: number }[];
  const readKinds = new Map<string, { finished: number; reading: number }>();
  for (const r of reading) {
    const k = readKinds.get(r.kind) ?? { finished: 0, reading: 0 };
    if (r.percent >= 0.99) k.finished++;
    else k.reading++;
    readKinds.set(r.kind, k);
  }

  return {
    totals: { seconds: Math.round(total), titles: titles.size, episodes, movies, activeDays, streak },
    byType: [...types.entries()].map(([type, t]) => ({ type, seconds: Math.round(t.seconds), titles: t.titles.size })).sort((a, b) => b.seconds - a.seconds),
    months: monthList,
    genres: [...genres.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, s]) => ({ name, seconds: Math.round(s) })),
    top: top.slice(0, 10).map((t) => ({ ...t, seconds: Math.round(t.seconds) })),
    reading: [...readKinds.entries()].map(([kind, k]) => ({ kind, ...k })),
  };
}
