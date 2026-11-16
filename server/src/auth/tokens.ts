import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export interface SessionClaims {
  /** Account id. */
  sub: string;
}

export function signSession(accountId: string, ttlSeconds = config.sessionTtlSeconds): string {
  return jwt.sign({ sub: accountId }, config.sessionSecret, {
    expiresIn: ttlSeconds,
  });
}

export function verifySession(token: string): SessionClaims | null {
  try {
    const decoded = jwt.verify(token, config.sessionSecret) as jwt.JwtPayload;
    if (!decoded.sub) return null;
    return { sub: String(decoded.sub) };
  } catch {
    return null;
  }
}
