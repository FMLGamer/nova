import { api } from './api';
import type { ClientTorrent, PlaySource, SourceKind } from './types';

/**
 * The Nova desktop app doubles as a local streaming engine (like Stremio's
 * streaming server): a web Nova whose server doesn't touch torrents hands the
 * torrent to the app on this computer and plays it from there.
 */
export interface Engine {
  base: string;
  /** base + /engine/<token>: prefix for /stream and /api/play on the engine. */
  root: string;
}

const KEY = 'nova.engine.v1';

function stored(): { base: string; token: string } | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null') as { base: string; token: string } | null;
  } catch {
    return null;
  }
}

async function probe(url: string, init: RequestInit = {}, ms = 1500): Promise<Response | null> {
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, credentials: 'omit' });
  } catch {
    return null;
  } finally {
    window.clearTimeout(t);
  }
}

/** Finds the Nova app on this computer. With `pair`, asks it (the user approves in the app) for access. */
export async function connectEngine(port: number, opts: { pair: boolean; onAsk?: () => void }): Promise<Engine | null> {
  for (const host of ['127.0.0.1', 'localhost']) {
    const base = `http://${host}:${port}`;
    const info = await probe(`${base}/api/engine/info`);
    if (!info?.ok) continue;
    const s = stored();
    if (s?.base === base) {
      const ok = await probe(`${base}/engine/${s.token}/api/play/cached`);
      if (ok?.ok) return { base, root: `${base}/engine/${s.token}` };
    }
    if (!opts.pair) return null;
    opts.onAsk?.();
    const res = await probe(`${base}/api/engine/pair`, { method: 'POST' }, 125_000);
    if (!res?.ok) throw new Error('Streaming on this computer was not allowed in the Nova app');
    const { token } = (await res.json()) as { token: string };
    localStorage.setItem(KEY, JSON.stringify({ base, token }));
    return { base, root: `${base}/engine/${token}` };
  }
  return null;
}

/** Has the engine fetch the torrent, returning a source with absolute engine URLs. */
export async function enginePrepare(engine: Engine, t: ClientTorrent, kind: SourceKind, itemKey: string | null, title: string | null): Promise<PlaySource> {
  const link = t.magnet ? `${t.magnet}${t.fileIdx != null ? `&nova_file=${t.fileIdx}` : ''}` : undefined;
  const { source } = await api.play.prepare(
    { link, torrent: t.magnet ? undefined : (t.torrent ?? undefined), episode: t.episode, kind, itemKey, title },
    engine.root,
  );
  return { ...source, path: `${engine.root}${source.path}`, files: source.files.map((f) => ({ ...f, path: `${engine.root}${f.path}` })) };
}
