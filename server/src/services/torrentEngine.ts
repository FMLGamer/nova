import fs from 'node:fs';
import type WebTorrent from 'webtorrent';
import type { Torrent, TorrentFile } from 'webtorrent';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { episodeMatch, magnetInfoHash } from '../core/release.js';
import { getAccountSettings } from './entitlements.js';
import { forgetSubtitles } from './subtitleCache.js';
import { forgetEmbedded } from './embeddedSubs.js';

fs.mkdirSync(config.torrentDir, { recursive: true });

// Leech-only client. `uploadLimit` caps total outgoing bytes as a safety net;
// it cannot be 0 because handshakes and piece requests share the same pipe.
// Created (and the library loaded, the slowest part of startup) on first use,
// so a TORRENT_MODE=client server never opens a socket.
let _client: WebTorrent | null = null;
async function torrents(): Promise<WebTorrent> {
  if (config.torrentMode === 'client') throw new Error('This server does not download torrents; your device streams them');
  if (!_client) {
    const { default: Client } = await import('webtorrent');
    // On a phone there's no router port mapping to ask for (and Android won't list the network to find one).
    _client ??= new Client({ uploadLimit: config.uploadLimitBps, ...(process.platform === 'android' ? { natUpnp: false, natPmp: false } : {}) });
    _client.on('error', (err) => console.error('[torrent] client error:', err));
  }
  return _client;
}

// We never seed: zero unchoke slots means no peer is ever unchoked, so piece
// data is never sent upstream. This is the protocol-correct way to stay a pure
// leech without breaking the control messages we need to download.
export const TORRENT_OPTS = { path: config.torrentDir, uploads: 0, alwaysChokeSeeders: true };

const VIDEO_RE = /\.(mp4|mkv|webm|m4v|avi|mov)$/i;
const AUDIO_RE = /\.(mp3|flac|m4a|m4b|aac|ogg|opus|wav|wma)$/i;
const BOOK_RE = /\.(epub|pdf|mobi|azw3|txt)$/i;
const COMIC_RE = /\.(cbz|cbr|cb7|zip)$/i;
/** What kind of media we want out of a torrent. */
export type MediaKind = 'video' | 'audio' | 'book' | 'comic';
const KIND_RE: Record<MediaKind, RegExp> = { video: VIDEO_RE, audio: AUDIO_RE, book: BOOK_RE, comic: COMIC_RE };
const MB = 1024 * 1024;

export interface PreparedFile {
  index: number;
  name: string;
  size: number;
  mime: string;
}

export interface Prepared {
  infoHash: string;
  name: string;
  fileIndex: number;
  fileName: string;
  size: number;
  mime: string;
  /** Every file of the requested kind, ordered — an album's tracks, a book's parts. */
  files: PreparedFile[];
}

export interface CacheEntry {
  infoHash: string;
  accountId: string | null;
  itemKey: string | null;
  title: string | null;
  fileIndex: number;
  fileName: string | null;
  sizeBytes: number;
  bytesOnDisk: number;
  progress: number;
  active: boolean;
  createdAt: string;
  lastAccess: string;
}

interface CacheRow {
  info_hash: string;
  account_id: string | null;
  item_key: string | null;
  title: string | null;
  file_index: number;
  file_name: string | null;
  size_bytes: number;
  bytes_on_disk: number;
  source_link: string | null;
  created_at: string;
  last_access: string;
}

