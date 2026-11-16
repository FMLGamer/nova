import crypto from 'node:crypto';
import type { Stream } from '../plugins/protocol.js';

/**
 * A playable release, normalised from whatever a source plugin returned
 * (Prowlarr releases, Torrentio streams, debrid links, ...). Everything the
 * ranking and the UI need is parsed out of the release name once, here.
 */
export interface Release {
  id: string;
  pluginId: string;
  pluginName: string;
  /** Other plugins that returned the same torrent. */
  alsoFrom: string[];
  title: string;
  fileName: string | null;
  infoHash: string | null;
  fileIdx: number | null;
  trackers: string[];
  url: string | null;
  headers: Record<string, string> | null;
  resolve: string | null;
  quality: string | null;
  codec: string | null;
  audio: string | null;
  source: string | null;
  hdr: boolean;
  sizeBytes: number;
  seeders: number;
  leechers: number;
  languages: string[];
  group: string | null;
  indexer: string;
  audioKind: 'dub' | 'dual' | 'sub' | null;
  hasSubs: boolean;
  cached: boolean;
  kind: 'video' | 'audio' | 'book' | 'comic';
  score: number;
  /** 0 = preferred source, 1 = everything else (shown collapsed). */
  tier: number;
}

export function parseQuality(t: string): string | null {
  if (/(?:2160p|\buhd\b|\b4k\b)/i.test(t)) return '2160p';
  if (/1080p/i.test(t)) return '1080p';
  if (/720p/i.test(t)) return '720p';
  if (/(?:480p|\bsd\b|\bdvdrip\b)/i.test(t)) return '480p';
  return null;
}

export function parseCodec(t: string): string | null {
  if (/(?:x265|h\.?265|hevc)/i.test(t)) return 'h265';
  if (/av1/i.test(t)) return 'av1';
  if (/(?:x264|h\.?264|avc)/i.test(t)) return 'h264';
  return null;
}

// Audio codecs most browsers CANNOT decode (AC3/EAC3/DTS/TrueHD) play as a
// silent track, so the codec is read from the title to rank playable audio up.
export function parseAudio(t: string): string | null {
  if (/(?:truehd|atmos|true-?hd)/i.test(t)) return 'truehd';
  if (/(?:e-?ac-?3|eac3|ddp|dd\+)/i.test(t)) return 'eac3';
  if (/(?:dts-?hd|dts-?ma|\bdts\b)/i.test(t)) return 'dts';
  if (/(?:\bac-?3\b|dolby\s?digital|\bdd\b|\bdd5)/i.test(t)) return 'ac3';
  if (/\bflac\b/i.test(t)) return 'flac';
  if (/\baac\b/i.test(t)) return 'aac';
  if (/\bopus\b/i.test(t)) return 'opus';
  if (/\bmp3\b/i.test(t)) return 'mp3';
  return null;
}

export function parseReleaseSource(t: string): string | null {
  if (/remux/i.test(t)) return 'remux';
  if (/(?:blu-?ray|bdrip|brrip)/i.test(t)) return 'bluray';
  if (/web-?dl/i.test(t)) return 'webdl';
  if (/web-?rip|\bweb\b/i.test(t)) return 'web';
  if (/hdtv/i.test(t)) return 'hdtv';
  if (/dvd/i.test(t)) return 'dvd';
  if (/\b(cam|hdcam|ts|telesync|hdts|tc)\b/i.test(t)) return 'cam';
  return null;
}

export function parseHdr(t: string): boolean {
  return /(?:hdr10\+?|\bhdr\b|dolby\s?vision|\bdv\b|\bdovi\b)/i.test(t);
}

export function parseGroup(t: string): string | null {
  const bracket = t.match(/^\[([^\]]+)\]/);
  if (bracket) return bracket[1]!;
  const m = t.replace(/\.(mkv|mp4|avi)$/i, '').match(/-([A-Za-z0-9]+)$/);
  return m ? m[1]! : null;
}

// Groups whose output is always softsubbed, plus the tags releases use to
// advertise embedded subtitles. Only a probe can confirm, so this is a hint.
const SOFTSUB_GROUPS = /\b(erai-raws|subsplease|horriblesubs|judas|ember|nandesuka|anime\s?time|asw|tsundere-raws|varyg)\b/i;
const SUB_TAGS =
  /\b(multi[\s._-]?subs?|e[\s._-]?subs?|m[\s._-]?subs?|softsubs?|soft[\s._-]?sub|subbed|subtitled|multiple[\s._-]?subtitle|w[\s._-]?subs?)\b/i;

