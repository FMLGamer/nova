// Shapes returned by the Nova API. Mirrors server/src (media/types.ts, services/*, routes/*).

export type MediaType = 'movie' | 'tv' | 'anime';

export interface CatalogItem {
  id: string;
  mediaType: MediaType;
  title: string;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
  overview: string;
  rating: number | null;
  runtime: number | null;
  genres: string[];
}

export interface Episode {
  id: string;
  season: number;
  episode: number;
  title: string;
  overview: string;
  still: string | null;
  airDate: string | null;
  runtime: number | null;
  /** Anime: 'filler' or 'recap' when the episode is known to be one. */
  filler?: 'filler' | 'recap' | null;
}

export interface Season {
  season: number;
  name: string;
  episodeCount: number;
}

export interface CastMember {
  name: string;
  character: string;
  photo: string | null;
}

export interface Character {
  name: string;
  role: string;
  image: string | null;
  voiceActor: string | null;
  voiceActorImage: string | null;
}

export interface Relation {
  id: string;
  relationType: string;
  title: string;
  format: string | null;
  poster: string | null;
}

export interface CatalogDetail extends CatalogItem {
  tagline: string | null;
  status: string | null;
  seasons: Season[];
  cast: CastMember[];
  studios: string[];
  totalEpisodes: number | null;
  trailer: { site: string; key: string } | null;
  characters: Character[];
  relations: Relation[];
  malId: number | null;
  imdbId: string | null;
  nextAiring?: { episode: number; airingAt: number } | null;
}

export interface Row {
  id: string;
  title: string;
  items: CatalogItem[];
}

export interface AiringEntry {
  item: CatalogItem;
  episode: number;
  airingAt: number;
  weekday: number;
}

// ---------------------------------------------------------------- account

export interface Account {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: string;
}

export interface Profile {
  id: string;
  name: string;
  avatar: string;
  isKids: boolean;
  sortOrder: number;
}

export interface AccountSettings {
  multiProfile: boolean;
  downloadsEnabled: boolean;
  autoApproveDownloads: boolean;
  transcodingEnabled: boolean;
  musicBooksEnabled: boolean;
  liveTvEnabled: boolean;
  assistantEnabled: boolean;
  cacheMb: number;
  maxProfiles: number;
}

export interface Session {
  account: Account;
  profiles: Profile[];
  settings: AccountSettings;
}

export interface SubtitleStyle {
  fontSize: number;
  color: string;
  background: number;
  opacity: number;
  fontFamily: 'sans' | 'serif' | 'mono' | 'rounded' | 'atkinson' | 'dyslexic';
  edge: 'none' | 'outline' | 'shadow' | 'raised' | 'depressed';
  position: number;
  weight: number;
}

export interface TorrentRequirements {
  qualities: string[];
  codecs: string[];
  audioCodecs: string[];
  formats: string[];
  allowHdr: boolean;
  minSeeders: number;
  maxSizeGb: number;
  preferredLanguages: string[];
}

