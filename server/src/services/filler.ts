/**
 * Filler and recap episodes of long anime, from MyAnimeList (through Jikan, a public read-only mirror).
 * Best effort: when Jikan is slow or down the episode list simply has no filler marks.
 */
type Kind = 'filler' | 'recap';

const known = new Map<number, { at: number; marks: Map<number, Kind> | null }>();
const loading = new Map<number, Promise<Map<number, Kind> | null>>();
const DAY = 86_400_000;

async function load(malId: number): Promise<Map<number, Kind> | null> {
  const marks = new Map<number, Kind>();
  try {
    for (let page = 1; page <= 30; page++) {
      const r = await fetch(`https://api.jikan.moe/v4/anime/${malId}/episodes?page=${page}`, { signal: AbortSignal.timeout(8000) });
      if (r.status === 429) {
        await new Promise((res) => setTimeout(res, 1500));
        page--;
        continue;
      }
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as { data: { mal_id: number; filler: boolean; recap: boolean }[]; pagination?: { has_next_page?: boolean } };
      for (const e of j.data) if (e.filler || e.recap) marks.set(e.mal_id, e.filler ? 'filler' : 'recap');
      if (!j.pagination?.has_next_page) break;
      // Jikan allows about three requests a second.
      await new Promise((res) => setTimeout(res, 400));
    }
    known.set(malId, { at: Date.now(), marks });
    return marks;
  } catch {
    known.set(malId, { at: Date.now() - 6.5 * DAY, marks: null }); // try again in half a day
    return null;
  }
}

/** Filler/recap marks by episode number; waits at most `waitMs`, then finishes in the background for next time. */
export async function fillerMarks(malId: number, waitMs = 3000): Promise<Map<number, Kind> | null> {
  const hit = known.get(malId);
  if (hit && Date.now() - hit.at < 7 * DAY) return hit.marks;
  let p = loading.get(malId);
  if (!p) {
    p = load(malId).finally(() => loading.delete(malId));
    loading.set(malId, p);
  }
  return Promise.race([p, new Promise<null>((res) => setTimeout(() => res(null), waitMs))]);
}
