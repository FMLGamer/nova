import type { Preferences } from '../services/profiles.js';
import { episodeMatch, is3d, type EpisodeMatch, type Release } from './release.js';

export interface RankQuery {
  kind: 'movie' | 'tv' | 'anime' | 'music' | 'book' | 'comic';
  title: string;
  year?: number | null;
  creator?: string | null;
  season?: number | null;
  episode?: number | null;
}

/** The subset of preferences that drives ranking (a quality profile has the same shape). */
export type RankPrefs = Pick<Preferences, 'torrent' | 'anime'>;

const QUALITY_RANK: Record<string, number> = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1 };
const AUDIO_BROWSER_OK = new Set(['aac', 'opus', 'mp3']);
const AUDIO_BROWSER_BAD = new Set(['ac3', 'eac3', 'dts', 'truehd', 'flac']);

/**
 * Strictly tiered weights: every tier's maximum is smaller than one step of the
 * tier above, so a lower tier only ever breaks ties inside a higher one. That
 * stops (say) a nice audio codec from dragging a 720p file above the 1080p the
 * user asked for, and keeps seeders a pure tie-breaker.
 *
 *   right title > right episode > language > instant (debrid) > quality > codec
 *   > subtitles > audio > format > seeders
 */
const WEIGHT = {
  titleMatch: 1_000_000_000,
  episodeExact: 400_000_000,
  episodePack: 200_000_000,
  language: 50_000_000,
  cached: 20_000_000,
  quality: 1_000_000,
  qualityStep: 100_000,
  codec: 10_000,
  codecStep: 2_000,
  subs: 1_000,
  audio: 600,
  audioStep: 200,
  format: 120,
  formatStep: 40,
  seeders: 10,
} as const;

/** Words that only ever appear on a video release, never on an album or book. */
const VIDEO_GIVEAWAY =
  /\b(s\d{2}e\d{2}|s\d{2}\b|season\s*\d|episode\s*\d|complete\s+series|480p|720p|1080p|2160p|4k|x26[45]|h\.?26[45]|hevc|xvid|divx|webrip|web[-\s]?dl|bluray|blu-ray|hdtv|dvdrip|brrip|remux)\b/i;

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !/^(the|and|for|feat|with|his|her|from)$/.test(w));
}

function covers(name: string, want: string[], ratio: number): boolean {
  if (!want.length) return true;
  const hits = want.filter((w) => name.includes(w)).length;
  return hits >= Math.ceil(want.length * ratio);
}

/** Albums and books: relevance first, then format. */
function scoreMedia(r: Release, q: RankQuery): number {
  const name = r.title.toLowerCase();
  let m = 0;
  if (VIDEO_GIVEAWAY.test(name)) m -= 6000;
  if (q.creator) {
    const want = tokens(q.creator);
    const hits = want.filter((w) => name.includes(w)).length;
    if (want.length) m += hits === want.length ? 2500 : hits > 0 ? 1200 : -2500;
  }
  const want = tokens(q.title);
  if (want.length) {
    const hits = want.filter((w) => name.includes(w)).length;
    m += (hits / want.length) * 1500;
    if (hits === 0) m -= 2000;
  }
  if (q.kind === 'music') {
    if (/\bflac\b/.test(name)) m += 600;
    else if (/\b(320|v0)\b/.test(name)) m += 400;
    else if (/\bmp3\b/.test(name)) m += 200;
  } else {
    if (/\bepub\b/.test(name)) m += 600;
    else if (/\bcbz\b/.test(name)) m += 550;
    else if (/\bm4b\b/.test(name)) m += 500;
    else if (/\bmp3\b|audiobook/.test(name)) m += 400;
    else if (/\bpdf\b|\bmobi\b|\bazw3\b/.test(name)) m += 200;
  }
  return m + Math.min(300, Math.log2(r.seeders + 1) * 40);
}

