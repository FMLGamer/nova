/**
 * Anime tracking with AniList and MyAnimeList: each profile connects its own account (one or both),
 * watched episodes are written to its lists, and status, score and progress can be changed from the
 * title page. Also reads the lists back (Library, schedule filter) and the episode discussion threads.
 */
import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { cached, forget } from '../lib/cache.js';
import { seal, signToken, unseal, verifyToken } from '../lib/crypto.js';
import { HttpError } from '../lib/http.js';
import { detailFor } from './catalog.js';
import { integration } from './integrations.js';
import { readDetail } from './readCatalog.js';

export type TrackerService = 'anilist' | 'mal';
/** One vocabulary for both sites. */
export type TrackStatus = 'watching' | 'rewatching' | 'completed' | 'planning' | 'paused' | 'dropped';

export interface TrackEntry {
  status: TrackStatus | null;
  progress: number;
  /** 0-10 in steps of 0.5; null = not scored. */
  score: number | null;
  url: string;
}

export interface TrackPatch {
  status?: TrackStatus;
  progress?: number;
  score?: number | null;
}

interface AccountRow {
  profile_id: string;
  service: TrackerService;
  token: string;
  refresh_token: string | null;
  expires_at: number | null;
  user_id: string | null;
  user_name: string | null;
  avatar: string | null;
}

const ANILIST = 'https://graphql.anilist.co';
const MAL_API = 'https://api.myanimelist.net/v2';
const MAL_OAUTH = 'https://myanimelist.net/v1/oauth2';

function account(profileId: string, service: TrackerService): AccountRow | null {
  return (db.prepare('SELECT * FROM tracker_accounts WHERE profile_id = ? AND service = ?').get(profileId, service) as AccountRow | undefined) ?? null;
}

function saveAccount(profileId: string, service: TrackerService, a: { token: string; refresh?: string | null; expiresAt?: number | null; userId: string; name: string; avatar: string | null }): void {
  db.prepare(
    `INSERT INTO tracker_accounts (profile_id, service, token, refresh_token, expires_at, user_id, user_name, avatar) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, service) DO UPDATE SET token = excluded.token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at,
       user_id = excluded.user_id, user_name = excluded.user_name, avatar = excluded.avatar`,
  ).run(profileId, service, seal(a.token), a.refresh ? seal(a.refresh) : null, a.expiresAt ?? null, a.userId, a.name, a.avatar);
}

export function disconnect(profileId: string, service: TrackerService): void {
  db.prepare('DELETE FROM tracker_accounts WHERE profile_id = ? AND service = ?').run(profileId, service);
}

export function trackerStatus(profileId: string) {
  const view = (s: TrackerService) => {
    const a = account(profileId, s);
    return a ? { connected: true, user: a.user_name, avatar: a.avatar, expiresAt: a.expires_at } : { connected: false, user: null, avatar: null, expiresAt: null };
  };
  return {
    anilist: { ...view('anilist'), clientId: integration('anilistClientId') || null },
    mal: { ...view('mal'), configured: Boolean(integration('malClientId')) },
  };
}

async function request<T>(url: string, init: RequestInit, what: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(12_000) });
  } catch {
    throw new HttpError(502, `${what} could not be reached`);
  }
  if (res.status === 401) throw new HttpError(401, `${what} rejected the sign-in; connect the account again in Settings → Tracking`);
  if (!res.ok) throw new HttpError(502, `${what} answered ${res.status}`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------- AniList

async function anilistGql<T>(query: string, variables: Record<string, unknown>, token?: string): Promise<T> {
  const r = await request<{ data: T; errors?: { message: string }[] }>(
    ANILIST,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ query, variables }),
    },
    'AniList',
  );
  if (r.errors?.length) throw new HttpError(502, `AniList: ${r.errors[0]!.message}`);
  return r.data;
}

/** AniList hands out year-long tokens (no refresh); the expiry is inside the JWT. */
function jwtExpiry(token: string): number | null {
  try {
    const exp = (JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number }).exp;
    return typeof exp === 'number' ? exp : null;
  } catch {
    return null;
  }
}

