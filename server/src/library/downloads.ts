import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Torrent } from 'webtorrent';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { newId } from '../lib/crypto.js';
import { HttpError } from '../lib/http.js';
import type { Release } from '../core/release.js';
import type { MediaContext } from '../plugins/protocol.js';
import { resolveRelease } from '../plugins/sources.js';
import { getAccountSettings } from '../services/entitlements.js';
import { notify, notifyAdmins } from '../services/notifications.js';
import { engine } from '../services/torrentEngine.js';
import { addFile, ensureItem, libraryEnabled, libraryRoot, storageStats } from './library.js';
import { fileKind, organizedPath, parseName, VIDEO_EXT, type LibraryKind } from './naming.js';

export type DownloadStatus = 'pending' | 'queued' | 'downloading' | 'completed' | 'failed' | 'cancelled';

export interface DownloadDTO {
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
  status: DownloadStatus;
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

interface DownloadRow {
  id: string;
  account_id: string | null;
  username?: string | null;
  profile_id: string | null;
  media_id: string | null;
  item_key: string | null;
  kind: string;
  title: string;
  poster: string | null;
  season: number | null;
  episode: number | null;
  release: string;
  status: DownloadStatus;
  progress: number;
  bytes_done: number;
  bytes_total: number;
  speed: number;
  error: string | null;
  info_hash: string | null;
  library_item_id: string | null;
  rule_id: string | null;
  created_at: string;
  completed_at: string | null;
}

interface StoredRelease {
  release: Release;
  context: MediaContext;
}

function toDTO(r: DownloadRow): DownloadDTO {
  const stored = JSON.parse(r.release) as StoredRelease;
  return {
    id: r.id,
    accountId: r.account_id,
    username: r.username ?? null,
    mediaId: r.media_id,
    itemKey: r.item_key,
    kind: r.kind,
    title: r.title,
    poster: r.poster,
    season: r.season,
    episode: r.episode,
    release: {
      title: stored.release.title,
      quality: stored.release.quality,
      sizeBytes: stored.release.sizeBytes,
      pluginName: stored.release.pluginName,
    },
    status: r.status,
    progress: r.progress,
    bytesDone: r.bytes_done,
    bytesTotal: r.bytes_total,
    speed: r.speed,
    error: r.error,
    infoHash: r.info_hash,
    libraryItemId: r.library_item_id,
    ruleId: r.rule_id,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

const SELECT = 'SELECT d.*, a.username FROM downloads d LEFT JOIN accounts a ON a.id = d.account_id';

export function listDownloads(opts: { accountId?: string; status?: DownloadStatus[] } = {}): DownloadDTO[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.accountId) {
    where.push('d.account_id = ?');
    params.push(opts.accountId);
  }
  if (opts.status?.length) {
    where.push(`d.status IN (${opts.status.map(() => '?').join(',')})`);
    params.push(...opts.status);
  }
  const rows = db
    .prepare(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.created_at DESC LIMIT 500`)
    .all(...params) as DownloadRow[];
  return rows.map(toDTO);
}

function getRow(id: string): DownloadRow | undefined {
  return db.prepare(`${SELECT} WHERE d.id = ?`).get(id) as DownloadRow | undefined;
}

function libraryKindOf(ctx: MediaContext): LibraryKind {
  if (ctx.kind === 'music') return 'music';
  return ctx.kind;
}

/** Queue a server download; members without auto-approve wait for an admin. */
export function requestDownload(input: {
  accountId: string;
  profileId: string | null;
  release: Release;
  context: MediaContext;
  itemKey: string | null;
  poster: string | null;
  ruleId?: string | null;
}): DownloadDTO {
  if (!libraryEnabled()) throw new HttpError(503, 'Server downloads need a library volume (LIBRARY_DIR)');
  const ctx = input.context;
  const dup = db
    .prepare(
      `SELECT id FROM downloads WHERE media_id = ? AND COALESCE(season, -1) = ? AND COALESCE(episode, -1) = ?
         AND status IN ('pending','queued','downloading','completed')`,
    )
    .get(ctx.mediaId, ctx.season ?? -1, ctx.episode ?? -1) as { id: string } | undefined;
  if (dup) return toDTO(getRow(dup.id)!);

  const isAdmin = (db.prepare('SELECT is_admin FROM accounts WHERE id = ?').get(input.accountId) as { is_admin: number } | undefined)?.is_admin === 1;
  const settings = getAccountSettings(input.accountId, isAdmin);
  if (!settings.downloadsEnabled) throw new HttpError(403, 'Downloads are not enabled for this account');
  const status: DownloadStatus = settings.autoApproveDownloads ? 'queued' : 'pending';
  const id = newId();
  const label =
    ctx.kind === 'tv' ? `${ctx.title} · S${ctx.season}E${ctx.episode}` : ctx.kind === 'anime' && ctx.episode ? `${ctx.title} · E${ctx.episode}` : ctx.title;
  db.prepare(
    `INSERT INTO downloads (id, account_id, profile_id, media_id, item_key, kind, title, poster, season, episode, release, status, bytes_total, rule_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.accountId,
    input.profileId,
    ctx.mediaId,
    input.itemKey,
    input.release.kind,
    label,
    input.poster,
    ctx.season,
    ctx.episode,
    JSON.stringify({ release: input.release, context: ctx } satisfies StoredRelease),
    status,
    input.release.sizeBytes,
    input.ruleId ?? null,
  );
  if (status === 'pending') {
    notifyAdmins({ kind: 'download-approval', title: `Download request: ${label}`, body: input.release.title, link: '/admin/downloads' });
  }
  return toDTO(getRow(id)!);
}

export function approveDownload(id: string, by: string, approve: boolean): void {
  const row = getRow(id);
  if (!row) throw new HttpError(404, 'Download not found');
  if (row.status !== 'pending') throw new HttpError(409, 'This request was already handled');
  db.prepare("UPDATE downloads SET status = ?, approved_by = ?, updated_at = datetime('now') WHERE id = ?").run(
    approve ? 'queued' : 'cancelled',
    by,
    id,
  );
  if (row.account_id) {
    notify(row.account_id, {
      kind: 'download',
      title: approve ? `Approved: ${row.title}` : `Declined: ${row.title}`,
      link: '/library?tab=downloads',
    });
  }
}

// ---------------------------------------------------------------- runner

const active = new Map<string, { torrent?: Torrent; abort?: AbortController }>();

function incomingDir(id: string): string {
  return path.join(libraryRoot(), '.incoming', id);
}

function setStatus(id: string, patch: Partial<Pick<DownloadRow, 'status' | 'error' | 'progress' | 'bytes_done' | 'bytes_total' | 'speed' | 'info_hash' | 'library_item_id'>>): void {
  const sets = Object.keys(patch).map((k) => `${k} = @${k}`);
  db.prepare(`UPDATE downloads SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = @id`).run({ ...patch, id });
}

function finish(row: DownloadRow, files: { abs: string; name: string }[]): void {
  const stored = JSON.parse(row.release) as StoredRelease;
  const ctx = stored.context;
  const kind = libraryKindOf(ctx);
  const root = libraryRoot();
  const itemId = ensureItem({
    mediaId: ctx.kind === 'music' || ctx.kind === 'book' || ctx.kind === 'comic' ? null : ctx.mediaId,
    kind,
    title: ctx.title,
    year: ctx.year,
    poster: row.poster,
    addedBy: row.account_id,
  });
  for (const f of files) {
    // Packs: every file carries its own episode number.
    const parsed = files.length > 1 ? parseName(f.name) : null;
    const season = ctx.kind === 'tv' ? parsed?.season ?? ctx.season : null;
    const episode = files.length === 1 ? ctx.episode : parsed?.episode ?? null;
    const rel = organizedPath({
      kind,
      title: ctx.title,
      year: ctx.year,
      season,
      episode,
      creator: ctx.creator,
      fileName: f.name,
    }).split(path.sep).join('/');
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.renameSync(f.abs, target);
    } catch {
      fs.copyFileSync(f.abs, target);
      fs.rmSync(f.abs, { force: true });
    }
    addFile(itemId, rel, fs.statSync(target).size, season, episode);
  }
  fs.rmSync(incomingDir(row.id), { recursive: true, force: true });
  db.prepare(
    "UPDATE downloads SET status = 'completed', progress = 1, speed = 0, library_item_id = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
  ).run(itemId, row.id);
  if (row.account_id) notify(row.account_id, { kind: 'download', title: `Ready: ${row.title}`, link: `/title/${ctx.mediaId.replace(':', '/')}` });
}

function fail(id: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  setStatus(id, { status: 'failed', error: msg.slice(0, 500), speed: 0 });
  active.delete(id);
}

function wantFiles(t: Torrent, release: Release, ctx: MediaContext): number[] {
  const all = t.files.map((f, i) => ({ f, i }));
  if (release.kind !== 'video') {
    const want = all.filter(({ f }) => fileKind(f.name) === (release.kind === 'comic' ? 'comic' : release.kind));
    return want.map((w) => w.i);
  }
  if (release.fileIdx != null && t.files[release.fileIdx]) return [release.fileIdx];
  const videos = all.filter(({ f }) => VIDEO_EXT.test(f.name) && !/\bsample\b/i.test(f.name));
  if (ctx.kind === 'movie' || ctx.episode != null) {
    return videos.sort((a, b) => b.f.length - a.f.length).slice(0, 1).map((v) => v.i);
  }
  return videos.map((v) => v.i);
}

async function startTorrent(row: DownloadRow, stored: StoredRelease, magnet: string | null, buf: Buffer | null): Promise<void> {
  const { client: getClient, find, markDownload } = engine();
  const client = await getClient();
  const dir = incomingDir(row.id);
  fs.mkdirSync(dir, { recursive: true });
  const hashMatch = magnet?.match(/btih:([a-fA-F0-9]{40})/);
  if (hashMatch && find(hashMatch[1]!.toLowerCase())) {
    // Someone is streaming this exact torrent from scratch right now; wait for
    // the stream cache to release it instead of cutting their playback.
    setStatus(row.id, { status: 'queued', error: 'Waiting for an active stream of this release to finish' });
    active.delete(row.id);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out fetching torrent metadata')), 120_000);
    const t = client.add(magnet ?? buf!, { path: dir, uploads: 0, alwaysChokeSeeders: true, deselect: true }, (torrent) => {
      clearTimeout(timer);
      markDownload(torrent.infoHash, true);
      const want = new Set(wantFiles(torrent, stored.release, stored.context));
      if (!want.size) {
        reject(new Error('No usable file in this torrent'));
        return;
      }
      torrent.files.forEach((f, i) => (want.has(i) ? f.select() : f.deselect()));
      const total = [...want].reduce((n, i) => n + torrent.files[i]!.length, 0);
      setStatus(row.id, { status: 'downloading', info_hash: torrent.infoHash, bytes_total: total });
      active.set(row.id, { torrent });
      const tick = setInterval(() => {
        const done = [...want].reduce((n, i) => n + Math.min(torrent.files[i]!.downloaded, torrent.files[i]!.length), 0);
        setStatus(row.id, { progress: total ? done / total : 0, bytes_done: done, speed: Math.round(torrent.downloadSpeed) });
        if (done >= total) {
          clearInterval(tick);
          const files = [...want].map((i) => ({ abs: path.join(dir, torrent.files[i]!.path), name: torrent.files[i]!.name }));
          torrent.destroy(() => {
            markDownload(torrent.infoHash, false);
            active.delete(row.id);
            try {
              finish(getRow(row.id)!, files);
            } catch (err) {
              fail(row.id, err);
            }
          });
        }
      }, 2000);
      torrent.on('close', () => clearInterval(tick));
      resolve();
    });
    t.on('error', (err: unknown) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error('torrent error'));
    });
  });
}

