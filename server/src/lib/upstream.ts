import { HttpError } from './http.js';

/** Fetch JSON from an upstream API with a timeout, mapping failures to 502. */
export async function fetchJson<T>(
  url: string,
  init: (RequestInit & { timeoutMs?: number }) = {},
): Promise<T> {
  const { timeoutMs = 10_000, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new HttpError(502, 'Upstream request failed');
  }
  if (!res.ok) {
    throw new HttpError(res.status === 404 ? 404 : 502, `Upstream responded ${res.status}`);
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