export function anilistAuthorizeUrl(): string | null {
  const id = integration('anilistClientId');
  return id ? `https://anilist.co/api/v2/oauth/authorize?client_id=${encodeURIComponent(id)}&response_type=token` : null;
}

export async function connectAnilist(profileId: string, token: string): Promise<void> {
  const t = token.trim().replace(/^Bearer\s+/i, '');
  const { Viewer } = await anilistGql<{ Viewer: { id: number; name: string; avatar: { medium: string | null } | null } }>(
    'query { Viewer { id name avatar { medium } } }',
    {},
    t,
  ).catch((err: unknown) => {
    if (err instanceof HttpError && /could not be reached/.test(err.message)) throw err;
    throw new HttpError(400, "AniList didn't accept that token. Copy the whole token from AniList's page and try again.");
  });
  saveAccount(profileId, 'anilist', { token: t, expiresAt: jwtExpiry(t), userId: String(Viewer.id), name: Viewer.name, avatar: Viewer.avatar?.medium ?? null });
}

const ANI_STATUS: Record<TrackStatus, string> = { watching: 'CURRENT', rewatching: 'REPEATING', completed: 'COMPLETED', planning: 'PLANNING', paused: 'PAUSED', dropped: 'DROPPED' };
const fromAni = (s: string | null | undefined): TrackStatus | null =>
  s === 'CURRENT' ? 'watching' : s === 'REPEATING' ? 'rewatching' : s === 'COMPLETED' ? 'completed' : s === 'PLANNING' ? 'planning' : s === 'PAUSED' ? 'paused' : s === 'DROPPED' ? 'dropped' : null;

type Kind = 'anime' | 'manga';

async function anilistEntry(token: string, anilistId: number, kind: Kind = 'anime'): Promise<TrackEntry & { episodes: number | null }> {
  const { Media } = await anilistGql<{ Media: { episodes: number | null; chapters: number | null; siteUrl: string; mediaListEntry: { status: string; progress: number; score: number | null } | null } }>(
    `query ($id: Int) { Media(id: $id, type: ${kind === 'anime' ? 'ANIME' : 'MANGA'}) { episodes chapters siteUrl mediaListEntry { status progress score(format: POINT_10_DECIMAL) } } }`,
    { id: anilistId },
    token,
  );
  const e = Media.mediaListEntry;
  return { status: fromAni(e?.status), progress: e?.progress ?? 0, score: e?.score || null, url: Media.siteUrl, episodes: kind === 'anime' ? Media.episodes : Media.chapters };
}

async function anilistSave(token: string, anilistId: number, patch: TrackPatch): Promise<void> {
  await anilistGql(
    'mutation ($mediaId: Int, $status: MediaListStatus, $progress: Int, $scoreRaw: Int) { SaveMediaListEntry(mediaId: $mediaId, status: $status, progress: $progress, scoreRaw: $scoreRaw) { id } }',
    {
      mediaId: anilistId,
      status: patch.status ? ANI_STATUS[patch.status] : undefined,
      progress: patch.progress,
      // scoreRaw is out of 100 whatever score format the user picked on AniList.
      scoreRaw: patch.score === undefined ? undefined : Math.round((patch.score ?? 0) * 10),
    },
    token,
  );
}

// ---------------------------------------------------------------- MyAnimeList

function malCredentials(): { id: string; secret: string } {
  const id = integration('malClientId');
  if (!id) throw new HttpError(409, 'MyAnimeList is not set up on this server yet (Server → Overview → Integrations)');
  return { id, secret: integration('malClientSecret') };
}

/** Starts the OAuth sign-in. PKCE \"plain\": MyAnimeList supports nothing else. */
export function malAuthorizeUrl(profileId: string, redirectUri: string): string {
  const { id } = malCredentials();
  const verifier = crypto.randomBytes(48).toString('base64url');
  const state = signToken({ p: profileId, v: verifier, r: redirectUri }, 15 * 60);
  const q = new URLSearchParams({ response_type: 'code', client_id: id, state, redirect_uri: redirectUri, code_challenge: verifier, code_challenge_method: 'plain' });
  return `${MAL_OAUTH}/authorize?${q}`;
}

