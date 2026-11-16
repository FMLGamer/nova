import { episodeLabel, fmtLeft, itemKeyFor } from './format';
import type { CatalogDetail, Progress } from './types';

export interface PlayIntent {
  label: string;
  sub: string | null;
  season: number | null;
  episode: number | null;
  progress: number;
}

/** Decides what the one big Play button does: resume, play the next episode, or start from the top. */
export function playIntent(detail: CatalogDetail, progress: Progress[] | undefined): PlayIntent {
  if (detail.mediaType === 'movie') {
    const p = progress?.find((x) => x.itemKey === detail.id);
    if (p && !p.finished && p.positionSeconds > 30) {
      return { label: 'Resume', sub: fmtLeft(p.positionSeconds, p.durationSeconds), season: null, episode: null, progress: p.durationSeconds ? p.positionSeconds / p.durationSeconds : 0 };
    }
    return { label: p?.finished ? 'Watch again' : 'Play', sub: null, season: null, episode: null, progress: 0 };
  }
  const isAnime = detail.mediaType === 'anime';
  const sorted = [...(progress ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const last = sorted[0];
  const firstSeason = isAnime ? 1 : (detail.seasons.find((s) => s.season >= 1)?.season ?? 1);
  if (!last || last.episode == null) {
    return { label: 'Play', sub: episodeLabel(detail.mediaType, firstSeason, 1), season: firstSeason, episode: 1, progress: 0 };
  }
  const s = last.season ?? 1;
  const e = last.episode;
  if (!last.finished && last.positionSeconds > 20) {
    return {
      label: 'Resume',
      sub: [episodeLabel(detail.mediaType, s, e), fmtLeft(last.positionSeconds, last.durationSeconds)].filter(Boolean).join(' · '),
      season: s,
      episode: e,
      progress: last.durationSeconds ? last.positionSeconds / last.durationSeconds : 0,
    };
  }
  let ns = s;
  let ne = e + 1;
  if (isAnime) {
    const aired = detail.nextAiring ? detail.nextAiring.episode - 1 : (detail.totalEpisodes ?? Infinity);
    if (ne > aired) return { label: 'Watch again', sub: episodeLabel(detail.mediaType, 1, 1), season: 1, episode: 1, progress: 0 };
  } else {
    const count = detail.seasons.find((x) => x.season === s)?.episodeCount ?? Infinity;
    if (ne > count) {
      const next = detail.seasons.find((x) => x.season === s + 1);
      if (!next) return { label: 'Watch again', sub: episodeLabel(detail.mediaType, firstSeason, 1), season: firstSeason, episode: 1, progress: 0 };
      ns = next.season;
      ne = 1;
    }
  }
  const already = progress?.find((x) => x.itemKey === itemKeyFor(detail.id, ns, ne));
  return {
    label: 'Next up',
    sub: episodeLabel(detail.mediaType, ns, ne),
    season: ns,
    episode: ne,
    progress: already?.durationSeconds ? already.positionSeconds / already.durationSeconds : 0,
  };
}
