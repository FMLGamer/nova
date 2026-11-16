import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';
import type { ProfileRow, ProfileDTO } from '../types.js';

/**
 * Per-profile preferences. These drive torrent filtering/sorting and the
 * anime-specific behaviour. Stored as a JSON blob and deep-merged with these
 * defaults so new keys appear automatically for existing profiles.
 */
export const DEFAULT_PREFERENCES = {
  torrent: {
    preferredQualities: ['1080p', '720p'] as string[],
    maxQuality: '1080p',
    preferredCodecs: ['h264'] as string[], // browser-friendly first
    // Audio codecs to favour. AAC/Opus/MP3 decode natively in every browser;
    // AC3/DTS/TrueHD play silently unless transcoded.
    preferredAudio: ['aac', 'opus', 'mp3'] as string[],
    // Release formats, best-first (remux | bluray | webdl | web | hdtv | dvd).
    preferredSources: ['webdl', 'bluray'] as string[],
    minSeeders: 3,
    maxSizeGb: 6,
    preferredLanguages: ['en'] as string[],
    preferRemux: false,
    hdr: false,
    indexerIds: [] as number[], // legacy (Prowlarr ids); sources are plugins now
    // Movies/shows: this indexer or source plugin is shown first; others collapse.
    preferredIndexer: '',
  },
  anime: {
    // Audio languages to accept, best-first. 'ja' alone (the default) means
    // subbed-only: English dubs are filtered out entirely.
    audioLanguages: ['ja'] as string[],
    // Rank releases that ship embedded/soft subtitles higher (never required).
    preferEmbeddedSubs: true,
    addAllToCalendar: false, // false = only "My List" anime appear on the calendar
    preferredGroups: [] as string[],
    calendarFilter: 'all' as 'all' | 'mylist' | 'watching',
    // Show every title airing that day as a list beside the carousel.
    scheduleAllTitles: false,
  },
  ui: {
    autoplayNext: true,
    autoplayPreviews: true,
    reduceMotion: false,
    autoSelectSource: false, // skip the source picker and play the top-ranked release
    alwaysShowTitles: true, // show titles on cards without hovering
    // Pick a subtitle track on playback: embedded first, then OpenSubtitles.
    autoSelectSubtitles: true,
    // Render ASS/SSA tracks exactly as authored (signs, karaoke, fonts) instead of plain text.
    styledSubtitles: true,
    subtitleLanguage: 'en',
    // Only usable when an admin enables transcoding for the account.
    transcode: false,
    transcodeHeight: 720,
    // Shows the Music and Books sections. Opt-in, and only offered when an
    // admin has enabled music/books for the account.
    musicAndBooks: false,
    subtitleStyle: {
      fontSize: 100, // percent of base size
      color: '#ffffff',
      background: 0, // 0..100 opacity of the text box
      opacity: 100, // 0..100 text opacity
      fontFamily: 'sans', // sans | serif | mono | rounded | atkinson | dyslexic
      edge: 'outline', // none | outline | shadow | raised | depressed
      position: 8, // percent from the bottom
      weight: 600,
    },
    // Second subtitle language shown above the main one (language learners).
    secondarySubtitleLanguage: '',
    // Translate subtitles into subtitleLanguage when none exist in it.
    translateSubtitles: false,
    translateProvider: 'google', // google | deepl | assistant
    playbackSpeed: 1,
    // Player enhancement chain: none | sharpen | anime4k | deband (+ custom GLSL).
    enhance: 'none',
    customShader: '',
    externalPlayer: '', // '' | vlc | mpv | iina
    skipIntroAutomatically: false,
    skipCreditsAutomatically: false,
    accent: 'nova', // nova | ember | ocean | aurora | mono
  },
  reader: {
    typeface: 'literata', // literata | atkinson | dyslexic | serif | sans
    fontSize: 110,
    lineHeight: 1.6,
    margins: 8, // percent each side
    theme: 'night', // night | sepia | paper | custom
    customBg: '#101014',
    customFg: '#e8e6e3',
    justify: true,
    comicMode: 'single', // single | double | scroll
    comicDirection: 'ltr', // ltr | rtl
    comicFit: 'height', // height | width | original
  },
  home: {
    // Section order for this profile's Home; unknown ids are ignored.
    sections: [
      'hero', 'continue', 'upnext', 'collections', 'live', 'reading', 'mylist',
      'trending', 'because', 'new', 'airing',
    ] as string[],
    hidden: [] as string[],
  },
};