async function malTokens(form: Record<string, string>): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const { id, secret } = malCredentials();
  return request(
    `${MAL_OAUTH}/token`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: id, ...(secret ? { client_secret: secret } : {}), ...form }) },
    'MyAnimeList',
  );
}

export async function malCallback(code: string, state: string): Promise<void> {
  const s = verifyToken<{ p: string; v: string; r: string }>(state);
  if (!s) throw new HttpError(400, 'This sign-in link expired; start again from Nova');
  const t = await malTokens({ grant_type: 'authorization_code', code, code_verifier: s.v, redirect_uri: s.r });
  const me = await request<{ id: number; name: string; picture?: string }>(`${MAL_API}/users/@me`, { headers: { Authorization: `Bearer ${t.access_token}` } }, 'MyAnimeList');
  saveAccount(s.p, 'mal', {
    token: t.access_token,
    refresh: t.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + t.expires_in,
    userId: String(me.id),
    name: me.name,
    avatar: me.picture ?? null,
  });
}

/** MyAnimeList tokens last a month; renew a day early. */
async function malAccessToken(a: AccountRow): Promise<string> {
  if (!a.expires_at || a.expires_at - Date.now() / 1000 > 86_400) return unseal(a.token);
  const t = await malTokens({ grant_type: 'refresh_token', refresh_token: unseal(a.refresh_token) });
  db.prepare('UPDATE tracker_accounts SET token = ?, refresh_token = ?, expires_at = ? WHERE profile_id = ? AND service = ?').run(
    seal(t.access_token),
    seal(t.refresh_token),
    Math.floor(Date.now() / 1000) + t.expires_in,
    a.profile_id,
    'mal',
  );
  return t.access_token;
}

const MAL_STATUS: Record<TrackStatus, string> = { watching: 'watching', rewatching: 'watching', completed: 'completed', planning: 'plan_to_watch', paused: 'on_hold', dropped: 'dropped' };
/** MyAnimeList's manga lists say "reading" where anime lists say "watching". */
const MAL_MANGA_STATUS: Record<TrackStatus, string> = { watching: 'reading', rewatching: 'reading', completed: 'completed', planning: 'plan_to_read', paused: 'on_hold', dropped: 'dropped' };
const fromMal = (s: string | undefined, rewatching?: boolean): TrackStatus | null =>
  rewatching
    ? 'rewatching'
    : s === 'watching' || s === 'reading'
      ? 'watching'
      : s === 'completed'
        ? 'completed'
        : s === 'plan_to_watch' || s === 'plan_to_read'
          ? 'planning'
          : s === 'on_hold'
            ? 'paused'
            : s === 'dropped'
              ? 'dropped'
              : null;

async function malEntry(token: string, malId: number, kind: Kind = 'anime'): Promise<TrackEntry & { episodes: number | null }> {
  type Status = { status?: string; num_episodes_watched?: number; num_chapters_read?: number; score?: number; is_rewatching?: boolean; is_rereading?: boolean };
  const r = await request<{ num_episodes?: number; num_chapters?: number; my_list_status?: Status }>(
    `${MAL_API}/${kind}/${malId}?fields=${kind === 'anime' ? 'num_episodes' : 'num_chapters'},my_list_status`,
    { headers: { Authorization: `Bearer ${token}` } },
    'MyAnimeList',
  );
  const e = r.my_list_status;
  return {
    status: fromMal(e?.status, e?.is_rewatching || e?.is_rereading),
    progress: (kind === 'anime' ? e?.num_episodes_watched : e?.num_chapters_read) ?? 0,
    score: e?.score || null,
    url: `https://myanimelist.net/${kind}/${malId}`,
    episodes: (kind === 'anime' ? r.num_episodes : r.num_chapters) || null,
  };
}

async function malSave(token: string, malId: number, patch: TrackPatch, kind: Kind = 'anime'): Promise<void> {
  const body = new URLSearchParams();
  if (patch.status) {
    body.set('status', (kind === 'anime' ? MAL_STATUS : MAL_MANGA_STATUS)[patch.status]);
    body.set(kind === 'anime' ? 'is_rewatching' : 'is_rereading', String(patch.status === 'rewatching'));
  }
  if (patch.progress != null) body.set(kind === 'anime' ? 'num_watched_episodes' : 'num_chapters_read', String(patch.progress));
  // MyAnimeList only has whole scores.
  if (patch.score !== undefined) body.set('score', String(Math.round(patch.score ?? 0)));
  await request(`${MAL_API}/${kind}/${malId}/my_list_status`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body }, 'MyAnimeList');
}

