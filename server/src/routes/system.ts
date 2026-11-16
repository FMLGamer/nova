/**
 * App-level endpoints: public client config, the desktop app's sign-in, and the
 * local streaming engine that lets a web Nova (TORRENT_MODE=client) stream
 * torrents on this computer.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { COOKIE_NAME, config } from '../config.js';
import { requireAdmin, requireAuth } from '../auth/middleware.js';
import { signSession } from '../auth/tokens.js';
import { db } from '../db/index.js';
import { signToken, verifyToken, randomToken } from '../lib/crypto.js';
import { HttpError } from '../lib/http.js';
import { asyncHandler } from '../lib/async.js';

export const VERSION = '2.2.0';

export const systemRouter = Router();

/** What the web client needs to know before signing in. */
systemRouter.get('/config', (_req, res) => {
  res.json({
    version: VERSION,
    mode: config.mode,
    torrentMode: config.torrentMode,
    enginePort: config.enginePort,
    desktopDownloadUrl: config.desktopDownloadUrl,
  });
});

const isLoopback = (req: Request) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');

function owner(): { id: string } {
  const row = db.prepare('SELECT id FROM accounts WHERE is_admin = 1 ORDER BY created_at LIMIT 1').get() as { id: string } | undefined;
  if (!row) throw new HttpError(503, 'No owner account yet');
  return row;
}

function ownerProfile(accountId: string): string | null {
  const row = db.prepare('SELECT id FROM profiles WHERE account_id = ? ORDER BY sort_order LIMIT 1').get(accountId) as { id: string } | undefined;
  return row?.id ?? null;
}

// ---------------------------------------------------------------- desktop sign-in

/** The desktop shell exchanges its per-launch key for the owner's session. */
systemRouter.post('/desktop/session', (req, res) => {
  const key = process.env.NOVA_DESKTOP_KEY ?? '';
  const given = String(req.header('x-nova-desktop-key') ?? '');
  const ok = config.mode === 'desktop' && key.length >= 32 && given.length === key.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key));
  if (!ok || !isLoopback(req)) throw new HttpError(403, 'Not available');
  res.json({ token: signSession(owner().id, 365 * 24 * 3600), maxAge: 365 * 24 * 3600 });
});

// ---------------------------------------------------------------- engine pairing

interface Pairing {
  id: string;
  origin: string;
  createdAt: string;
}

const pairingsFile = () => path.join(config.dataDir, 'engine-pairings.json');

function loadPairings(): Pairing[] {
  try {
    return JSON.parse(fs.readFileSync(pairingsFile(), 'utf8')) as Pairing[];
  } catch {
    return [];
  }
}

function savePairings(list: Pairing[]): void {
  fs.writeFileSync(pairingsFile(), JSON.stringify(list, null, 2));
}

/** Asks the desktop shell (over the IPC channel it spawned us with) whether to allow a site. */
const pendingAsks = new Map<string, (allow: boolean) => void>();
process.on('message', (m: unknown) => {
  const msg = m as { type?: string; id?: string; allow?: boolean };
  if (msg?.type === 'pair-response' && msg.id) {
    pendingAsks.get(msg.id)?.(Boolean(msg.allow));
    pendingAsks.delete(msg.id);
  }
});

function askOwner(origin: string): Promise<boolean> {
  if (!process.send) return Promise.resolve(false);
  const id = randomToken(8);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingAsks.delete(id);
      resolve(false);
    }, 120_000);
    pendingAsks.set(id, (allow) => {
      clearTimeout(timer);
      resolve(allow);
    });
    process.send!({ type: 'pair-request', id, origin });
  });
}

function engineCors(req: Request, res: Response, origin: string | null): void {
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.header('access-control-request-private-network')) res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function validOrigin(o: string | undefined): string | null {
  if (!o) return null;
  try {
    const u = new URL(o);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

export const engineRouter = Router();

engineRouter.use((req, res, next) => {
  if (config.mode !== 'desktop') throw new HttpError(404, 'Not found');
  engineCors(req, res, validOrigin(req.header('origin')));
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

/** Lets a web Nova discover that this computer can stream for it. */
engineRouter.get('/info', (_req, res) => {
  res.json({ nova: true, engine: 1, version: VERSION });
});

engineRouter.post(
  '/pair',
  asyncHandler(async (req, res) => {
    const origin = validOrigin(req.header('origin'));
    if (!origin) throw new HttpError(400, 'Pairing must come from a website');
    const list = loadPairings();
    let pairing = list.find((p) => p.origin === origin);
    if (!pairing) {
      if (!(await askOwner(origin))) throw new HttpError(403, 'Streaming on this computer was not allowed');
      pairing = { id: randomToken(12), origin, createdAt: new Date().toISOString() };
      savePairings([...loadPairings().filter((p) => p.origin !== origin), pairing]);
    }
    res.json({ token: signToken({ eng: pairing.id, o: origin }, 365 * 24 * 3600) });
  }),
);

/** Sites allowed to stream through this computer (managed in Settings). */
export const pairingsRouter = Router();
pairingsRouter.use(requireAuth, requireAdmin);
pairingsRouter.get('/', (_req, res) => {
  res.json({ pairings: config.mode === 'desktop' ? loadPairings() : [] });
});
pairingsRouter.delete('/:id', (req, res) => {
  savePairings(loadPairings().filter((p) => p.id !== req.params.id));
  res.status(204).end();
});

/**
 * /engine/<token>/<path>: a paired site's player reads /stream/* and calls
 * /api/play/* on this computer, signed in as the owner. The token is in the path
 * because <video src> can't carry headers and third-party cookies are blocked.
 */
export function engineGateway(app: express.Express) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (config.mode !== 'desktop') return next();
    const claims = verifyToken<{ eng: string; o: string }>(req.params.token ?? '');
    const pairing = claims ? loadPairings().find((p) => p.id === claims.eng) : undefined;
    const origin = validOrigin(req.header('origin'));
    if (!claims || !pairing || (origin && origin !== pairing.origin)) {
      engineCors(req, res, origin);
      res.status(401).json({ error: 'This computer is no longer paired; connect again' });
      return;
    }
    engineCors(req, res, pairing.origin);
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    const rest = req.url;
    // Casting from a paired site happens here too: this computer is the one on the TV's network.
    if (!rest.startsWith('/stream/') && !rest.startsWith('/api/play/') && !rest.startsWith('/api/cast/')) {
      res.status(404).json({ error: 'Not available through the engine' });
      return;
    }
    const acc = owner();
    req.headers.cookie = `${COOKIE_NAME}=${signSession(acc.id, 600)}`;
    const profile = ownerProfile(acc.id);
    if (profile) req.headers['x-profile-id'] = profile;
    req.url = rest;
    app(req, res);
  };
}
