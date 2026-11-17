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

/**
 * Video sources are ordered by what is *correct* first (the right film, the right episode,
 * a language the viewer understands, instant debrid links), then simply by seeders. The
 * viewer's quality settings are requirements, not a ranking: releases that miss one are
 * kept, but move to a collapsed second tier.
 */
const WEIGHT = {
  titleMatch: 1_000_000_000,
  episodeExact: 400_000_000,
  episodePack: 200_000_000,
  language: 50_000_000,
  cached: 20_000_000,
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

/** Correctness only; quality settings never move a release here (see `misses`). */
function scoreVideo(r: Release, prefs: RankPrefs, q: RankQuery, ep: EpisodeMatch): number {
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
  return s;
}

const FORMAT_LABEL: Record<string, string> = { remux: 'Remux', bluray: 'Blu-ray', webdl: 'WEB-DL', web: 'WEBRip', hdtv: 'HDTV', dvd: 'DVD' };

/** The viewer's requirements this release doesn't meet. Anything the release doesn't state passes. */
function missedRequirements(r: Release, prefs: RankPrefs, q: RankQuery, ep: EpisodeMatch): string[] {
  const t = prefs.torrent;
  const out: string[] = [];
  if (r.quality && t.qualities.length && !t.qualities.includes(r.quality)) out.push(r.quality === '2160p' ? '4K' : r.quality);
  if (r.codec && t.codecs.length && !t.codecs.includes(r.codec)) out.push(r.codec.toUpperCase());
  if (r.audio && t.audioCodecs.length && !t.audioCodecs.includes(r.audio)) out.push(r.audio.toUpperCase());
  if (r.source && t.formats.length && !t.formats.includes(r.source)) out.push(FORMAT_LABEL[r.source] ?? r.source);
  if (r.hdr && !t.allowHdr) out.push('HDR');
  if (!languageOk(r, prefs, q)) out.push('language');
  // Size limits apply to the file we will actually play; a pack's total says little.
  if (r.sizeBytes && !(ep === 'pack' && r.fileIdx == null) && r.sizeBytes / 1e9 > t.maxSizeGb) out.push('too large');
  if (!r.cached && r.url === null && r.seeders < t.minSeeders) out.push('few seeders');
  return out;
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
  pool = drop(pool, (r) => !r.sizeBytes || r.sizeBytes / 1e9 >= 0.1);
  // A torrent nobody seeds won't play at all.
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

  const preferred = (t.preferredIndexer ?? '').trim().toLowerCase();
  const isPreferred = (r: Release) =>
    r.indexer.toLowerCase().includes(preferred) || r.pluginName.toLowerCase().includes(preferred) || r.pluginId.toLowerCase() === preferred;
  // Preferred indexer/source (movies + shows): the others are shown collapsed, unless it has nothing.
  const narrow = Boolean(preferred) && q.kind !== 'anime' && pool.some(isPreferred);
  for (const r of pool) {
    const ep = matchOf.get(r) ?? 'unknown';
    r.score = scoreVideo(r, prefs, q, ep);
    r.misses = missedRequirements(r, prefs, q, ep);
    r.tier = r.misses.length || (narrow && !isPreferred(r)) ? 1 : 0;
  }

  // Ties on seeders: embedded subtitles (if wanted), then dual audio for anime.
  const extra = (r: Release) => (prefs.anime.preferEmbeddedSubs && r.hasSubs ? 2 : 0) + (r.audioKind === 'dual' ? 1 : 0);
  return {
    releases: pool.sort((a, b) => a.tier - b.tier || b.score - a.score || b.seeders - a.seeders || extra(b) - extra(a)).slice(0, 80),
    noDub,
  };
}