/** A release is fine when it states no language, is multi-language, or speaks one we want. */
function languageOk(r: Release, prefs: RankPrefs, q: RankQuery): boolean {
  if (!r.languages.length || r.languages.includes('multi')) return true;
  const want = new Set(prefs.torrent.preferredLanguages.length ? prefs.torrent.preferredLanguages : ['en']);
  if (q.kind === 'anime') {
    want.add('ja');
    for (const l of prefs.anime.audioLanguages ?? []) want.add(l);
  }
  return r.languages.some((l) => want.has(l));
}

function scoreVideo(r: Release, prefs: RankPrefs, q: RankQuery, ep: EpisodeMatch): number {
  const t = prefs.torrent;
  let s = 0;

  if (q.kind === 'movie' && q.year) {
    const hay = `${r.title} ${r.fileName ?? ''}`;
    if ([q.year, q.year - 1, q.year + 1].some((y) => hay.includes(String(y)))) s += WEIGHT.titleMatch;
    else if (/\b(?:19|20)\d{2}\b/.test(r.title)) s -= WEIGHT.titleMatch;
  }

  if (ep === 'exact') s += WEIGHT.episodeExact;
  // A pack plays the right file only when the source named it (or the name says so).
  else if (ep === 'pack') s += r.fileIdx != null ? WEIGHT.episodePack : WEIGHT.episodePack / 2;

  if (languageOk(r, prefs, q)) s += WEIGHT.language;
  if (r.cached) s += WEIGHT.cached;

  if (q.kind === 'anime') {
    const langs = prefs.anime.audioLanguages?.length ? prefs.anime.audioLanguages : ['ja'];
    const wantsDub = langs.some((l) => l !== 'ja');
    if (r.audioKind === 'dual') s += WEIGHT.subs;
    else if (wantsDub && r.audioKind === 'dub') s += WEIGHT.subs;
  }

  const qIdx = r.quality ? t.preferredQualities.indexOf(r.quality) : -1;
  if (qIdx >= 0) s += WEIGHT.quality - qIdx * WEIGHT.qualityStep;
  else if (r.quality) s += WEIGHT.quality - t.preferredQualities.length * WEIGHT.qualityStep;

  const cIdx = r.codec ? t.preferredCodecs.indexOf(r.codec) : -1;
  if (cIdx >= 0) s += WEIGHT.codec - cIdx * WEIGHT.codecStep;

  if (prefs.anime.preferEmbeddedSubs && r.hasSubs) s += WEIGHT.subs;

  const aIdx = r.audio ? (t.preferredAudio ?? []).indexOf(r.audio) : -1;
  if (aIdx >= 0) s += WEIGHT.audio - aIdx * WEIGHT.audioStep;
  else if (r.audio && AUDIO_BROWSER_OK.has(r.audio)) s += WEIGHT.audio - WEIGHT.audioStep;
  else if (r.audio && AUDIO_BROWSER_BAD.has(r.audio)) s -= WEIGHT.audio;

  const sIdx = r.source ? (t.preferredSources ?? []).indexOf(r.source) : -1;
  if (sIdx >= 0) s += WEIGHT.format - sIdx * WEIGHT.formatStep;
  if (r.source === 'remux' && !t.preferRemux) s -= WEIGHT.format;
  if (r.hdr) s += t.hdr ? WEIGHT.format : -WEIGHT.format;

  s += Math.min(WEIGHT.seeders, Math.log2(r.seeders + 1) * 1.4);
  return s;
}

export interface RankResult {
  releases: Release[];
  /** Anime: dubs were wanted but none exist, so subbed releases are shown. */
  noDub: boolean;
}

function kindFor(k: RankQuery['kind']): Release['kind'] {
  if (k === 'music') return 'audio';
  if (k === 'book') return 'book';
  if (k === 'comic') return 'comic';
  return 'video';
}