// ---------------------------------------------------------------- entries

async function ids(mediaId: string): Promise<{ kind: Kind; anilist: number; mal: number | null }> {
  const m = /^(anime|manga):(\d+)$/.exec(mediaId);
  if (!m) throw new HttpError(400, 'Only anime and manga can be tracked');
  const kind = m[1] as Kind;
  const detail = kind === 'anime' ? await detailFor(mediaId).catch(() => null) : await readDetail('manga', m[2]!).catch(() => null);
  return { kind, anilist: Number(m[2]), mal: detail?.malId ?? null };
}

export async function getEntries(profileId: string, mediaId: string): Promise<{ anilist?: TrackEntry | null; mal?: TrackEntry | null; episodes: number | null }> {
  const id = await ids(mediaId);
  const out: { anilist?: TrackEntry | null; mal?: TrackEntry | null; episodes: number | null } = { episodes: null };
  const ani = account(profileId, 'anilist');
  const mal = account(profileId, 'mal');
  await Promise.all([
    ani &&
      anilistEntry(unseal(ani.token), id.anilist, id.kind).then(({ episodes, ...e }) => {
        out.anilist = e;
        out.episodes ??= episodes;
      }),
    mal &&
      (id.mal
        ? malAccessToken(mal)
            .then((t) => malEntry(t, id.mal!, id.kind))
            .then(({ episodes, ...e }) => {
              out.mal = e;
              out.episodes ??= episodes;
            })
        : (out.mal = null)),
  ]);
  return out;
}

export async function setEntries(profileId: string, mediaId: string, patch: TrackPatch): Promise<void> {
  const id = await ids(mediaId);
  const ani = account(profileId, 'anilist');
  const mal = account(profileId, 'mal');
  if (!ani && !mal) throw new HttpError(409, 'Connect AniList or MyAnimeList in Settings → Tracking first');
  await Promise.all([ani && anilistSave(unseal(ani.token), id.anilist, patch), mal && id.mal && malAccessToken(mal).then((t) => malSave(t, id.mal!, patch, id.kind))]);
  forget(`lists:${profileId}:${id.kind}`);
}

const pushed = new Map<string, number>();
const started = new Set<string>();

/** Both lists, each moved with `step` (which gets the current entry and returns the change, if any). */
async function updateBoth(profileId: string, mediaId: string, step: (e: TrackEntry & { episodes: number | null }) => TrackPatch | null): Promise<void> {
  const ani = account(profileId, 'anilist');
  const mal = account(profileId, 'mal');
  if (!ani && !mal) return;
  const id = await ids(mediaId);
  const jobs: Promise<void>[] = [];
  if (ani) {
    const token = unseal(ani.token);
    jobs.push(
      anilistEntry(token, id.anilist, id.kind).then(async (e) => {
        const p = step(e);
        if (p) await anilistSave(token, id.anilist, p);
      }),
    );
  }
  if (mal && id.mal) {
    jobs.push(
      malAccessToken(mal).then(async (token) => {
        const e = await malEntry(token, id.mal!, id.kind);
        const p = step(e);
        if (p) await malSave(token, id.mal!, p, id.kind);
      }),
    );
  }
  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === 'rejected') console.error('[trackers] update failed:', r.reason instanceof Error ? r.reason.message : r.reason);
  forget(`lists:${profileId}:${id.kind}`);
}

/** Starting a show you haven't listed (or only planned) puts it on "Watching". */
export async function trackStarted(profileId: string, mediaId: string): Promise<void> {
  const key = `${profileId}:${mediaId}`;
  if (!/^anime:\d+$/.test(mediaId) || started.has(key)) return;
  started.add(key);
  await updateBoth(profileId, mediaId, (e) => (e.status === null || e.status === 'planning' ? { status: 'watching' } : null));
}

