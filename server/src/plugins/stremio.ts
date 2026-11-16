/**
 * Client for remote Stremio addons (Torrentio, OpenSubtitles v3, Comet, ...).
 * The addon's base URL is its manifest URL without `/manifest.json`; any user
 * configuration is already encoded in that path, exactly like in Stremio.
 */
export function addonBase(manifestUrl: string): string {
  return manifestUrl.replace(/\/manifest\.json(\?.*)?$/i, '').replace(/\/+$/, '');
}

export async function stremioCall<T>(
  manifestUrl: string,
  resource: string,
  type: string,
  id: string,
  extra: Record<string, string>,
  timeoutMs = 25_000,
): Promise<T> {
  const extraPath = Object.keys(extra).length
    ? `/${Object.entries(extra)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&')}`
    : '';
  const url = `${addonBase(manifestUrl)}/${resource}/${encodeURIComponent(type)}/${encodeURIComponent(id)}${extraPath}.json`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: 'application/json', 'User-Agent': 'Nova/2 (+stremio-compatible)' },
  });
  if (!res.ok) throw new Error(`addon answered ${res.status}`);
  return (await res.json()) as T;
}