/** Filters (each relaxes itself if it would leave nothing) then scores and orders. */
export function rankReleases(input: Release[], prefs: RankPrefs, q: RankQuery): RankResult {
  const drop = (pool: Release[], keep: (r: Release) => boolean): Release[] => {
    const kept = pool.filter(keep);
    return kept.length ? kept : pool;
  };
  const want = kindFor(q.kind);
  let pool = input.filter((r) => r.kind === want || (want === 'book' && r.kind === 'audio'));
  let noDub = false;

  if (q.kind === 'music' || q.kind === 'book' || q.kind === 'comic') {
    // Relevance is a hard requirement here and deliberately NOT relaxed: no
    // sources is a far better answer than a confidently wrong one.
    const titleWants = tokens(q.title);
    const creatorWants = q.creator ? tokens(q.creator) : [];
    pool = pool.filter((r) => {
      if (VIDEO_GIVEAWAY.test(r.title)) return false;
      const n = r.title.toLowerCase();
      return covers(n, titleWants, 0.7) && covers(n, creatorWants, 1);
    });
    for (const r of pool) r.score = scoreMedia(r, q);
    return { releases: pool.sort((a, b) => b.score - a.score).slice(0, 60), noDub };
  }

  const t = prefs.torrent;
  const episodic = (q.kind === 'tv' || q.kind === 'anime') && q.episode != null;
  const matchOf = new Map<Release, EpisodeMatch>();
  for (const r of pool) {
    matchOf.set(r, episodic ? episodeMatch(`${r.title} ${r.fileName ?? ''}`, q.kind as 'tv' | 'anime', q.season ?? null, q.episode ?? null) : 'unknown');
  }

  // A different episode is simply the wrong thing to play.
  if (episodic) pool = drop(pool, (r) => matchOf.get(r) !== 'mismatch');
  pool = drop(pool, (r) => !is3d(`${r.title} ${r.fileName ?? ''}`));
  // Cams and telesyncs are never what anyone wants when anything else exists.
  pool = drop(pool, (r) => r.source !== 'cam');
  pool = drop(pool, (r) => languageOk(r, prefs, q));
  const maxRank = QUALITY_RANK[t.maxQuality] ?? 4;
  pool = drop(pool, (r) => !r.quality || (QUALITY_RANK[r.quality] ?? 0) <= maxRank);
  // Size limits apply to the file we will actually play; a pack's total says little.
  pool = drop(pool, (r) => !r.sizeBytes || (matchOf.get(r) === 'pack' && r.fileIdx == null) || r.sizeBytes / 1e9 <= t.maxSizeGb);
  pool = drop(pool, (r) => !r.sizeBytes || r.sizeBytes / 1e9 >= 0.1);
  pool = drop(pool, (r) => r.cached || r.url !== null || r.seeders >= t.minSeeders);
  pool = drop(pool, (r) => r.cached || r.url !== null || r.seeders >= 1);

  if (q.kind === 'anime') {
    const langs = prefs.anime.audioLanguages?.length ? prefs.anime.audioLanguages : ['ja'];
    const wantsDub = langs.some((l) => l !== 'ja');
    const wantsJapanese = langs.includes('ja');
    if (!wantsDub) pool = drop(pool, (r) => r.audioKind !== 'dub');
    else {
      const dubbed = pool.filter((r) => r.audioKind === 'dub' || r.audioKind === 'dual');
      if (!dubbed.length) noDub = true;
      else if (!wantsJapanese) pool = dubbed;
    }
  }

  for (const r of pool) r.score = scoreVideo(r, prefs, q, matchOf.get(r) ?? 'unknown');

  // Preferred indexer/source (movies + shows): its releases come first and the
  // rest are shown collapsed, unless it has nothing.
  const preferred = (t.preferredIndexer ?? '').trim().toLowerCase();
  if (preferred && q.kind !== 'anime') {
    const isPreferred = (r: Release) =>
      r.indexer.toLowerCase().includes(preferred) ||
      r.pluginName.toLowerCase().includes(preferred) ||
      r.pluginId.toLowerCase() === preferred;
    const hasPreferred = pool.some(isPreferred);
    for (const r of pool) r.tier = hasPreferred && !isPreferred(r) ? 1 : 0;
  }

  return {
    releases: pool.sort((a, b) => a.tier - b.tier || b.score - a.score || b.seeders - a.seeders).slice(0, 80),
    noDub,
  };
}