export interface Preferences {
  torrent: TorrentRequirements & {
    indexerIds: number[];
    preferredIndexer: string;
  };
  anime: {
    audioLanguages: string[];
    preferEmbeddedSubs: boolean;
    addAllToCalendar: boolean;
    preferredGroups: string[];
    calendarFilter: 'all' | 'mylist' | 'watching';
    scheduleAllTitles: boolean;
    trackAutoAdd: boolean;
    trackAt: number;
  };
  ui: {
    autoplayNext: boolean;
    autoplayPreviews: boolean;
    reduceMotion: boolean;
    autoSelectSource: boolean;
    alwaysShowTitles: boolean;
    autoSelectSubtitles: boolean;
    styledSubtitles: boolean;
    subtitleLanguage: string;
    transcode: boolean;
    transcodeHeight: number;
    musicAndBooks: boolean;
    subtitleStyle: SubtitleStyle;
    secondarySubtitleLanguage: string;
    translateSubtitles: boolean;
    translateProvider: 'google' | 'deepl' | 'assistant';
    playbackSpeed: number;
    enhance: 'none' | 'sharpen' | 'anime4k' | 'deband' | 'custom';
    customShader: string;
    externalPlayer: '' | 'vlc' | 'mpv' | 'iina';
    skipIntroAutomatically: boolean;
    skipCreditsAutomatically: boolean;
    accent: 'nova' | 'ember' | 'ocean' | 'aurora' | 'mono';
    updateNotices: boolean;
    hideSpoilers: boolean;
    hideScores: boolean;
    customCss: string;
    subtitleIgnore: string[];
    shortcuts: Record<string, string>;
  };
  reader: {
    typeface: 'literata' | 'atkinson' | 'dyslexic' | 'serif' | 'sans';
    fontSize: number;
    lineHeight: number;
    margins: number;
    theme: 'night' | 'sepia' | 'paper' | 'custom';
    customBg: string;
    customFg: string;
    justify: boolean;
    comicMode: 'single' | 'double' | 'scroll';
    comicDirection: 'ltr' | 'rtl';
    comicFit: 'height' | 'width' | 'original';
  };
  home: {
    sections: string[];
    hidden: string[];
  };
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

export interface Invite {
  id: string;
  code: string;
  note: string | null;
  createdAt: string;
  usedByUsername: string | null;
  usedAt: string | null;
  revoked: boolean;
  status: 'available' | 'used' | 'revoked';
}

// ---------------------------------------------------------------- library (personal)

export interface Progress {
  itemKey: string;
  mediaType: string;
  mediaId: string;
  season: number | null;
  episode: number | null;
  positionSeconds: number;
  durationSeconds: number | null;
  finished: boolean;
  title: string | null;
  poster: string | null;
  backdrop: string | null;
  year: number | null;
  sourceLink: string | null;
  updatedAt: string;
}

export interface WatchedSummary {
  mediaId: string;
  started: number;
  finished: number;
  lastPercent: number;
  lastSeason: number | null;
  lastEpisode: number | null;
  updatedAt: string;
}

export interface ListEntry {
  mediaType: MediaType;
  mediaId: string;
  title: string | null;
  poster: string | null;
  year: number | null;
  addedAt: string;
}

export interface CollectionItem {
  mediaId: string;
  mediaType: string;
  title: string | null;
  poster: string | null;
  year: number | null;
  position: number;
}

export interface Collection {
  id: string;
  name: string;
  description: string | null;
  pinned: boolean;
  sortOrder: number;
  count: number;
  items: CollectionItem[];
  updatedAt: string;
}

export interface UpNext {
  mediaId: string;
  mediaType: 'tv' | 'anime';
  title: string;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
  season: number;
  episode: number;
  episodeTitle: string;
  still: string | null;
  runtime: number | null;
  itemKey: string;
}

export interface Notification {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  createdAt: string;
}

export interface CalendarEntry {
  mediaId: string;
  mediaType: 'tv' | 'anime';
  title: string;
  poster: string | null;
  backdrop: string | null;
  season: number | null;
  episode: number;
  episodeTitle: string | null;
  airsAt: number;
  allDay: boolean;
}

export interface ApiToken {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

// ---------------------------------------------------------------- playback

export type SourceKind = 'video' | 'audio' | 'book' | 'comic';

export interface Release {
  id: string;
  pluginId: string;
  pluginName: string;
  alsoFrom: string[];
  title: string;
  fileName: string | null;
  infoHash: string | null;
  fileIdx: number | null;
  url: string | null;
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
  kind: SourceKind;
  score: number;
  tier: 0 | 1;
  /** Requirements a tier-1 release misses ("4K", "HDR", "too large", ...). */
  misses?: string[];
}

export interface PluginRun {
  pluginId: string;
  name: string;
  status: 'running' | 'done' | 'error' | 'skipped';
  count: number;
  ms: number;
  error?: string;
}

export interface SourceSearch {
  id: string;
  done: boolean;
  noDub: boolean;
  runs: PluginRun[];
  releases: Release[];
  context: { title: string; year: number | null; kind: string; ids: Record<string, string> };
}

export interface PlayFile {
  index: number;
  name: string;
  size: number;
  mime: string;
  path: string;
}

/** A torrent the viewer's device streams (server in TORRENT_MODE=client). */
export interface ClientTorrent {
  magnet: string | null;
  torrent: string | null;
  infoHash: string | null;
  fileIdx: number | null;
  episode: { kind: 'tv' | 'anime'; season: number | null; episode: number | null } | null;
}

export interface PlaySource {
  kind: 't' | 'l' | 'u' | 'c';
  a: string;
  b?: string;
  path: string;
  name: string;
  size: number;
  mime: string;
  files: PlayFile[];
  link: string;
  torrent?: ClientTorrent;
}

export interface AppConfig {
  version: string;
  mode: 'server' | 'desktop';
  torrentMode: 'server' | 'client';
  enginePort: number;
  desktopDownloadUrl: string;
  projectUrl: string;
}

export type ReadFormat = 'manga' | 'manhwa' | 'manhua' | 'novel' | 'oneshot' | 'book';

export interface ReadItem {
  id: string;
  format: ReadFormat;
  title: string;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
  overview: string;
  rating: number | null;
  genres: string[];
  author: string | null;
}

export interface ReadDetail extends ReadItem {
  status: string | null;
  chapters: number | null;
  volumes: number | null;
  altTitles: string[];
  links: { label: string; url: string }[];
  related: (Pick<ReadItem, 'id' | 'title' | 'poster' | 'format'> & { relation: string })[];
  anilistId: number | null;
  malId: number | null;
}

export interface AppUpdate {
  current: string;
  latest: { version: string; url: string; notes: string; publishedAt: string | null } | null;
  available: boolean;
}

export interface ProfileStats {
  totals: { seconds: number; titles: number; episodes: number; movies: number; activeDays: number; streak: number };
  byType: { type: string; seconds: number; titles: number }[];
  months: { month: string; seconds: number }[];
  genres: { name: string; seconds: number }[];
  top: { mediaId: string; mediaType: string; title: string; poster: string | null; seconds: number; episodes: number }[];
  reading: { kind: string; finished: number; reading: number }[];
}

export interface Recommendations {
  forYou: { item: CatalogItem; reason: string }[];
  because: { seed: { mediaId: string; title: string }; items: CatalogItem[] }[];
}

export interface EnginePairing {
  id: string;
  origin: string;
  createdAt: string;
}

export interface MediaTrack {
  index: number;
  codec: string;
  language: string | null;
  title: string | null;
  channels?: number | null;
  default?: boolean;
  forced?: boolean;
  /** Matroska track number (embedded subtitles stream from /subs/:number). */
  number?: number;
}

export interface MediaChapter {
  start: number;
  end: number | null;
  title: string;
}

export interface MediaTracks {
  container?: 'matroska' | null;
  video: { codec: string; width: number | null; height: number | null; hdr: boolean } | null;
  audio: MediaTrack[];
  subtitles: MediaTrack[];
  duration: number | null;
  chapters?: MediaChapter[];
  fonts?: number[];
}

export interface TorrentStatus {
  ready: boolean;
  progress: number;
  downloadSpeed: number;
  numPeers: number;
}

export interface SubtitleOption {
  fileId: number;
  language: string;
  release: string;
  match: 'exact' | 'likely';
  /** Set for subtitles from a plugin (e.g. OpenSubtitles v3): the VTT URL and who provided it. */
  url?: string;
  provider?: string;
}

export interface SkipTimes {
  op: { start: number; end: number } | null;
  ed: { start: number; end: number } | null;
}

export interface ExternalLinks {
  url: string;
  vlc: string;
  iina: string;
  mpv: string;
  playlist: string;
}

// ---------------------------------------------------------------- server library

export interface MatchCandidate {
  mediaId: string;
  title: string;
  year: number | null;
  poster: string | null;
  overview: string;
  confidence: number;
}

export interface LibraryItem {
  id: string;
  mediaId: string | null;
  kind: 'movie' | 'tv' | 'anime' | 'book' | 'comic' | 'manga' | 'music';
  title: string;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
  overview: string | null;
  matchStatus: 'matched' | 'review' | 'unmatched';
  matchConfidence: number | null;
  candidates: MatchCandidate[];
  folder: string | null;
  private: boolean;
  privateMine: boolean;
  overrides: Record<string, unknown>;
  fileCount: number;
  sizeBytes: number;
  addedAt: string;
}

export interface LibraryFile {
  id: string;
  path: string;
  size: number;
  season: number | null;
  episode: number | null;
  kind: string;
  mime: string | null;
}

/** A folder of books, comics or manga the server reads in place. */
export interface LibrarySource {
  id: string;
  name: string;
  path: string;
  kind: 'book' | 'comic' | 'manga';
  fileCount: number;
  available: boolean;
}

// ---------------------------------------------------------------- anime tracking

export type TrackStatus = 'watching' | 'rewatching' | 'completed' | 'planning' | 'paused' | 'dropped';

interface TrackerAccount {
  connected: boolean;
  user: string | null;
  avatar: string | null;
  expiresAt: number | null;
}

export interface TrackerStatus {
  anilist: TrackerAccount & { clientId: string | null };
  mal: TrackerAccount & { configured: boolean };
  anilistAuthorizeUrl: string | null;
  malRedirectUri: string;
}

export interface TrackEntry {
  status: TrackStatus | null;
  progress: number;
  score: number | null;
  url: string;
}

export interface TrackEntries {
  anilist?: TrackEntry | null;
  mal?: TrackEntry | null;
  episodes: number | null;
}

export interface Discussion {
  site: 'AniList' | 'MyAnimeList';
  title: string;
  url: string;
  comments: number | null;
  embed: { site: 'anilist' | 'mal'; id: number } | null;
}

export interface ThreadPost {
  id: number;
  user: string;
  avatar: string | null;
  createdAt: number;
  likes: number | null;
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

export interface TrackedShow {
  mediaId: string;
  title: string;
  poster: string | null;
  status: TrackStatus;
  progress: number;
  episodes: number | null;
  score: number | null;
  sites: ('anilist' | 'mal')[];
  updatedAt: number;
}

export interface MediaFile extends LibraryFile {
  stream: string;
  src: string;
  itemId: string;
}

export interface LibraryStatus {
  enabled: boolean;
  storage: { totalBytes: number; freeBytes: number; usedByLibrary: number; maxBytes: number | null };
  lastScan: { at: string; added: number; review: number; removed: number } | null;
}

export interface ServerDownload {
  id: string;
  accountId: string | null;
  username: string | null;
  mediaId: string | null;
  itemKey: string | null;
  kind: string;
  title: string;
  poster: string | null;
  season: number | null;
  episode: number | null;
  release: { title: string; quality: string | null; sizeBytes: number; pluginName: string };
  status: 'pending' | 'queued' | 'downloading' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  bytesDone: number;
  bytesTotal: number;
  speed: number;
  error: string | null;
  infoHash: string | null;
  libraryItemId: string | null;
  ruleId: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface DownloadRule {
  id: string;
  accountId: string;
  mediaId: string;
  title: string;
  poster: string | null;
  qualityProfileId: string | null;
  mode: 'new' | 'missing';
  enabled: boolean;
  lastCheckedAt: string | null;
  createdAt: string;
}

export interface QualityProfile {
  id: string;
  name: string;
  isDefault: boolean;
  torrent: TorrentRequirements;
  anime: { audioLanguages: string[]; preferEmbeddedSubs: boolean };
}

export interface MissingSeries {
  mediaId: string;
  title: string;
  poster: string | null;
  aired: number;
  have: number;
  missing: { season: number; episode: number; title: string; airDate: string | null; still: string | null }[];
}

// ---------------------------------------------------------------- plugins

export interface PermissionSummary {
  network: string[];
  fs: { path: 'library' | 'data'; access: 'read' | 'write' }[];
  storage: boolean;
  api: string[];
}

export interface ConfigField {
  key: string;
  type: 'text' | 'password' | 'url' | 'number' | 'checkbox' | 'select' | 'textarea';
  title: string;
  description?: string;
  default?: string | number | boolean;
  options?: string[];
  required?: boolean;
  network?: boolean;
}

export interface PluginInfo {
  id: string;
  kind: 'local' | 'stremio';
  name: string;
  shortName: string | null;
  version: string;
  description: string;
  logo: string | null;
  sourceUrl: string | null;
  enabled: boolean;
  status: 'pending' | 'approved';
  priority: number;
  types: string[];
  resources: string[];
  requested: PermissionSummary;
  granted: PermissionSummary;
  config: (ConfigField & { value: unknown; managed: boolean })[];
  pendingUpdate: { version: string; permissions: PermissionSummary } | null;
  runtime: { status: string; lastError: string | null; handlers: string[] };
  configurable: boolean;
  installedAt: string;
}

export interface RegistryEntry {
  id: string;
  name: string;
  description?: string;
  manifest: string;
  kind?: 'nova' | 'stremio';
  configure?: string;
  logo?: string;
  tags?: string[];
  registry: string;
  installed?: boolean;
}

export interface PluginManifest {
  id: string;
  version: string;
  name: string;
  description?: string;
  logo?: string;
  types: string[];
  resources: (string | { name: string })[];
  catalogs?: CatalogDef[];
  behaviorHints?: { configurable?: boolean; configurationRequired?: boolean; adult?: boolean; p2p?: boolean };
  config?: ConfigField[];
  nova?: { config?: ConfigField[]; shortName?: string };
}

export interface InstallPreview {
  kind: 'local' | 'stremio';
  sourceUrl: string;
  manifest: PluginManifest;
  permissions: PermissionSummary;
  installed: boolean;
  sandbox: boolean;
}

export interface CatalogDef {
  type: string;
  id: string;
  name: string;
  extra?: { name: string; isRequired?: boolean; options?: string[] }[];
}

export interface UiAction {
  id: string;
  label: string;
  icon?: string;
  placement: 'title' | 'command' | 'player';
  types?: string[];
  shortcut?: string;
  pluginId: string;
  pluginName: string;
}

export interface Contributions {
  actions: UiAction[];
  pages: { id: string; title: string; icon?: string; pluginId: string }[];
  mediaTypes: { id: string; name: string; reader: 'comic' | 'book' | 'video' | 'audio'; icon?: string; pluginId: string }[];
  catalogs: (CatalogDef & { pluginId: string; pluginName: string })[];
  searchCatalogs: (CatalogDef & { pluginId: string; pluginName: string })[];
  themes: { pluginId: string; url: string }[];
}

export interface MetaPreview {
  id: string;
  type: string;
  name: string;
  poster?: string;
  posterShape?: 'poster' | 'landscape' | 'square';
  background?: string;
  logo?: string;
  description?: string;
  releaseInfo?: string;
  genres?: string[];
  imdbRating?: string;
}

export interface Meta extends MetaPreview {
  videos?: { id: string; title: string; released?: string; season?: number; episode?: number; thumbnail?: string; overview?: string }[];
  runtime?: string;
  cast?: string[];
  director?: string[];
}

export interface ViewNode {
  type: 'stack' | 'row' | 'text' | 'heading' | 'cards' | 'button' | 'image';
  text?: string;
  children?: ViewNode[];
  items?: MetaPreview[];
  action?: string;
  url?: string;
}

export interface PluginLog {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  timestamp: string;
}

// ---------------------------------------------------------------- live tv

export interface Channel {
  id: string;
  name: string;
  number: string | null;
  logo: string | null;
  group: string | null;
  epgId: string | null;
  catchup: boolean;
  catchupDays: number | null;
  favorite: boolean;
  hidden: boolean;
  sourceId: string;
}

export interface Programme {
  epgId: string;
  start: number;
  stop: number;
  title: string;
  subtitle: string | null;
  description: string | null;
  category: string | null;
  image: string | null;
}

export interface Airing extends Programme {
  channelId: string;
  channelName: string;
  channelLogo: string | null;
}

export interface LivePlay {
  url: string;
  type: 'hls' | 'mpegts';
  remux: string;
  transcode: string;
  name: string;
  logo: string | null;
}

export interface LiveSource {
  id: string;
  kind: 'm3u' | 'xtream' | 'hdhomerun' | 'iptvorg' | 'plugin';
  name: string;
  config: Record<string, string>;
  epgUrl: string | null;
  enabled: boolean;
  channelCount: number;
  lastRefreshedAt: string | null;
  error: string | null;
}

export interface DirectoryChannel {
  name: string;
  url: string;
  tvgId: string | null;
  logo: string | null;
  group: string | null;
  number: string | null;
  country: string | null;
  preview: { url: string; type: 'hls' | 'mpegts'; remux: string; transcode: string };
}

// ---------------------------------------------------------------- reading

export type ReadingKind = 'book' | 'comic' | 'manga' | 'audiobook' | 'pdf';

export interface ReadingProgress {
  itemKey: string;
  kind: ReadingKind;
  title: string | null;
  cover: string | null;
  author: string | null;
  locator: string | null;
  percent: number;
  source: Record<string, unknown> | null;
  updatedAt: string;
}

export interface Annotation {
  id: string;
  itemKey: string;
  kind: 'highlight' | 'note' | 'bookmark';
  locator: string;
  text: string | null;
  note: string | null;
  color: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Book {
  id: string;
  title: string;
  author: string;
  year: number | null;
  cover: string | null;
  kind: 'ebook' | 'audiobook';
  freeUrl: string | null;
  format: string | null;
}

export interface BookDetail extends Book {
  description: string | null;
  subjects: string[];
  chapters: { title: string; url: string; seconds: number | null }[];
}

export interface Album {
  id: string;
  title: string;
  artist: string;
  artistId: string | null;
  year: number | null;
  cover: string | null;
  primaryType: string | null;
}

export interface AlbumDetail extends Album {
  tracks: { id: string; title: string; position: number; lengthMs: number | null }[];
  totalMs: number | null;
}

// ---------------------------------------------------------------- people

export interface RoomTarget {
  mediaId: string;
  mediaType: string;
  itemKey: string;
  title: string;
  poster: string | null;
  backdrop: string | null;
  season: number | null;
  episode: number | null;
  path: string;
  src: string;
}

export interface RoomState {
  playing: boolean;
  position: number;
  rate: number;
  at: number;
}

export interface RoomMember {
  id: string;
  name: string;
  avatar: string | null;
  buffering: boolean;
  host: boolean;
}

export interface RoomChat {
  id: string;
  from: string;
  name: string;
  text: string;
  at: number;
  kind: 'chat' | 'system' | 'react';
}

export interface Room {
  code: string;
  target: RoomTarget;
  state: RoomState;
  hostAccountId: string;
  members: RoomMember[];
  chat: RoomChat[];
}

export interface Share {
  id: string;
  scope: 'title' | 'collection' | 'library';
  target: string;
  label: string | null;
  expiresAt: string | null;
  revoked: boolean;
  uses: number;
  createdAt: string;
  lastUsedAt: string | null;
  expired: boolean;
}

// ---------------------------------------------------------------- admin

export interface AdminAccount {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: string;
  settings: AccountSettings;
  usage: {
    profiles: number;
    itemsWatched: number;
    watchSeconds: number;
    listItems: number;
    lastActivity: string | null;
    cacheBytes: number;
    cacheBudgetBytes: number;
  };
}

export interface BackupInfo {
  name: string;
  size: number;
  createdAt: string;
}

export interface AdminOverview {
  accounts: AdminAccount[];
  cache: { totalMb: number; ttlMinutes: number; keepPerAccount: number; minAccountMb: number };
  limits: { maxProfiles: number; maxTranscodes: number };
  server: {
    version: string;
    sandbox: boolean;
    hwAccel: string | null;
    library: LibraryStatus;
    plugins: { total: number; pending: number };
    approvals: number;
    review: number;
    liveChannels: number;
    backups: BackupInfo[];
  };
}

// ---------------------------------------------------------------- assistant

export interface AssistantProvider {
  id: string;
  kind: 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'ollama' | 'openai-compatible';
  name: string;
  baseUrl: string | null;
  model: string;
  enabled: boolean;
  shared: boolean;
  hasKey: boolean;
}

export interface AssistantThread {
  id: string;
  title: string;
  context: unknown;
  updatedAt: string;
}

export interface Receipt {
  id: string;
  summary: string;
  status: 'applied' | 'pending' | 'discarded' | 'undone';
  createdAt: string;
}

export interface AssistantContext {
  kind: string;
  id?: string | null;
  label?: string | null;
  data?: Record<string, unknown>;
}