/** A watched episode (or read chapter) moves the list forward; going back to an earlier one changes nothing. */
export async function trackWatched(profileId: string, mediaId: string, episode: number): Promise<void> {
  if (!/^(anime|manga):\d+$/.test(mediaId)) return;
  const key = `${profileId}:${mediaId}`;
  if ((pushed.get(key) ?? 0) >= episode) return;
  pushed.set(key, episode);
  await updateBoth(profileId, mediaId, (e) => {
    if (e.progress >= episode && e.status !== 'planning' && e.status !== null) return null;
    const done = e.episodes != null && episode >= e.episodes;
    return { progress: Math.max(e.progress, episode), status: done ? 'completed' : e.status === 'rewatching' ? 'rewatching' : 'watching' };
  });
}

// ---------------------------------------------------------------- lists

export interface TrackedShow {
  mediaId: string;
  title: string;
  poster: string | null;
  status: TrackStatus;
  progress: number;
  episodes: number | null;
  score: number | null;
  /** Which of the connected sites list it. */
  sites: TrackerService[];
  updatedAt: number;
}

type AniListEntry = {
  status: string;
  progress: number;
  score: number;
  updatedAt: number;
  media: { id: number; episodes: number | null; title: { userPreferred: string }; coverImage: { large: string | null } };
};

async function anilistLists(a: AccountRow, kind: Kind): Promise<TrackedShow[]> {
  const { MediaListCollection } = await anilistGql<{ MediaListCollection: { lists: { isCustomList: boolean; entries: AniListEntry[] }[] } }>(
    `query ($userId: Int) { MediaListCollection(userId: $userId, type: ${kind === 'manga' ? 'MANGA' : 'ANIME'}) { lists { isCustomList entries {
      status progress score(format: POINT_10_DECIMAL) updatedAt media { id episodes: ${kind === 'manga' ? 'chapters' : 'episodes'} title { userPreferred } coverImage { large } } } } } }`,
    { userId: Number(a.user_id) },
    unseal(a.token),
  );
  return MediaListCollection.lists
    .filter((l) => !l.isCustomList)
    .flatMap((l) => l.entries)
    .map((e) => ({
      mediaId: `${kind}:${e.media.id}`,
      title: e.media.title.userPreferred,
      poster: e.media.coverImage.large,
      status: fromAni(e.status) ?? 'planning',
      progress: e.progress ?? 0,
      episodes: e.media.episodes,
      score: e.score || null,
      sites: ['anilist' as const],
      updatedAt: e.updatedAt ?? 0,
    }));
}

/** MyAnimeList ids -> AniList ids (Nova's anime and manga ids), 50 at a time. */
async function anilistIdsForMal(malIds: number[], kind: Kind): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (let i = 0; i < malIds.length; i += 50) {
    const { Page } = await anilistGql<{ Page: { media: { id: number; idMal: number }[] } }>(
      `query ($ids: [Int]) { Page(perPage: 50) { media(idMal_in: $ids, type: ${kind === 'manga' ? 'MANGA' : 'ANIME'}) { id idMal } } }`,
      { ids: malIds.slice(i, i + 50) },
    );
    for (const m of Page.media) out.set(m.idMal, m.id);
  }
  return out;
}

async function malLists(a: AccountRow, kind: Kind): Promise<TrackedShow[]> {
  const token = await malAccessToken(a);
  type Row = {
    node: { id: number; title: string; main_picture?: { large?: string; medium?: string }; num_episodes?: number; num_chapters?: number };
    list_status: { status: string; num_episodes_watched?: number; num_chapters_read?: number; score: number; is_rewatching?: boolean; is_rereading?: boolean; updated_at: string };
  };
  const rows: Row[] = [];
  let url: string | undefined =
    kind === 'manga' ? `${MAL_API}/users/@me/mangalist?fields=list_status,num_chapters&limit=1000&nsfw=true` : `${MAL_API}/users/@me/animelist?fields=list_status,num_episodes&limit=1000&nsfw=true`;
  for (let page = 0; url && page < 10; page++) {
    const r: { data: Row[]; paging?: { next?: string } } = await request(url, { headers: { Authorization: `Bearer ${token}` } }, 'MyAnimeList');
    rows.push(...r.data);
    url = r.paging?.next;
  }
  const map = await anilistIdsForMal(rows.map((r) => r.node.id), kind);
  return rows
    .filter((r) => map.has(r.node.id))
    .map((r) => ({
      mediaId: `${kind}:${map.get(r.node.id)}`,
      title: r.node.title,
      poster: r.node.main_picture?.large ?? r.node.main_picture?.medium ?? null,
      status: fromMal(r.list_status.status, Boolean(r.list_status.is_rewatching || r.list_status.is_rereading)) ?? 'planning',
      progress: (kind === 'manga' ? r.list_status.num_chapters_read : r.list_status.num_episodes_watched) ?? 0,
      episodes: (kind === 'manga' ? r.node.num_chapters : r.node.num_episodes) || null,
      score: r.list_status.score || null,
      sites: ['mal' as const],
      updatedAt: Math.floor(Date.parse(r.list_status.updated_at) / 1000) || 0,
    }));
}