export function parseHasSubs(t: string): boolean {
  if (SOFTSUB_GROUPS.test(t) || SUB_TAGS.test(t)) return true;
  return /\[[^\]]*\b(subs?|subtitle)\b[^\]]*\]/i.test(t);
}

export function audioKindOf(t: string): 'dub' | 'dual' | 'sub' {
  if (/\bdual[\s._-]?audio\b|\bmulti[\s._-]?audio\b/i.test(t)) return 'dual';
  if (/\b(?:dub|dubbed)\b/i.test(t) || /eng(?:lish)?[\s._-]?dub/i.test(t)) return 'dub';
  return 'sub';
}

const LANGUAGE_HINTS: [string, RegExp][] = [
  ['multi', /\bmulti\b|\bdual[\s._-]?audio\b/i],
  ['en', /\benglish\b|\beng\b/i],
  ['ja', /\bjapanese\b|\bjpn?\b/i],
  ['nl', /\bdutch\b|\bnl\b|\bnlsubs?\b/i],
  ['es', /\bspanish\b|\besp\b|castellano|latino|\bespa[nñ]ol\b/i],
  ['fr', /\bfrench\b|\bvostfr\b|\bvff\b|\btruefrench\b|\bfran[cç]ais\b/i],
  ['de', /\bgerman\b|\bger\b|\bdeutsch\b/i],
  ['it', /\bitalian\b|\bita\b|\bitaliano\b/i],
  ['pt', /\bportuguese\b|\bpt-?br\b|\bdublado\b|\bcompleto\b|\bdual\s?[\d.]+\s?pt\b/i],
  ['ru', /\brussian\b|\brus\b/i],
  ['hi', /\bhindi\b/i],
  ['ta', /\btamil\b/i],
  ['te', /\btelugu\b/i],
  ['ko', /\bkorean\b|\bkor\b/i],
  ['zh', /\bchinese\b|\bchs\b|\bcht\b|\bmandarin\b/i],
  ['pl', /\bpolish\b|\bpldub\b|\blektor\b/i],
  ['tr', /\bturkish\b/i],
];

const FLAG_LANG: Record<string, string> = {
  '🇬🇧': 'en', '🇺🇸': 'en', '🇯🇵': 'ja', '🇳🇱': 'nl', '🇪🇸': 'es', '🇲🇽': 'es', '🇫🇷': 'fr',
  '🇩🇪': 'de', '🇮🇹': 'it', '🇵🇹': 'pt', '🇧🇷': 'pt', '🇷🇺': 'ru', '🇰🇷': 'ko', '🇨🇳': 'zh',
  '🇹🇼': 'zh', '🇮🇳': 'hi', '🇵🇱': 'pl', '🇹🇷': 'tr', '🇺🇦': 'uk', '🇸🇪': 'sv', '🇳🇴': 'no',
  '🇩🇰': 'da', '🇫🇮': 'fi', '🇬🇷': 'el', '🇭🇺': 'hu', '🇨🇿': 'cs', '🇷🇴': 'ro', '🇸🇦': 'ar',
  '🇹🇭': 'th', '🇻🇳': 'vi', '🇮🇱': 'he',
};

/** Languages a release explicitly advertises; empty = nothing stated (usually the original audio). */
export function parseLanguages(t: string): string[] {
  const out = new Set(LANGUAGE_HINTS.filter(([, re]) => re.test(t)).map(([code]) => code));
  for (const [flag, code] of Object.entries(FLAG_LANG)) if (t.includes(flag)) out.add(code);
  return [...out];
}

/** Stereoscopic releases are never what a browser player wants. */
export function is3d(t: string): boolean {
  return /\b(3d|h-?sbs|half-?sbs|sbs|h-?ou|half-?ou)\b/i.test(t);
}

export type EpisodeMatch = 'exact' | 'pack' | 'unknown' | 'mismatch';

/**
 * Does a release (name + file name) contain the wanted episode? TV uses
 * SxxEyy; anime uses "- 05", "E05", "Episode 5" (absolute numbering) and
 * batch ranges. A pack is fine when the source pointed at the right file.
 */
