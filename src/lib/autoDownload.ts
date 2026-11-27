import { create } from 'zustand';
import { api } from './api';
import { episodeLabel, itemKeyFor } from './format';
import { offlineSupported, useOffline } from './offline';
import type { CatalogDetail, Episode } from './types';

/**
 * Downloading to this device, more than one episode at a time: a season, everything missing, and
 * "new episodes" rules that fetch what comes out after they were turned on (checked while Nova is open).
 */
export interface DeviceRule {
  mediaId: string;
  mediaType: string;
  title: string;
  poster: string | null;
  /** The last episode that was out when the rule was turned on; only later ones download. */
  after: { season: number; episode: number };
  /** Item keys this rule already downloaded: removing one afterwards doesn't bring it back. */
  done?: string[];
  createdAt: number;
}

const KEY = 'nova.auto-download';
const read = (): DeviceRule[] => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as DeviceRule[];
  } catch {
    return [];
  }
};

interface RulesState {
  rules: DeviceRule[];
  add: (rule: DeviceRule) => void;
  remove: (mediaId: string) => void;
}

export const useDeviceRules = create<RulesState>((set, get) => ({
  rules: read(),
  add: (rule) => {
    const rules = [...get().rules.filter((r) => r.mediaId !== rule.mediaId), rule];
    localStorage.setItem(KEY, JSON.stringify(rules));
    set({ rules });
  },
  remove: (mediaId) => {
    const rules = get().rules.filter((r) => r.mediaId !== mediaId);
    localStorage.setItem(KEY, JSON.stringify(rules));
    set({ rules });
  },
}));

const isOut = (e: Episode) => !e.airDate || Date.parse(e.airDate) <= Date.now();
const later = (e: { season: number; episode: number }, than: { season: number; episode: number }) => e.season > than.season || (e.season === than.season && e.episode > than.episode);

/** Real seasons, oldest first (anime is one list). */
const seasonsOf = (d: Pick<CatalogDetail, 'mediaType' | 'seasons'>) => (d.mediaType === 'anime' ? [1] : d.seasons.filter((s) => s.season > 0 && s.episodeCount > 0).map((s) => s.season).sort((a, b) => a - b));

/** Every episode that is out, over the given seasons. */
async function outEpisodes(mediaId: string, seasons: number[]): Promise<Episode[]> {
  const lists = await Promise.all(seasons.map((s) => api.catalog.episodes(mediaId, s).catch(() => [] as Episode[])));
  return lists.flat().filter(isOut);
}

/** Queues device downloads for these episodes, skipping what is already downloaded or on its way. Returns how many. */
export function downloadEpisodes(detail: Pick<CatalogDetail, 'id' | 'mediaType' | 'title' | 'poster'>, episodes: Episode[]): number {
  if (!offlineSupported()) return 0;
  const offline = useOffline.getState();
  let n = 0;
  for (const e of episodes) {
    const itemKey = itemKeyFor(detail.id, e.season, e.episode);
    if (offline.jobs[itemKey] || offline.entries.some((x) => x.itemKey === itemKey)) continue;
    n++;
    void offline.saveBest({
      itemKey,
      mediaId: detail.id,
      mediaType: detail.mediaType,
      title: detail.title,
      subtitle: episodeLabel(detail.mediaType, e.season, e.episode, true),
      poster: detail.poster,
      season: e.season,
      episode: e.episode,
    });
  }
  return n;
}

/** Aired episodes of the whole series that aren't on this device yet. */
export async function missingOnDevice(detail: CatalogDetail): Promise<Episode[]> {
  const entries = useOffline.getState().entries;
  return (await outEpisodes(detail.id, seasonsOf(detail))).filter((e) => !entries.some((x) => x.itemKey === itemKeyFor(detail.id, e.season, e.episode)));
}

/** Turns "new episodes" on: remembers the latest episode out right now. */
export async function enableDeviceRule(detail: CatalogDetail): Promise<void> {
  const seasons = seasonsOf(detail);
  let after = { season: 0, episode: 0 };
  // The newest season with something out holds the latest episode.
  for (const s of [...seasons].reverse()) {
    const out = await outEpisodes(detail.id, [s]);
    if (!out.length) continue;
    after = out.reduce((b, e) => (later(e, b) ? { season: e.season, episode: e.episode } : b), after);
    break;
  }
  useDeviceRules.getState().add({ mediaId: detail.id, mediaType: detail.mediaType, title: detail.title, poster: detail.poster, after, createdAt: Date.now() });
}

/** Looks for episodes released since each rule was turned on and downloads them. */
let checking = false;
export async function runDeviceRules(): Promise<void> {
  if (!offlineSupported() || checking) return;
  checking = true;
  try {
    await checkRules();
  } finally {
    checking = false;
  }
}

async function checkRules(): Promise<void> {
  for (const rule of useDeviceRules.getState().rules) {
    try {
      const detail = await api.catalog.detail(rule.mediaId);
      const seasons = seasonsOf(detail).filter((s) => s >= rule.after.season);
      // What finished downloading counts as done; what failed (often: no copy out yet) is tried again next round.
      const have = useOffline.getState().entries.filter((x) => x.mediaId === rule.mediaId).map((x) => x.itemKey);
      const done = new Set([...(rule.done ?? []), ...have]);
      const now = useDeviceRules.getState().rules.find((r) => r.mediaId === rule.mediaId);
      if (now && done.size !== (rule.done ?? []).length) useDeviceRules.getState().add({ ...now, done: [...done].slice(-500) });
      const fresh = (await outEpisodes(rule.mediaId, seasons)).filter((e) => later(e, rule.after) && !done.has(itemKeyFor(rule.mediaId, e.season, e.episode)));
      if (fresh.length) downloadEpisodes(detail, fresh);
    } catch {
      /* listings unreachable: try again next round */
    }
  }
}
