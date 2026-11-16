import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { config } from '../config.js';

/**
 * Extracting an embedded subtitle track means demuxing the whole video, which
 * on a still-downloading torrent trickles in and competes with playback for
 * pieces. That is why seeking ahead used to leave a gap: the extractor simply
 * had not reached that timestamp yet.
 *
 * So each track is extracted exactly once into a small .vtt on scratch. While
 * that first pass runs, readers are fed the bytes as they appear; afterwards the
 * finished file is served instantly and seeking anywhere works immediately.
 *
 * Sources are identified by a filename-safe key: t_<hash>_<idx> (torrent),
 * l_<fileId> (server library) or u_<sha1> (remote URL).
 */
const CACHE_DIR = path.join(config.torrentDir, '.subtitles');
fs.mkdirSync(CACHE_DIR, { recursive: true });

type Listener = (chunk: string) => void;

interface Extraction {
  text: string;
  done: boolean;
  failed: boolean;
  bytesRead: number;
  totalBytes: number;
  listeners: Set<Listener>;
  finishers: Set<() => void>;
}

export interface SubtitleInput {
  size: number;
  createReadStream: () => Readable;
  /** A complete file on disk: ffmpeg reads it directly (seekable, fast). */
  path: string | null;
  /** A remote URL ffmpeg can read itself. */
  url?: string | null;
  headers?: Record<string, string> | null;
}

const active = new Map<string, Extraction>();

export interface SubtitleProgress {
  /** 0..1 of the video demuxed so far; 1 once the track is fully cached. */
  progress: number;
  done: boolean;
  cues: number;
}

function keyOf(sourceKey: string, track: number): string {
  return `${sourceKey}.${track}`;
}

function cachePath(key: string): string {
  return path.join(CACHE_DIR, `${key}.vtt`);
}

export function subtitleProgress(sourceKey: string, track: number): SubtitleProgress | null {
  const key = keyOf(sourceKey, track);
  const live = active.get(key);
  if (live) {
    return {
      progress: live.done ? 1 : live.totalBytes ? Math.min(0.99, live.bytesRead / live.totalBytes) : 0,
      done: live.done,
      cues: (live.text.match(/-->/g) ?? []).length,
    };
  }
  const cached = cachedSubtitle(sourceKey, track);
  return cached ? { progress: 1, done: true, cues: (cached.match(/-->/g) ?? []).length } : null;
}

/** A completed extraction from a previous request, if we have one. */
export function cachedSubtitle(sourceKey: string, track: number): string | null {
  const key = keyOf(sourceKey, track);
  const live = active.get(key);
  if (live?.done && !live.failed) return live.text;
  try {
    const text = fs.readFileSync(cachePath(key), 'utf8');
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

export interface SubtitleStream {
  /** Everything extracted so far — send this before subscribing. */
  initial: string;
  done: boolean;
  subscribe: (onChunk: Listener, onDone: () => void) => () => void;
}

/** Starts (or joins) the extraction of one track. Concurrent viewers share one ffmpeg. */
export function extractSubtitle(sourceKey: string, track: number, input: SubtitleInput): SubtitleStream {
  const key = keyOf(sourceKey, track);
  const existing = active.get(key);
  if (existing) return toStream(existing);

  const state: Extraction = {
    text: '',
    done: false,
    failed: false,
    bytesRead: 0,
    totalBytes: input.size,
    listeners: new Set(),
    finishers: new Set(),
  };
  active.set(key, state);

  const direct = input.path ?? input.url ?? null;
  const headerArgs =
    !input.path && input.url && input.headers
      ? ['-headers', Object.entries(input.headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')]
      : [];
  const ff = spawn(config.ffmpegPath, [
    '-loglevel', 'error',
    ...headerArgs,
    '-i', direct ?? 'pipe:0',
    '-map', `0:s:${track}?`,
    '-f', 'webvtt',
    '-flush_packets', '1',
    'pipe:1',
  ]);
  const stream = direct ? null : input.createReadStream();
  // ffmpeg closing the pipe early is expected; the exit code decides the result.
  stream?.on('error', () => undefined);
  stream?.on('data', (c: Buffer) => {
    state.bytesRead += c.length;
  });
  if (stream) stream.pipe(ff.stdin);
  ff.stdin.on('error', () => undefined);
  ff.stderr.on('data', () => undefined);

  ff.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    state.text += text;
    for (const l of state.listeners) l(text);
  });

  const finish = (failed: boolean) => {
    if (state.done) return;
    state.done = true;
    state.failed = failed;
    stream?.destroy();
    if (!failed && state.text.includes('-->')) {
      fs.writeFile(cachePath(key), state.text, () => undefined);
    } else {
      active.delete(key);
    }
    for (const f of state.finishers) f();
    state.listeners.clear();
    state.finishers.clear();
  };

  ff.on('error', () => finish(true));
  ff.on('close', () => finish(false));

  return toStream(state);
}

function toStream(state: Extraction): SubtitleStream {
  return {
    initial: state.text,
    done: state.done,
    subscribe: (onChunk, onDone) => {
      if (state.done) {
        onDone();
        return () => undefined;
      }
      state.listeners.add(onChunk);
      state.finishers.add(onDone);
      return () => {
        state.listeners.delete(onChunk);
        state.finishers.delete(onDone);
      };
    },
  };
}

/** Drops cached subtitles for a source that is being evicted (prefix of its key). */
export function forgetSubtitles(sourcePrefix: string): void {
  for (const key of [...active.keys()]) {
    if (key.startsWith(sourcePrefix)) active.delete(key);
  }
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (f.startsWith(sourcePrefix)) fs.unlinkSync(path.join(CACHE_DIR, f));
    }
  } catch {
    /* nothing cached */
  }
}