export type Preferences = typeof DEFAULT_PREFERENCES;

const AVATAR_PALETTE = ['red', 'blue', 'green', 'amber', 'purple', 'teal', 'pink', 'slate'];

function pickAvatar(index: number): string {
  return AVATAR_PALETTE[index % AVATAR_PALETTE.length]!;
}

export function profileToDTO(p: ProfileRow): ProfileDTO {
  return { id: p.id, name: p.name, avatar: p.avatar, isKids: p.is_kids === 1, sortOrder: p.sort_order };
}

export function listProfiles(accountId: string): ProfileRow[] {
  return db
    .prepare('SELECT * FROM profiles WHERE account_id = ? ORDER BY sort_order, created_at')
    .all(accountId) as ProfileRow[];
}

export function getProfileForAccount(id: string, accountId: string): ProfileRow | undefined {
  return db.prepare('SELECT * FROM profiles WHERE id = ? AND account_id = ?').get(id, accountId) as
    | ProfileRow
    | undefined;
}

export function countProfiles(accountId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE account_id = ?').get(accountId) as {
    n: number;
  }).n;
}

export function createProfile(
  accountId: string,
  opts: { name: string; avatar?: string; isKids?: boolean; limit?: number },
): ProfileRow {
  const existing = countProfiles(accountId);
  // Accounts get one profile unless an admin grants extras in the dashboard.
  const limit = Math.min(config.maxProfiles, opts.limit ?? config.maxProfiles);
  if (existing >= limit) {
    throw new HttpError(
      400,
      limit === 1
        ? 'This account is limited to one profile. Ask an admin to enable multiple profiles.'
        : `Profile limit reached (${limit})`,
    );
  }
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO profiles (id, account_id, name, avatar, is_kids, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, accountId, opts.name.trim(), opts.avatar || pickAvatar(existing), opts.isKids ? 1 : 0, existing);
  db.prepare('INSERT INTO preferences (profile_id, data) VALUES (?, ?)').run(
    id,
    JSON.stringify(DEFAULT_PREFERENCES),
  );
  return db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as ProfileRow;
}

export function updateProfile(
  id: string,
  accountId: string,
  patch: { name?: string; avatar?: string; isKids?: boolean },
): ProfileRow {
  const current = getProfileForAccount(id, accountId);
  if (!current) throw new HttpError(404, 'Profile not found');
  db.prepare('UPDATE profiles SET name = ?, avatar = ?, is_kids = ? WHERE id = ?').run(
    patch.name?.trim() || current.name,
    patch.avatar || current.avatar,
    patch.isKids === undefined ? current.is_kids : patch.isKids ? 1 : 0,
    id,
  );
  return db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as ProfileRow;
}

export function deleteProfile(id: string, accountId: string): void {
  const current = getProfileForAccount(id, accountId);
  if (!current) throw new HttpError(404, 'Profile not found');
  if (countProfiles(accountId) <= 1) throw new HttpError(400, 'Cannot delete the last profile');
  db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
}

// --- Preferences ---------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge `patch` over `base` (arrays and scalars are replaced wholesale). */
function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : (patch as T));
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in base ? deepMerge((base as Record<string, unknown>)[key], value) : value;
  }
  return out as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function getPreferences(profileId: string): typeof DEFAULT_PREFERENCES {
  const row = db.prepare('SELECT data FROM preferences WHERE profile_id = ?').get(profileId) as
    | { data: string }
    | undefined;
  return deepMerge(DEFAULT_PREFERENCES, row ? safeJson(row.data) : {});
}

export function updatePreferences(profileId: string, patch: unknown): typeof DEFAULT_PREFERENCES {
  const merged = deepMerge(getPreferences(profileId), patch);
  db.prepare(
    `INSERT INTO preferences (profile_id, data, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(profile_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  ).run(profileId, JSON.stringify(merged));
  return merged;
}
