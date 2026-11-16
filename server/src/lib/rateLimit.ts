import type { Request, Response, NextFunction } from 'express';
import { HttpError } from './http.js';

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * A small fixed-window limiter kept in process memory. The app runs as a single
 * replica (SQLite on a ReadWriteOnce volume), so an in-memory counter is an
 * accurate view of the whole service and needs no extra dependency.
 */
export function rateLimit(opts: { windowMs: number; max: number; key?: (req: Request) => string }) {
  const { windowMs, max } = opts;
  const buckets = new Map<string, Bucket>();

  // Drop expired buckets so a flood of unique IPs can't grow the map forever.
  setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, windowMs).unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = opts.key?.(req) ?? req.ip ?? 'unknown';
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    bucket.count++;
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      throw new HttpError(429, `Too many attempts. Try again in ${retryAfter}s.`);
    }
    next();
  };
}