export function mimeForName(name: string): string {
  if (/\.(mp4|m4v)$/i.test(name)) return 'video/mp4';
  if (/\.webm$/i.test(name)) return 'video/webm';
  if (/\.mkv$/i.test(name)) return 'video/x-matroska';
  if (/\.mp3$/i.test(name)) return 'audio/mpeg';
  if (/\.flac$/i.test(name)) return 'audio/flac';
  if (/\.(m4a|m4b|aac)$/i.test(name)) return 'audio/mp4';
  if (/\.ogg$/i.test(name)) return 'audio/ogg';
  if (/\.opus$/i.test(name)) return 'audio/opus';
  if (/\.wav$/i.test(name)) return 'audio/wav';
  if (/\.epub$/i.test(name)) return 'application/epub+zip';
  if (/\.pdf$/i.test(name)) return 'application/pdf';
  if (/\.(cbz)$/i.test(name)) return 'application/vnd.comicbook+zip';
  if (/\.txt$/i.test(name)) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function findTorrent(infoHash: string): Torrent | undefined {
  return _client?.torrents.find((t) => t.infoHash === infoHash);
}

/** Torrents owned by the server-library downloader (never evicted by the stream cache). */
const downloadHashes = new Set<string>();

export function engine(): { client: () => Promise<WebTorrent>; find: (h: string) => Torrent | undefined; markDownload: (h: string, on: boolean) => void } {
  return {
    client: torrents,
    find: findTorrent,
    markDownload: (h, on) => (on ? downloadHashes.add(h) : downloadHashes.delete(h)),
  };
}

export function isDownloadTorrent(infoHash: string): boolean {
  return downloadHashes.has(infoHash);
}

/** Bytes actually written to scratch for a torrent (sparse file growth). */
function downloadedBytes(infoHash: string): number {
  const t = findTorrent(infoHash) as (Torrent & { downloaded?: number }) | undefined;
  return t?.downloaded ?? 0;
}

// --- Cache ledger --------------------------------------------------------

/** Marks real user activity: refreshes the TTL and the size estimate. */
function touch(infoHash: string): void {
  db.prepare(
    "UPDATE cache_entries SET last_access = datetime('now'), bytes_on_disk = ? WHERE info_hash = ?",
  ).run(downloadedBytes(infoHash), infoHash);
}

/** Size-only refresh — must NOT touch last_access or the TTL would never fire. */
function syncBytes(infoHash: string): void {
  db.prepare('UPDATE cache_entries SET bytes_on_disk = ? WHERE info_hash = ?').run(
    downloadedBytes(infoHash),
    infoHash,
  );
}

function rowToEntry(r: CacheRow): CacheEntry {
  const t = findTorrent(r.info_hash) as (Torrent & { progress?: number }) | undefined;
  return {
    infoHash: r.info_hash,
    accountId: r.account_id,
    itemKey: r.item_key,
    title: r.title,
    fileIndex: r.file_index,
    fileName: r.file_name,
    sizeBytes: r.size_bytes,
    bytesOnDisk: t ? downloadedBytes(r.info_hash) : r.bytes_on_disk,
    progress: t?.progress ?? 0,
    active: Boolean(t),
    createdAt: r.created_at,
    lastAccess: r.last_access,
  };
}

/** Destroys a torrent and deletes its scratch files + ledger row. */
export function evict(infoHash: string): void {
  const t = findTorrent(infoHash);
  if (t && !downloadHashes.has(infoHash)) {
    try {
      // destroyStore removes the partially-downloaded file from the scratch directory.
      t.destroy({ destroyStore: true });
    } catch (err) {
      console.error('[cache] evict failed:', err);
    }
  }
  forgetSubtitles(`t_${infoHash}_`);
  forgetEmbedded(`t_${infoHash}_`);
  db.prepare('DELETE FROM cache_entries WHERE info_hash = ?').run(infoHash);
}

function totalBytes(): number {
  const rows = db.prepare('SELECT info_hash, bytes_on_disk FROM cache_entries').all() as {
    info_hash: string;
    bytes_on_disk: number;
  }[];
  return rows.reduce((n, r) => n + (downloadedBytes(r.info_hash) || r.bytes_on_disk), 0);
}

function accountBytes(accountId: string): number {
  const rows = db
    .prepare('SELECT info_hash, bytes_on_disk FROM cache_entries WHERE account_id = ?')
    .all(accountId) as { info_hash: string; bytes_on_disk: number }[];
  return rows.reduce((n, r) => n + (downloadedBytes(r.info_hash) || r.bytes_on_disk), 0);
}

/** Drops entries whose TTL has passed (nothing is kept forever). */
function evictExpired(): void {
  const rows = db
    .prepare("SELECT info_hash FROM cache_entries WHERE last_access < datetime('now', ?)")
    .all(`-${config.cache.ttlMinutes} minutes`) as { info_hash: string }[];
  for (const r of rows) evict(r.info_hash);
}

/**
 * Enforces the cache policy for one account: only the item being watched plus a
 * couple of recent ones survive, and the account stays inside its size budget.
 */
function enforceAccount(accountId: string, keepHash: string): void {
  const keep = Math.max(1, config.cache.keepPerAccount);
  const rows = db
    .prepare(
      `SELECT info_hash FROM cache_entries
        WHERE account_id = ? AND info_hash != ?
        ORDER BY last_access DESC`,
    )
    .all(accountId, keepHash) as { info_hash: string }[];

  // "Cache only the current item": anything past the keep window goes now.
  for (const r of rows.slice(keep - 1)) evict(r.info_hash);

  const budget = getAccountSettings(accountId).cacheMb * MB;
  let used = accountBytes(accountId);
  if (used <= budget) return;
  const lru = db
    .prepare(
      `SELECT info_hash FROM cache_entries
        WHERE account_id = ? AND info_hash != ?
        ORDER BY last_access ASC`,
    )
    .all(accountId, keepHash) as { info_hash: string }[];
  for (const r of lru) {
    if (used <= budget) break;
    used -= downloadedBytes(r.info_hash);
    evict(r.info_hash);
  }
}

/** Node-wide ceiling so the scratch volume can never fill up. */
function enforceGlobal(keepHash: string): void {
  const budget = config.cache.totalMb * MB;
  let used = totalBytes();
  if (used <= budget) return;
  const lru = db
    .prepare('SELECT info_hash FROM cache_entries WHERE info_hash != ? ORDER BY last_access ASC')
    .all(keepHash) as { info_hash: string }[];
  for (const r of lru) {
    if (used <= budget) break;
    used -= downloadedBytes(r.info_hash);
    evict(r.info_hash);
  }
}

export interface CacheOwner {
  accountId: string;
  itemKey?: string | null;
  title?: string | null;
  sourceLink?: string | null;
}

function record(prepared: Prepared, owner: CacheOwner | undefined, link: string): void {
  if (!owner) return;
  // Cache bookkeeping must never break playback, so failures here are logged
  // rather than propagated to the caller.
  try {
    db.prepare(
      `INSERT INTO cache_entries
       (info_hash, account_id, item_key, title, file_index, file_name, size_bytes, bytes_on_disk, source_link)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(info_hash) DO UPDATE SET
       account_id = excluded.account_id,
       item_key = COALESCE(excluded.item_key, cache_entries.item_key),
       title = COALESCE(excluded.title, cache_entries.title),
       file_index = excluded.file_index,
       file_name = excluded.file_name,
       size_bytes = excluded.size_bytes,
       last_access = datetime('now')`,
    ).run(
      prepared.infoHash,
      owner.accountId,
      owner.itemKey ?? null,
      owner.title ?? null,
      prepared.fileIndex,
      prepared.fileName,
      prepared.size,
      downloadedBytes(prepared.infoHash),
      owner.sourceLink ?? link,
    );
    evictExpired();
    enforceAccount(owner.accountId, prepared.infoHash);
    enforceGlobal(prepared.infoHash);
  } catch (err) {
    console.error('[cache] bookkeeping failed:', err);
  }
}

function pickFiles(torrent: Torrent, kind: MediaKind, preferredIdx: number | null, hint: EpisodeHint | null = null): { file: TorrentFile; index: number }[] {
  const re = KIND_RE[kind];
  const out: { file: TorrentFile; index: number }[] = [];
  torrent.files.forEach((file, index) => {
    if (re.test(file.name)) out.push({ file, index });
  });
  // Video: the file the source named (an episode inside a season pack), else
  // the file whose name carries the wanted episode, else the biggest.
  // Audio/books: keep disc/track order.
  if (kind === 'video') {
    const named = preferredIdx != null ? out.find((f) => f.index === preferredIdx) : undefined;
    if (named) return [named];
    out.sort((a, b) => b.file.length - a.file.length);
    if (hint && out.length > 1) {
      const ep = out.find((f) => episodeMatch(f.file.path, hint.kind, hint.season, hint.episode) === 'exact');
      if (ep) return [ep];
    }
    return out.slice(0, 1);
  }
  out.sort((a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true }));
  return out;
}

