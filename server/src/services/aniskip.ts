import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/upstream.js';

export interface SkipInterval {
  start: number;
  end: number;
}

export interface SkipTimes {
  op: SkipInterval | null;
  ed: SkipInterval | null;
}

interface AniSkipResult {
  interval: { startTime: number; endTime: number };
  skipType: string; // 'op' | 'ed'
}

interface AniSkipResponse {
  found: boolean;
  results?: AniSkipResult[];
}

/** Opening/ending skip times from the community AniSkip API (keyed by MAL id). */
export async function getSkipTimes(malId: number, episode: number): Promise<SkipTimes> {
  return cached(`aniskip:${malId}:${episode}`, 7 * 24 * 60 * 60 * 1000, async () => {
    const url = `https://api.aniskip.com/v2/skip-times/${malId}/${episode}?types=op&types=ed&episodeLength=0`;
    try {
      const data = await fetchJson<AniSkipResponse>(url, { timeoutMs: 8000 });
      const find = (t: string): SkipInterval | null => {
        const r = (data.results ?? []).find((x) => x.skipType === t);
        return r ? { start: r.interval.startTime, end: r.interval.endTime } : null;
      };
      return { op: find('op'), ed: find('ed') };
    } catch {
      return { op: null, ed: null };
    }
  });
}
