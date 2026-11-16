import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { newId } from '../lib/crypto.js';
import { HttpError } from '../lib/http.js';
import { detailFor } from '../services/catalog.js';
import { anilistSearch } from '../services/anilist.js';
import { bookDetail, searchBooks } from '../services/books.js';
import { tmdbSearch } from '../services/tmdb.js';
import { mimeForName } from '../services/torrentEngine.js';
import { fileKind, kindFromPath, normTitle, parseName, type LibraryKind } from './naming.js';

export interface LibraryFileDTO {
  id: string;
  path: string;
  size: number;
  season: number | null;
  episode: number | null;
  kind: string;
  mime: string | null;
}

export interface MatchCandidate {
  mediaId: string;
  title: string;
  year: number | null;
  poster: string | null;
  overview: string;
  confidence: number;
}

export interface LibraryItemDTO {
  id: string;
  mediaId: string | null;
  kind: LibraryKind;
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

interface ItemRow {
  id: string;
  media_id: string | null;
  kind: LibraryKind;
  title: string;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
  overview: string | null;
  metadata: string;
  overrides: string;
  match_status: LibraryItemDTO['matchStatus'];
  match_confidence: number | null;
  match_candidates: string | null;
  folder: string | null;
  private_account_id: string | null;
  added_at: string;
  file_count?: number;
  size_bytes?: number;
}

export function libraryEnabled(): boolean {
  return Boolean(config.library.dir);
}

export function libraryRoot(): string {
  if (!config.library.dir) throw new HttpError(503, 'No library volume is configured on this server');
  return path.resolve(config.library.dir);
}

/** Hand edits always win over provider metadata. */
function toDTO(r: ItemRow, accountId: string | null): LibraryItemDTO {
  const overrides = JSON.parse(r.overrides || '{}') as Record<string, unknown>;
  const pick = <T>(key: string, value: T): T => (key in overrides ? (overrides[key] as T) : value);
  return {
    id: r.id,
    mediaId: r.media_id,
    kind: r.kind,
    title: pick('title', r.title),
    year: pick('year', r.year),
    poster: pick('poster', r.poster),
    backdrop: pick('backdrop', r.backdrop),
    overview: pick('overview', r.overview),
    matchStatus: r.match_status,
    matchConfidence: r.match_confidence,
    candidates: r.match_candidates ? (JSON.parse(r.match_candidates) as MatchCandidate[]) : [],
    folder: r.folder,
    private: Boolean(r.private_account_id),
    privateMine: Boolean(accountId && r.private_account_id === accountId),
    overrides,
    fileCount: r.file_count ?? 0,
    sizeBytes: r.size_bytes ?? 0,
    addedAt: r.added_at,
  };
}

const ITEM_SELECT = `
  SELECT i.*, (SELECT COUNT(*) FROM library_files f WHERE f.item_id = i.id) AS file_count,
         (SELECT COALESCE(SUM(size), 0) FROM library_files f WHERE f.item_id = i.id) AS size_bytes
    FROM library_items i`;

/** Private items are only visible to the account that marked them. */
const VISIBLE = '(i.private_account_id IS NULL OR i.private_account_id = @account)';

export function listItems(accountId: string, opts: { kind?: string; status?: string; q?: string } = {}): LibraryItemDTO[] {
  const where = [VISIBLE];
  if (opts.kind) where.push('i.kind = @kind');
  if (opts.status) where.push('i.match_status = @status');
  if (opts.q) where.push('i.title LIKE @q');
  const rows = db
    .prepare(`${ITEM_SELECT} WHERE ${where.join(' AND ')} ORDER BY i.added_at DESC LIMIT 2000`)
    .all({ account: accountId, kind: opts.kind ?? null, status: opts.status ?? null, q: `%${opts.q ?? ''}%` }) as ItemRow[];
  return rows.map((r) => toDTO(r, accountId));
}

export function getItem(id: string, accountId: string | null): LibraryItemDTO & { files: LibraryFileDTO[] } {
  const row = db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(id) as ItemRow | undefined;
  if (!row || (row.private_account_id && row.private_account_id !== accountId)) throw new HttpError(404, 'Not in the library');
  return { ...toDTO(row, accountId), files: filesOf(id) };
}

export function filesOf(itemId: string): LibraryFileDTO[] {
  return db
    .prepare('SELECT id, path, size, season, episode, kind, mime FROM library_files WHERE item_id = ? ORDER BY season, episode, path')
    .all(itemId) as LibraryFileDTO[];
}

/** Files on the server for a catalogue title (drives "play from library" + episode badges). */
export function filesForMedia(mediaId: string, accountId: string): (LibraryFileDTO & { itemId: string })[] {
  return db
    .prepare(
      `SELECT f.id, f.path, f.size, f.season, f.episode, f.kind, f.mime, f.item_id AS itemId
         FROM library_files f JOIN library_items i ON i.id = f.item_id
        WHERE i.media_id = @media AND ${VISIBLE} ORDER BY f.season, f.episode`,
    )
    .all({ media: mediaId, account: accountId }) as (LibraryFileDTO & { itemId: string })[];
}

export function mediaIdsInLibrary(accountId: string): Set<string> {
  const rows = db
    .prepare(`SELECT DISTINCT i.media_id FROM library_items i WHERE i.media_id IS NOT NULL AND ${VISIBLE}`)
    .all({ account: accountId }) as { media_id: string }[];
  return new Set(rows.map((r) => r.media_id));
}

export function ensureItem(input: {
  mediaId: string | null;
  kind: LibraryKind;
  title: string;
  year?: number | null;
  poster?: string | null;
  backdrop?: string | null;
  overview?: string | null;
  folder?: string | null;
  addedBy?: string | null;
  matchStatus?: LibraryItemDTO['matchStatus'];
  confidence?: number | null;
  candidates?: MatchCandidate[];
}): string {
  if (input.mediaId) {
    const existing = db.prepare('SELECT id FROM library_items WHERE media_id = ? AND kind = ?').get(input.mediaId, input.kind) as
      | { id: string }
      | undefined;
    if (existing) return existing.id;
  }
  if (input.folder) {
    const existing = db.prepare('SELECT id FROM library_items WHERE folder = ?').get(input.folder) as { id: string } | undefined;
    if (existing) return existing.id;
  }
  const id = newId();
  db.prepare(
    `INSERT INTO library_items (id, media_id, kind, title, year, poster, backdrop, overview, folder, added_by,
                                match_status, match_confidence, match_candidates)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.mediaId,
    input.kind,
    input.title,
    input.year ?? null,
    input.poster ?? null,
    input.backdrop ?? null,
    input.overview ?? null,
    input.folder ?? null,
    input.addedBy ?? null,
    input.matchStatus ?? 'matched',
    input.confidence ?? null,
    input.candidates?.length ? JSON.stringify(input.candidates) : null,
  );
  return id;
}

export function addFile(itemId: string, rel: string, size: number, season: number | null, episode: number | null): string {
  const kind = fileKind(rel) ?? 'other';
  const existing = db.prepare('SELECT id FROM library_files WHERE path = ?').get(rel) as { id: string } | undefined;
  if (existing) {
    db.prepare('UPDATE library_files SET item_id = ?, size = ?, season = ?, episode = ? WHERE id = ?').run(
      itemId,
      size,
      season,
      episode,
      existing.id,
    );
    return existing.id;
  }
  const id = newId();
  db.prepare('INSERT INTO library_files (id, item_id, path, size, season, episode, kind, mime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    itemId,
    rel,
    size,
    season,
    episode,
    kind,
    mimeForName(rel),
  );
  return id;
}

// ---------------------------------------------------------------- matching

function confidence(want: string, wantYear: number | null, got: string, gotYear: number | null): number {
  const a = normTitle(want);
  const b = normTitle(got);
  let c: number;
  if (a === b) c = 0.85;
  else if (a && b && (a.startsWith(b) || b.startsWith(a))) c = 0.65;
  else {
    const ta = new Set(a.split(' '));
    const tb = new Set(b.split(' '));
    let hit = 0;
    for (const w of ta) if (tb.has(w)) hit++;
    c = (hit / Math.max(ta.size, tb.size, 1)) * 0.6;
  }
  if (wantYear && gotYear) c += Math.abs(wantYear - gotYear) <= 1 ? 0.12 : -0.25;
  return Math.max(0, Math.min(0.99, c));
}

export async function findCandidates(kind: LibraryKind, title: string, year: number | null): Promise<MatchCandidate[]> {
  if (!title) return [];
  let raw: { mediaId: string; title: string; year: number | null; poster: string | null; overview: string }[] = [];
  try {
    if (kind === 'movie' || kind === 'tv') {
      raw = (await tmdbSearch(kind, title)).slice(0, 8).map((i) => ({ mediaId: i.id, title: i.title, year: i.year, poster: i.poster, overview: i.overview }));
    } else if (kind === 'anime') {
      raw = (await anilistSearch(title)).slice(0, 8).map((i) => ({ mediaId: i.id, title: i.title, year: i.year, poster: i.poster, overview: i.overview }));
    } else if (kind === 'book') {
      raw = (await searchBooks(title)).slice(0, 8).map((b) => ({ mediaId: `book:${b.id}`, title: b.title, year: b.year, poster: b.cover, overview: b.author }));
    }
  } catch {
    return [];
  }
  return raw
    .map((r) => ({ ...r, confidence: confidence(title, year, r.title, r.year) }))
    .sort((x, y) => y.confidence - x.confidence)
    .slice(0, 6);
}

async function metadataFor(mediaId: string): Promise<{ title: string; year: number | null; poster: string | null; backdrop: string | null; overview: string | null }> {
  if (mediaId.startsWith('book:')) {
    const b = await bookDetail(mediaId.slice(5));
    return { title: b.title, year: b.year, poster: b.cover, backdrop: null, overview: b.description ?? null };
  }
  const d = await detailFor(mediaId);
  return { title: d.title, year: d.year, poster: d.poster, backdrop: d.backdrop, overview: d.overview };
}

/** Matches an item (and optionally every sibling in the same parent folder, e.g. a whole season). */
export async function applyMatch(itemId: string, mediaId: string, siblings: boolean): Promise<number> {
  const row = db.prepare('SELECT * FROM library_items WHERE id = ?').get(itemId) as ItemRow | undefined;
  if (!row) throw new HttpError(404, 'Not in the library');
  const meta = await metadataFor(mediaId);
  const ids = [itemId];
  if (siblings && row.folder) {
    const parent = path.dirname(row.folder);
    const sib = db
      .prepare("SELECT id FROM library_items WHERE id != ? AND folder LIKE ? AND match_status != 'matched'")
      .all(itemId, `${parent}%`) as { id: string }[];
    ids.push(...sib.map((s) => s.id));
  }
  const target = db.prepare('SELECT id FROM library_items WHERE media_id = ? AND kind = ?').get(mediaId, row.kind) as
    | { id: string }
    | undefined;
  const tx = db.transaction(() => {
    for (const id of ids) {
      if (target && target.id !== id) {
        // Merge into the item that already represents this title.
        db.prepare('UPDATE library_files SET item_id = ? WHERE item_id = ?').run(target.id, id);
        db.prepare('DELETE FROM library_items WHERE id = ?').run(id);
        continue;
      }
      db.prepare(
        `UPDATE library_items SET media_id = ?, title = ?, year = ?, poster = ?, backdrop = ?, overview = ?,
                match_status = 'matched', match_confidence = 1, match_candidates = NULL, updated_at = datetime('now')
          WHERE id = ?`,
      ).run(mediaId, meta.title, meta.year, meta.poster, meta.backdrop, meta.overview, id);
    }
  });
  tx();
  return ids.length;
}

export function setOverrides(itemId: string, patch: Record<string, unknown>): void {
  const row = db.prepare('SELECT overrides FROM library_items WHERE id = ?').get(itemId) as { overrides: string } | undefined;
  if (!row) throw new HttpError(404, 'Not in the library');
  const current = JSON.parse(row.overrides || '{}') as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (!['title', 'year', 'overview', 'poster', 'backdrop'].includes(k)) continue;
    if (v === null) delete current[k];
    else current[k] = v;
  }
  db.prepare("UPDATE library_items SET overrides = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(current), itemId);
}

/** Refresh provider metadata while preserving hand-edited fields (they live in `overrides`). */
export async function refreshMetadata(itemId: string): Promise<void> {
  const row = db.prepare('SELECT media_id FROM library_items WHERE id = ?').get(itemId) as { media_id: string | null } | undefined;
  if (!row?.media_id) return;
  const meta = await metadataFor(row.media_id);
  db.prepare(
    "UPDATE library_items SET title = ?, year = ?, poster = ?, backdrop = ?, overview = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(meta.title, meta.year, meta.poster, meta.backdrop, meta.overview, itemId);
}

export function setPrivate(itemId: string, accountId: string, on: boolean): void {
  const row = db.prepare('SELECT private_account_id FROM library_items WHERE id = ?').get(itemId) as
    | { private_account_id: string | null }
    | undefined;
  if (!row) throw new HttpError(404, 'Not in the library');
  if (row.private_account_id && row.private_account_id !== accountId) throw new HttpError(403, 'Another member owns this private title');
  db.prepare('UPDATE library_items SET private_account_id = ? WHERE id = ?').run(on ? accountId : null, itemId);
}

export function deleteItem(itemId: string, deleteFiles: boolean): void {
  if (deleteFiles && libraryEnabled()) {
    const root = libraryRoot();
    for (const f of filesOf(itemId)) {
      const abs = path.resolve(root, f.path);
      if (abs.startsWith(root)) fs.rmSync(abs, { force: true });
    }
  }
  db.prepare('DELETE FROM library_items WHERE id = ?').run(itemId);
}

// ---------------------------------------------------------------- scanning

function* walk(dir: string, root: string, depth = 0): Generator<{ rel: string; size: number }> {
  if (depth > 7) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(abs, root, depth + 1);
    else if (e.isFile()) {
      const k = fileKind(e.name);
      if (!k || k === 'subtitle') continue;
      if (k === 'video' && /\bsample\b/i.test(e.name)) continue;
      try {
        yield { rel: path.relative(root, abs).split(path.sep).join('/'), size: fs.statSync(abs).size };
      } catch {
        /* vanished mid-scan */
      }
    }
  }
}

let scanning = false;
export let lastScan: { at: string; added: number; review: number; removed: number } | null = null;

/** Picks up files dropped into the library volume and matches them to metadata. */
export async function scanLibrary(): Promise<{ added: number; review: number; removed: number }> {
  if (!libraryEnabled() || scanning) return { added: 0, review: 0, removed: 0 };
  scanning = true;
  try {
    const root = libraryRoot();
    const known = new Set((db.prepare('SELECT path FROM library_files').all() as { path: string }[]).map((r) => r.path));
    const seen = new Set<string>();
    let added = 0;
    let review = 0;
    for (const f of walk(root, root)) {
      seen.add(f.rel);
      if (known.has(f.rel)) continue;
      const parts = f.rel.split('/');
      const fk = fileKind(f.rel);
      const parsedFile = parseName(f.rel);
      let kind = kindFromPath(f.rel);
      if (!kind) {
        if (fk === 'book') kind = 'book';
        else if (fk === 'comic') kind = 'comic';
        else if (fk === 'audio') kind = 'music';
        else if (parsedFile.animeStyle) kind = 'anime';
        else kind = parsedFile.season != null || parsedFile.episode != null ? 'tv' : 'movie';
      }
      const grouped = (kind === 'tv' || kind === 'anime' || kind === 'movie') && parts.length > 2;
      const folder = grouped ? parts.slice(0, 2).join('/') : f.rel;
      const existing = db.prepare('SELECT id FROM library_items WHERE folder = ?').get(folder) as { id: string } | undefined;
      let itemId = existing?.id;
      if (!itemId) {
        const parsedFolder = grouped ? parseName(parts[1]!) : parsedFile;
        const title = parsedFolder.title || parsedFile.title;
        const year = parsedFolder.year ?? parsedFile.year;
        const candidates = kind === 'comic' || kind === 'music' ? [] : await findCandidates(kind, title, year);
        const best = candidates[0];
        const confident = best && best.confidence >= 0.75 && (candidates[1]?.confidence ?? 0) < best.confidence - 0.05;
        if (confident) {
          itemId = ensureItem({
            mediaId: best.mediaId,
            kind,
            title: best.title,
            year: best.year,
            poster: best.poster,
            overview: best.overview,
            folder,
            matchStatus: 'matched',
            confidence: best.confidence,
          });
          if (best.mediaId.split(':')[0] !== 'book') await refreshMetadata(itemId).catch(() => undefined);
        } else {
          itemId = ensureItem({
            mediaId: null,
            kind,
            title,
            year,
            poster: best?.poster ?? null,
            folder,
            matchStatus: kind === 'comic' || kind === 'music' ? 'unmatched' : 'review',
            confidence: best?.confidence ?? 0,
            candidates,
          });
          if (kind !== 'comic' && kind !== 'music') review++;
        }
      }
      addFile(itemId, f.rel, f.size, parsedFile.season ?? (parsedFile.episode != null ? 1 : null), parsedFile.episode);
      added++;
    }
    // Files that disappeared from disk.
    let removed = 0;
    for (const rel of known) {
      if (seen.has(rel)) continue;
      db.prepare('DELETE FROM library_files WHERE path = ?').run(rel);
      removed++;
    }
    db.prepare('DELETE FROM library_items WHERE id NOT IN (SELECT DISTINCT item_id FROM library_files)').run();
    lastScan = { at: new Date().toISOString(), added, review, removed };
    return { added, review, removed };
  } finally {
    scanning = false;
  }
}

export function storageStats(): { totalBytes: number; freeBytes: number; usedByLibrary: number; maxBytes: number | null } | null {
  if (!libraryEnabled()) return null;
  const used = (db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM library_files').get() as { n: number }).n;
  try {
    const s = fs.statfsSync(libraryRoot());
    return {
      totalBytes: s.blocks * s.bsize,
      freeBytes: s.bavail * s.bsize,
      usedByLibrary: used,
      maxBytes: config.library.maxGb > 0 ? config.library.maxGb * 1e9 : null,
    };
  } catch {
    return { totalBytes: 0, freeBytes: 0, usedByLibrary: used, maxBytes: config.library.maxGb > 0 ? config.library.maxGb * 1e9 : null };
  }
}