function prepareFrom(torrent: Torrent, kind: MediaKind, preferredIdx: number | null = null, hint: EpisodeHint | null = null): Prepared {
  const picked = pickFiles(torrent, kind, preferredIdx, hint);
  if (!picked.length) throw new Error(`No playable ${kind} file found in torrent`);
  // Focus bandwidth on what will actually be read (downloads keep their own selection).
  if (!downloadHashes.has(torrent.infoHash)) torrent.files.forEach((f) => f.deselect());
  const first = picked[0]!;
  first.file.select();
  return {
    infoHash: torrent.infoHash,
    name: torrent.name,
    fileIndex: first.index,
    fileName: first.file.name,
    size: first.file.length,
    mime: mimeForName(first.file.name),
    files: picked.map((p) => ({
      index: p.index,
      name: p.file.name,
      size: p.file.length,
      mime: mimeForName(p.file.name),
    })),
  };
}

export interface EpisodeHint {
  kind: 'tv' | 'anime';
  season: number | null;
  episode: number | null;
}

export interface TorrentInput {
  magnet?: string | null;
  torrent?: Buffer | null;
  fileIdx?: number | null;
  episode?: EpisodeHint | null;
}

/** Add a magnet/.torrent and resolve once metadata + a usable file exist. */
export async function addTorrent(
  input: TorrentInput,
  owner?: CacheOwner,
  kind: MediaKind = 'video',
): Promise<Prepared> {
  const source = input.magnet ?? input.torrent;
  if (!source) throw new Error('Nothing to open');
  const magnet = input.magnet ?? null;
  const hash = magnet ? magnetInfoHash(magnet) : null;
  const link = magnet ?? `torrent:${hash ?? 'upload'}`;
  if (hash) {
    const existing = findTorrent(hash);
    // Cache hit: the file is already (partly) on scratch, so playback is instant.
    if (existing && existing.ready) {
      const prepared = prepareFrom(existing, kind, input.fileIdx ?? null, input.episode ?? null);
      if (!downloadHashes.has(hash)) record(prepared, owner, link);
      return prepared;
    }
    if (existing) {
      return new Promise<Prepared>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out fetching torrent metadata')), 45_000);
        existing.once('ready', () => {
          clearTimeout(timer);
          try {
            const prepared = prepareFrom(existing, kind, input.fileIdx ?? null, input.episode ?? null);
            if (!downloadHashes.has(hash)) record(prepared, owner, link);
            resolve(prepared);
          } catch (err) {
            reject(err instanceof Error ? err : new Error('torrent preparation failed'));
          }
        });
      });
    }
  }

  const client = await torrents();
  return new Promise<Prepared>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out fetching torrent metadata')), 45_000);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      fn();
    };
    try {
      const torrent = client.add(source, TORRENT_OPTS, (t) => {
        done(() => {
          try {
            const prepared = prepareFrom(t, kind, input.fileIdx ?? null, input.episode ?? null);
            record(prepared, owner, magnet ?? link);
            resolve(prepared);
          } catch (err) {
            reject(err instanceof Error ? err : new Error('torrent preparation failed'));
          }
        });
      });
      torrent.on('error', (err: unknown) =>
        done(() => reject(err instanceof Error ? err : new Error('torrent error'))),
      );
    } catch (err) {
      done(() => reject(err instanceof Error ? err : new Error('failed to add torrent')));
    }
  });
}

