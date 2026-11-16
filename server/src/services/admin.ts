import { db } from '../db/index.js';
import { config } from '../config.js';
import { getAccountSettings, type AccountSettings } from './entitlements.js';
import { cacheUsage, listCache, type CacheEntry } from './torrentEngine.js';

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
  cache: CacheEntry[];
}

interface Row {
  id: string;
  username: string;
  is_admin: number;
  created_at: string;
  profiles: number;
  items_watched: number;
  watch_seconds: number | null;
  list_items: number;
  last_activity: string | null;
}

const MB = 1024 * 1024;

export function listAdminAccounts(): AdminAccount[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.username, a.is_admin, a.created_at,
              (SELECT COUNT(*) FROM profiles p WHERE p.account_id = a.id) AS profiles,
              (SELECT COUNT(*) FROM watch_progress w
                 JOIN profiles p ON p.id = w.profile_id WHERE p.account_id = a.id) AS items_watched,
              (SELECT SUM(w.position_seconds) FROM watch_progress w
                 JOIN profiles p ON p.id = w.profile_id WHERE p.account_id = a.id) AS watch_seconds,
              (SELECT COUNT(*) FROM my_list m
                 JOIN profiles p ON p.id = m.profile_id WHERE p.account_id = a.id) AS list_items,
              (SELECT MAX(w.updated_at) FROM watch_progress w
                 JOIN profiles p ON p.id = w.profile_id WHERE p.account_id = a.id) AS last_activity
         FROM accounts a
        ORDER BY a.is_admin DESC, a.username COLLATE NOCASE ASC`,
    )
    .all() as Row[];

  return rows.map((r) => {
    const settings = getAccountSettings(r.id, r.is_admin === 1);
    return {
      id: r.id,
      username: r.username,
      isAdmin: r.is_admin === 1,
      createdAt: r.created_at,
      settings,
      usage: {
        profiles: r.profiles,
        itemsWatched: r.items_watched,
        watchSeconds: Math.round(r.watch_seconds ?? 0),
        listItems: r.list_items,
        lastActivity: r.last_activity,
        cacheBytes: cacheUsage(r.id),
        cacheBudgetBytes: settings.cacheMb * MB,
      },
      cache: listCache(r.id),
    };
  });
}

export function countAdmins(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE is_admin = 1').get() as { n: number }).n;
}

export function deleteAccount(id: string): void {
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
}

export function cacheLimits(): { totalMb: number; ttlMinutes: number; keepPerAccount: number; minAccountMb: number } {
  return {
    totalMb: config.cache.totalMb,
    ttlMinutes: config.cache.ttlMinutes,
    keepPerAccount: config.cache.keepPerAccount,
    minAccountMb: config.cache.minAccountMb,
  };
}