async function startHttp(row: DownloadRow, url: string, headers: Record<string, string> | null, stored: StoredRelease): Promise<void> {
  const dir = incomingDir(row.id);
  fs.mkdirSync(dir, { recursive: true });
  const name = stored.release.fileName ?? `${stored.context.title}.mkv`;
  const abs = path.join(dir, path.basename(name));
  const abort = new AbortController();
  active.set(row.id, { abort });
  const res = await fetch(url, { headers: headers ?? {}, signal: abort.signal });
  if (!res.ok || !res.body) throw new Error(`Remote answered ${res.status}`);
  const total = Number(res.headers.get('content-length')) || stored.release.sizeBytes;
  setStatus(row.id, { status: 'downloading', bytes_total: total });
  let done = 0;
  let last = Date.now();
  let lastBytes = 0;
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
  body.on('data', (c: Buffer) => {
    done += c.length;
    const now = Date.now();
    if (now - last > 2000) {
      setStatus(row.id, { progress: total ? done / total : 0, bytes_done: done, speed: Math.round(((done - lastBytes) * 1000) / (now - last)) });
      last = now;
      lastBytes = done;
    }
  });
  pipeline(body, fs.createWriteStream(abs))
    .then(() => {
      active.delete(row.id);
      finish(getRow(row.id)!, [{ abs, name: path.basename(name) }]);
    })
    .catch((err: unknown) => fail(row.id, err));
}