export function getFile(infoHash: string, fileIndex: number): TorrentFile | null {
  const torrent = findTorrent(infoHash);
  const file = torrent?.files[fileIndex];
  if (!file) return null;
  // Multi-file torrents (albums, audiobooks) switch files as the queue advances,
  // so make sure the one being read is the one we are downloading.
  file.select();
  touch(infoHash);
  return file;
}

export interface TorrentStatus {
  ready: boolean;
  progress: number;
  downloadSpeed: number;
  numPeers: number;
}

export function torrentStatus(infoHash: string): TorrentStatus | null {
  const torrent = findTorrent(infoHash);
  if (!torrent) return null;
  touch(infoHash);
  // webtorrent's bundled types omit these live-progress fields.
  const live = torrent as Torrent & { progress: number; downloadSpeed: number; numPeers: number };
  return {
    ready: torrent.ready,
    progress: live.progress,
    downloadSpeed: live.downloadSpeed,
    numPeers: live.numPeers,
  };
}

// --- Cache queries (used by the player + admin dashboard) ----------------

/** Item keys this account can resume straight from scratch. */
export function cachedItemKeys(accountId: string): string[] {
  const rows = db
    .prepare('SELECT info_hash, item_key FROM cache_entries WHERE account_id = ? AND item_key IS NOT NULL')
    .all(accountId) as { info_hash: string; item_key: string }[];
  return rows.filter((r) => Boolean(findTorrent(r.info_hash))).map((r) => r.item_key);
}

