/**
 * The Nova plugin contract, version 1.
 *
 * It is a strict SUPERSET of the Stremio addon protocol: every Stremio addon
 * manifest is a valid Nova manifest, and Nova-only additions live under the
 * `nova` key (which Stremio ignores). A local plugin answers the same
 * resources (`stream`, `catalog`, `meta`, `subtitles`) with the same shapes, so
 * porting a Stremio addon is mostly a matter of moving its handlers.
 *
 * Keep in sync with nova-plugins/packages/sdk/src/protocol.ts.
 */
export const SDK_VERSION = 1;

export type StremioResource = 'stream' | 'catalog' | 'meta' | 'subtitles' | 'addon_catalog';
export type NovaResource =
  | 'resolve' // turn a stream's opaque `nova.resolve` token into a magnet/url
  | 'pages' // comic/manga chapter -> page images
  | 'live' // live TV channel lineup (+ optional EPG url)
  | 'action' // title-menu / command-palette actions
  | 'tool' // assistant tools
  | 'job' // scheduled or webhook-triggered background work
  | 'import' // watch-history import from another server
  | 'auth' // extra sign-in methods
  | 'page'; // custom pages rendered from a declarative view tree
export type ResourceName = StremioResource | NovaResource;

export interface ManifestResource {
  name: ResourceName;
  types?: string[];
  idPrefixes?: string[];
}

export interface CatalogDef {
  type: string;
  id: string;
  name: string;
  extra?: { name: string; isRequired?: boolean; options?: string[] }[];
}

export interface ConfigField {
  key: string;
  type: 'text' | 'password' | 'url' | 'number' | 'checkbox' | 'select' | 'textarea';
  title: string;
  description?: string;
  default?: string | number | boolean;
  options?: string[];
  required?: boolean;
  /** For `url` fields: the configured origin is added to the network allowlist (shown at approval). */
  network?: boolean;
}

export interface FsGrant {
  /** Symbolic: 'library' (the server library volume) or 'data' (the plugin's own folder). */
  path: 'library' | 'data';
  access: 'read' | 'write';
}

export interface Permissions {
  /** Hosts the plugin may reach: 'api.example.com', 'host:8080', '*.example.com'. */
  network?: string[];
  fs?: FsGrant[];
  /** Plugin-scoped key/value storage in the Nova database. */
  storage?: boolean;
  /** Server API scopes, e.g. 'catalog.read', 'library.read', 'library.write', 'progress.write'. */
  api?: string[];
}

export interface UiAction {
  id: string;
  label: string;
  icon?: string;
  /** Where it appears. */
  placement: 'title' | 'command' | 'player';
  types?: string[];
  /** Player shortcut key, e.g. 'shift+s'. */
  shortcut?: string;
}

export interface MediaTypeDef {
  id: string;
  name: string;
  /** Which built-in experience opens it. */
  reader: 'comic' | 'book' | 'video' | 'audio';
  icon?: string;
  fields?: { key: string; label: string; type: 'text' | 'number' | 'date' | 'tags' }[];
}

export interface JobDef {
  id: string;
  name: string;
  /** Minutes between runs; omitted = webhook/manual only. */
  everyMinutes?: number;
  webhook?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON schema of the arguments object. */
  parameters: Record<string, unknown>;
  /** Mutating tools show a preview + need confirmation when they touch shared state. */
  mutates?: 'none' | 'personal' | 'shared';
}

export interface PageDef {
  id: string;
  title: string;
  icon?: string;
}

export interface NovaManifestExtension {
  sdk: number;
  /** ESM bundle, relative to the manifest URL. Present => runs as a sandboxed local plugin. */
  entry?: string;
  permissions?: Permissions;
  config?: ConfigField[];
  ui?: { actions?: UiAction[]; css?: string; pages?: PageDef[] };
  mediaTypes?: MediaTypeDef[];
  jobs?: JobDef[];
  tools?: ToolDef[];
  /** Short label used on source chips, e.g. 'Prowlarr'. */
  shortName?: string;
}

export interface PluginManifest {
  id: string;
  version: string;
  name: string;
  description?: string;
  logo?: string;
  background?: string;
  types: string[];
  resources: (ResourceName | ManifestResource)[];
  idPrefixes?: string[];
  catalogs?: CatalogDef[];
  behaviorHints?: { configurable?: boolean; configurationRequired?: boolean; adult?: boolean; p2p?: boolean };
  /** Stremio's own config description (for configurable addons). */
  config?: ConfigField[];
  nova?: NovaManifestExtension;
}

