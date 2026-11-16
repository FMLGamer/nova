/**
 * Embedded subtitles straight out of Matroska files, Seanime-style: instead of
 * demuxing the whole file with ffmpeg, the clusters around the playhead are
 * read (through the Cues index) and only that subtitle track's blocks are
 * decoded. Results are cached per track together with which parts of the file
 * have been covered, so seeking back is instant and no byte range is parsed twice.
 */
import { HttpError } from '../lib/http.js';
import {
  TEXT_SUBTITLE_CODECS,
  clusterFor,
  extractTrack,
  fileReader,
  readMkvInfo,
  streamReader,
  type ByteReader,
  type MkvInfo,
  type SubtitleBlock,
} from '../media/matroska.js';
import type { MediaSource } from '../streaming/source.js';

/** How far (in media seconds) a still-downloading torrent may be read ahead of the viewer. */
const TORRENT_LEAD_SECONDS = 240;

export function readerFor(src: MediaSource): ByteReader {
  if (src.diskPath) return fileReader(src.diskPath, src.size);
  const open = new Set<{ destroy(): void }>();
  const base = streamReader(src.size, (start, end) => {
    const s = src.createReadStream({ start, end });
    open.add(s);
    s.on('close', () => open.delete(s));
    return s;
  });
  return {
    ...base,
    async close() {
      for (const s of open) s.destroy();
      open.clear();
    },
  };
}

// ---------------------------------------------------------------- header cache

const infoCache = new Map<string, Promise<MkvInfo | null>>();

/** Parsed Matroska header for a source (cached), or null when it isn't Matroska. */
export function mkvInfo(src: MediaSource): Promise<MkvInfo | null> {
  if (!src.size) return Promise.resolve(null);
  let hit = infoCache.get(src.key);
  if (!hit) {
    const reader = readerFor(src);
    hit = readMkvInfo(reader)
      .catch(() => null)
      .finally(() => reader.close?.());
    infoCache.set(src.key, hit);
    hit.then((v) => {
      if (!v) infoCache.delete(src.key);
    });
    if (infoCache.size > 100) infoCache.delete(infoCache.keys().next().value!);
  }
  return hit;
}

// ---------------------------------------------------------------- per-track cache

interface Range {
  startPos: number;
  endPos: number;
  startTime: number;
  endTime: number;
}

class TrackState {
  blocks = new Map<string, SubtitleBlock>();
  ranges: Range[] = [];
  complete = false;
  used = Date.now();

  add(r: Range): void {
    const merged: Range[] = [];
    let cur = { ...r };
    for (const x of this.ranges) {
      if (x.endPos < cur.startPos || x.startPos > cur.endPos) merged.push(x);
      else {
        cur = {
          startPos: Math.min(x.startPos, cur.startPos),
          endPos: Math.max(x.endPos, cur.endPos),
          startTime: Math.min(x.startTime, cur.startTime),
          endTime: Math.max(x.endTime, cur.endTime),
        };
      }
    }
    merged.push(cur);
    this.ranges = merged.sort((a, b) => a.startPos - b.startPos);
  }

  /** End of the covered range containing `pos`, if any. */
  coveredUntil(pos: number): number | null {
    for (const r of this.ranges) if (pos >= r.startPos && pos < r.endPos) return r.endPos;
    return null;
  }

  times(): [number, number][] {
    return this.ranges.map((r) => [r.startTime, r.endTime]);
  }
}

const tracks = new Map<string, TrackState>();

function stateFor(sourceKey: string, track: number): TrackState {
  const key = `${sourceKey}#${track}`;
  let s = tracks.get(key);
  if (!s) {
    s = new TrackState();
    tracks.set(key, s);
    if (tracks.size > 40) {
      const oldest = [...tracks.entries()].sort((a, b) => a[1].used - b[1].used)[0];
      if (oldest) tracks.delete(oldest[0]);
    }
  }
  s.used = Date.now();
  return s;
}

export function forgetEmbedded(sourcePrefix: string): void {
  for (const k of [...infoCache.keys()]) if (k.startsWith(sourcePrefix)) infoCache.delete(k);
  for (const k of [...tracks.keys()]) if (k.startsWith(sourcePrefix)) tracks.delete(k);
}

// ---------------------------------------------------------------- streaming session

