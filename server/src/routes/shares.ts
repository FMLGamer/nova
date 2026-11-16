import { Router, type Request } from 'express';
import { z } from 'zod';
import { GUEST_COOKIE, requireAuth, requireProfile, requireViewer } from '../auth/middleware.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { asyncHandler } from '../lib/async.js';
import { newId, randomToken, sha256, signToken } from '../lib/crypto.js';
import { HttpError, parse, publicUrl } from '../lib/http.js';
import { openSse } from '../lib/sse.js';
import { lookupRelease, searchSources } from '../plugins/sources.js';
import { detailFor, episodesFor } from '../services/catalog.js';
import { DEFAULT_PREFERENCES } from '../services/profiles.js';
import { prepareFromRelease } from '../streaming/play.js';
import { librarySource, resolveSource } from '../streaming/source.js';
import { allowGuestSource } from './stream.js';
import { filesForMedia } from '../library/library.js';

/**
 * Granular sharing: a whole server library, one collection or one title, with
 * an optional expiry. A guest redeems the link and gets a scoped cookie that
 * can only read and play what the share covers.
 */
export const sharesRouter = Router();

interface ShareRow {
  id: string;
  account_id: string;
  scope: 'title' | 'collection' | 'library';
  target: string;
  label: string | null;
  expires_at: string | null;
  revoked: number;
  uses: number;
  created_at: string;
  last_used_at: string | null;
}

const toDTO = (r: ShareRow) => ({
  id: r.id,
  scope: r.scope,
  target: r.target,
  label: r.label,
  expiresAt: r.expires_at,
  revoked: r.revoked === 1,
  uses: r.uses,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  expired: Boolean(r.expires_at && new Date(r.expires_at).getTime() < Date.now()),
});

// ---------------------------------------------------------------- owners
const createSchema = z.object({
  scope: z.enum(['title', 'collection', 'library']),
  target: z.string().min(1).max(200),
  label: z.string().max(120).nullish(),
  expiresInDays: z.number().min(0.04).max(365).nullish(),
});

sharesRouter.get('/', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM shares WHERE account_id = ? ORDER BY created_at DESC').all(req.account!.id) as ShareRow[];
  res.json({ shares: rows.map(toDTO) });
});

sharesRouter.post('/', requireAuth, requireProfile, (req, res) => {
  const b = parse(createSchema, req.body);
  if (b.scope === 'library' && req.account!.is_admin !== 1) throw new HttpError(403, 'Only admins can share the whole library');
  if (b.scope === 'collection') {
    const own = db.prepare('SELECT 1 FROM collections WHERE id = ? AND profile_id = ?').get(b.target, req.profile!.id);
    if (!own) throw new HttpError(404, 'Collection not found');
  }
  const token = randomToken(18);
  const id = newId();
  const expires = b.expiresInDays ? new Date(Date.now() + b.expiresInDays * 86400_000).toISOString() : null;
  db.prepare('INSERT INTO shares (id, token_hash, account_id, scope, target, label, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    sha256(token),
    req.account!.id,
    b.scope,
    b.target,
    b.label ?? null,
    expires,
  );
  res.status(201).json({ id, url: new URL(`/share/${token}`, publicUrl(req)).toString() });
});

sharesRouter.delete('/:id', requireAuth, (req, res) => {
  db.prepare('UPDATE shares SET revoked = 1 WHERE id = ? AND account_id = ?').run(req.params.id, req.account!.id);
  res.status(204).end();
});

// ---------------------------------------------------------------- guests
export const guestRouter = Router();

guestRouter.post('/redeem', (req, res) => {
  const { token } = parse(z.object({ token: z.string().min(10).max(100) }), req.body);
  const row = db.prepare('SELECT * FROM shares WHERE token_hash = ?').get(sha256(token)) as ShareRow | undefined;
  if (!row || row.revoked) throw new HttpError(404, 'This link is no longer valid');
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) throw new HttpError(410, 'This link has expired');
  db.prepare("UPDATE shares SET uses = uses + 1, last_used_at = datetime('now') WHERE id = ?").run(row.id);
  const ttl = row.expires_at ? Math.max(60, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000)) : 30 * 86400;
  res.cookie(GUEST_COOKIE, signToken({ g: row.id }, ttl), {
    httpOnly: true,
    secure: config.cookieSecure ?? req.secure,
    sameSite: 'lax',
    maxAge: ttl * 1000,
    path: '/',
  });
  res.json({ share: toDTO(row) });
});

guestRouter.use(requireViewer);