// ---------------------------------------------------------------- requests

/** Everything Nova knows about the thing being looked up. */
export interface MediaContext {
  kind: 'movie' | 'tv' | 'anime' | 'music' | 'book' | 'comic';
  mediaId: string;
  title: string;
  altTitles: string[];
  year: number | null;
  season: number | null;
  episode: number | null;
  /** Anime: episode number within the AniList entry. TV: same as `episode`. */
  absoluteEpisode: number | null;
  ids: { tmdb?: string; imdb?: string; anilist?: string; mal?: string; kitsu?: string; tvdb?: string };
  /** TMDB coordinates for anime (AniList seasons are separate entries). */
  tvSeason?: number | null;
  tvEpisode?: number | null;
  /** Artist (music) or author (books). */
  creator?: string | null;
  format?: string | null;
}

export interface ResourceRequest {
  resource: ResourceName;
  /** Stremio type: movie | series | channel | tv | ... */
  type: string;
  /** Stremio id, e.g. 'tt0111161' or 'tt0944947:1:2' or 'kitsu:1:5'. */
  id: string;
  extra: Record<string, string>;
  nova?: MediaContext;
}

// ---------------------------------------------------------------- responses

export interface Stream {
  url?: string;
  ytId?: string;
  infoHash?: string;
  fileIdx?: number;
  externalUrl?: string;
  name?: string;
  title?: string;
  description?: string;
  subtitles?: SubtitleEntry[];
  sources?: string[];
  behaviorHints?: {
    notWebReady?: boolean;
    bingeGroup?: string;
    countryWhitelist?: string[];
    proxyHeaders?: { request?: Record<string, string>; response?: Record<string, string> };
    videoHash?: string;
    videoSize?: number;
    filename?: string;
  };
  nova?: {
    /** The release name, when `title` is decorated. */
    release?: string;
    seeders?: number;
    leechers?: number;
    size?: number;
    indexer?: string;
    languages?: string[];
    /** Opaque token handed back to the plugin's `resolve` handler on play. */
    resolve?: string;
    /** Debrid: already cached, instant. */
    cached?: boolean;
    /** File kind inside a torrent when it is not video (albums, books). */
    kind?: 'video' | 'audio' | 'book' | 'comic';
  };
}

export interface SubtitleEntry {
  id: string;
  url: string;
  lang: string;
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

export interface MetaVideo {
  id: string;
  title: string;
  released?: string;
  season?: number;
  episode?: number;
  thumbnail?: string;
  overview?: string;
}

export interface Meta extends MetaPreview {
  videos?: MetaVideo[];
  runtime?: string;
  cast?: string[];
  director?: string[];
  links?: { name: string; category: string; url: string }[];
}

export interface PageImage {
  url: string;
  width?: number;
  height?: number;
  headers?: Record<string, string>;
}

export interface LiveChannel {
  id: string;
  name: string;
  url: string;
  logo?: string;
  group?: string;
  number?: string;
  epgId?: string;
  headers?: Record<string, string>;
}

export interface ResolveResult {
  magnet?: string;
  url?: string;
  /** Raw .torrent, base64. */
  torrent?: string;
  headers?: Record<string, string>;
}

export interface ActionResult {
  toast?: string;
  openUrl?: string;
  navigate?: string;
}

export interface ViewNode {
  type: 'stack' | 'row' | 'text' | 'heading' | 'cards' | 'button' | 'image';
  text?: string;
  children?: ViewNode[];
  items?: MetaPreview[];
  action?: string;
  url?: string;
}

/** History import rows (resolved to Nova ids by the host). */
export interface ImportedHistory {
  ids: { imdb?: string; tmdb?: string; anilist?: string; mal?: string };
  kind: 'movie' | 'tv' | 'anime';
  title?: string;
  season?: number;
  episode?: number;
  positionSeconds?: number;
  durationSeconds?: number;
  finished?: boolean;
  watchedAt?: string;
}

// ---------------------------------------------------------------- IPC (host <-> worker)

export type HostToWorker =
  | { t: 'init'; manifest: PluginManifest; config: Record<string, unknown>; allowedHosts: string[] }
  | { t: 'call'; id: number; method: ResourceName; args: unknown }
  | { t: 'reply'; id: number; ok: boolean; value?: unknown; error?: string };

export type WorkerToHost =
  | { t: 'ready'; resources: string[] }
  | { t: 'result'; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; msg: string }
  | { t: 'host'; id: number; method: string; args: unknown };
