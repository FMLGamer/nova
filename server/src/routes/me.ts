import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireProfile } from '../auth/middleware.js';
import { db } from '../db/index.js';
import { asyncHandler } from '../lib/async.js';
import { newId, randomToken, sha256 } from '../lib/crypto.js';
import { HttpError, parse } from '../lib/http.js';
import { calendar } from '../library/followed.js';
import {
  addToCollection,
  collectionsContaining,
  createCollection,
  deleteCollection,
  getCollection,
  listCollections,
  removeFromCollection,
  reorderCollection,
  updateCollection,
} from '../services/collections.js';
import { listNotifications, markNotificationsRead } from '../services/notifications.js';
import { getPreferences } from '../services/profiles.js';
import { dismiss as dismissRecommendation, recommendations } from '../services/recommend.js';
import { profileStats } from '../services/stats.js';
import { upNext } from '../services/upnext.js';

export const meRouter = Router();
meRouter.use(requireAuth);

// ---------------------------------------------------------------- notifications
meRouter.get('/notifications', (req, res) => {
  res.json({ notifications: listNotifications(req.account!.id) });
});

meRouter.post('/notifications/read', (req, res) => {
  markNotificationsRead(req.account!.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- api tokens (CLI, integrations)
meRouter.get('/tokens', (req, res) => {
  res.json({
    tokens: db
      .prepare('SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt FROM api_tokens WHERE account_id = ? ORDER BY created_at DESC')
      .all(req.account!.id),
  });
});

meRouter.post('/tokens', (req, res) => {
  if (req.viaToken) throw new HttpError(403, 'Tokens cannot mint tokens');
  const { name } = parse(z.object({ name: z.string().min(1).max(60) }), req.body);
  const token = `nova_${randomToken(30)}`;
  db.prepare('INSERT INTO api_tokens (id, account_id, name, token_hash) VALUES (?, ?, ?, ?)').run(newId(), req.account!.id, name, sha256(token));
  res.status(201).json({ token });
});

meRouter.delete('/tokens/:id', (req, res) => {
  db.prepare('DELETE FROM api_tokens WHERE id = ? AND account_id = ?').run(req.params.id, req.account!.id);
  res.status(204).end();
});

// ---------------------------------------------------------------- per-profile
meRouter.use(requireProfile);

meRouter.get(
  '/upnext',
  asyncHandler(async (req, res) => {
    const hidden = new Set(
      (db.prepare('SELECT item_key FROM upnext_dismissed WHERE profile_id = ?').all(req.profile!.id) as { item_key: string }[]).map((r) => r.item_key),
    );
    res.json({ items: (await upNext(req.profile!.id)).filter((u) => !hidden.has(u.itemKey)) });
  }),
);

meRouter.post('/upnext/dismiss', (req, res) => {
  const { itemKey } = parse(z.object({ itemKey: z.string().min(1).max(200) }), req.body);
  db.prepare('INSERT OR IGNORE INTO upnext_dismissed (profile_id, item_key) VALUES (?, ?)').run(req.profile!.id, itemKey);
  res.json({ ok: true });
});

meRouter.get(
  '/stats',
  asyncHandler(async (req, res) => {
    res.json(await profileStats(req.profile!.id));
  }),
);

meRouter.get(
  '/recommendations',
  asyncHandler(async (req, res) => {
    res.json(await recommendations(req.profile!.id));
  }),
);

meRouter.post('/recommendations/dismiss', (req, res) => {
  const { mediaId } = parse(z.object({ mediaId: z.string().min(3).max(200) }), req.body);
  dismissRecommendation(req.profile!.id, mediaId);
  res.json({ ok: true });
});

meRouter.get('/history', (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 60);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const rows = db
    .prepare(
      `SELECT item_key AS itemKey, media_type AS mediaType, media_id AS mediaId, season, episode,
              position_seconds AS positionSeconds, duration_seconds AS durationSeconds, finished,
              title, poster, backdrop, year, updated_at AS updatedAt
         FROM watch_progress WHERE profile_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    )
    .all(req.profile!.id, limit, offset) as { finished: number }[];
  res.json({ items: rows.map((r) => ({ ...r, finished: r.finished === 1 })) });
});

meRouter.post('/history/clear', (req, res) => {
  db.prepare('DELETE FROM watch_progress WHERE profile_id = ?').run(req.profile!.id);
  res.json({ ok: true });
});

meRouter.get(
  '/calendar',
  asyncHandler(async (req, res) => {
    const now = Math.floor(Date.now() / 1000);
    const from = Number(req.query.from) || now - 7 * 86400;
    const to = Number(req.query.to) || now + 28 * 86400;
    if (to - from > 62 * 86400) throw new HttpError(400, 'Range too large');
    const scope = (['followed', 'list', 'watching'] as const).find((s) => s === req.query.scope) ?? 'followed';
    res.json({ entries: await calendar(req.profile!.id, req.account!.id, from, to, scope) });
  }),
);

// ---------------------------------------------------------------- collections
meRouter.get('/collections', (req, res) => {
  res.json({ collections: listCollections(req.profile!.id) });
});

meRouter.get('/collections/containing/:mediaId', (req, res) => {
  res.json({ ids: collectionsContaining(req.profile!.id, decodeURIComponent(req.params.mediaId)) });
});

const collectionSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).nullish(),
  pinned: z.boolean().optional(),
});

meRouter.post('/collections', (req, res) => {
  res.status(201).json({ collection: createCollection(req.profile!.id, parse(collectionSchema, req.body)) });
});

meRouter.get('/collections/:id', (req, res) => {
  res.json({ collection: getCollection(req.params.id, req.profile!.id) });
});

meRouter.patch('/collections/:id', (req, res) => {
  const body = parse(collectionSchema.partial().extend({ sortOrder: z.number().int().optional() }), req.body);
  res.json({ collection: updateCollection(req.params.id, req.profile!.id, body) });
});

meRouter.delete('/collections/:id', (req, res) => {
  deleteCollection(req.params.id, req.profile!.id);
  res.status(204).end();
});

const itemSchema = z.object({
  mediaId: z.string().min(1),
  mediaType: z.string().min(1).max(20),
  title: z.string().nullish(),
  poster: z.string().nullish(),
  year: z.number().int().nullish(),
});

meRouter.post('/collections/:id/items', (req, res) => {
  const b = parse(itemSchema, req.body);
  addToCollection(req.params.id, req.profile!.id, {
    mediaId: b.mediaId,
    mediaType: b.mediaType,
    title: b.title ?? null,
    poster: b.poster ?? null,
    year: b.year ?? null,
  });
  res.status(201).json({ ok: true });
});

meRouter.delete('/collections/:id/items/:mediaId', (req, res) => {
  removeFromCollection(req.params.id, req.profile!.id, decodeURIComponent(req.params.mediaId));
  res.status(204).end();
});

meRouter.put('/collections/:id/order', (req, res) => {
  const { mediaIds } = parse(z.object({ mediaIds: z.array(z.string()).max(1000) }), req.body);
  reorderCollection(req.params.id, req.profile!.id, mediaIds);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- export (personal data)
meRouter.get('/export', (req, res) => {
  const p = req.profile!.id;
  const q = (sql: string) => db.prepare(sql).all(p);
  const data = {
    exportedAt: new Date().toISOString(),
    app: 'Nova',
    profile: { id: req.profile!.id, name: req.profile!.name },
    preferences: getPreferences(p),
    watchHistory: q('SELECT * FROM watch_progress WHERE profile_id = ?'),
    myList: q('SELECT * FROM my_list WHERE profile_id = ?'),
    collections: listCollections(p, 1000),
    readingProgress: q('SELECT * FROM reading_progress WHERE profile_id = ?'),
    annotations: q('SELECT * FROM annotations WHERE profile_id = ?'),
    liveFavorites: q('SELECT * FROM live_favorites WHERE profile_id = ?'),
  };
  res.setHeader('Content-Disposition', `attachment; filename="nova-${req.profile!.name.replace(/[^a-z0-9]+/gi, '-')}-export.json"`);
  res.json(data);
});
