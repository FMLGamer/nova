import { db } from '../db/index.js';
import type { Plugin } from './manager.js';
import type { ImportedHistory } from './protocol.js';
import { detailFor, episodesFor, searchAll } from '../services/catalog.js';
import { notify, notifyAdmins } from '../services/notifications.js';
import { upsertProgress } from '../services/library.js';
import { tmdbFindByImdb } from '../services/tmdb.js';

function requireScope(p: Plugin, scope: string): void {
  if (!p.granted.api.includes(scope)) {
    throw new Error(`permission '${scope}' was not granted to this plugin`);
  }
}

/** Has this account allowed the plugin to act on its behalf for `scope`? */
function userGranted(pluginId: string, accountId: string, scope: string): boolean {
  const row = db
    .prepare('SELECT scopes FROM plugin_user_grants WHERE plugin_id = ? AND account_id = ?')
    .get(pluginId, accountId) as { scopes: string } | undefined;
  return row ? (JSON.parse(row.scopes) as string[]).includes(scope) : false;
}

function requireUser(p: Plugin, accountId: string, scope: string): void {
  if (userGranted(p.id, accountId, scope)) return;
  notify(accountId, {
    kind: 'plugin-consent',
    title: `${p.manifest.name} wants to act on your behalf`,
    body: `It asked for '${scope}'. Review it under Settings → Connected plugins.`,
    link: `/settings?tab=plugins&grant=${encodeURIComponent(p.id)}:${encodeURIComponent(scope)}`,
  });
  throw new Error(`waiting for the user to approve '${scope}'`);
}

async function resolveImported(h: ImportedHistory): Promise<string | null> {
  if (h.ids.anilist) return `anime:${h.ids.anilist}`;
  if (h.ids.tmdb) return `${h.kind === 'movie' ? 'movie' : 'tv'}:${h.ids.tmdb}`;
  if (h.ids.imdb) return tmdbFindByImdb(h.ids.imdb).catch(() => null);
  return null;
}

/** Everything a sandboxed plugin can ask the host for. */
export async function hostCall(p: Plugin, method: string, args: unknown): Promise<unknown> {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (method) {
    case 'storage.get': {
      if (!p.granted.storage) throw new Error('storage permission was not granted');
      const row = db.prepare('SELECT value FROM plugin_kv WHERE plugin_id = ? AND key = ?').get(p.id, String(a.key)) as
        | { value: string }
        | undefined;
      return row ? JSON.parse(row.value) : null;
    }
    case 'storage.set': {
      if (!p.granted.storage) throw new Error('storage permission was not granted');
      const value = JSON.stringify(a.value ?? null);
      if (value.length > 1_000_000) throw new Error('value too large (1MB max)');
      db.prepare(
        `INSERT INTO plugin_kv (plugin_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value`,
      ).run(p.id, String(a.key), value);
      return null;
    }
    case 'storage.delete': {
      if (!p.granted.storage) throw new Error('storage permission was not granted');
      db.prepare('DELETE FROM plugin_kv WHERE plugin_id = ? AND key = ?').run(p.id, String(a.key));
      return null;
    }
    case 'api.catalog.search':
      requireScope(p, 'catalog.read');
      return searchAll(String(a.q ?? ''));
    case 'api.catalog.detail':
      requireScope(p, 'catalog.read');
      return detailFor(String(a.id));
    case 'api.catalog.episodes':
      requireScope(p, 'catalog.read');
      return episodesFor(String(a.id), Number(a.season ?? 1));
    case 'api.library.items':
      requireScope(p, 'library.read');
      return db
        .prepare('SELECT id, media_id AS mediaId, kind, title, year FROM library_items WHERE private_account_id IS NULL')
        .all();
    case 'api.users.list':
      requireScope(p, 'users.read');
      return db.prepare('SELECT id, username FROM accounts ORDER BY username').all();
    case 'api.notify':
      requireScope(p, 'notify');
      notifyAdmins({ kind: 'plugin', title: `${p.manifest.name}: ${String(a.title ?? '')}`, body: String(a.body ?? '') });
      return null;
    case 'api.progress.import': {
      requireScope(p, 'progress.write');
      const profileId = String(a.profileId ?? '');
      const owner = db.prepare('SELECT account_id FROM profiles WHERE id = ?').get(profileId) as
        | { account_id: string }
        | undefined;
      if (!owner) throw new Error('unknown profile');
      requireUser(p, owner.account_id, 'progress.write');
      let imported = 0;
      for (const h of (a.items as ImportedHistory[]) ?? []) {
        const mediaId = await resolveImported(h);
        if (!mediaId) continue;
        const mediaType = mediaId.split(':')[0]!;
        const itemKey =
          mediaType === 'movie'
            ? mediaId
            : mediaType === 'anime'
              ? `${mediaId}:e${h.episode ?? 1}`
              : `${mediaId}:s${h.season ?? 1}e${h.episode ?? 1}`;
        upsertProgress(profileId, {
          itemKey,
          mediaType,
          mediaId,
          season: mediaType === 'movie' ? null : h.season ?? 1,
          episode: mediaType === 'movie' ? null : h.episode ?? 1,
          positionSeconds: h.positionSeconds ?? 0,
          durationSeconds: h.durationSeconds ?? null,
          finished: h.finished ?? false,
          title: h.title ?? null,
        });
        imported++;
      }
      return { imported };
    }
    default:
      throw new Error(`unknown host method '${method}'`);
  }
}
