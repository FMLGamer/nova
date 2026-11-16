import { integration } from './integrations.js';
import { HttpError } from '../lib/http.js';

const BASE = 'https://api.opensubtitles.com/api/v1';
const UA = 'Nova v2';

let tokenCache: { token: string; expires: number } | null = null;

export function subtitlesConfigured(): boolean {
  return Boolean(integration('openSubtitlesApiKey'));
}

async function osFetch(path: string, init: RequestInit = {}, auth = false): Promise<Response> {
  const apiKey = integration('openSubtitlesApiKey');
  if (!apiKey) throw new HttpError(503, 'Subtitles are not configured');
  const headers: Record<string, string> = {
    'Api-Key': apiKey,
    'User-Agent': UA,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (auth) headers.Authorization = `Bearer ${await getToken()}`;
  return fetch(`${BASE}${path}`, { ...init, headers, signal: AbortSignal.timeout(15000) });
}

async function getToken(): Promise<string> {
  if (tokenCache && tokenCache.expires > Date.now()) return tokenCache.token;
  const username = integration('openSubtitlesUsername');
  const password = integration('openSubtitlesPassword');
  if (!username || !password) {
    throw new HttpError(503, 'Subtitle downloads need OpenSubtitles credentials');
  }
  const res = await osFetch('/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new HttpError(502, 'OpenSubtitles login failed');
  const data = (await res.json()) as { token: string };
  tokenCache = { token: data.token, expires: Date.now() + 20 * 60 * 60 * 1000 };
  return data.token;
}

export interface SubtitleOption {
  fileId: number;
  language: string;
  release: string;
  /** How confident we are that this file belongs to the requested episode. */
  match: 'exact' | 'likely';
}

interface OsSearchResponse {
  data?: {
    attributes?: {
      language?: string;
      release?: string;
      download_count?: number;
      feature_details?: {
        feature_type?: string;
        imdb_id?: number;
        parent_imdb_id?: number;
        season_number?: number;
        episode_number?: number;
        title?: string;
        movie_name?: string;
        parent_title?: string;
      };
      files?: { file_id: number }[];
    };
  }[];
}

/** Loose title key: lowercase alphanumerics only, season/part markers removed. */
function titleKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(season|part|cour)\s*\d+\b/g, ' ')
    .replace(/\b(s\d{1,2}e\d{1,3})\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function titlesAgree(a: string, b: string): boolean {
  const ka = titleKey(a);
  const kb = titleKey(b);
  if (!ka || !kb) return false;
  if (ka === kb || ka.includes(kb) || kb.includes(ka)) return true;
  const ta = new Set(ka.split(' ').filter((w) => w.length > 2));
  const tb = new Set(kb.split(' ').filter((w) => w.length > 2));
  if (!ta.size || !tb.size) return false;
  let hit = 0;
  for (const w of ta) if (tb.has(w)) hit++;
  return hit / Math.min(ta.size, tb.size) >= 0.7;
}

export async function searchSubtitles(opts: {
  imdbId?: string;
  query?: string;
  season?: number;
  episode?: number;
  languages?: string;
  /** 'episode' switches to parent_imdb_id + season/episode lookup. */
  kind?: 'movie' | 'episode';
}): Promise<SubtitleOption[]> {
  const imdbNum = opts.imdbId ? Number(opts.imdbId.replace(/^tt/, '')) : null;
  const isEpisode = opts.kind === 'episode' || opts.episode != null;

  const params = new URLSearchParams();
  if (imdbNum && isEpisode) {
    // The IMDb id we hold is the series', so it is the *parent* of the episode.
    params.set('parent_imdb_id', String(imdbNum));
  } else if (imdbNum) {
    params.set('imdb_id', String(imdbNum));
  } else if (opts.query) {
    params.set('query', opts.query);
  }
  if (opts.season) params.set('season_number', String(opts.season));
  if (opts.episode) params.set('episode_number', String(opts.episode));
  params.set('languages', opts.languages || 'en');
  params.set('order_by', 'download_count');
  params.set('order_direction', 'desc');

  const res = await osFetch(`/subtitles?${params.toString()}`);
  if (!res.ok) throw new HttpError(502, 'Subtitle search failed');
  const data = (await res.json()) as OsSearchResponse;

  // OpenSubtitles' query search is noisy: it happily returns other shows and
  // other episodes. Every result must positively prove it belongs to what was
  // asked for — anything that cannot is dropped rather than shown.
  const exact: SubtitleOption[] = [];
  const likely: SubtitleOption[] = [];
  const seenFile = new Set<number>();
  const seenRelease = new Set<string>();

  for (const item of data.data ?? []) {
    const a = item.attributes;
    const file = a?.files?.[0];
    if (!file || seenFile.has(file.file_id)) continue;
    const fd = a?.feature_details;

    // Without feature details we cannot verify anything — skip it.
    if (!fd) continue;

    // Episode/season must match exactly whenever we know what we want.
    if (opts.episode != null && fd.episode_number != null && fd.episode_number !== opts.episode) continue;
    if (opts.season != null && fd.season_number != null && fd.season_number !== opts.season) continue;
    // An episode request must not return a whole-season or movie entry.
    if (isEpisode && opts.episode != null && fd.episode_number == null) continue;

    const idHit = imdbNum != null && (fd.imdb_id === imdbNum || fd.parent_imdb_id === imdbNum);
    const names = [fd.parent_title, fd.title, fd.movie_name].filter(Boolean) as string[];
    const nameHit = opts.query ? names.some((n) => titlesAgree(n, opts.query!)) : false;

    // With an IMDb id we demand an id match; otherwise the title must agree.
    if (imdbNum != null) {
      if (!idHit && !nameHit) continue;
    } else if (!nameHit) {
      continue;
    }

    const release = (a?.release ?? '').trim();
    const dedupeKey = `${a?.language ?? ''}|${release.toLowerCase()}`;
    if (release && seenRelease.has(dedupeKey)) continue;
    seenFile.add(file.file_id);
    if (release) seenRelease.add(dedupeKey);

    const option: SubtitleOption = {
      fileId: file.file_id,
      language: a?.language ?? 'en',
      release: release || fd.movie_name || fd.title || 'Subtitle',
      match: idHit || (nameHit && opts.episode == null) ? 'exact' : 'likely',
    };
    (option.match === 'exact' ? exact : likely).push(option);
    if (exact.length >= 15) break;
  }

  // Verified matches first; a few fuzzy ones only if we found little.
  return [...exact, ...likely].slice(0, 15);
}

function srtToVtt(srt: string): string {
  const body = srt
    .replace(/^\uFEFF/, '')
    .replace(/\r+/g, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body}`;
}

export async function downloadSubtitleVtt(fileId: number): Promise<string> {
  const res = await osFetch('/download', { method: 'POST', body: JSON.stringify({ file_id: fileId }) }, true);
  if (!res.ok) throw new HttpError(502, 'Subtitle download failed');
  const data = (await res.json()) as { link?: string };
  if (!data.link) throw new HttpError(502, 'No subtitle link returned');

  const fileRes = await fetch(data.link, { signal: AbortSignal.timeout(15000) });
  if (!fileRes.ok) throw new HttpError(502, 'Subtitle file fetch failed');
  return srtToVtt(await fileRes.text());
}
