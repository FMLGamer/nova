import type * as T from './types';

/** The active profile travels on every request as a header (and as ?profile= where headers can't). */
let activeProfileId: string | null = null;
export function setApiProfile(id: string | null): void {
  activeProfileId = id;
}
export function apiProfile(): string | null {
  return activeProfileId;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

function qs(query?: Query): string {
  if (!query) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export async function req<R>(method: string, path: string, body?: unknown, query?: Query): Promise<R> {
  // Absolute URLs are this computer's Nova engine: no cookies, no remote profile id.
  const external = /^https?:\/\//.test(path);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (activeProfileId && !external) headers['X-Profile-Id'] = activeProfileId;
  const res = await fetch(`${path}${qs(query)}`, {
    method,
    headers,
    credentials: external ? 'omit' : 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as R;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const fromBody = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : '';
    throw new ApiError(res.status, fromBody || res.statusText || 'Request failed');
  }
  return data as R;
}

const get = <R>(p: string, q?: Query) => req<R>('GET', p, undefined, q);
const post = <R>(p: string, b?: unknown, q?: Query) => req<R>('POST', p, b ?? {}, q);
const put = <R>(p: string, b?: unknown) => req<R>('PUT', p, b ?? {});
const patch = <R>(p: string, b?: unknown) => req<R>('PATCH', p, b ?? {});
const del = <R = void>(p: string, q?: Query) => req<R>('DELETE', p, undefined, q);
const enc = encodeURIComponent;

/** A URL that carries the profile as a query parameter (EventSource, WebSocket, <img>). */
export function withProfile(path: string): string {
  if (!activeProfileId) return path;
  return `${path}${path.includes('?') ? '&' : '?'}profile=${enc(activeProfileId)}`;
}

export const api = {
  system: {
    config: () => get<T.AppConfig>('/api/config'),
    update: (fresh?: boolean) => get<T.AppUpdate>(`/api/update${fresh ? '?fresh=1' : ''}`),
    pairings: () => get<{ pairings: T.EnginePairing[] }>('/api/engine-pairings').then((r) => r.pairings),
    unpair: (id: string) => del(`/api/engine-pairings/${enc(id)}`),
  },
  auth: {
    me: () => get<T.Session>('/api/auth/me'),
    login: (username: string, password: string, remember: boolean) =>
      post<T.Session>('/api/auth/login', { username, password, remember }),
    register: (username: string, password: string, inviteCode: string, remember: boolean) =>
      post<T.Session>('/api/auth/register', { username, password, inviteCode, remember }),
    logout: () => post<void>('/api/auth/logout'),
  },

  profiles: {
    list: () => get<{ profiles: T.Profile[] }>('/api/profiles').then((r) => r.profiles),
    create: (b: { name: string; avatar?: string; isKids?: boolean }) =>
      post<{ profile: T.Profile }>('/api/profiles', b).then((r) => r.profile),
    update: (id: string, b: { name?: string; avatar?: string; isKids?: boolean }) =>
      patch<{ profile: T.Profile }>(`/api/profiles/${id}`, b).then((r) => r.profile),
    remove: (id: string) => del(`/api/profiles/${id}`),
    prefs: (id: string) => get<{ preferences: T.Preferences }>(`/api/profiles/${id}/preferences`).then((r) => r.preferences),
    savePrefs: (id: string, b: T.DeepPartial<T.Preferences>) =>
      put<{ preferences: T.Preferences }>(`/api/profiles/${id}/preferences`, b).then((r) => r.preferences),
  },

  catalog: {
    home: () => get<{ rows: T.Row[] }>('/api/catalog/home').then((r) => r.rows),
    genres: (kind: 'movie' | 'tv') => get<{ genres: { id: number; name: string }[] }>(`/api/catalog/genres/${kind}`).then((r) => r.genres),
    browse: (kind: 'movies' | 'shows', q: { page: number; genre?: string; sort?: string }) =>
      get<{ items: T.CatalogItem[] }>(`/api/catalog/${kind}`, q).then((r) => r.items),
    anime: (sort: 'trending' | 'popular' | 'top' | 'seasonal') =>
      get<{ items: T.CatalogItem[] }>('/api/catalog/anime', { sort }).then((r) => r.items),
    animeGenres: () => get<{ genres: { id: string; name: string }[] }>('/api/catalog/anime/genres').then((r) => r.genres),
    animeBrowse: (q: { page: number; genre?: string; sort?: string; format?: string }) =>
      get<{ items: T.CatalogItem[] }>('/api/catalog/anime/browse', q).then((r) => r.items),
    animeRecent: () => get<{ items: T.CatalogItem[] }>('/api/catalog/anime/recent').then((r) => r.items),
    readBrowse: (q: { page: number; format?: string; genre?: string; sort?: string }) => get<{ items: T.ReadItem[] }>('/api/catalog/read/browse', q).then((r) => r.items),
    readGenres: (format: string) => get<{ genres: string[] }>('/api/catalog/read/genres', { format }).then((r) => r.genres),
    readDetail: (kind: string, id: string) => get<T.ReadDetail>(`/api/catalog/read/${enc(kind)}/${enc(id)}`),
    readFree: (title: string, author: string | null) => get<{ epub: string | null }>('/api/catalog/read/free', { title, ...(author ? { author } : {}) }).then((r) => r.epub),
    schedule: (week: number) => get<{ schedule: T.AiringEntry[] }>('/api/catalog/anime/schedule', { week }).then((r) => r.schedule),
    search: (q: string) => get<{ movies: T.CatalogItem[]; shows: T.CatalogItem[]; anime: T.CatalogItem[] }>('/api/catalog/search', { q }),
    because: (mediaId: string) => {
      const [t, id] = mediaId.split(':');
      return get<{ title: string; items: T.CatalogItem[] }>(`/api/catalog/because/${t}/${id}`);
    },
    detail: (mediaId: string) => {
      const [t, id] = mediaId.split(':');
      return get<{ detail: T.CatalogDetail }>(`/api/catalog/${t}/${id}`).then((r) => r.detail);
    },
    episodes: (mediaId: string, season: number) => {
      const [t, id] = mediaId.split(':');
      return get<{ episodes: T.Episode[] }>(`/api/catalog/${t}/${id}/episodes`, { season }).then((r) => r.episodes);
    },
    aniskip: (malId: number, episode: number) => get<T.SkipTimes>(`/api/catalog/aniskip/${malId}/${episode}`),
    subtitlesStatus: () => get<{ configured: boolean }>('/api/catalog/subtitles/status').then((r) => r.configured),
    subtitles: (q: { imdbId?: string; query?: string; season?: number; episode?: number; languages?: string; kind?: 'movie' | 'episode' }) =>
      get<{ subtitles: T.SubtitleOption[] }>('/api/catalog/subtitles', q).then((r) => r.subtitles),
    subtitleUrl: (fileId: number) => `/api/catalog/subtitles/file/${fileId}`,
    pluginSubtitles: (q: { mediaId: string; season?: number | null; episode?: number | null }) =>
      get<{ subtitles: { token: string; language: string; release: string; plugin: string }[] }>('/api/catalog/subtitles/sources', {
        mediaId: q.mediaId,
        ...(q.season != null ? { season: q.season } : {}),
        ...(q.episode != null ? { episode: q.episode } : {}),
      }).then((r) => r.subtitles),
    pluginSubtitleUrl: (token: string) => `/api/catalog/subtitles/plugin/${token}`,
    resolve: (id: string, type: string) => get<{ mediaId: string | null }>('/api/catalog/resolve', { id, type }).then((r) => r.mediaId),
  },

  progress: {
    continue: () => get<{ items: T.Progress[] }>('/api/progress').then((r) => r.items),
    summary: () => get<{ items: T.WatchedSummary[] }>('/api/progress/summary').then((r) => r.items),
    media: (mediaId: string) => get<{ items: T.Progress[] }>(`/api/progress/media/${enc(mediaId)}`).then((r) => r.items),
    get: (itemKey: string) => get<{ progress: T.Progress | null }>(`/api/progress/${enc(itemKey)}`).then((r) => r.progress),
    save: (b: Partial<T.Progress> & { itemKey: string; mediaType: string; mediaId: string; positionSeconds: number }) =>
      put<{ progress: T.Progress }>('/api/progress', b),
    remove: (itemKey: string) => del(`/api/progress/${enc(itemKey)}`),
  },

  list: {
    all: () => get<{ items: T.ListEntry[] }>('/api/list').then((r) => r.items),
    add: (b: { mediaType: string; mediaId: string; title?: string | null; poster?: string | null; year?: number | null }) =>
      post('/api/list', b),
    remove: (mediaId: string) => del(`/api/list/${enc(mediaId.split(':')[0] ?? '')}/${enc(mediaId)}`),
  },

  me: {
    stats: () => get<T.ProfileStats>('/api/me/stats'),
    recommendations: () => get<T.Recommendations>('/api/me/recommendations'),
    dismissRecommendation: (mediaId: string) => post('/api/me/recommendations/dismiss', { mediaId }),
    notifications: () => get<{ notifications: T.Notification[] }>('/api/me/notifications').then((r) => r.notifications),
    readNotifications: () => post('/api/me/notifications/read'),
    tokens: () => get<{ tokens: T.ApiToken[] }>('/api/me/tokens').then((r) => r.tokens),
    createToken: (name: string) => post<{ token: string }>('/api/me/tokens', { name }).then((r) => r.token),
    deleteToken: (id: string) => del(`/api/me/tokens/${id}`),
    upnext: () => get<{ items: T.UpNext[] }>('/api/me/upnext').then((r) => r.items),
    dismissUpNext: (itemKey: string) => post('/api/me/upnext/dismiss', { itemKey }),
    history: (offset = 0, limit = 60) => get<{ items: T.Progress[] }>('/api/me/history', { offset, limit }).then((r) => r.items),
    clearHistory: () => post('/api/me/history/clear'),
    calendar: (from: number, to: number, scope: 'followed' | 'list' | 'watching') =>
      get<{ entries: T.CalendarEntry[] }>('/api/me/calendar', { from, to, scope }).then((r) => r.entries),
    collections: () => get<{ collections: T.Collection[] }>('/api/me/collections').then((r) => r.collections),
    collection: (id: string) => get<{ collection: T.Collection }>(`/api/me/collections/${id}`).then((r) => r.collection),
    containing: (mediaId: string) => get<{ ids: string[] }>(`/api/me/collections/containing/${enc(mediaId)}`).then((r) => r.ids),
    createCollection: (b: { name: string; description?: string | null; pinned?: boolean }) =>
      post<{ collection: T.Collection }>('/api/me/collections', b).then((r) => r.collection),
    updateCollection: (id: string, b: { name?: string; description?: string | null; pinned?: boolean; sortOrder?: number }) =>
      patch<{ collection: T.Collection }>(`/api/me/collections/${id}`, b).then((r) => r.collection),
    deleteCollection: (id: string) => del(`/api/me/collections/${id}`),
    addToCollection: (id: string, b: { mediaId: string; mediaType: string; title?: string | null; poster?: string | null; year?: number | null }) =>
      post(`/api/me/collections/${id}/items`, b),
    removeFromCollection: (id: string, mediaId: string) => del(`/api/me/collections/${id}/items/${enc(mediaId)}`),
    reorderCollection: (id: string, mediaIds: string[]) => put(`/api/me/collections/${id}/order`, { mediaIds }),
    exportUrl: () => withProfile('/api/me/export'),
  },

  play: {
    sourcesUrl: (q: { mediaId: string; season?: number | null; episode?: number | null; kind?: T.SourceKind; title?: string; creator?: string; unplayable?: string }) =>
      withProfile(`/api/play/sources${qs(q)}`),
    sourcesSync: (b: { mediaId: string; season?: number | null; episode?: number | null; kind?: T.SourceKind; title?: string; creator?: string }) =>
      post<T.SourceSearch>('/api/play/sources', b),
    prepare: (b: { releaseId?: string; link?: string; torrent?: string; episode?: T.ClientTorrent['episode']; itemKey?: string | null; title?: string | null; kind?: T.SourceKind }, base = '') =>
      post<{ source: T.PlaySource; release: T.Release | null }>(`${base}/api/play/prepare`, b),
    tracks: (src: string, base = '') => get<{ tracks: T.MediaTracks }>(`${base}/api/play/tracks`, { src }).then((r) => r.tracks),
    status: (src: string, base = '') => get<{ status: T.TorrentStatus }>(`${base}/api/play/status`, { src }).then((r) => r.status),
    subtitleProgress: (src: string, track: number, base = '') =>
      get<{ progress: { progress: number; done: boolean; cues: number } | null }>(`${base}/api/play/subtitle-progress`, { src, track }).then((r) => r.progress),
    cached: () => get<{ itemKeys: string[] }>('/api/play/cached').then((r) => r.itemKeys),
    external: (b: {
      src: string;
      filename: string;
      itemKey?: string | null;
      mediaId?: string | null;
      mediaType?: string | null;
      season?: number | null;
      episode?: number | null;
      title?: string | null;
      duration?: number | null;
    }) => post<T.ExternalLinks>('/api/play/external', b),
  },

  subtitles: {
    translate: async (vtt: string, target: string, provider: string, providerId?: string) => {
      const res = await fetch('/api/subtitles/translate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vtt, target, provider, providerId }),
      });
      if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => null))?.error ?? 'Translation failed');
      return res.text();
    },
  },

  trackers: {
    status: () => get<T.TrackerStatus>('/api/trackers'),
    connectAnilist: (token: string) => post<T.TrackerStatus>('/api/trackers/anilist', { token }),
    malAuthorize: () => get<{ url: string }>('/api/trackers/mal/authorize').then((r) => r.url),
    disconnect: (service: 'anilist' | 'mal') => del(`/api/trackers/${service}`),
    entry: (mediaId: string) => get<T.TrackEntries>(`/api/trackers/entry/${enc(mediaId)}`),
    setEntry: (mediaId: string, b: { status?: T.TrackStatus; progress?: number; score?: number | null }) => put<T.TrackEntries>(`/api/trackers/entry/${enc(mediaId)}`, b),
    discussions: (mediaId: string, episode: number) =>
      get<{ discussions: T.Discussion[] }>(`/api/trackers/discussions/${enc(mediaId)}`, { episode }).then((r) => r.discussions),
    thread: (site: 'anilist' | 'mal', id: number, page = 1) => get<T.Thread>(`/api/trackers/thread/${site}/${id}`, { page }),
    lists: (kind: 'anime' | 'manga' = 'anime') => get<{ items: T.TrackedShow[] }>('/api/trackers/lists', { kind }).then((r) => r.items),
    watching: () => get<{ ids: string[] }>('/api/trackers/watching').then((r) => r.ids),
    progress: (mediaId: string, progress: number) => post<{ ok: true }>('/api/trackers/progress', { mediaId, progress }),
  },

  server: {
    status: () => get<T.LibraryStatus>('/api/server-library/status'),
    items: (q: { kind?: string; status?: string; q?: string } = {}) =>
      get<{ items: T.LibraryItem[] }>('/api/server-library/items', q).then((r) => r.items),
    item: (id: string) => get<{ item: T.LibraryItem & { files: T.LibraryFile[] } }>(`/api/server-library/items/${id}`).then((r) => r.item),
    mediaFiles: (mediaId: string) => get<{ files: T.MediaFile[] }>(`/api/server-library/media/${enc(mediaId)}`).then((r) => r.files),
    fileSource: (fileId: string) => get<{ source: T.PlaySource }>(`/api/server-library/files/${fileId}/source`).then((r) => r.source),
    editItem: (id: string, b: { title?: string | null; year?: number | null; overview?: string | null; poster?: string | null; backdrop?: string | null }) =>
      patch<{ item: T.LibraryItem }>(`/api/server-library/items/${id}`, b).then((r) => r.item),
    setPrivate: (id: string, on: boolean) => post<{ item: T.LibraryItem }>(`/api/server-library/items/${id}/private`, { on }).then((r) => r.item),
    refreshItem: (id: string) => post<{ item: T.LibraryItem }>(`/api/server-library/items/${id}/refresh`).then((r) => r.item),
    deleteItem: (id: string, files: boolean) => del(`/api/server-library/items/${id}`, { files: files ? '1' : undefined }),
    scan: () => post<{ result: { added: number; review: number; removed: number } }>('/api/server-library/scan').then((r) => r.result),
    sources: () => get<{ sources: T.LibrarySource[] }>('/api/server-library/sources').then((r) => r.sources),
    addSource: (b: { path: string; kind: T.LibrarySource['kind']; name?: string }) =>
      post<{ source: T.LibrarySource; result: { added: number } }>('/api/server-library/sources', b),
    removeSource: (id: string) => del(`/api/server-library/sources/${id}`),
    review: () => get<{ items: T.LibraryItem[] }>('/api/server-library/review').then((r) => r.items),
    candidates: (kind: string, q: string, year?: number | null) =>
      get<{ candidates: T.MatchCandidate[] }>('/api/server-library/candidates', { kind, q, year }).then((r) => r.candidates),
    match: (id: string, mediaId: string, siblings: boolean) =>
      post<{ matched: number }>(`/api/server-library/items/${id}/match`, { mediaId, siblings }).then((r) => r.matched),
    bulkMatch: (matches: { itemId: string; mediaId: string }[]) =>
      post<{ matched: number }>('/api/server-library/review/bulk', { matches }).then((r) => r.matched),
    missing: () => get<{ series: T.MissingSeries[] }>('/api/server-library/missing').then((r) => r.series),
    downloads: (all = false) => get<{ downloads: T.ServerDownload[] }>('/api/server-library/downloads', { all: all ? '1' : undefined }).then((r) => r.downloads),
    requestDownload: (releaseId: string, itemKey?: string | null, poster?: string | null) =>
      post<{ download: T.ServerDownload }>('/api/server-library/downloads', { releaseId, itemKey, poster }).then((r) => r.download),
    approve: (id: string, approve: boolean) => post(`/api/server-library/downloads/${id}/approve`, { approve }),
    retry: (id: string) => post(`/api/server-library/downloads/${id}/retry`),
    cancel: (id: string) => del(`/api/server-library/downloads/${id}`),
    rules: (all = false) => get<{ rules: T.DownloadRule[] }>('/api/server-library/rules', { all: all ? '1' : undefined }).then((r) => r.rules),
    saveRule: (b: { mediaId: string; title: string; poster?: string | null; qualityProfileId?: string | null; mode?: 'new' | 'missing'; enabled?: boolean; runNow?: boolean }) =>
      post<{ rule: T.DownloadRule; queued: number }>('/api/server-library/rules', b),
    deleteRule: (id: string) => del(`/api/server-library/rules/${id}`),
    qualityProfiles: () => get<{ profiles: T.QualityProfile[] }>('/api/server-library/quality-profiles').then((r) => r.profiles),
    saveQualityProfile: (b: Partial<T.QualityProfile> & { name: string }) =>
      post<{ profile: T.QualityProfile }>('/api/server-library/quality-profiles', b).then((r) => r.profile),
    deleteQualityProfile: (id: string) => del(`/api/server-library/quality-profiles/${id}`),
  },

  plugins: {
    contributions: () => get<T.Contributions>('/api/plugins/contributions'),
    catalog: (pluginId: string, type: string, catalogId: string, extra?: Query) =>
      get<{ metas: T.MetaPreview[] }>(`/api/plugins/${enc(pluginId)}/catalog/${enc(type)}/${enc(catalogId)}`, extra).then((r) => r.metas),
    meta: (pluginId: string, type: string, id: string) =>
      get<{ meta: T.Meta }>(`/api/plugins/${enc(pluginId)}/meta/${enc(type)}/${enc(id)}`).then((r) => r.meta),
    pages: (pluginId: string, type: string, videoId: string) =>
      get<{ pages: { url: string; width?: number; height?: number }[] }>(`/api/plugins/${enc(pluginId)}/pages/${enc(type)}/${enc(videoId)}`).then((r) => r.pages),
    page: (pluginId: string, pageId: string, params?: Query) =>
      get<{ view: T.ViewNode }>(`/api/plugins/${enc(pluginId)}/page/${enc(pageId)}`, params).then((r) => r.view),
    action: (pluginId: string, action: string, context?: Record<string, unknown>) =>
      post<{ result: { toast?: string; openUrl?: string; navigate?: string } }>(`/api/plugins/${enc(pluginId)}/action`, { action, context }).then((r) => r.result),
  },

  admin: {
    overview: () => get<T.AdminOverview>('/api/admin/overview'),
    integrations: () => get<{ integrations: Record<string, { set: boolean; fromEnv: boolean }> }>('/api/admin/integrations').then((r) => r.integrations),
    saveIntegrations: (b: Record<string, string>) => put<{ integrations: Record<string, { set: boolean; fromEnv: boolean }> }>('/api/admin/integrations', b),
    updateAccount: (id: string, b: Partial<T.AccountSettings>) =>
      patch<{ settings: T.AccountSettings }>(`/api/admin/accounts/${id}`, b).then((r) => r.settings),
    deleteAccount: (id: string) => del(`/api/admin/accounts/${id}`),
    flushAccount: (id: string) => post<{ flushed: number }>(`/api/admin/accounts/${id}/cache/flush`),
    flushAll: () => post<{ flushed: number }>('/api/admin/cache/flush'),
    backups: () => get<{ backups: T.BackupInfo[]; keep: number; hourUtc: number }>('/api/admin/backups'),
    backupNow: () => post<{ backup: T.BackupInfo }>('/api/admin/backups').then((r) => r.backup),
    backupUrl: (name: string) => `/api/admin/backups/${enc(name)}`,
    invites: () => get<{ invites: T.Invite[] }>('/api/invites').then((r) => r.invites),
    createInvite: (note?: string) => post<{ invite: { id: string; code: string } }>('/api/invites', { note }).then((r) => r.invite),
    revokeInvite: (id: string) => post(`/api/invites/${id}/revoke`),
    plugins: () => get<{ plugins: T.PluginInfo[]; sandbox: boolean }>('/api/admin/plugins'),
    registry: () => get<{ entries: T.RegistryEntry[] }>('/api/admin/plugins/registry').then((r) => r.entries),
    preview: (url: string) => post<{ preview: T.InstallPreview }>('/api/admin/plugins/preview', { url }).then((r) => r.preview),
    install: (url: string, config?: Record<string, unknown>) =>
      post<{ plugin: T.PluginInfo }>('/api/admin/plugins/install', { url, config }).then((r) => r.plugin),
    approve: (id: string) => post<{ plugin: T.PluginInfo }>(`/api/admin/plugins/${enc(id)}/approve`).then((r) => r.plugin),
    updatePlugin: (id: string, b: { enabled?: boolean; priority?: number; config?: Record<string, unknown> }) =>
      patch<{ plugin: T.PluginInfo }>(`/api/admin/plugins/${enc(id)}`, b).then((r) => r.plugin),
    checkUpdate: (id: string) => post<{ result: 'none' | 'updated' | 'needs-approval'; plugin: T.PluginInfo }>(`/api/admin/plugins/${enc(id)}/update`),
    uninstall: (id: string) => del(`/api/admin/plugins/${enc(id)}`),
    logs: (id: string) => get<{ logs: T.PluginLog[] }>(`/api/admin/plugins/${enc(id)}/logs`).then((r) => r.logs),
    test: (id: string) => post<{ ok: boolean; message: string; ms: number }>(`/api/admin/plugins/${enc(id)}/test`),
  },

  live: {
    channels: (all = false) => get<{ channels: T.Channel[] }>('/api/live/channels', { all: all ? '1' : undefined }).then((r) => r.channels),
    favorite: (id: string, on: boolean) => post(`/api/live/channels/${enc(id)}/favorite`, { on }),
    hide: (id: string, hidden: boolean) => post(`/api/live/channels/${enc(id)}/hidden`, { hidden }),
    play: (id: string) => get<T.LivePlay>(`/api/live/channels/${enc(id)}/play`),
    catchup: (id: string, start: number, stop: number) => get<T.LivePlay>(`/api/live/channels/${enc(id)}/catchup`, { start, stop }),
    guide: (from: number, to: number) => get<{ from: number; to: number; programmes: T.Programme[] }>('/api/live/guide', { from, to }),
    airings: (title: string) => get<{ airings: T.Airing[] }>('/api/live/airings', { title }).then((r) => r.airings),
    sources: () => get<{ sources: T.LiveSource[]; plugins: string[] }>('/api/live/sources'),
    addSource: (b: { kind: string; name: string; config: Record<string, string>; epgUrl?: string | null }) =>
      post<{ source: T.LiveSource }>('/api/live/sources', b).then((r) => r.source),
    updateSource: (id: string, b: { name?: string; enabled?: boolean; epgUrl?: string | null }) =>
      patch<{ source: T.LiveSource }>(`/api/live/sources/${id}`, b).then((r) => r.source),
    deleteSource: (id: string) => del(`/api/live/sources/${id}`),
    refreshSource: (id: string) => post<{ source: T.LiveSource; programmes: number }>(`/api/live/sources/${id}/refresh`),
    directory: () =>
      get<{ countries: { code: string; name: string; flag?: string }[]; categories: { id: string; name: string }[]; languages: { code: string; name: string }[] }>(
        '/api/live/directory',
      ),
    directoryList: (by: 'countries' | 'categories' | 'languages', code: string) =>
      get<{ channels: T.DirectoryChannel[] }>(`/api/live/directory/${by}/${enc(code)}`).then((r) => r.channels),
    directoryAdd: (entries: Omit<T.DirectoryChannel, 'preview' | 'number'>[]) =>
      post<{ added: number }>('/api/live/directory/add', { entries }).then((r) => r.added),
  },

  reading: {
    progress: () => get<{ items: T.ReadingProgress[] }>('/api/reading/progress').then((r) => r.items),
    get: (itemKey: string) => get<{ progress: T.ReadingProgress | null }>(`/api/reading/progress/${enc(itemKey)}`).then((r) => r.progress),
    save: (b: Omit<T.ReadingProgress, 'updatedAt' | 'title' | 'cover' | 'author' | 'locator' | 'source'> & Partial<T.ReadingProgress>) =>
      put('/api/reading/progress', b),
    remove: (itemKey: string) => del(`/api/reading/progress/${enc(itemKey)}`),
    annotations: (itemKey?: string) => get<{ annotations: T.Annotation[] }>('/api/reading/annotations', { itemKey }).then((r) => r.annotations),
    annotate: (b: { itemKey: string; kind: T.Annotation['kind']; locator: string; text?: string | null; note?: string | null; color?: string | null }) =>
      post<{ annotation: T.Annotation }>('/api/reading/annotations', b).then((r) => r.annotation),
    updateAnnotation: (id: string, b: { note?: string | null; color?: string | null }) => patch(`/api/reading/annotations/${id}`, b),
    deleteAnnotation: (id: string) => del(`/api/reading/annotations/${id}`),
  },

  media: {
    musicHome: () => get<{ rows: { id: string; title: string; items: T.Album[] }[] }>('/api/library/music/home').then((r) => r.rows),
    musicSearch: (q: string) => get<{ albums: T.Album[] }>('/api/library/music/search', { q }).then((r) => r.albums),
    artist: (id: string) => get<{ albums: T.Album[] }>(`/api/library/music/artist/${id}`).then((r) => r.albums),
    album: (id: string) => get<{ album: T.AlbumDetail }>(`/api/library/music/album/${id}`).then((r) => r.album),
    booksHome: () => get<{ rows: { id: string; title: string; items: T.Book[] }[] }>('/api/library/books/home').then((r) => r.rows),
    bookSearch: (q: string) => get<{ books: T.Book[] }>('/api/library/books/search', { q }).then((r) => r.books),
    book: (id: string) => get<{ book: T.BookDetail }>(`/api/library/books/detail/${enc(id)}`).then((r) => r.book),
    fetchUrl: (url: string) => `/api/library/fetch?url=${enc(url)}`,
  },

  rooms: {
    create: (target: T.RoomTarget) => post<{ code: string }>('/api/rooms', { target }).then((r) => r.code),
    get: (code: string) => get<{ room: T.Room }>(`/api/rooms/${code}`).then((r) => r.room),
  },

  shares: {
    list: () => get<{ shares: T.Share[] }>('/api/shares').then((r) => r.shares),
    create: (b: { scope: T.Share['scope']; target: string; label?: string | null; expiresInDays?: number | null }) =>
      post<{ id: string; url: string }>('/api/shares', b),
    revoke: (id: string) => del(`/api/shares/${id}`),
    redeem: (token: string) => post<{ share: T.Share }>('/api/share/redeem', { token }).then((r) => r.share),
    guest: () =>
      get<{ guest: null | { share: T.Share; owner: string; items: T.CatalogDetail[] } }>('/api/share/me').then((r) => r.guest),
    title: (mediaId: string) => {
      const [t, id] = mediaId.split(':');
      return get<{ detail: T.CatalogDetail }>(`/api/share/title/${t}/${id}`).then((r) => r.detail);
    },
    episodes: (mediaId: string, season: number) => {
      const [t, id] = mediaId.split(':');
      return get<{ episodes: T.Episode[] }>(`/api/share/title/${t}/${id}/episodes`, { season }).then((r) => r.episodes);
    },
    sourcesUrl: (q: { mediaId: string; season?: number | null; episode?: number | null }) => `/api/share/sources${qs(q)}`,
    prepare: (b: { releaseId?: string; fileId?: string }) => post<{ source: T.PlaySource }>('/api/share/prepare', b).then((r) => r.source),
  },

  assistant: {
    providers: () => get<{ providers: T.AssistantProvider[] }>('/api/assistant/providers').then((r) => r.providers),
    saveProvider: (b: Partial<T.AssistantProvider> & { kind: string; name: string; model: string; apiKey?: string | null }) =>
      post<{ provider: T.AssistantProvider }>('/api/assistant/providers', b).then((r) => r.provider),
    deleteProvider: (id: string) => del(`/api/assistant/providers/${id}`),
    threads: () => get<{ threads: T.AssistantThread[] }>('/api/assistant/threads').then((r) => r.threads),
    thread: (id: string) =>
      get<{
        thread: T.AssistantThread;
        messages: { role: string; content: unknown; createdAt: string; toolCalls?: { id: string; name: string; args: Record<string, unknown> }[]; name?: string }[];
        receipts: T.Receipt[];
      }>(`/api/assistant/threads/${id}`),
    deleteThread: (id: string) => del(`/api/assistant/threads/${id}`),
    receipts: () => get<{ receipts: T.Receipt[] }>('/api/assistant/receipts').then((r) => r.receipts),
    apply: (id: string) => post<{ ok: boolean; message: string }>(`/api/assistant/receipts/${id}/apply`),
    discard: (id: string) => post(`/api/assistant/receipts/${id}/discard`),
    undo: (id: string) => post(`/api/assistant/receipts/${id}/undo`),
  },
};

/** Reads a POST Server-Sent-Events response (fetch, so it can carry a body and headers). */
export async function postSse(
  path: string,
  body: unknown,
  onEvent: (event: string, data: unknown) => void,
  signal?: AbortSignal,
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (activeProfileId) headers['X-Profile-Id'] = activeProfileId;
  const res = await fetch(path, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => null);
    throw new ApiError(res.status, err?.error ?? 'Request failed');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      try {
        onEvent(event, JSON.parse(data));
      } catch {
        onEvent(event, data);
      }
    }
  }
}
