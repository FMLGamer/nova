interface Entry {
  value: unknown;
  expires: number;
}

const store = new Map<string, Entry>();

/** Memoise an async result in-process for `ttlMs`. Keeps upstream calls cheap. */
export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  const value = await fn();
  store.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

/** Drop a memoised entry so the next call fetches again. */
export function forget(key: string): void {
  store.delete(key);
}
