import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough, Readable } from 'node:stream';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { signToken, verifyToken } from '../lib/crypto.js';
import { getFile, mimeForName, torrentStatus } from '../services/torrentEngine.js';
import { mkvInfo } from '../services/embeddedSubs.js';
import { libraryFilePath } from '../library/library.js';
import { TEXT_SUBTITLE_CODECS, isFont, type MkvInfo } from '../media/matroska.js';

/**
 * Anything the player can read: a file inside a torrent, a file in the server
 * library, or a remote URL (debrid / direct HTTP streams). Every streaming
 * feature (range requests, audio fix, subtitles, transcode, track probe) works
 * on this one shape.
 */
export interface MediaSource {
  /** Filename-safe key, used for the subtitle cache. */
  key: string;
  name: string;
  size: number;
  mime: string;
  /** A complete file on local disk. */
  diskPath: string | null;
  url: string | null;
  headers: Record<string, string> | null;
  createReadStream(opts?: { start?: number; end?: number }): Readable;
  /** 0..1 for torrents, 1 for files on disk, null when unknown. */
  progress(): number | null;
}

export function torrentSource(infoHash: string, fileIndex: number): MediaSource | null {
  const hash = infoHash.toLowerCase();
  const file = getFile(hash, fileIndex);
  if (!file) return null;
  const complete = () => (torrentStatus(hash)?.progress ?? 0) >= 1;
  return {
    key: `t_${hash}_${fileIndex}`,
    name: file.name,
    size: file.length,
    mime: mimeForName(file.name),
    get diskPath() {
      if (!complete()) return null;
      const candidates = [path.join(config.torrentDir, file.path)];
      if (config.library.dir) candidates.push(path.join(config.library.dir, '.incoming', file.path));
      for (const c of candidates) {
        try {
          if (fs.statSync(c).size === file.length) return c;
        } catch {
          /* not here */
        }
      }
      return null;
    },
    url: null,
    headers: null,
    createReadStream: (opts) => file.createReadStream(opts),
    progress: () => torrentStatus(hash)?.progress ?? null,
  };
}

interface LibraryFileRow {
  id: string;
  path: string;
  size: number;
  mime: string | null;
}

export function librarySource(fileId: string): MediaSource | null {
  const row = db.prepare('SELECT id, path, size, mime FROM library_files WHERE id = ?').get(fileId) as LibraryFileRow | undefined;
  if (!row) return null;
  const abs = libraryFilePath(row.path);
  if (!abs) return null;
  let size = row.size;
  try {
    size = fs.statSync(abs).size;
  } catch {
    return null;
  }
  return {
    key: `l_${row.id.replace(/[^a-zA-Z0-9]/g, '')}`,
    name: path.basename(abs),
    size,
    mime: row.mime ?? mimeForName(abs),
    diskPath: abs,
    url: null,
    headers: null,
    createReadStream: (opts) => fs.createReadStream(abs, opts),
    progress: () => 1,
  };
}

/** A signed token naming a remote URL, so clients never send us arbitrary URLs. */
export function urlToken(url: string, headers: Record<string, string> | null, name: string, size = 0): string {
  return signToken({ u: url, h: headers ?? undefined, n: name, s: size }, 12 * 60 * 60);
}

function fetchStream(url: string, headers: Record<string, string> | null, start?: number, end?: number): Readable {
  const out = new PassThrough();
  const h: Record<string, string> = { ...(headers ?? {}) };
  if (start !== undefined) h.Range = `bytes=${start}-${end ?? ''}`;
  fetch(url, { headers: h, redirect: 'follow' })
    .then((res) => {
      if (!res.ok || !res.body) throw new Error(`upstream ${res.status}`);
      Readable.fromWeb(res.body as import('node:stream/web').ReadableStream).pipe(out);
    })
    .catch((err: Error) => out.destroy(err));
  return out;
}

export function urlSource(token: string): MediaSource | null {
  const data = verifyToken<{ u: string; h?: Record<string, string>; n: string; s?: number }>(token);
  if (!data) return null;
  const url = data.u;
  const headers = data.h ?? null;
  return {
    key: `u_${crypto.createHash('sha1').update(url).digest('hex')}`,
    name: data.n,
    size: data.s ?? 0,
    mime: mimeForName(data.n),
    diskPath: null,
    url,
    headers,
    createReadStream: (opts) => fetchStream(url, headers, opts?.start, opts?.end),
    progress: () => null,
  };
}

/** Resolves the `<kind>/<a>[/<b>]` path segments used by /stream and the track API. */
export function resolveSource(kind: string, a: string, b?: string): MediaSource | null {
  if (kind === 't') return torrentSource(a, Number(b ?? 0));
  if (kind === 'l') return librarySource(a);
  if (kind === 'u') return urlSource(a);
  return null;
}

/** ffmpeg input args for a source: direct file/URL when possible, else stdin. */
export function ffInput(src: MediaSource): { args: string[]; stdin: Readable | null } {
  if (src.diskPath) return { args: ['-i', src.diskPath], stdin: null };
  if (src.url) {
    const h = src.headers ? ['-headers', Object.entries(src.headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')] : [];
    return { args: [...h, '-i', src.url], stdin: null };
  }
  return { args: ['-i', 'pipe:0'], stdin: src.createReadStream() };
}

export interface MediaTrack {
  index: number; // ordinal within its type, for ffmpeg -map 0:a:N / 0:s:N
  codec: string;
  language: string | null;
  title: string | null;
  channels?: number | null;
  default?: boolean;
  forced?: boolean;
  /** Matroska track number: subtitles of MKV files stream through /subs/:number. */
  number?: number;
}

export interface MediaTracks {
  container?: 'matroska' | null;
  video: { codec: string; width: number | null; height: number | null; hdr: boolean } | null;
  audio: MediaTrack[];
  subtitles: MediaTrack[];
  duration: number | null;
  chapters?: { start: number; end: number | null; title: string }[];
  /** Embedded font attachments (by attachment index) for styled subtitles. */
  fonts?: number[];
}

// Text subtitle codecs we can convert to WebVTT (image subs like PGS/VOBSUB can't).
const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'vtt', 'mov_text', 'text', 'stl']);

