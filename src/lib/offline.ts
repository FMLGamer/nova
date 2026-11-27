import { create } from 'zustand';
import { api } from './api';
import { errorText, toast } from './store';

/** Offline copies live in the browser's origin-private file system, keyed by item key. */
export interface OfflineEntry {
  itemKey: string;
  kind: 'video' | 'comic' | 'book';
  mediaId: string;
  mediaType: string;
  title: string;
  subtitle: string | null;
  poster: string | null;
  mime: string;
  size: number;
  fileName: string;
  season: number | null;
  episode: number | null;
  createdAt: number;
}

const MANIFEST = 'offline.json';
const DIR = 'media';

export const offlineSupported = () => typeof navigator !== 'undefined' && Boolean(navigator.storage?.getDirectory);
const safe = (k: string) => k.replace(/[^a-z0-9]/gi, '_');

async function readManifest(): Promise<OfflineEntry[]> {
  try {
    const fh = await (await navigator.storage.getDirectory()).getFileHandle(MANIFEST);
    return JSON.parse(await (await fh.getFile()).text()) as OfflineEntry[];
  } catch {
    return [];
  }
}

async function writeManifest(list: OfflineEntry[]): Promise<void> {
  const fh = await (await navigator.storage.getDirectory()).getFileHandle(MANIFEST, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(list));
  await w.close();
}

async function mediaDir() {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true });
}

export async function offlineUrl(itemKey: string): Promise<string | null> {
  if (!offlineSupported()) return null;
  try {
    const fh = await (await mediaDir()).getFileHandle(safe(itemKey));
    return URL.createObjectURL(await fh.getFile());
  } catch {
    return null;
  }
}

export async function offlineFile(itemKey: string): Promise<File | null> {
  if (!offlineSupported()) return null;
  try {
    return await (await (await mediaDir()).getFileHandle(safe(itemKey))).getFile();
  } catch {
    return null;
  }
}

interface Job {
  itemKey: string;
  title: string;
  progress: number;
  phase: 'queued' | 'finding' | 'downloading';
  abort: AbortController;
}

/** Downloads run two at a time; the rest wait their turn (a whole season can be asked for at once). */
const PARALLEL = 2;
let running = 0;
const turns: (() => void)[] = [];
async function myTurn(): Promise<void> {
  if (running >= PARALLEL) await new Promise<void>((r) => turns.push(r));
  running++;
}
function nextTurn(): void {
  running--;
  turns.shift()?.();
}

interface OfflineState {
  entries: OfflineEntry[];
  jobs: Record<string, Job>;
  load: () => Promise<void>;
  remove: (itemKey: string) => Promise<void>;
  cancel: (itemKey: string) => void;
  /** Saves a prepared stream path to the device. */
  save: (meta: Omit<OfflineEntry, 'createdAt' | 'size' | 'mime' | 'fileName'>, streamPath: string, fileName: string, mime: string) => Promise<void>;
  /** Finds the best source, prepares it and saves it — one tap from a title page. */
  saveBest: (meta: Omit<OfflineEntry, 'createdAt' | 'size' | 'mime' | 'fileName' | 'kind'>) => Promise<void>;
}

export const useOffline = create<OfflineState>((set, get) => ({
  entries: [],
  jobs: {},
  load: async () => set({ entries: offlineSupported() ? await readManifest() : [] }),
  remove: async (itemKey) => {
    try {
      await (await mediaDir()).removeEntry(safe(itemKey));
    } catch {
      /* already gone */
    }
    const list = (await readManifest()).filter((e) => e.itemKey !== itemKey);
    await writeManifest(list);
    set({ entries: list });
  },
  cancel: (itemKey) => {
    const job = get().jobs[itemKey];
    job?.abort.abort();
    // One still waiting for its turn just leaves the queue.
    if (job?.phase === 'queued')
      set((s) => {
        const jobs = { ...s.jobs };
        delete jobs[itemKey];
        return { jobs };
      });
  },
  save: async (meta, streamPath, fileName, mime) => {
    if (!offlineSupported()) throw new Error('This browser cannot keep offline copies');
    const abort = get().jobs[meta.itemKey]?.abort ?? new AbortController();
    const setJob = (p: Partial<Job>) =>
      set((s) => {
        const base: Job = s.jobs[meta.itemKey] ?? { itemKey: meta.itemKey, title: meta.title, progress: 0, phase: 'downloading', abort };
        return { jobs: { ...s.jobs, [meta.itemKey]: { ...base, ...p } } };
      });
    setJob({ phase: 'downloading', progress: 0 });
    const dir = await mediaDir();
    const fh = await dir.getFileHandle(safe(meta.itemKey), { create: true });
    const w = await fh.createWritable();
    try {
      const res = await fetch(streamPath, { credentials: 'include', signal: abort.signal });
      if (!res.ok || !res.body) throw new Error('Download failed');
      const total = Number(res.headers.get('Content-Length')) || 0;
      const reader = res.body.getReader();
      let got = 0;
      let lastPaint = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await w.write(value);
        got += value.byteLength;
        if (total && Date.now() - lastPaint > 400) {
          lastPaint = Date.now();
          setJob({ progress: got / total });
        }
      }
      await w.close();
      const entry: OfflineEntry = { ...meta, mime, fileName, size: got, createdAt: Date.now() };
      const list = [...(await readManifest()).filter((e) => e.itemKey !== meta.itemKey), entry];
      await writeManifest(list);
      set({ entries: list });
      toast(`${meta.subtitle ? `${meta.title} · ${meta.subtitle}` : meta.title} is downloaded`, 'ok');
    } catch (e) {
      await w.abort().catch(() => undefined);
      await dir.removeEntry(safe(meta.itemKey)).catch(() => undefined);
      if (!abort.signal.aborted) toast(errorText(e), 'bad');
    } finally {
      set((s) => {
        const jobs = { ...s.jobs };
        delete jobs[meta.itemKey];
        return { jobs };
      });
    }
  },
  saveBest: async (meta) => {
    if (get().jobs[meta.itemKey] || get().entries.some((e) => e.itemKey === meta.itemKey)) return;
    const abort = new AbortController();
    set((s) => ({ jobs: { ...s.jobs, [meta.itemKey]: { itemKey: meta.itemKey, title: meta.title, progress: 0, phase: 'queued', abort } } }));
    await myTurn();
    try {
      if (abort.signal.aborted) throw new DOMException('aborted', 'AbortError');
      set((s) => (s.jobs[meta.itemKey] ? { jobs: { ...s.jobs, [meta.itemKey]: { ...s.jobs[meta.itemKey]!, phase: 'finding' } } } : s));
      const search = await api.play.sourcesSync({ mediaId: meta.mediaId, season: meta.season ?? undefined, episode: meta.episode ?? undefined });
      const best = search.releases[0];
      if (!best) throw new Error(`No source found for ${meta.subtitle ?? meta.title}`);
      const { source } = await api.play.prepare({ releaseId: best.id, itemKey: meta.itemKey, title: meta.title });
      if (abort.signal.aborted) throw new DOMException('aborted', 'AbortError');
      await get().save({ ...meta, kind: 'video' }, source.path, source.name, source.mime);
    } catch (e) {
      set((s) => {
        if (s.jobs[meta.itemKey]?.abort !== abort) return s;
        const jobs = { ...s.jobs };
        delete jobs[meta.itemKey];
        return { jobs };
      });
      if (!abort.signal.aborted) toast(errorText(e), 'bad');
    } finally {
      nextTurn();
    }
  },
}));

if (offlineSupported()) void useOffline.getState().load();
