/**
 * Filler and recap episodes of long anime, from MyAnimeList (through Jikan, a public read-only mirror).
 * Best effort: when Jikan is slow or down the episode list simply has no filler marks. Nothing waits for
 * this: episode lists show the marks once they are known, and the title page asks for them separately.
 */
import { cached } from '../lib/cache.js';

type Kind = 'filler' | 'recap';

const DAY = 86_400_000;
/** When Jikan last failed for a title: it's left alone for half a day after that. */
const failed = new Map<number, number>();

async function load(malId: number): Promise<[number, Kind][]> {
  const marks: [number, Kind][] = [];
  for (let page = 1; page <= 30; page++) {
    const r = await fetch(`https://api.jikan.moe/v4/anime/${malId}/episodes?page=${page}`, { signal: AbortSignal.timeout(8000) });
    if (r.status === 429) {
      await new Promise((res) => setTimeout(res, 1500));
      page--;
      continue;
    }
    if (!r.ok) throw new Error(String(r.status));
    const j = (await r.json()) as { data: { mal_id: number; filler: boolean; recap: boolean }[]; pagination?: { has_next_page?: boolean } };
    for (const e of j.data) if (e.filler || e.recap) marks.push([e.mal_id, e.filler ? 'filler' : 'recap']);
    if (!j.pagination?.has_next_page) break;
    // Jikan allows about three requests a second.
    await new Promise((res) => setTimeout(res, 400));
  }
  return marks;
}

/** Filler/recap marks by episode number; waits at most `waitMs` (kept across restarts), then finishes in the background. */
export async function fillerMarks(malId: number, waitMs = 0): Promise<Map<number, Kind> | null> {
  if ((failed.get(malId) ?? 0) > Date.now() - DAY / 2) return null;
  const p = cached(`jikan:filler:${malId}`, 7 * DAY, () => load(malId))
    .then((pairs) => new Map(pairs))
    .catch(() => {
      failed.set(malId, Date.now());
      return null;
    });
  return Promise.race([p, new Promise<null>((res) => setTimeout(() => res(null), waitMs))]);
}