const probeCache = new Map<string, MediaTracks>();

function tracksFromMkv(info: MkvInfo): MediaTracks {
  const video = info.tracks.find((t) => t.type === 'video' && t.codec !== 'mjpeg');
  let a = 0;
  let s = 0;
  const audio: MediaTrack[] = [];
  const subtitles: MediaTrack[] = [];
  for (const t of info.tracks) {
    if (t.type === 'audio') {
      audio.push({ index: a++, codec: t.codec, language: t.language, title: t.name, channels: t.channels, default: t.default });
    } else if (t.type === 'subtitle') {
      const ord = s++;
      if (TEXT_SUBTITLE_CODECS.has(t.codec) && !t.encrypted) {
        subtitles.push({ index: ord, number: t.number, codec: t.codec, language: t.language, title: t.name, default: t.default, forced: t.forced });
      }
    }
  }
  return {
    container: 'matroska',
    video: video ? { codec: video.codec, width: video.width, height: video.height, hdr: video.hdr } : null,
    audio,
    subtitles,
    duration: info.duration,
    chapters: info.chapters,
    fonts: info.attachments.filter(isFont).map((f) => f.index),
  };
}

/** Track table for a source: read natively from Matroska headers, ffprobe for anything else. */
export async function probeTracks(src: MediaSource): Promise<MediaTracks | null> {
  const hit = probeCache.get(src.key);
  if (hit) return hit;
  const info = await mkvInfo(src);
  if (info && info.tracks.length) {
    const tracks = tracksFromMkv(info);
    probeCache.set(src.key, tracks);
    return tracks;
  }
  return ffprobeTracks(src);
}

/** Probe the embedded audio/subtitle tracks via ffprobe (header only, fast). */
function ffprobeTracks(src: MediaSource): Promise<MediaTracks | null> {
  const hit = probeCache.get(src.key);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const input = ffInput(src);
    const ff = spawn(config.ffprobePath, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_entries',
      'stream=index,codec_type,codec_name,width,height,channels,color_transfer:stream_tags=language,title:stream_disposition=default:format=duration',
      // A Matroska/MP4 header carries the track table up front, so a small
      // probe window is enough and keeps this fast on a slow torrent stream.
      '-analyzeduration', '4M',
      '-probesize', '4M',
      ...input.args,
    ]);
    let out = '';
    let done = false;
    const finish = (val: MediaTracks | null) => {
      if (done) return;
      done = true;
      input.stdin?.destroy();
      try {
        ff.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      if (val && (val.audio.length || val.video)) probeCache.set(src.key, val);
      resolve(val);
    };
    // ffprobe closes the pipe the moment it has read enough (EPIPE here). That
    // is the normal path; only ffprobe's own exit decides the result.
    if (input.stdin) {
      input.stdin.on('error', () => undefined);
      input.stdin.pipe(ff.stdin);
    }
    ff.stdin.on('error', () => undefined);
    ff.stdout.on('data', (d) => {
      out += d.toString();
    });
    ff.on('error', () => finish(null));
    ff.on('close', () => {
      try {
        const json = JSON.parse(out) as {
          streams?: {
            codec_type?: string;
            codec_name?: string;
            width?: number;
            height?: number;
            channels?: number;
            color_transfer?: string;
            tags?: { language?: string; title?: string };
            disposition?: { default?: number };
          }[];
          format?: { duration?: string };
        };
        const audio: MediaTrack[] = [];
        const subtitles: MediaTrack[] = [];
        let video: MediaTracks['video'] = null;
        let audioOrd = 0;
        let subOrd = 0;
        for (const s of json.streams ?? []) {
          if (s.codec_type === 'video' && !video && s.codec_name !== 'mjpeg' && s.codec_name !== 'png') {
            video = {
              codec: s.codec_name ?? '',
              width: s.width ?? null,
              height: s.height ?? null,
              hdr: /smpte2084|arib-std-b67/.test(s.color_transfer ?? ''),
            };
          } else if (s.codec_type === 'audio') {
            audio.push({
              index: audioOrd++,
              codec: s.codec_name ?? '',
              language: s.tags?.language ?? null,
              title: s.tags?.title ?? null,
              channels: s.channels ?? null,
              default: s.disposition?.default === 1,
            });
          } else if (s.codec_type === 'subtitle') {
            const ord = subOrd++;
            if (TEXT_SUB_CODECS.has((s.codec_name ?? '').toLowerCase())) {
              subtitles.push({
                index: ord,
                codec: s.codec_name ?? '',
                language: s.tags?.language ?? null,
                title: s.tags?.title ?? null,
                default: s.disposition?.default === 1,
              });
            }
          }
        }
        const duration = Number(json.format?.duration);
        finish({ video, audio, subtitles, duration: Number.isFinite(duration) && duration > 0 ? duration : null });
      } catch {
        finish(null);
      }
    });
    setTimeout(() => finish(null), 45_000).unref();
  });
}
