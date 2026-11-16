import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../lib/async.js';
import { HttpError } from '../lib/http.js';
import { getAccountSettings } from '../services/entitlements.js';
import { albumDetail, artistAlbums, musicHome, searchAlbums } from '../services/music.js';
import { bookDetail, booksHome, searchBooks } from '../services/books.js';

export const libraryRouter = Router();
libraryRouter.use(requireAuth, (req, _res, next) => {
  const settings = getAccountSettings(req.account!.id, req.account!.is_admin === 1);
  if (!settings.musicBooksEnabled) return next(new HttpError(403, 'Music and books are not enabled for this account'));
  next();
});

// --- Music ---------------------------------------------------------------

libraryRouter.get(
  '/music/home',
  asyncHandler(async (_req, res) => {
    res.json({ rows: await musicHome() });
  }),
);

libraryRouter.get(
  '/music/search',
  asyncHandler(async (req, res) => {
    res.json({ albums: await searchAlbums(String(req.query.q ?? '')) });
  }),
);

libraryRouter.get(
  '/music/artist/:id',
  asyncHandler(async (req, res) => {
    res.json({ albums: await artistAlbums(req.params.id) });
  }),
);

libraryRouter.get(
  '/music/album/:id',
  asyncHandler(async (req, res) => {
    res.json({ album: await albumDetail(req.params.id) });
  }),
);

// --- Books ---------------------------------------------------------------

libraryRouter.get(
  '/books/home',
  asyncHandler(async (_req, res) => {
    res.json({ rows: await booksHome() });
  }),
);

libraryRouter.get(
  '/books/search',
  asyncHandler(async (req, res) => {
    res.json({ books: await searchBooks(String(req.query.q ?? '')) });
  }),
);

libraryRouter.get(
  '/books/detail/:id',
  asyncHandler(async (req, res) => {
    res.json({ book: await bookDetail(req.params.id) });
  }),
);

/**
 * Streams a public-domain file (Gutenberg EPUB, LibriVox MP3) through the app.
 * Going via the server keeps the browser on one origin, which the EPUB reader
 * needs in order to unzip the file, and avoids mixed-content issues.
 */
const ALLOWED_HOSTS = [
  'gutenberg.org',
  'www.gutenberg.org',
  'gutendex.com',
  'librivox.org',
  'www.archive.org',
  'archive.org',
  'ia800207.us.archive.org',
];

libraryRouter.get(
  '/fetch',
  asyncHandler(async (req, res) => {
    const raw = String(req.query.url ?? '');
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new HttpError(400, 'Invalid url');
    }
    const host = url.hostname.toLowerCase();
    const ok =
      url.protocol === 'https:' &&
      (ALLOWED_HOSTS.includes(host) || host.endsWith('.archive.org') || host.endsWith('.gutenberg.org'));
    if (!ok) throw new HttpError(400, 'Unsupported source');

    const upstream = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!upstream.ok || !upstream.body) throw new HttpError(502, 'Source fetch failed');
    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/octet-stream');
    const len = upstream.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  }),
);
