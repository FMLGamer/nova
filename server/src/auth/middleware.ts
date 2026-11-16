import type { Request, Response, NextFunction } from 'express';
import { COOKIE_NAME, config } from '../config.js';
import { verifySession } from './tokens.js';
import { getAccountById } from '../services/accounts.js';
import { getProfileForAccount } from '../services/profiles.js';
import { HttpError } from '../lib/http.js';
import { db } from '../db/index.js';
import { sha256, verifyToken } from '../lib/crypto.js';
import type { AccountRow, ProfileRow } from '../types.js';

export const GUEST_COOKIE = 'nova_guest';

export interface GuestSession {
  shareId: string;
  scope: 'title' | 'collection' | 'library';
  target: string;
  accountId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      account?: AccountRow;
      profile?: ProfileRow;
      guest?: GuestSession;
      viaToken?: boolean;
    }
  }
}

function accountFromBearer(req: Request): AccountRow | undefined {
  const auth = req.header('authorization');
  if (!auth?.startsWith('Bearer nova_')) return undefined;
  const hash = sha256(auth.slice('Bearer '.length));
  const row = db.prepare('SELECT id, account_id FROM api_tokens WHERE token_hash = ?').get(hash) as
    | { id: string; account_id: string }
    | undefined;
  if (!row) return undefined;
  db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
  req.viaToken = true;
  return getAccountById(row.account_id);
}

let devAccount: AccountRow | undefined;
export function devAuthAccount(): AccountRow | undefined {
  if (!config.devAuth) return undefined;
  devAccount ??= db.prepare('SELECT * FROM accounts WHERE is_admin = 1 ORDER BY created_at LIMIT 1').get() as
    | AccountRow
    | undefined;
  return devAccount;
}

export function accountFromRequest(req: Request): AccountRow | undefined {
  const token = req.cookies?.[COOKIE_NAME] as string | undefined;
  const claims = token ? verifySession(token) : null;
  return (claims ? getAccountById(claims.sub) : undefined) ?? accountFromBearer(req) ?? devAuthAccount();
}

export function guestFromRequest(req: Request): GuestSession | undefined {
  const token = req.cookies?.[GUEST_COOKIE] as string | undefined;
  if (!token) return undefined;
  const data = verifyToken<{ g: string }>(token);
  if (!data) return undefined;
  const share = db
    .prepare(
      `SELECT id, scope, target, account_id, expires_at, revoked FROM shares WHERE id = ?`,
    )
    .get(data.g) as
    | { id: string; scope: GuestSession['scope']; target: string; account_id: string; expires_at: string | null; revoked: number }
    | undefined;
  if (!share || share.revoked) return undefined;
  if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) return undefined;
  return { shareId: share.id, scope: share.scope, target: share.target, accountId: share.account_id };
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const account = accountFromRequest(req);
  if (!account) throw new HttpError(401, 'Not authenticated');
  req.account = account;
  next();
}

/** Accounts or share guests (guests are scoped further by each route). */
export function requireViewer(req: Request, _res: Response, next: NextFunction): void {
  const account = accountFromRequest(req);
  if (account) {
    req.account = account;
    next();
    return;
  }
  const guest = guestFromRequest(req);
  if (!guest) throw new HttpError(401, 'Not authenticated');
  req.guest = guest;
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.account || req.account.is_admin !== 1) throw new HttpError(403, 'Admin access required');
  next();
}

/** Loads the active profile from the `X-Profile-Id` header and verifies ownership. */
export function requireProfile(req: Request, _res: Response, next: NextFunction): void {
  const profileId = req.header('X-Profile-Id') ?? (req.query.profile as string | undefined);
  if (!profileId) throw new HttpError(400, 'Missing X-Profile-Id header');
  const profile = getProfileForAccount(profileId, req.account!.id);
  if (!profile) throw new HttpError(403, 'Invalid profile for this account');
  req.profile = profile;
  next();
}
