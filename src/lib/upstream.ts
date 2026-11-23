import { ApiError, isUpstreamError } from './api';
import { toast } from './store';

const shown = new Map<string, number>();

/** Tell the user once (per problem, per half minute) that a service Nova depends on is in trouble, and what happens next. */
export function noticeUpstream(e: unknown, retryInMs?: number): void {
  if (!isUpstreamError(e)) return;
  const now = Date.now();
  if ((shown.get(e.message) ?? 0) > now - 30_000) return;
  shown.set(e.message, now);
  const code = e.status === 503 ? (/rate limit/i.test(e.message) ? '429' : '503') : String(e.status);
  toast(
    retryInMs != null
      ? `${e.message} (${code}). Nova tries again in ${Math.max(1, Math.round(retryInMs / 1000))} s.`
      : `${e.message} (${code}). Some of this page couldn't load; it fills in when you come back in a minute.`,
    'bad',
  );
}

/** How long to wait before the next try: what the server suggested, else a growing pause. */
export function upstreamRetryDelay(attempt: number, e: unknown): number {
  const hinted = e instanceof ApiError && e.retryAfter ? e.retryAfter * 1000 + Math.random() * 1000 : 0;
  const delay = hinted || Math.min(30_000, 1500 * 2 ** attempt);
  noticeUpstream(e, delay);
  return delay;
}
