import type { Request } from 'express';
import type { ZodTypeAny, infer as ZodInfer } from 'zod';
import { config } from '../config.js';

/** The address people reach this server on: PUBLIC_URL, else whatever host the request came in on. */
export function publicUrl(req?: Request): string {
  if (config.publicUrl) return config.publicUrl;
  if (req) return `${req.protocol}://${req.get('host')}`;
  return `http://localhost:${config.port}`;
}

export class HttpError extends Error {
  status: number;
  /** Seconds after which trying again makes sense (rate limits). */
  retryAfter?: number;
  constructor(status: number, message: string, opts: { retryAfter?: number } = {}) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
    if (opts.retryAfter) this.retryAfter = Math.ceil(opts.retryAfter);
  }
}

/** Validate a request payload, throwing a 400 with a readable message on failure. */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): ZodInfer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    throw new HttpError(400, msg || 'Invalid request');
  }
  return result.data as ZodInfer<S>;
}