/** Everything on the profile's connected anime (or manga) lists, AniList first where both have a title. */
export function trackedLists(profileId: string, kind: Kind = 'anime'): Promise<TrackedShow[]> {
  return cached(`lists:${profileId}:${kind}`, 2 * 60_000, async () => {
    const ani = account(profileId, 'anilist');
    const mal = account(profileId, 'mal');
    const [a, m] = await Promise.allSettled([ani ? anilistLists(ani, kind) : Promise.resolve([]), mal ? malLists(mal, kind) : Promise.resolve([])]);
    if (a.status === 'rejected' && m.status === 'rejected') throw a.reason;
    const byId = new Map<string, TrackedShow>();
    for (const s of a.status === 'fulfilled' ? a.value : []) byId.set(s.mediaId, s);
    for (const s of m.status === 'fulfilled' ? m.value : []) {
      const have = byId.get(s.mediaId);
      if (have) have.sites.push('mal');
      else byId.set(s.mediaId, s);
    }
    return [...byId.values()].sort((x, y) => y.updatedAt - x.updatedAt);
  });
}

// ---------------------------------------------------------------- episode discussions

export interface Discussion {
  site: 'AniList' | 'MyAnimeList';
  title: string;
  url: string;
  comments: number | null;
  /** Set when Nova can show the thread itself. */
  embed: { site: 'anilist' | 'mal'; id: number } | null;
}

/** "Episode 5 Discussion" or "Episodes 1-4 Discussion" covering episode n. */
function covers(title: string, n: number): boolean {
  const m = /\bepisodes?\s*(\d+)(?:\s*[-\u2013~]\s*(\d+))?/i.exec(title);
  if (!m) return false;
  const from = Number(m[1]);
  return n >= from && n <= Number(m[2] ?? from);
}

/** AniList's thread search ignores titles, so read the show's threads (oldest first). */
function anilistThreads(anilistId: number): Promise<{ id: number; title: string; siteUrl: string; replyCount: number }[]> {
  return cached(`threads:${anilistId}`, 60 * 60_000, async () => {
    const out: { id: number; title: string; siteUrl: string; replyCount: number }[] = [];
    for (let page = 1; page <= 4; page++) {
      const { Page } = await anilistGql<{ Page: { pageInfo: { hasNextPage: boolean }; threads: { id: number; title: string; siteUrl: string; replyCount: number }[] } }>(
        'query ($id: Int, $page: Int) { Page(page: $page, perPage: 50) { pageInfo { hasNextPage } threads(mediaCategoryId: $id, sort: ID) { id title siteUrl replyCount } } }',
        { id: anilistId, page },
      );
      out.push(...Page.threads);
      if (!Page.pageInfo.hasNextPage) break;
    }
    return out;
  });
}

const topicId = (url: string) => Number(/topicid=(\d+)/.exec(url)?.[1]) || null;

