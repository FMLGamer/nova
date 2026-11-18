/**
 * The one way Nova talks to AniList. AniList allows 90 requests a minute (30 while it is degraded) and answers
 * 429 beyond that, which used to break the first minute after a launch when every page asks at once. Requests
 * are queued under the limit the API reports, identical requests in flight are shared, and a 429 waits for
 * Retry-After instead of failing.
 */
import { createHash } from 'node:crypto';
import { HttpError } from './http.js';

const ENDPOINT = 'https://graphql.anilist.co';
const WINDOW_MS = 60_000;
const MAX_WAIT_MS = 75_000;
const CONCURRENCY = 4;

let limit = 30;
let blockedUntil = 0;
const sent: number[] = [];
let running = 0;
const waiting: (() => void)[] = [];
const inflight = new Map<string, Promise<unknown>>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for a free slot under both the per-minute budget and the concurrency cap. */
async function slot(deadline: number): Promise<void> {
  if (running >= CONCURRENCY) await new Promise<void>((r) => waiting.push(r));
  running++;
  for (;;) {
    const now = Date.now();
    while (sent.length && sent[0]! <= now - WINDOW_MS) sent.shift();
    const wait = Math.max(blockedUntil - now, sent.length >= limit ? sent[0]! + WINDOW_MS - now : 0);
    if (wait <= 0) break;
    if (now + wait > deadline) {
      release();
      throw new HttpError(503, 'AniList is busy right now; try again in a minute');
    }
    await sleep(Math.min(wait, 5_000));
  }
  sent.push(Date.now());
}

function release(): void {
  running--;
  waiting.shift()?.();
}

/** Tracks the limit AniList reports so the queue follows it (it drops to 30/min when AniList is degraded). */
function learn(res: Response): void {
  const reported = Number(res.headers.get('x-ratelimit-limit'));
  // A few requests of headroom for other clients on the same IP.
  if (reported > 0) limit = Math.max(10, reported - 5);
  const remaining = Number(res.headers.get('x-ratelimit-remaining'));
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (res.headers.has('x-ratelimit-remaining') && remaining <= 1 && reset > 0) blockedUntil = Math.max(blockedUntil, reset * 1000);
  if (res.status === 429) {
    const after = Number(res.headers.get('retry-after'));
    blockedUntil = Math.max(blockedUntil, Date.now() + (after > 0 ? after * 1000 : 30_000));
  }
}

interface Options {
  token?: string;
  timeoutMs?: number;
}

async function send<T>(body: string, opts: Options): Promise<T> {
  const deadline = Date.now() + MAX_WAIT_MS;
  for (let attempt = 0; ; attempt++) {
    await slot(deadline);
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
      });
    } catch {
      release();
      if (attempt < 1) {
        await sleep(1_000);
        continue;
      }
      throw new HttpError(502, 'AniList could not be reached');
    }
    release();
    learn(res);
    if (res.status === 429 && attempt < 3) continue;
    if (res.status >= 500 && attempt < 1) {
      await sleep(1_000);
      continue;
    }
    if (res.status === 401 && opts.token) throw new HttpError(401, 'AniList rejected the sign-in; connect the account again in Settings → Tracking');
    const json = (await res.json().catch(() => null)) as { data?: T; errors?: { message: string; status?: number }[] } | null;
    if (res.status === 404 || json?.errors?.some((e) => e.status === 404)) throw new HttpError(404, 'Not found on AniList');
    if (res.status === 429) throw new HttpError(503, 'AniList is busy right now; try again in a minute');
    if (!res.ok || !json?.data) throw new HttpError(502, json?.errors?.[0]?.message ? `AniList: ${json.errors[0].message}` : `AniList answered ${res.status}`);
    return json.data;
  }
}

/** A GraphQL query against AniList (`token` for a user's own lists). Identical concurrent queries share one request. */
export function anilistQuery<T>(query: string, variables: Record<string, unknown> = {}, opts: Options = {}): Promise<T> {
  const body = JSON.stringify({ query, variables });
  const key = createHash('sha1').update(`${opts.token ?? ''}\n${body}`).digest('hex');
  const have = inflight.get(key);
  if (have) return have as Promise<T>;
  const p = send<T>(body, opts).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
