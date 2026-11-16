import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireProfile } from '../auth/middleware.js';
import { db } from '../db/index.js';
import { newId } from '../lib/crypto.js';
import { HttpError, parse } from '../lib/http.js';

export const readingRouter = Router();
readingRouter.use(requireAuth, requireProfile);

interface ProgressRow {
  item_key: string;
  kind: string;
  title: string | null;
  cover: string | null;
  author: string | null;
  locator: string | null;
  percent: number;
  source: string | null;
  updated_at: string;
}

const toProgress = (r: ProgressRow) => ({
  itemKey: r.item_key,
  kind: r.kind,
  title: r.title,
  cover: r.cover,
  author: r.author,
  locator: r.locator,
  percent: r.percent,
  source: r.source ? (JSON.parse(r.source) as unknown) : null,
  updatedAt: r.updated_at,
});

readingRouter.get('/progress', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM reading_progress WHERE profile_id = ? ORDER BY updated_at DESC LIMIT 100')
    .all(req.profile!.id) as ProgressRow[];
  res.json({ items: rows.map(toProgress) });
});

readingRouter.get('/progress/:itemKey', (req, res) => {
  const row = db
    .prepare('SELECT * FROM reading_progress WHERE profile_id = ? AND item_key = ?')
    .get(req.profile!.id, req.params.itemKey) as ProgressRow | undefined;
  res.json({ progress: row ? toProgress(row) : null });
});

const progressSchema = z.object({
  itemKey: z.string().min(1).max(300),
  kind: z.enum(['book', 'comic', 'manga', 'audiobook', 'pdf']),
  title: z.string().max(300).nullish(),
  cover: z.string().max(2000).nullish(),
  author: z.string().max(300).nullish(),
  locator: z.string().max(4000).nullish(),
  percent: z.number().min(0).max(1),
  source: z.record(z.unknown()).nullish(),
});

readingRouter.put('/progress', (req, res) => {
  const b = parse(progressSchema, req.body);
  db.prepare(
    `INSERT INTO reading_progress (profile_id, item_key, kind, title, cover, author, locator, percent, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(profile_id, item_key) DO UPDATE SET
       kind = excluded.kind, title = COALESCE(excluded.title, reading_progress.title),
       cover = COALESCE(excluded.cover, reading_progress.cover), author = COALESCE(excluded.author, reading_progress.author),
       locator = excluded.locator, percent = excluded.percent,
       source = COALESCE(excluded.source, reading_progress.source), updated_at = excluded.updated_at`,
  ).run(
    req.profile!.id,
    b.itemKey,
    b.kind,
    b.title ?? null,
    b.cover ?? null,
    b.author ?? null,
    b.locator ?? null,
    b.percent,
    b.source ? JSON.stringify(b.source) : null,
  );
  res.json({ ok: true });
});

readingRouter.delete('/progress/:itemKey', (req, res) => {
  db.prepare('DELETE FROM reading_progress WHERE profile_id = ? AND item_key = ?').run(req.profile!.id, req.params.itemKey);
  res.status(204).end();
});

// ---------------------------------------------------------------- highlights, notes, bookmarks

interface AnnotationRow {
  id: string;
  item_key: string;
  kind: 'highlight' | 'note' | 'bookmark';
  locator: string;
  text: string | null;
  note: string | null;
  color: string | null;
  created_at: string;
  updated_at: string;
}

const toAnnotation = (r: AnnotationRow) => ({
  id: r.id,
  itemKey: r.item_key,
  kind: r.kind,
  locator: r.locator,
  text: r.text,
  note: r.note,
  color: r.color,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

readingRouter.get('/annotations', (req, res) => {
  const itemKey = typeof req.query.itemKey === 'string' ? req.query.itemKey : null;
  const rows = (itemKey
    ? db.prepare('SELECT * FROM annotations WHERE profile_id = ? AND item_key = ? ORDER BY created_at').all(req.profile!.id, itemKey)
    : db.prepare('SELECT * FROM annotations WHERE profile_id = ? ORDER BY updated_at DESC LIMIT 500').all(req.profile!.id)) as AnnotationRow[];
  res.json({ annotations: rows.map(toAnnotation) });
});

const annotationSchema = z.object({
  itemKey: z.string().min(1).max(300),
  kind: z.enum(['highlight', 'note', 'bookmark']),
  locator: z.string().min(1).max(4000),
  text: z.string().max(5000).nullish(),
  note: z.string().max(10000).nullish(),
  color: z.string().max(20).nullish(),
});

readingRouter.post('/annotations', (req, res) => {
  const b = parse(annotationSchema, req.body);
  const id = newId();
  db.prepare('INSERT INTO annotations (id, profile_id, item_key, kind, locator, text, note, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    req.profile!.id,
    b.itemKey,
    b.kind,
    b.locator,
    b.text ?? null,
    b.note ?? null,
    b.color ?? null,
  );
  res.status(201).json({ annotation: toAnnotation(db.prepare('SELECT * FROM annotations WHERE id = ?').get(id) as AnnotationRow) });
});

readingRouter.patch('/annotations/:id', (req, res) => {
  const b = parse(z.object({ note: z.string().max(10000).nullish(), color: z.string().max(20).nullish() }), req.body);
  const info = db
    .prepare("UPDATE annotations SET note = COALESCE(?, note), color = COALESCE(?, color), updated_at = datetime('now') WHERE id = ? AND profile_id = ?")
    .run(b.note ?? null, b.color ?? null, req.params.id, req.profile!.id);
  if (!info.changes) throw new HttpError(404, 'Not found');
  res.json({ ok: true });
});

readingRouter.delete('/annotations/:id', (req, res) => {
  db.prepare('DELETE FROM annotations WHERE id = ? AND profile_id = ?').run(req.params.id, req.profile!.id);
  res.status(204).end();
});
