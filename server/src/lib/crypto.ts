import crypto from 'node:crypto';
import { config } from '../config.js';

const encKey = crypto.hkdfSync('sha256', config.sessionSecret, 'nova', 'secret-box', 32);
const macKey = Buffer.from(crypto.hkdfSync('sha256', config.sessionSecret, 'nova', 'url-signing', 32));

/** Encrypts a secret at rest (plugin credentials, assistant API keys). */
export function seal(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(encKey), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
}

export function unseal(sealed: string | null | undefined): string {
  if (!sealed) return '';
  if (!sealed.startsWith('v1.')) return sealed;
  try {
    const raw = Buffer.from(sealed.slice(3), 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(encKey), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    // The session secret changed since this was stored; the value is unrecoverable.
    return '';
  }
}

/** A compact signed token carrying a JSON payload and an expiry (unix seconds). */
export function signToken(payload: Record<string, unknown>, ttlSeconds: number): string {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }),
  ).toString('base64url');
  const mac = crypto.createHmac('sha256', macKey).update(body).digest('base64url').slice(0, 32);
  return `${body}.${mac}`;
}

export function verifyToken<T extends Record<string, unknown>>(token: string): T | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', macKey).update(body).digest('base64url').slice(0, 32);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp?: number };
    if (!data.exp || data.exp < Date.now() / 1000) return null;
    return data;
  } catch {
    return null;
  }
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export const newId = (): string => crypto.randomUUID();
