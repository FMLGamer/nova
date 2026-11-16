import { create } from 'zustand';
import { api } from './api';

export interface AudioTrack {
  id: string;
  title: string;
  subtitle: string;
  url: string;
  cover: string | null;
}

export type RepeatMode = 'off' | 'all' | 'one';

interface AudioState {
  queue: AudioTrack[];
  index: number;
  playing: boolean;
  context: { title: string; href: string } | null;
  shuffle: boolean;
  repeat: RepeatMode;
  volume: number;
  /** Bumped to restart the current track (repeat-one). */
  nonce: number;
  playQueue: (tracks: AudioTrack[], start?: number, context?: { title: string; href: string }) => void;
  toggle: () => void;
  setPlaying: (v: boolean) => void;
  next: (auto?: boolean) => void;
  previous: () => void;
  jumpTo: (i: number) => void;
  setShuffle: (v: boolean) => void;
  cycleRepeat: () => void;
  setVolume: (v: number) => void;
  close: () => void;
}

export const useAudio = create<AudioState>((set, get) => ({
  queue: [],
  index: 0,
  playing: false,
  context: null,
  shuffle: false,
  repeat: 'off',
  volume: 1,
  nonce: 0,
  playQueue: (tracks, start = 0, context) =>
    set({ queue: tracks, index: Math.max(0, Math.min(start, tracks.length - 1)), playing: tracks.length > 0, context: context ?? null }),
  toggle: () => set((s) => ({ playing: s.queue.length > 0 && !s.playing })),
  setPlaying: (v) => set({ playing: v }),
  next: (auto = false) => {
    const { queue, index, repeat, shuffle } = get();
    if (!queue.length) return;
    if (auto && repeat === 'one') return set((s) => ({ nonce: s.nonce + 1, playing: true }));
    if (shuffle && queue.length > 1) {
      let n = index;
      while (n === index) n = Math.floor(Math.random() * queue.length);
      return set({ index: n, playing: true });
    }
    if (index >= queue.length - 1) return set(repeat === 'all' ? { index: 0, playing: true } : { playing: false });
    set({ index: index + 1, playing: true });
  },
  previous: () => set((s) => ({ index: Math.max(0, s.index - 1), playing: true })),
  jumpTo: (index) => set({ index, playing: true }),
  setShuffle: (v) => set({ shuffle: v }),
  cycleRepeat: () => set((s) => ({ repeat: s.repeat === 'off' ? 'all' : s.repeat === 'all' ? 'one' : 'off' })),
  setVolume: (v) => set({ volume: v }),
  close: () => set({ queue: [], index: 0, playing: false, context: null }),
}));

/** Strips the extension and a leading track number from a file name. */
export function prettyTrack(name: string): string {
  const base = name.split('/').pop() ?? name;
  return base
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/^\s*\d{1,3}\s*[-._)]\s*/, '')
    .replace(/_/g, ' ')
    .trim();
}

/** Finds the best release for an album/audiobook, prepares it, and returns its audio files as a queue. */
export async function resolveAudio(opts: { mediaId: string; title: string; creator: string; cover: string | null; itemKey: string }): Promise<AudioTrack[]> {
  const search = await api.play.sourcesSync({ mediaId: opts.mediaId, kind: 'audio', title: opts.title, creator: opts.creator });
  const best = search.releases[0];
  if (!best) return [];
  const { source } = await api.play.prepare({ releaseId: best.id, itemKey: opts.itemKey, title: `${opts.creator} — ${opts.title}`, kind: 'audio' });
  const files = source.files.length ? source.files : [{ index: 0, name: source.name, size: source.size, mime: source.mime, path: source.path }];
  return files.map((f) => ({ id: `${source.a}:${f.index}`, title: prettyTrack(f.name), subtitle: opts.creator, url: f.path, cover: opts.cover }));
}