async function malThread(malId: number, title: string, n: number): Promise<Discussion> {
  const clientId = integration('malClientId');
  // Reading a topic inside Nova needs MyAnimeList's API (a client ID); otherwise it opens on the site.
  const embed = (url: string) => (clientId && topicId(url) ? { site: 'mal' as const, id: topicId(url)! } : null);
  try {
    const r = await fetch(`https://api.jikan.moe/v4/anime/${malId}/forum?filter=episode`, { signal: AbortSignal.timeout(6000) });
    const t = r.ok ? ((await r.json()) as { data: { title: string; url: string; comments: number }[] }).data.find((x) => covers(x.title, n)) : undefined;
    if (t) return { site: 'MyAnimeList', title: t.title, url: t.url, comments: t.comments, embed: embed(t.url) };
  } catch {
    /* Jikan is a volunteer mirror and sometimes down */
  }
  if (clientId) {
    try {
      const q = new URLSearchParams({ q: `${title} Episode ${n} Discussion`, limit: '10' });
      const r = await request<{ data: { id: number; title: string; number_of_posts: number }[] }>(`${MAL_API}/forum/topics?${q}`, { headers: { 'X-MAL-CLIENT-ID': clientId } }, 'MyAnimeList');
      const t = r.data.find((x) => covers(x.title, n));
      if (t) return { site: 'MyAnimeList', title: t.title, url: `https://myanimelist.net/forum/?topicid=${t.id}`, comments: t.number_of_posts, embed: { site: 'mal', id: t.id } };
    } catch {
      /* fall back to the episode page */
    }
  }
  // MyAnimeList's episode page links its discussion thread.
  return { site: 'MyAnimeList', title: `Episode ${n} on MyAnimeList`, url: `https://myanimelist.net/anime/${malId}/_/episode/${n}`, comments: null, embed: null };
}

export async function discussions(mediaId: string, episode: number): Promise<Discussion[]> {
  const id = await ids(mediaId);
  const detail = await detailFor(mediaId).catch(() => null);
  return cached(`discuss:${mediaId}:${episode}`, 60 * 60_000, async () => {
    const [ani, mal] = await Promise.allSettled([anilistThreads(id.anilist), id.mal ? malThread(id.mal, detail?.title ?? '', episode) : Promise.reject(new Error('no MAL id'))]);
    const out: Discussion[] = [];
    if (ani.status === 'fulfilled') {
      const t = ani.value.find((x) => covers(x.title, episode));
      if (t) out.push({ site: 'AniList', title: t.title.trim(), url: t.siteUrl, comments: t.replyCount, embed: { site: 'anilist', id: t.id } });
    }
    if (mal.status === 'fulfilled') out.push(mal.value);
    return out;
  });
}

// ---------------------------------------------------------------- reading a thread in Nova

export interface ThreadPost {
  id: number;
  user: string;
  avatar: string | null;
  createdAt: number;
  likes: number | null;
  /** Untrusted HTML from the site: the client sanitises it before showing it. */
  html: string;
  replies: ThreadPost[];
}

export interface Thread {
  title: string;
  url: string;
  post: ThreadPost | null;
  comments: ThreadPost[];
  page: number;
  hasMore: boolean;
}

type AniComment = { id: number; comment: string; createdAt: number; likeCount: number; user?: { name?: string; avatar?: { medium?: string } } | null; childComments?: AniComment[] | null };

const aniPost = (c: AniComment, depth = 0): ThreadPost => ({
  id: c.id,
  user: c.user?.name ?? 'Someone',
  avatar: c.user?.avatar?.medium ?? null,
  createdAt: c.createdAt,
  likes: c.likeCount ?? null,
  html: c.comment ?? '',
  replies: depth < 6 ? (c.childComments ?? []).map((r) => aniPost(r, depth + 1)) : [],
});

