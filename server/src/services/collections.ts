import { db } from '../db/index.js';
import { newId } from '../lib/crypto.js';
import { HttpError } from '../lib/http.js';

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

interface Row {
  id: string;
  name: string;
  description: string | null;
  pinned: number;
  sort_order: number;
  updated_at: string;
}

function itemsOf(id: string, limit = 500): CollectionItem[] {
  return db
    .prepare(
      `SELECT media_id AS mediaId, media_type AS mediaType, title, poster, year, position
         FROM collection_items WHERE collection_id = ? ORDER BY position, added_at LIMIT ?`,
    )
    .all(id, limit) as CollectionItem[];
}

function toDTO(r: Row, preview: number): Collection {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM collection_items WHERE collection_id = ?').get(r.id) as { n: number }).n;
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    pinned: r.pinned === 1,
    sortOrder: r.sort_order,
    count,
    items: itemsOf(r.id, preview),
    updatedAt: r.updated_at,
  };
}

function own(id: string, profileId: string): Row {
  const r = db.prepare('SELECT * FROM collections WHERE id = ? AND profile_id = ?').get(id, profileId) as Row | undefined;
  if (!r) throw new HttpError(404, 'Collection not found');
  return r;
}

export function listCollections(profileId: string, preview = 20): Collection[] {
  const rows = db.prepare('SELECT * FROM collections WHERE profile_id = ? ORDER BY pinned DESC, sort_order, updated_at DESC').all(profileId) as Row[];
  return rows.map((r) => toDTO(r, preview));
}

export function getCollection(id: string, profileId: string): Collection {
  return toDTO(own(id, profileId), 500);
}

export function createCollection(profileId: string, input: { name: string; description?: string | null; pinned?: boolean }): Collection {
  const id = newId();
  const order = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM collections WHERE profile_id = ?').get(profileId) as { n: number }).n;
  db.prepare('INSERT INTO collections (id, profile_id, name, description, pinned, sort_order) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    profileId,
    input.name.trim(),
    input.description ?? null,
    input.pinned ? 1 : 0,
    order,
  );
  return getCollection(id, profileId);
}

export function updateCollection(id: string, profileId: string, patch: { name?: string; description?: string | null; pinned?: boolean; sortOrder?: number }): Collection {
  const r = own(id, profileId);
  db.prepare(
    "UPDATE collections SET name = ?, description = ?, pinned = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(
    patch.name?.trim() || r.name,
    patch.description === undefined ? r.description : patch.description,
    patch.pinned === undefined ? r.pinned : patch.pinned ? 1 : 0,
    patch.sortOrder ?? r.sort_order,
    id,
  );
  return getCollection(id, profileId);
}

export function deleteCollection(id: string, profileId: string): { name: string; items: CollectionItem[]; pinned: boolean } {
  const r = own(id, profileId);
  const items = itemsOf(id);
  db.prepare('DELETE FROM collections WHERE id = ?').run(id);
  return { name: r.name, items, pinned: r.pinned === 1 };
}

export function addToCollection(id: string, profileId: string, item: Omit<CollectionItem, 'position'>): void {
  own(id, profileId);
  const pos = (db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM collection_items WHERE collection_id = ?').get(id) as { n: number }).n;
  db.prepare(
    `INSERT INTO collection_items (collection_id, media_id, media_type, title, poster, year, position) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(collection_id, media_id) DO UPDATE SET title = excluded.title, poster = excluded.poster, year = excluded.year`,
  ).run(id, item.mediaId, item.mediaType, item.title, item.poster, item.year, pos);
  db.prepare("UPDATE collections SET updated_at = datetime('now') WHERE id = ?").run(id);
}

export function removeFromCollection(id: string, profileId: string, mediaId: string): void {
  own(id, profileId);
  db.prepare('DELETE FROM collection_items WHERE collection_id = ? AND media_id = ?').run(id, mediaId);
}

export function reorderCollection(id: string, profileId: string, mediaIds: string[]): void {
  own(id, profileId);
  const stmt = db.prepare('UPDATE collection_items SET position = ? WHERE collection_id = ? AND media_id = ?');
  db.transaction(() => mediaIds.forEach((m, i) => stmt.run(i, id, m)))();
}

/** Which of the profile's collections hold a title (for the title page toggle). */
export function collectionsContaining(profileId: string, mediaId: string): string[] {
  return (db
    .prepare('SELECT c.id FROM collections c JOIN collection_items i ON i.collection_id = c.id WHERE c.profile_id = ? AND i.media_id = ?')
    .all(profileId, mediaId) as { id: string }[]).map((r) => r.id);
}
