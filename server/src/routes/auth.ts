import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { COOKIE_NAME, config } from '../config.js';
import { HttpError, parse } from '../lib/http.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { signSession } from '../auth/tokens.js';
import { requireAuth } from '../auth/middleware.js';
import {
  accountToDTO,
  createAccount,
  getAccountByUsername,
  getInviteByCode,
  markInviteUsed,
} from '../services/accounts.js';
import { createProfile, listProfiles, profileToDTO } from '../services/profiles.js';
import { getAccountSettings } from '../services/entitlements.js';
import { rateLimit } from '../lib/rateLimit.js';
import type { AccountRow, ProfileRow } from '../types.js';

export const authRouter = Router();

// Credential endpoints are the only unauthenticated write paths, so they get a
// per-IP cap to blunt password and invite-code guessing.
const credentialLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

const usernameSchema = z
  .string()
  .trim()
  .min(3, 'must be at least 3 characters')
  .max(32, 'must be at most 32 characters')
  .regex(/^[a-zA-Z0-9_.-]+$/, 'may only contain letters, numbers, and _.-');

const passwordSchema = z.string().min(8, 'must be at least 8 characters').max(200);

const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  inviteCode: z.string().trim().min(1, 'invite code is required'),
  remember: z.boolean().optional(),
});

const loginSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
  remember: z.boolean().optional(),
});

/**
 * Issues the session cookie. Without "remember me" it is a browser-session
 * cookie (no maxAge, so it dies when the browser closes) and the token itself
 * expires the same day, so a copied cookie is not usable for a month.
 */
function setSessionCookie(req: Request, res: Response, accountId: string, remember: boolean): void {
  const ttl = remember ? config.sessionTtlSeconds : config.shortSessionTtlSeconds;
  res.cookie(COOKIE_NAME, signSession(accountId, ttl), {
    httpOnly: true,
    secure: config.cookieSecure ?? req.secure,
    sameSite: 'lax',
    ...(remember ? { maxAge: ttl * 1000 } : {}),
    path: '/',
  });
}

function sessionPayload(account: AccountRow, profiles: ProfileRow[]) {
  return {
    account: accountToDTO(account),
    profiles: profiles.map(profileToDTO),
    settings: getAccountSettings(account.id, account.is_admin === 1),
  };
}

authRouter.post('/register', credentialLimit, (req, res) => {
  const { username, password, inviteCode, remember } = parse(registerSchema, req.body);

  const created = db.transaction(() => {
    const invite = getInviteByCode(inviteCode);
    if (!invite || invite.revoked === 1) throw new HttpError(400, 'Invalid invite code');
    if (invite.used_by) throw new HttpError(400, 'This invite code has already been used');
    if (getAccountByUsername(username)) throw new HttpError(409, 'Username is already taken');

    const account = createAccount({
      username,
      passwordHash: hashPassword(password),
      inviteId: invite.id,
    });
    markInviteUsed(invite.id, account.id);
    createProfile(account.id, { name: username });
    return account;
  })();

  setSessionCookie(req, res, created.id, remember ?? false);
  res.status(201).json(sessionPayload(created, listProfiles(created.id)));
});

authRouter.post('/login', credentialLimit, (req, res) => {
  const { username, password, remember } = parse(loginSchema, req.body);
  const account = getAccountByUsername(username);
  if (!account || !verifyPassword(password, account.password_hash)) {
    throw new HttpError(401, 'Incorrect username or password');
  }
  setSessionCookie(req, res, account.id, remember ?? false);
  res.json(sessionPayload(account, listProfiles(account.id)));
});

authRouter.post('/logout', (req, res) => {
  // Attributes must match the ones used when setting it or some browsers keep it.
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: config.cookieSecure ?? req.secure,
    sameSite: 'lax',
    path: '/',
  });
  res.status(204).end();
});

authRouter.get('/me', requireAuth, (req, res) => {
  const account = req.account!;
  res.json(sessionPayload(account, listProfiles(account.id)));
});