async function startOne(row: DownloadRow): Promise<void> {
  const stored = JSON.parse(row.release) as StoredRelease;
  setStatus(row.id, { status: 'downloading', error: null });
  active.set(row.id, {});
  try {
    const resolved = await resolveRelease(stored.release, stored.context);
    if (resolved.url) await startHttp(row, resolved.url, resolved.headers, stored);
    else await startTorrent(row, stored, resolved.magnet, resolved.torrent);
  } catch (err) {
    fail(row.id, err);
  }
}

function hasRoom(bytes: number): boolean {
  const s = storageStats();
  if (!s) return false;
  if (s.maxBytes && s.usedByLibrary + bytes > s.maxBytes) return false;
  return !s.totalBytes || s.freeBytes > bytes + 2e9;
}

/** Starts queued downloads up to the concurrency limit. */
export async function pumpDownloads(): Promise<void> {
  if (!libraryEnabled()) return;
  const running = active.size;
  const slots = config.library.maxConcurrentDownloads - running;
  if (slots <= 0) return;
  const queued = db
    .prepare("SELECT * FROM downloads WHERE status = 'queued' ORDER BY created_at LIMIT ?")
    .all(slots) as DownloadRow[];
  for (const row of queued) {
    const stored = JSON.parse(row.release) as StoredRelease;
    if (!hasRoom(stored.release.sizeBytes)) {
      setStatus(row.id, { status: 'failed', error: 'Not enough space in the library volume' });
      continue;
    }
    void startOne(row);
  }
}

