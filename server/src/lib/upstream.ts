import { HttpError } from './http.js';

const SERVICES: Record<string, string> = {
  'api.themoviedb.org': 'TMDB',
  'v3-cinemeta.strem.io': 'Cinemeta',
  'api.ani.zip': 'ani.zip',
  'openlibrary.org': 'Open Library',
  'gutendex.com': 'Project Gutenberg',
  'api.jikan.moe': 'Jikan',
};

/** A readable name for the service behind a URL, for error messages. */
export function serviceName(url: string): string {
  try {
    const host = new URL(url).hostname;
    return SERVICES[host] ?? host;
  } catch {
    return 'An outside service';
  }
}

/** Fetch JSON from an upstream API with a timeout, mapping failures to 502 (503 with Retry-After when rate limited). */
export async function fetchJson<T>(
  url: string,
  init: (RequestInit & { timeoutMs?: number }) = {},
): Promise<T> {
  const { timeoutMs = 10_000, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new HttpError(502, `${serviceName(url)} could not be reached`);
  }
  if (res.status === 429) {
    const after = Number(res.headers.get('retry-after'));
    throw new HttpError(503, `${serviceName(url)} is busy right now (its rate limit was reached)`, { retryAfter: after > 0 ? after : 30 });
  }
  if (!res.ok) {
    throw new HttpError(res.status === 404 ? 404 : 502, `${serviceName(url)} answered ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Strip HTML tags and decode a few common entities (AniList descriptions). */
export function stripHtml(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .trim();
}