export function listCache(accountId?: string): CacheEntry[] {
  const rows = (
    accountId
      ? db.prepare('SELECT * FROM cache_entries WHERE account_id = ? ORDER BY last_access DESC').all(accountId)
      : db.prepare('SELECT * FROM cache_entries ORDER BY last_access DESC').all()
  ) as CacheRow[];
  return rows.map(rowToEntry);
}

export function cacheUsage(accountId: string): number {
  return accountBytes(accountId);
}

export function cacheTotals(): { usedBytes: number; budgetBytes: number; entries: number } {
  const entries = (db.prepare('SELECT COUNT(*) AS n FROM cache_entries').get() as { n: number }).n;
  return { usedBytes: totalBytes(), budgetBytes: config.cache.totalMb * MB, entries };
}

export function flushAccountCache(accountId: string): number {
  const rows = db.prepare('SELECT info_hash FROM cache_entries WHERE account_id = ?').all(accountId) as {
    info_hash: string;
  }[];
  for (const r of rows) evict(r.info_hash);
  return rows.length;
}

export function flushAllCache(): number {
  const rows = db.prepare('SELECT info_hash FROM cache_entries').all() as { info_hash: string }[];
  for (const r of rows) evict(r.info_hash);
  // Anything still running without a ledger row (e.g. after a restart) goes too,
  // except server-library downloads, which are not cache.
  for (const t of [...(_client?.torrents ?? [])]) {
    if (downloadHashes.has(t.infoHash)) continue;
    try {
      t.destroy({ destroyStore: true });
    } catch {
      /* already gone */
    }
  }
  return rows.length;
}

// Torrents added before a restart have no live handle, so their rows would
// over-report disk use; scratch is treated as disposable across restarts.
db.prepare('DELETE FROM cache_entries').run();

// Keep the ledger honest and the scratch volume inside budget.
setInterval(() => {
  try {
    for (const t of _client?.torrents ?? []) syncBytes(t.infoHash);
    evictExpired();
    enforceGlobal('');
  } catch (err) {
    console.error('[cache] sweep failed:', err);
  }
}, 60 * 1000).unref();