export function cancelDownload(id: string, accountId: string, isAdmin: boolean): void {
  const row = getRow(id);
  if (!row) throw new HttpError(404, 'Download not found');
  if (!isAdmin && row.account_id !== accountId) throw new HttpError(403, 'Not your download');
  const a = active.get(id);
  if (a?.torrent) {
    engine().markDownload(a.torrent.infoHash, false);
    a.torrent.destroy({ destroyStore: true });
  }
  a?.abort?.abort();
  active.delete(id);
  if (libraryEnabled()) fs.rmSync(incomingDir(id), { recursive: true, force: true });
  if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') {
    db.prepare('DELETE FROM downloads WHERE id = ?').run(id);
  } else {
    setStatus(id, { status: 'cancelled', speed: 0 });
  }
}

export function retryDownload(id: string): void {
  const row = getRow(id);
  if (!row || (row.status !== 'failed' && row.status !== 'cancelled')) throw new HttpError(409, 'Nothing to retry');
  setStatus(id, { status: 'queued', error: null, progress: 0, bytes_done: 0 });
}

/** After a restart, in-flight downloads go back to the queue (torrents resume from their pieces). */
export function recoverDownloads(): void {
  db.prepare("UPDATE downloads SET status = 'queued', speed = 0 WHERE status = 'downloading'").run();
}
