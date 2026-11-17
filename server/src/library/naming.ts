import path from 'node:path';

export type LibraryKind = 'movie' | 'tv' | 'anime' | 'book' | 'comic' | 'manga' | 'music';

export const VIDEO_EXT = /\.(mkv|mp4|m4v|webm|avi|mov|ts)$/i;
export const AUDIO_EXT = /\.(mp3|flac|m4a|m4b|aac|ogg|opus|wav)$/i;
export const BOOK_EXT = /\.(epub|pdf|mobi|azw3|txt)$/i;
export const COMIC_EXT = /\.(cbz|cbr|cb7)$/i;
export const SUB_EXT = /\.(srt|vtt|ass|ssa)$/i;

export function fileKind(name: string): 'video' | 'audio' | 'book' | 'comic' | 'subtitle' | null {
  if (VIDEO_EXT.test(name)) return 'video';
  if (AUDIO_EXT.test(name)) return 'audio';
  if (BOOK_EXT.test(name)) return 'book';
  if (COMIC_EXT.test(name)) return 'comic';
  if (SUB_EXT.test(name)) return 'subtitle';
  return null;
}

export interface ParsedName {
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  /** Fansub-style "[Group] Title - 05" naming. */
  animeStyle: boolean;
}

const NOISE =
  /\b(2160p|1080p|720p|480p|4k|uhd|hdr10?\+?|dv|dolby\s?vision|x26[45]|h\.?26[45]|hevc|avc|av1|10bit|8bit|web-?dl|web-?rip|webrip|bluray|blu-ray|bdrip|brrip|remux|hdtv|dvdrip|aac(?:2\.0)?|ac3|eac3|ddp?5?\.?1?|dts(?:-hd)?|truehd|atmos|flac|opus|proper|repack|extended|unrated|remastered|multi|dual[\s.-]?audio|subbed|dubbed|complete|internal|limited|imax)\b.*$/i;

function clean(s: string): string {
  return s
    .replace(/\[[^\]]*\]|\([^)]*\b(?:1080p|720p|x26[45]|hevc|web|bd)\b[^)]*\)/gi, ' ')
    .replace(/[._]+/g, ' ')
    .replace(NOISE, ' ')
    .replace(/\s+-\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseName(fileOrFolder: string): ParsedName {
  const base = path.basename(fileOrFolder).replace(/\.[a-z0-9]{2,4}$/i, '');
  const animeStyle = /^\[[^\]]+\]/.test(base);
  let season: number | null = null;
  let episode: number | null = null;
  let title = base;

  const sxe = base.match(/[\s._-]S(\d{1,2})[\s._-]?E(\d{1,4})/i) ?? base.match(/[\s._-](\d{1,2})x(\d{2,3})[\s._-]/i);
  if (sxe) {
    season = Number(sxe[1]);
    episode = Number(sxe[2]);
    title = base.slice(0, sxe.index);
  } else {
    const anime = base.match(/^(?:\[[^\]]+\]\s*)?(.+?)\s+-\s+(\d{1,4})(?:v\d)?(?:\s|\[|\(|$)/);
    if (anime) {
      episode = Number(anime[2]);
      title = anime[1]!;
    } else {
      const seasonOnly = base.match(/[\s._-]S(\d{1,2})(?:[\s._-]|$)/i) ?? base.match(/\bSeason[\s._-]?(\d{1,2})\b/i);
      if (seasonOnly) {
        season = Number(seasonOnly[1]);
        title = base.slice(0, seasonOnly.index);
      }
    }
  }

  const yearMatch = title.match(/[\s.(_[-]((?:19|20)\d{2})(?:[\s.)_\]-]|$)/) ?? base.match(/[\s.(_[-]((?:19|20)\d{2})(?:[\s.)_\]-]|$)/);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  if (yearMatch && title.includes(yearMatch[1]!)) title = title.slice(0, title.indexOf(yearMatch[1]!));

  title = clean(title.replace(/^\[[^\]]+\]\s*/, '').replace(/[([]\s*$/, ''));
  return { title: title || clean(base), year, season, episode, animeStyle };
}

function safe(part: string): string {
  return part.replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Where a finished download lives inside the library. */
export function organizedPath(opts: {
  kind: LibraryKind;
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  creator?: string | null;
  fileName: string;
}): string {
  const ext = path.extname(opts.fileName).toLowerCase() || '.mkv';
  const t = safe(opts.title);
  const ty = opts.year ? `${t} (${opts.year})` : t;
  switch (opts.kind) {
    case 'movie':
      return path.join('Movies', ty, `${ty}${ext}`);
    case 'tv':
      return path.join('Shows', ty, `Season ${pad(opts.season ?? 1)}`, `${t} - S${pad(opts.season ?? 1)}E${pad(opts.episode ?? 1)}${ext}`);
    case 'anime':
      return opts.episode
        ? path.join('Anime', t, `${t} - ${pad(opts.episode)}${ext}`)
        : path.join('Anime', t, `${t}${ext}`);
    case 'book':
      return path.join('Books', safe(opts.creator ?? 'Unknown'), `${t}${ext}`);
    case 'comic':
      return path.join('Comics', t, safe(path.basename(opts.fileName)));
    case 'manga':
      return path.join('Manga', t, safe(path.basename(opts.fileName)));
    case 'music':
      return path.join('Music', safe(opts.creator ?? 'Unknown'), t, safe(path.basename(opts.fileName)));
  }
}

/** Top-level library folder -> kind. */
export function kindFromPath(rel: string): LibraryKind | null {
  const top = rel.split(/[\\/]/)[0]?.toLowerCase() ?? '';
  if (/^movies?$/.test(top)) return 'movie';
  if (/^(shows?|tv|series)$/.test(top)) return 'tv';
  if (/^anime$/.test(top)) return 'anime';
  if (/^(books?|ebooks?|audiobooks?)$/.test(top)) return 'book';
  if (/^comics?$/.test(top)) return 'comic';
  if (/^manga$/.test(top)) return 'manga';
  if (/^music$/.test(top)) return 'music';
  return null;
}

export function normTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