export type SubsMessage =
  | { t: 'h'; codec: string; header: string | null }
  | { t: 'e'; e: [number, number, string][] }
  | { t: 'cov'; r: [number, number][]; done: boolean }
  | { t: 'end' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Streams one subtitle track starting near `fromSeconds`: everything already
 * cached first, then new blocks as the clusters are read.
 */
export async function streamEmbeddedTrack(
  src: MediaSource,
  trackNumber: number,
  fromSeconds: number,
  send: (m: SubsMessage) => void,
  signal: AbortSignal,
): Promise<void> {
  const info = await mkvInfo(src);
  if (!info) throw new HttpError(404, 'Not a Matroska file');
  const track = info.tracks.find((t) => t.number === trackNumber && t.type === 'subtitle');
  if (!track || !TEXT_SUBTITLE_CODECS.has(track.codec) || track.encrypted) throw new HttpError(404, 'No such text subtitle track');
  const state = stateFor(src.key, trackNumber);
  const isAss = track.codec === 'ass' || track.codec === 'ssa';
  send({ t: 'h', codec: track.codec, header: isAss && track.codecPrivate ? track.codecPrivate.toString('utf8') : null });

  const known = [...state.blocks.values()];
  for (let i = 0; i < known.length; i += 500) {
    send({ t: 'e', e: known.slice(i, i + 500).map((b) => [b.start, b.duration, b.text]) });
  }
  send({ t: 'cov', r: state.times(), done: state.complete });
  if (state.complete || info.firstCluster == null) {
    send({ t: 'end' });
    return;
  }

  const reader = readerFor(src);
  const local = () => Boolean(src.diskPath) || (src.progress() ?? 0) >= 1;
  const started = Date.now();
  const startAt = Math.max(0, fromSeconds - 3);
  let pending: [number, number, string][] = [];
  let lastCov = 0;
  let current: Range | null = null;

  const flush = (force = false) => {
    if (pending.length) {
      send({ t: 'e', e: pending });
      pending = [];
    }
    if (force || Date.now() - lastCov > 700) {
      lastCov = Date.now();
      send({ t: 'cov', r: state.times(), done: state.complete });
    }
  };

  const run = (from: number, until?: number) =>
    extractTrack(reader, info, track, {
      from,
      until,
      signal,
      onBlock: (b) => {
        const key = `${b.start}|${b.text}`;
        if (state.blocks.has(key)) return;
        state.blocks.set(key, b);
        pending.push([b.start, b.duration, b.text]);
      },
      onCluster: (span) => {
        current = current
          ? { ...current, endPos: span.end, endTime: Math.max(current.endTime, span.time) }
          : { startPos: span.pos, endPos: span.end, startTime: span.time, endTime: span.time };
        state.add(current);
        flush();
        const jump = state.coveredUntil(span.end);
        if (jump != null) {
          current = null;
          return jump;
        }
      },
      pace: async (sec) => {
        while (!signal.aborted && !local() && sec > startAt + (Date.now() - started) / 1000 + TORRENT_LEAD_SECONDS) {
          flush(true);
          await sleep(1000);
        }
      },
    });

  try {
    let from = (await clusterFor(reader, info, startAt)) ?? info.firstCluster;
    from = state.coveredUntil(from) ?? from;
    await run(from);
    // A complete file can be finished off quickly: wrap around to fill in the start.
    if (!signal.aborted && local()) {
      current = null;
      const head = state.coveredUntil(info.firstCluster) ?? info.firstCluster;
      if (head < info.segmentEnd) await run(head);
      const whole = state.ranges.length === 1 && state.ranges[0]!.startPos <= info.firstCluster && state.ranges[0]!.endPos >= info.segmentEnd - 16;
      if (whole) state.complete = true;
    }
    flush(true);
    if (!signal.aborted) send({ t: 'end' });
  } finally {
    await reader.close?.();
  }
}

/** The whole track as WebVTT (used for machine translation). */
export async function embeddedTrackVtt(src: MediaSource, trackNumber: number, signal: AbortSignal): Promise<string> {
  const info = await mkvInfo(src);
  if (!info) throw new HttpError(404, 'Not a Matroska file');
  const blocks: [number, number, string][] = [];
  let isAss = false;
  await streamEmbeddedTrack(
    src,
    trackNumber,
    0,
    (m) => {
      if (m.t === 'h') isAss = m.codec === 'ass' || m.codec === 'ssa';
      if (m.t === 'e') blocks.push(...m.e);
    },
    signal,
  );
  const ts = (ms: number) => {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  };
  const cues = blocks
    .map(([start, dur, text]) => ({ start, end: start + dur, text: isAss ? assToPlain(text) : text.replace(/\r/g, '').trim() }))
    .filter((c) => c.text)
    .sort((a, b) => a.start - b.start);
  return `WEBVTT\n\n${cues.map((c) => `${ts(c.start)} --> ${ts(c.end)}\n${c.text}`).join('\n\n')}\n`;
}

/** The dialogue text of a Matroska ASS block ("ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text"). */
export function assToPlain(block: string): string {
  let rest = block;
  for (let i = 0; i < 8; i++) {
    const c = rest.indexOf(',');
    if (c < 0) return '';
    rest = rest.slice(c + 1);
  }
  if (/\{[^}]*\\p[1-9]/.test(rest)) return '';
  return rest
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\[Nn]/g, '\n')
    .replace(/\\h/g, ' ')
    .trim();
}

/** What has been read of a track so far (by any viewer): its blocks and the covered time ranges. */
export function knownTrack(src: MediaSource, trackNumber: number): { blocks: SubtitleBlock[]; ranges: [number, number][]; complete: boolean } {
  const s = stateFor(src.key, trackNumber);
  return { blocks: [...s.blocks.values()].sort((a, b) => a.start - b.start), ranges: s.times(), complete: s.complete };
}

/** Keeps reading a track from `fromSeconds` in the background (paced to the download) until `signal` aborts. */
export function followTrack(src: MediaSource, trackNumber: number, fromSeconds: number, signal: AbortSignal): Promise<void> {
  return streamEmbeddedTrack(src, trackNumber, fromSeconds, () => undefined, signal).catch(() => undefined);
}

/** True once the track's covered ranges reach `until` from `from` (seconds), or the whole track is known. */
export function trackCovers(src: MediaSource, trackNumber: number, from: number, until: number): boolean {
  const k = knownTrack(src, trackNumber);
  return k.complete || k.ranges.some(([a, b]) => a <= from + 1 && b >= until);
}
