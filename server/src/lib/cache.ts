import { db } from '../db/index.js';

interface Entry {
  value: unknown;
  expires: number;
}

const store = new Map<string, Entry>();
const pending = new Map<string, Promise<unknown>>();

/**
 * Answers from outside services that are kept across restarts. When one has expired it is still
 * served while a fresh copy is fetched (if that takes longer than STALE_WAIT_MS), so the first
 * minutes after a start never wait on, or run into, an upstream rate limit.
 */
const PERSISTED = ['anilist:', 'anizip:', 'tmdb:', 'cinemeta:', 'read:ani', 'read:ol', 'arm:', 'kitsu:', 'lists:', 'jikan:'];
const STALE_FOR_MS = 7 * 24 * 3600_000;
const STALE_WAIT_MS = 2_500;

const persisted = (key: string) => PERSISTED.some((p) => key.startsWith(p));

function load(key: string): Entry | null {
  const row = db.prepare('SELECT value, expires_at FROM upstream_cache WHERE key = ?').get(key) as { value: string; expires_at: number } | undefined;
  if (!row) return null;
  try {
    return { value: JSON.parse(row.value), expires: row.expires_at };
  } catch {
    return null;
  }
}

function save(key: string, e: Entry): void {
  try {
    db.prepare('INSERT INTO upstream_cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at').run(
      key,
      JSON.stringify(e.value),
      e.expires,
    );
  } catch (err) {
    console.error('[cache] could not keep', key, (err as Error).message);
  }
}

/** Memoise an async result for `ttlMs`. Keeps upstream calls cheap; concurrent misses share one call. */
export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  let hit = store.get(key);
  const keep = persisted(key);
  if (!hit && keep) {
    const disk = load(key);
    if (disk) store.set(key, (hit = disk));
  }
  if (hit && hit.expires > now) return hit.value as T;

  let p = pending.get(key) as Promise<T> | undefined;
  if (!p) {
    p = fn()
      .then((value) => {
        const e = { value, expires: Date.now() + ttlMs };
        store.set(key, e);
        if (keep) save(key, e);
        return value;
      })
      .finally(() => pending.delete(key));
    pending.set(key, p);
  }
  const stale = keep && hit && hit.expires + STALE_FOR_MS > now ? hit : null;
  if (!stale) return p;
  // Fresh if it comes quickly; otherwise what we had, while the refresh carries on.
  const fallback = stale.value as T;
  return Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), STALE_WAIT_MS))]);
}

/** Drop a memoised entry so the next call fetches again. */
export function forget(key: string): void {
  store.delete(key);
  if (persisted(key)) db.prepare('DELETE FROM upstream_cache WHERE key = ?').run(key);
}

/** Old copies nobody asked for in a month. */
export function pruneCache(): void {
  db.prepare('DELETE FROM upstream_cache WHERE expires_at < ?').run(Date.now() - 30 * 24 * 3600_000);
}
