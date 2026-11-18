interface Entry {
  value: unknown;
  expires: number;
}

const store = new Map<string, Entry>();
const pending = new Map<string, Promise<unknown>>();

/** Memoise an async result in-process for `ttlMs`. Keeps upstream calls cheap; concurrent misses share one call. */
export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  const running = pending.get(key);
  if (running) return running as Promise<T>;
  const p = fn()
    .then((value) => {
      store.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    })
    .finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

/** Drop a memoised entry so the next call fetches again. */
export function forget(key: string): void {
  store.delete(key);
}