async function anilistThread(id: number, page: number): Promise<Thread> {
  const { Thread: t, Page } = await anilistGql<{
    Thread: { title: string; body: string; createdAt: number; siteUrl: string; user: { name: string; avatar: { medium: string | null } } | null };
    Page: { pageInfo: { hasNextPage: boolean }; threadComments: AniComment[] };
  }>(
    `query ($id: Int, $page: Int) {
      Thread(id: $id) { title body(asHtml: true) createdAt siteUrl user { name avatar { medium } } }
      Page(page: $page, perPage: 25) { pageInfo { hasNextPage } threadComments(threadId: $id) { id comment(asHtml: true) createdAt likeCount user { name avatar { medium } } childComments } }
    }`,
    { id, page },
  );
  return {
    title: t.title.trim(),
    url: t.siteUrl,
    post: page === 1 ? { id, user: t.user?.name ?? 'Someone', avatar: t.user?.avatar.medium ?? null, createdAt: t.createdAt, likes: null, html: t.body ?? '', replies: [] } : null,
    comments: Page.threadComments.map((c) => aniPost(c)),
    page,
    hasMore: Page.pageInfo.hasNextPage,
  };
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** MyAnimeList posts are BBCode: the common tags become HTML, anything else stays as text. */
export function bbcode(src: string): string {
  let s = escapeHtml(src);
  const url = (u: string) => (/^https?:\/\//i.test(u) ? u.replace(/"/g, '%22') : '#');
  const rules: [RegExp, string | ((...m: string[]) => string)][] = [
    [/\[b\]([\s\S]*?)\[\/b\]/gi, '<strong>$1</strong>'],
    [/\[i\]([\s\S]*?)\[\/i\]/gi, '<em>$1</em>'],
    [/\[u\]([\s\S]*?)\[\/u\]/gi, '<u>$1</u>'],
    [/\[s\]([\s\S]*?)\[\/s\]/gi, '<s>$1</s>'],
    [/\[center\]([\s\S]*?)\[\/center\]/gi, '<center>$1</center>'],
    [/\[img(?:=[^\]]*)?\](.*?)\[\/img\]/gi, (_m, u) => `<img src="${url(u)}" alt="">`],
    [/\[url=(.*?)\]([\s\S]*?)\[\/url\]/gi, (_m, u, t) => `<a href="${url(u)}">${t}</a>`],
    [/\[url\](.*?)\[\/url\]/gi, (_m, u) => `<a href="${url(u)}">${u}</a>`],
    [/\[quote(?:=([^\]]*))?\]([\s\S]*?)\[\/quote\]/gi, (_m, who, t) => `<blockquote>${who ? `<strong>${who} said:</strong><br>` : ''}${t}</blockquote>`],
    [/\[spoiler(?:=[^\]]*)?\]([\s\S]*?)\[\/spoiler\]/gi, '<span class="markdown_spoiler"><span>$1</span></span>'],
    [/\[(?:color|size|font|justify|right|left|list|\*|yt)(?:=[^\]]*)?\]|\[\/(?:color|size|font|justify|right|left|list|yt)\]/gi, ''],
  ];
  // Nested quotes and spoilers need a few passes.
  for (let pass = 0; pass < 4; pass++) for (const [re, to] of rules) s = s.replace(re, to as string);
  return s.replace(/\r?\n/g, '<br>');
}

async function malTopic(id: number, page: number): Promise<Thread> {
  const clientId = integration('malClientId');
  if (!clientId) throw new HttpError(409, 'Reading MyAnimeList threads in Nova needs MyAnimeList set up on the server');
  const per = 50;
  const r = await request<{ data: { title: string; posts: { id: number; number: number; created_at: string; created_by: { name: string; forum_avator?: string }; body: string }[] }; paging?: { next?: string } }>(
    `${MAL_API}/forum/topic/${id}?limit=${per}&offset=${(page - 1) * per}`,
    { headers: { 'X-MAL-CLIENT-ID': clientId } },
    'MyAnimeList',
  );
  const posts = r.data.posts.map((p) => ({
    id: p.id,
    user: p.created_by?.name ?? 'Someone',
    avatar: p.created_by?.forum_avator || null,
    createdAt: Math.floor(Date.parse(p.created_at) / 1000) || 0,
    likes: null,
    html: bbcode(p.body ?? ''),
    replies: [],
  }));
  const first = page === 1 ? (posts.shift() ?? null) : null;
  return { title: r.data.title, url: `https://myanimelist.net/forum/?topicid=${id}`, post: first, comments: posts, page, hasMore: Boolean(r.paging?.next) };
}

export function thread(site: 'anilist' | 'mal', id: number, page: number): Promise<Thread> {
  return cached(`thread:${site}:${id}:${page}`, 10 * 60_000, () => (site === 'anilist' ? anilistThread(id, page) : malTopic(id, page)));
}