export function episodeMatch(
  text: string,
  kind: 'tv' | 'anime',
  season: number | null,
  episode: number | null,
): EpisodeMatch {
  if (episode == null) return 'unknown';
  const t = text.replace(/[._]/g, ' ');
  if (kind === 'tv') {
    const s = season ?? 1;
    const all = [...t.matchAll(/\bS(\d{1,2})\s?E(\d{1,3})(?:\s?-?\s?E?(\d{1,3}))?\b/gi)];
    if (all.length) {
      const hit = all.some((m) => {
        const ms = Number(m[1]);
        const a = Number(m[2]);
        const b = m[3] ? Number(m[3]) : a;
        return ms === s && episode >= a && episode <= b;
      });
      return hit ? 'exact' : 'mismatch';
    }
    const x = t.match(/\b(\d{1,2})x(\d{2,3})\b/);
    if (x) return Number(x[1]) === s && Number(x[2]) === episode ? 'exact' : 'mismatch';
    const seasons = [...t.matchAll(/\b(?:S|Season\s?)(\d{1,2})\b(?!\s?E\d)/gi)].map((m) => Number(m[1]));
    const range = t.match(/\bS(\d{1,2})\s?-\s?S?(\d{1,2})\b/i);
    if (range && s >= Number(range[1]) && s <= Number(range[2])) return 'pack';
    if (seasons.length) return seasons.includes(s) ? 'pack' : 'mismatch';
    if (/\b(complete|full series|all seasons|collection|integrale)\b/i.test(t)) return 'pack';
    return 'unknown';
  }
  const ep = episode;
  const patterns = [
    new RegExp(`\\s-\\s0*${ep}(?:v\\d)?\\b`),
    new RegExp(`\\b(?:E|EP|Episode)\\s?0*${ep}\\b`, 'i'),
    new RegExp(`\\[0*${ep}(?:v\\d)?\\]`),
    new RegExp(`\\bS\\d{1,2}E0*${ep}\\b`, 'i'),
  ];
  if (patterns.some((re) => re.test(t))) return 'exact';
  const range = t.match(/\b0*(\d{1,4})\s?(?:-|~|to)\s?0*(\d{1,4})\b/);
  if (range && Number(range[2]) > Number(range[1]) && ep >= Number(range[1]) && ep <= Number(range[2])) return 'pack';
  if (/\b(batch|complete|bd ?box|collection)\b/i.test(t)) return 'pack';
  const other = t.match(/\s-\s(\d{1,4})(?:v\d)?(?:\s|\[|\(|$)|\b(?:E|EP|Episode)\s?(\d{1,4})\b/i);
  if (other) return 'mismatch';
  return 'unknown';
}

export function magnetInfoHash(magnet: string): string | null {
  const m = magnet.match(/btih:([A-Za-z0-9]{32,40})/i);
  if (!m) return null;
  const raw = m[1]!;
  if (raw.length === 40) return raw.toLowerCase();
  // base32 (32 chars) -> hex
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of raw.toUpperCase()) {
    const v = alphabet.indexOf(c);
    if (v < 0) return null;
    bits += v.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex.slice(0, 40);
}

const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://explodie.org:6969/announce',
  'wss://tracker.openwebtorrent.com',
];

export function buildMagnet(infoHash: string, name: string | null, trackers: string[]): string {
  const tr = (trackers.length ? trackers : DEFAULT_TRACKERS).slice(0, 20);
  const params = [`xt=urn:btih:${infoHash}`];
  if (name) params.push(`dn=${encodeURIComponent(name)}`);
  for (const t of tr) params.push(`tr=${encodeURIComponent(t)}`);
  return `magnet:?${params.join('&')}`;
}

function parseSize(text: string): number {
  const m = text.match(/(?:💾|size[:\s]*)\s*([\d.,]+)\s*(TB|GB|MB|KB|GiB|MiB)/i);
  if (!m) return 0;
  const n = Number(m[1]!.replace(',', '.'));
  const unit = m[2]!.toUpperCase();
  const mult = unit.startsWith('T') ? 1e12 : unit.startsWith('G') ? 1e9 : unit.startsWith('M') ? 1e6 : 1e3;
  return Math.round(n * mult);
}

function parseSeeders(text: string): number {
  const m = text.match(/(?:👤|👥|🌱|⬆️?|seeds?|seeders?|peers?)[:\s]*([\d,]+)/i);
  return m ? Number(m[1]!.replace(/,/g, '')) : 0;
}

function parseProvider(text: string): string | null {
  const m = text.match(/⚙️\s*([^\n]+)/) ?? text.match(/🔗\s*([^\n]+)/);
  return m ? m[1]!.trim() : null;
}

const FILE_RE = /\.(mkv|mp4|avi|m4v|webm|mov|ts|flac|mp3|m4a|m4b|epub|pdf|cbz|cbr)$/i;

/**
 * Turns a plugin's stream into a Release. Handles Nova-native streams (with a
 * `nova` block) and decorated Stremio ones (Torrentio-style emoji stat lines).
 */
export function normalizeStream(
  s: Stream,
  plugin: { id: string; name: string },
  mediaKind: 'video' | 'audio' | 'book' | 'comic',
): Release | null {
  const text = [s.title, s.description].filter(Boolean).join('\n');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const statLine = lines.findIndex((l) => /👤|💾|⚙️/.test(l));
  const nameLines = statLine >= 0 ? lines.slice(0, statLine) : lines.slice(0, 1);
  const release = s.nova?.release ?? nameLines[0] ?? s.behaviorHints?.filename ?? s.name ?? 'Unknown release';
  const fileName =
    s.behaviorHints?.filename ?? nameLines.find((l, i) => i > 0 && FILE_RE.test(l)) ?? (FILE_RE.test(release) ? release : null);
  const parseText = `${release} ${fileName ?? ''} ${s.name ?? ''}`;

  let infoHash = s.infoHash?.toLowerCase() ?? null;
  const magnet = s.url?.startsWith('magnet:') ? s.url : null;
  if (!infoHash && magnet) infoHash = magnetInfoHash(magnet);
  const url = s.url && !s.url.startsWith('magnet:') && /^https?:/i.test(s.url) ? s.url : null;
  if (!infoHash && !url && !s.nova?.resolve) return null;

  const trackers = (s.sources ?? [])
    .filter((x) => x.startsWith('tracker:'))
    .map((x) => x.slice('tracker:'.length));
  if (magnet) {
    for (const m of magnet.matchAll(/[?&]tr=([^&]+)/g)) trackers.push(decodeURIComponent(m[1]!));
  }

  const id = infoHash
    ? `${infoHash}:${s.fileIdx ?? ''}`
    : crypto.createHash('sha1').update(`${plugin.id}|${url ?? s.nova?.resolve ?? release}`).digest('hex');

  return {
    id,
    pluginId: plugin.id,
    pluginName: plugin.name,
    alsoFrom: [],
    title: release,
    fileName,
    infoHash,
    fileIdx: typeof s.fileIdx === 'number' ? s.fileIdx : null,
    trackers: [...new Set(trackers)],
    url,
    headers: s.behaviorHints?.proxyHeaders?.request ?? null,
    resolve: s.nova?.resolve ?? null,
    quality: parseQuality(parseText),
    codec: parseCodec(parseText),
    audio: parseAudio(parseText),
    source: parseReleaseSource(parseText),
    hdr: parseHdr(parseText),
    sizeBytes: s.nova?.size ?? s.behaviorHints?.videoSize ?? parseSize(text),
    seeders: s.nova?.seeders ?? parseSeeders(text),
    leechers: s.nova?.leechers ?? 0,
    languages: s.nova?.languages ?? parseLanguages(`${parseText} ${text}`),
    group: parseGroup(release),
    indexer: s.nova?.indexer ?? parseProvider(text) ?? plugin.name,
    audioKind: audioKindOf(`${release} ${text}`),
    hasSubs: parseHasSubs(release),
    cached: Boolean(s.nova?.cached) || /\[(RD|AD|PM|DL|TB|ED|OC|PP)\+\]/.test(s.name ?? ''),
    kind: s.nova?.kind ?? mediaKind,
    score: 0,
    tier: 0,
  };
}

/** Merges duplicates (same torrent from several plugins), keeping the healthiest stats. */
export function dedupeReleases(list: Release[]): Release[] {
  const byId = new Map<string, Release>();
  for (const r of list) {
    const key = r.infoHash ?? r.id;
    const prev = byId.get(key);
    if (!prev) {
      byId.set(key, r);
      continue;
    }
    if (r.pluginId !== prev.pluginId && !prev.alsoFrom.includes(r.pluginName)) prev.alsoFrom.push(r.pluginName);
    prev.seeders = Math.max(prev.seeders, r.seeders);
    prev.sizeBytes ||= r.sizeBytes;
    prev.fileIdx ??= r.fileIdx;
    prev.fileName ??= r.fileName;
    prev.cached ||= r.cached;
    prev.trackers = [...new Set([...prev.trackers, ...r.trackers])];
  }
  return [...byId.values()];
}