/** Titles a guest may see under their share. */
function allowedMediaIds(req: Request): Set<string> | 'any-library' {
  const g = req.guest;
  if (!g) throw new HttpError(403, 'Guests only');
  if (g.scope === 'title') return new Set([g.target]);
  if (g.scope === 'collection') {
    return new Set((db.prepare('SELECT media_id FROM collection_items WHERE collection_id = ?').all(g.target) as { media_id: string }[]).map((r) => r.media_id));
  }
  return 'any-library';
}

function assertAllowed(req: Request, mediaId: string): void {
  const allowed = allowedMediaIds(req);
  if (allowed === 'any-library') {
    const ok = db.prepare('SELECT 1 FROM library_items WHERE media_id = ? AND private_account_id IS NULL').get(mediaId);
    if (!ok) throw new HttpError(403, 'Not part of this share');
    return;
  }
  if (!allowed.has(mediaId)) throw new HttpError(403, 'Not part of this share');
}

guestRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    const g = req.guest;
    if (!g) {
      res.json({ guest: null });
      return;
    }
    const owner = db.prepare('SELECT username FROM accounts WHERE id = ?').get(g.accountId) as { username: string } | undefined;
    const allowed = allowedMediaIds(req);
    const ids =
      allowed === 'any-library'
        ? (db.prepare('SELECT DISTINCT media_id FROM library_items WHERE media_id IS NOT NULL AND private_account_id IS NULL LIMIT 300').all() as { media_id: string }[]).map((r) => r.media_id)
        : [...allowed];
    const items = (
      await Promise.all(ids.slice(0, 300).map((id) => detailFor(id).catch(() => null)))
    ).filter(Boolean);
    const share = db.prepare('SELECT * FROM shares WHERE id = ?').get(g.shareId) as ShareRow;
    res.json({ guest: { share: toDTO(share), owner: owner?.username ?? 'someone', items } });
  }),
);

guestRouter.get(
  '/title/:type/:id',
  asyncHandler(async (req, res) => {
    const mediaId = `${req.params.type}:${req.params.id}`;
    assertAllowed(req, mediaId);
    res.json({ detail: await detailFor(mediaId) });
  }),
);

guestRouter.get(
  '/title/:type/:id/episodes',
  asyncHandler(async (req, res) => {
    const mediaId = `${req.params.type}:${req.params.id}`;
    assertAllowed(req, mediaId);
    res.json({ episodes: await episodesFor(mediaId, Number(req.query.season) || 1) });
  }),
);

guestRouter.get(
  '/sources',
  asyncHandler(async (req, res) => {
    const mediaId = String(req.query.mediaId ?? '');
    assertAllowed(req, mediaId);
    const sse = openSse(req, res);
    const q = { mediaId, season: Number(req.query.season) || null, episode: Number(req.query.episode) || null };
    const files = filesForMedia(mediaId, req.guest!.accountId).filter(
      (f) => (q.episode == null || f.episode === q.episode) && (q.season == null || f.season == null || f.season === q.season),
    );
    try {
      const final = await searchSources(q, DEFAULT_PREFERENCES, (s) =>
        sse.send('update', { done: false, releases: s.releases.slice(0, 20), runs: s.runs, files }),
      );
      sse.send('done', { done: true, releases: final.releases.slice(0, 20), runs: final.runs, files });
    } catch (err) {
      sse.send('error', { error: (err as Error).message });
    } finally {
      sse.close();
    }
  }),
);

guestRouter.post(
  '/prepare',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ releaseId: z.string().optional(), fileId: z.string().optional() }), req.body);
    const g = req.guest!;
    if (b.fileId) {
      const row = db
        .prepare('SELECT i.media_id FROM library_files f JOIN library_items i ON i.id = f.item_id WHERE f.id = ? AND i.private_account_id IS NULL')
        .get(b.fileId) as { media_id: string | null } | undefined;
      if (!row?.media_id) throw new HttpError(404, 'File not found');
      assertAllowed(req, row.media_id);
      const src = librarySource(b.fileId);
      if (!src) throw new HttpError(404, 'File missing');
      allowGuestSource(g.shareId, src.key);
      res.json({ source: { kind: 'l', a: b.fileId, path: `/stream/l/${b.fileId}`, name: src.name, size: src.size, mime: src.mime, files: [], link: '' } });
      return;
    }
    const hit = b.releaseId ? lookupRelease(b.releaseId) : null;
    if (!hit) throw new HttpError(410, 'That source expired; search again');
    assertAllowed(req, hit.context.mediaId);
    const source = await prepareFromRelease(hit.release, hit.context, { accountId: g.accountId, title: `Guest: ${hit.context.title}` }, 'video');
    const resolved = resolveSource(source.kind, source.a, source.b);
    if (resolved) allowGuestSource(g.shareId, resolved.key);
    res.json({ source });
  }),
);
