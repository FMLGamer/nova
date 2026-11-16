/**
 * What a TV plays when you cast. Chromecasts get HLS: ffmpeg remuxes (or, when
 * the video needs it, re-encodes) into 4-second TS segments, and text subtitles
 * travel alongside as a WebVTT rendition built segment by segment from the
 * subtitle reader, so they work on torrents that are still downloading.
 *
 * ASS/SSA subtitles can't be shown by a TV, so they are burned into the picture
 * while encoding (ffmpeg + libass, the file's own fonts). That is the cheapest
 * way to keep the typesetting: one encode pass that only runs while you cast,
 * nothing rendered ahead of time. On a torrent the burn runs in chunks that
 * follow the subtitle reader, so later lines are never missing.
 *
 * DLNA TVs get the original file (they decode most containers themselves), or
 * the same burned stream as one continuous MPEG-TS when subtitles must be burned.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import { randomToken } from '../lib/crypto.js';
import { HttpError } from '../lib/http.js';
import { isFont } from '../media/matroska.js';
import { followTrack, knownTrack, mkvInfo, trackCovers } from '../services/embeddedSubs.js';
import { ISO3 } from '../lib/lang.js';
import { probeTracks, resolveSource, type MediaSource } from '../streaming/source.js';

const SEG = 4;
/** -copyts keeps the file's own timestamps; this offset keeps them positive in MPEG-TS. */
const TS_OFFSET = 10;

export type CastSubtitle = { kind: 'embedded'; track: number } | { kind: 'text'; vtt: string; language?: string | null; label?: string | null };

interface Cue {
  start: number;
  end: number;
  text: string;
}

interface Run {
  k: number;
  from: number;
  to: number | null;
  proc: ChildProcess | null;
  done: boolean;
}

// ---------------------------------------------------------------- encoder choice

type Encoder = { name: string; args: string[]; filterTail: string; pre: string[] };

let encoderPick: Promise<Encoder> | null = null;

function tryEncoder(e: Encoder): Promise<boolean> {
  return new Promise((resolve) => {
    const ff = spawn(config.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', ...e.pre,
      '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=0.3',
      '-vf', `format=yuv420p${e.filterTail}`, ...e.args, '-frames:v', '4', '-f', 'null', '-',
    ]);
    ff.on('error', () => resolve(false));
    ff.on('close', (code) => resolve(code === 0));
    setTimeout(() => {
      ff.kill('SIGKILL');
      resolve(false);
    }, 15_000).unref();
  });
}

/** The fastest H.264 encoder this machine has (GPU when available). */
export function castEncoder(): Promise<Encoder> {
  encoderPick ??= (async () => {
    const candidates: Encoder[] = [];
    if (config.hwAccel === 'vaapi' && fs.existsSync(config.vaapiDevice)) {
      candidates.push({ name: 'h264_vaapi', pre: ['-vaapi_device', config.vaapiDevice], filterTail: ',format=nv12,hwupload', args: ['-c:v', 'h264_vaapi', '-qp', '22'] });
    }
    candidates.push(
      { name: 'h264_nvenc', pre: [], filterTail: '', args: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '22', '-profile:v', 'high', '-forced-idr', '1'] },
      { name: 'h264_qsv', pre: [], filterTail: ',format=nv12', args: ['-c:v', 'h264_qsv', '-preset', 'faster', '-global_quality', '22', '-profile:v', 'high', '-forced_idr', '1'] },
      { name: 'h264_amf', pre: [], filterTail: ',format=nv12', args: ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '21', '-qp_p', '23', '-profile:v', 'high', '-bf', '0'] },
    );
    for (const c of candidates) if (await tryEncoder(c)) return c;
    return { name: 'libx264', pre: [], filterTail: '', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-profile:v', 'high', '-level', '4.1'] };
  })();
  return encoderPick;
}

// ---------------------------------------------------------------- helpers

function assTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

function vttTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}

function parseVtt(text: string): Cue[] {
  const toSec = (t: string) => {
    const p = t.replace(',', '.').split(':').map(Number);
    return p.length === 3 ? p[0]! * 3600 + p[1]! * 60 + p[2]! : p[0]! * 60 + p[1]!;
  };
  const cues: Cue[] = [];
  for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const m = /([\d:.,]+)\s*-->\s*([\d:.,]+)/.exec(lines[at]!);
    if (!m) continue;
    const body = lines.slice(at + 1).join('\n').trim();
    if (body) cues.push({ start: toSec(m[1]!), end: toSec(m[2]!), text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** SRT/VTT body -> safe WebVTT payload (inline styling kept, override tags dropped). */
function cleanText(t: string): string {
  return t
    .replace(/\r/g, '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/<(?!\/?(i|b|u)>)[^>]+>/g, '')
    .replace(/-->/g, '->')
    .trim();
}

/** Parses the playlist ffmpeg writes for one run. */
function readRunPlaylist(file: string): { dur: number; uri: string }[] {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: { dur: number; uri: string }[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^#EXTINF:([\d.]+)/.exec(lines[i]!);
    if (m && lines[i + 1] && !lines[i + 1]!.startsWith('#')) out.push({ dur: Number(m[1]), uri: lines[i + 1]!.trim() });
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the session

export interface CastMediaOptions {
  owner: string;
  source: string;
  audioTrack: number;
  start: number;
  subtitle: CastSubtitle | null;
  target: 'hls' | 'dlna';
}

export class CastMedia {
  readonly token = randomToken(24);
  readonly dir: string;
  readonly owner: string;
  readonly target: 'hls' | 'dlna';
  readonly start: number;
  private srcRef: [string, string, string | undefined];
  src: MediaSource;
  private audioTrack: number;
  duration: number | null = null;
  copyVideo = true;
  burnTrack: number | null = null;
  textTrack: number | null = null;
  private textCues: Cue[] | null = null;
  textLanguage: string | null = null;
  textLabel: string | null = null;
  firstPts: number | null = null;
  runs: Run[] = [];
  finished = false;
  error: string | null = null;
  lastAccess = Date.now();
  private ac = new AbortController();
  private encoder: Encoder | null = null;
  private stopped = false;

  constructor(opts: CastMediaOptions, src: MediaSource) {
    this.owner = opts.owner;
    this.target = opts.target;
    this.start = Math.max(0, opts.start);
    this.audioTrack = opts.audioTrack;
    const [kind, a, b] = opts.source.split('/');
    this.srcRef = [kind!, a!, b];
    this.src = src;
    this.dir = path.join(config.torrentDir, '.cast', this.token);
    fs.mkdirSync(this.dir, { recursive: true });
    if (opts.subtitle?.kind === 'text') {
      this.textCues = parseVtt(opts.subtitle.vtt).map((c) => ({ ...c, text: cleanText(c.text) })).filter((c) => c.text);
      this.textLanguage = opts.subtitle.language ?? null;
      this.textLabel = opts.subtitle.label ?? null;
    }
  }

  get hasText(): boolean {
    return this.textCues !== null || this.textTrack !== null;
  }

  /** DLNA without burning plays the original file. */
  get direct(): boolean {
    return this.target === 'dlna' && this.burnTrack === null;
  }

  /** Decides copy vs encode and burn vs text, then starts producing. */
  async prepare(subtitle: CastSubtitle | null): Promise<void> {
    const tracks = await probeTracks(this.src).catch(() => null);
    this.duration = tracks?.duration ?? null;
    const info = await mkvInfo(this.src).catch(() => null);
    if (subtitle?.kind === 'embedded') {
      const t = info?.tracks.find((x) => x.number === subtitle.track && x.type === 'subtitle');
      if (!t) throw new HttpError(404, 'That subtitle track is not in the file');
      if (t.codec === 'ass' || t.codec === 'ssa') this.burnTrack = t.number;
      else this.textTrack = t.number;
      this.textLanguage = t.language;
      this.textLabel = t.name;
    }
    if (this.direct) {
      // TVs often show a file's own text subtitles; an external file is offered as a sidecar.
      return;
    }
    const video = info?.tracks.find((t) => t.type === 'video');
    const codec = video?.codec ?? tracks?.video?.codec ?? '';
    const profile = video?.codecPrivate?.[1];
    // Chromecasts decode 8-bit H.264 everywhere; 10-bit H.264 and other codecs are re-encoded.
    this.copyVideo = this.burnTrack === null && codec === 'h264' && profile !== 110 && profile !== 122 && profile !== 244 && !tracks?.video?.hdr;
    if (!this.copyVideo) this.encoder = await castEncoder();
    const subTrack = this.burnTrack ?? this.textTrack;
    if (subTrack !== null) void followTrack(this.src, subTrack, this.start, this.ac.signal);
    if (this.burnTrack !== null) await this.writeFonts(info);
    await this.startRun(this.start);
  }

  private async writeFonts(info: Awaited<ReturnType<typeof mkvInfo>>): Promise<void> {
    const dir = path.join(this.dir, 'fonts');
    fs.mkdirSync(dir, { recursive: true });
    for (const att of info?.attachments.filter(isFont) ?? []) {
      if (!att.size || att.size > 64 * 1024 * 1024) continue;
      const file = path.join(dir, `${att.index}${path.extname(att.name) || '.ttf'}`);
      await new Promise<void>((resolve) => {
        const r = this.src.createReadStream({ start: att.pos, end: att.pos + att.size - 1 });
        const w = fs.createWriteStream(file);
        r.on('error', () => resolve());
        w.on('error', () => resolve());
        w.on('finish', () => resolve());
        r.pipe(w);
      });
    }
  }

  /** How far (media seconds) the subtitle reader has covered from `from`, or null when all is known. */
  private coveredUntil(from: number): number | null {
    if (this.burnTrack === null) return null;
    const k = knownTrack(this.src, this.burnTrack);
    if (k.complete) return null;
    return k.ranges.find(([a, b]) => a <= from + 1 && b > from)?.[1] ?? from;
  }

  private async writeAss(k: number): Promise<string> {
    const info = await mkvInfo(this.src);
    const track = info?.tracks.find((t) => t.number === this.burnTrack);
    let header = track?.codecPrivate?.toString('utf8') ?? '[Script Info]\nScriptType: v4.00+\n';
    if (!/\[Events\]/i.test(header)) header += '\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
    const lines = knownTrack(this.src, this.burnTrack!).blocks
      .map((b) => {
        // Matroska ASS blocks: ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
        const parts = b.text.split(',');
        if (parts.length < 9) return null;
        const order = Number(parts[0]);
        return { order, start: b.start, line: `Dialogue: ${parts[1]},${assTime(b.start)},${assTime(b.start + b.duration)},${parts.slice(2, 8).join(',')},${parts.slice(8).join(',')}` };
      })
      .filter((x): x is { order: number; start: number; line: string } => x !== null)
      .sort((a, b) => a.start - b.start || a.order - b.order)
      .map((x) => x.line);
    const name = `sub_${k}.ass`;
    fs.writeFileSync(path.join(this.dir, name), `${header.trimEnd()}\n${lines.join('\n')}\n`, 'utf8');
    return name;
  }

  private inputArgs(from: number, to: number | null): string[] {
    const src = this.src;
    const dur = to !== null ? ['-t', (to - from).toFixed(3)] : [];
    const ss = from > 0 ? ['-ss', from.toFixed(3)] : [];
    if (src.diskPath) return [...ss, ...dur, '-i', src.diskPath];
    if (src.url) {
      const h = src.headers ? ['-headers', Object.entries(src.headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')] : [];
      return [...h, ...ss, ...dur, '-i', src.url];
    }
    // Torrents: the loopback stream URL supports byte ranges, so ffmpeg can seek.
    const [kind, a, b] = this.srcRef;
    return [...ss, ...dur, '-i', internalStreamUrl(kind, a, b)];
  }

  private async encodeArgs(from: number, to: number | null, k: number): Promise<string[]> {
    const audio = ['-map', '0:v:0', '-map', `0:a:${this.audioTrack}?`, '-c:a', 'aac', '-b:a', '192k', '-ac', '2'];
    if (this.copyVideo) return [...this.inputArgs(from, to), ...audio, '-c:v', 'copy'];
    const e = this.encoder!;
    const filters: string[] = [];
    if (this.burnTrack !== null) filters.push(`ass=${await this.writeAss(k)}:fontsdir=fonts`);
    filters.push(`scale=-2:'min(1080,ih)'`, `format=yuv420p${e.filterTail}`);
    return [
      ...e.pre,
      ...this.inputArgs(from, to),
      ...audio,
      '-vf', filters.join(','),
      ...e.args,
      '-g', '96',
      '-force_key_frames', `expr:if(isnan(prev_forced_t),1,gte(t,prev_forced_t+${SEG}))`,
    ];
  }

  private async startRun(from: number): Promise<void> {
    if (this.stopped) return;
    const k = this.runs.length;
    // A torrent's subtitles arrive as it downloads: burn only as far as they're known, then continue.
    const covered = this.coveredUntil(from);
    let to: number | null = null;
    if (covered !== null) to = from + Math.max(SEG * 8, Math.floor((covered - from) / SEG) * SEG);
    if (to !== null && this.duration && to >= this.duration - 1) to = null;
    const run: Run = { k, from, to, proc: null, done: false };
    this.runs.push(run);
    if (this.target === 'dlna') return; // DLNA streams are produced per request (see streamTs)
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      ...(await this.encodeArgs(from, to, k)),
      '-copyts', '-muxdelay', '0', '-muxpreload', '0', '-output_ts_offset', String(TS_OFFSET),
      '-f', 'hls', '-hls_time', String(SEG), '-hls_list_size', '0', '-hls_playlist_type', 'event',
      '-hls_flags', 'independent_segments+temp_file', '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', `r${k}_%05d.ts`, `run${k}.m3u8`,
    ];
    const ff = spawn(config.ffmpegPath, args, { cwd: this.dir });
    run.proc = ff;
    let stderr = '';
    ff.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    ff.on('error', (e) => {
      this.error = `ffmpeg could not start: ${e.message}`;
    });
    ff.on('close', (code) => {
      run.done = true;
      run.proc = null;
      if (this.stopped) return;
      if (code !== 0 && !readRunPlaylist(path.join(this.dir, `run${k}.m3u8`)).length) {
        this.error = stderr.trim().split('\n').pop() || `ffmpeg exited with code ${code}`;
        return;
      }
      if (to === null) {
        this.finished = true;
        return;
      }
      void this.continueAfter(to);
    });
  }

  private async continueAfter(to: number): Promise<void> {
    // Wait (a while) for the subtitle reader to get further, then encode the next chunk.
    for (let i = 0; i < 90 && !this.stopped; i++) {
      const covered = this.coveredUntil(to);
      if (covered === null || covered >= to + SEG * 8) break;
      await sleep(1000);
    }
    await this.startRun(to);
  }

  /** Every segment produced so far, in order, with its absolute start time. */
  segments(): { uri: string; dur: number; at: number }[] {
    const out: { uri: string; dur: number; at: number }[] = [];
    for (const run of this.runs) {
      let at = run.k === 0 ? (this.firstPts ?? run.from) : run.from;
      for (const s of readRunPlaylist(path.join(this.dir, `run${run.k}.m3u8`))) {
        out.push({ uri: s.uri, dur: s.dur, at });
        at += s.dur;
      }
    }
    return out;
  }

  /** Resolves once the stream can be handed to a TV (a couple of segments exist). */
  async ready(timeoutMs = 90_000): Promise<void> {
    if (this.direct) return;
    if (this.target === 'dlna') return;
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (this.error) throw new HttpError(500, `Casting failed: ${this.error}`);
      const segs = this.segments();
      if (segs.length >= 2 || (segs.length && (this.finished || this.runs.every((r) => r.done)))) {
        if (this.firstPts === null) this.firstPts = await firstPts(path.join(this.dir, segs[0]!.uri)).then((t) => (t === null ? this.start : t - TS_OFFSET));
        return;
      }
      await sleep(400);
    }
    throw new HttpError(504, 'The stream took too long to start; the source may be slow');
  }

  // ---------------------------------------------------------------- playlists

  masterPlaylist(): string {
    if (!this.hasText) return this.videoPlaylist();
    const raw = (this.textLanguage ?? 'und').toLowerCase().replace(/[^a-z-]/g, '');
    const lang = ISO3[raw] ?? raw;
    const name = (this.textLabel || lang || 'Subtitles').replace(/"/g, "'");
    return [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-START:TIME-OFFSET=0,PRECISE=YES',
      `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${name}",LANGUAGE="${lang}",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,URI="subs.m3u8"`,
      '#EXT-X-STREAM-INF:BANDWIDTH=10000000,SUBTITLES="subs"',
      'video.m3u8',
      '',
    ].join('\n');
  }

  private playlist(entries: { uri: string; dur: number }[], end: boolean): string {
    const target = this.copyVideo ? 20 : SEG + 1;
    return [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.max(target, ...entries.map((e) => Math.ceil(e.dur)))}`,
      '#EXT-X-PLAYLIST-TYPE:EVENT',
      // A still-growing playlist would otherwise start at its live edge, not where you pressed cast.
      '#EXT-X-START:TIME-OFFSET=0,PRECISE=YES',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      ...entries.flatMap((e) => [`#EXTINF:${e.dur.toFixed(3)},`, e.uri]),
      ...(end ? ['#EXT-X-ENDLIST'] : []),
      '',
    ].join('\n');
  }

  videoPlaylist(): string {
    return this.playlist(this.segments(), this.finished);
  }

  /** Subtitle segments are only listed once their lines are known, so a TV never caches an empty one. */
  subsPlaylist(): string {
    const segs = this.segments();
    let list = segs.map((s, i) => ({ uri: `subs_${i}.vtt`, dur: s.dur, at: s.at }));
    if (this.textTrack !== null) list = list.filter((s) => trackCovers(this.src, this.textTrack!, s.at, s.at + s.dur));
    // A gap would hide everything after it: stop at the first segment that isn't ready yet.
    const contiguous: typeof list = [];
    for (let i = 0; i < list.length; i++) {
      if (list[i]!.uri !== `subs_${i}.vtt`) break;
      contiguous.push(list[i]!);
    }
    return this.playlist(contiguous, this.finished && contiguous.length === segs.length);
  }

  subsSegment(i: number): string {
    const seg = this.segments()[i];
    if (!seg) throw new HttpError(404, 'No such segment');
    const from = seg.at;
    const to = seg.at + seg.dur;
    let cues: Cue[] = [];
    if (this.textCues) cues = this.textCues.filter((c) => c.start < to && c.end > from);
    else if (this.textTrack !== null) {
      cues = knownTrack(this.src, this.textTrack)
        .blocks.filter((b) => b.start / 1000 < to && (b.start + b.duration) / 1000 > from)
        .map((b) => ({ start: b.start / 1000, end: (b.start + b.duration) / 1000, text: cleanText(b.text) }))
        .filter((c) => c.text);
    }
    // Cue times are the file's own clock; the map ties them to the segments' timestamps.
    return [
      'WEBVTT',
      `X-TIMESTAMP-MAP=MPEGTS:${TS_OFFSET * 90000},LOCAL:00:00:00.000`,
      '',
      ...cues.flatMap((c) => [`${vttTime(c.start)} --> ${vttTime(c.end)}`, c.text, '']),
    ].join('\n');
  }

  /** SRT sidecar for DLNA TVs. */
  srt(): string {
    const cues = this.textCues ?? (this.textTrack !== null
      ? knownTrack(this.src, this.textTrack).blocks.map((b) => ({ start: b.start / 1000, end: (b.start + b.duration) / 1000, text: cleanText(b.text) }))
      : []);
    const t = (s: number) => vttTime(s).replace('.', ',');
    return cues
      .filter((c) => c.text)
      .map((c, i) => `${i + 1}\n${t(c.start)} --> ${t(c.end)}\n${c.text.replace(/<[^>]+>/g, '')}\n`)
      .join('\n');
  }

  // ---------------------------------------------------------------- DLNA burned stream

  /** One continuous MPEG-TS for DLNA TVs: the chunks are encoded one after another into the response. */
  async streamTs(req: Request, res: Response): Promise<void> {
    res.setHeader('Content-Type', 'video/mpeg');
    res.setHeader('transferMode.dlna.org', 'Streaming');
    res.setHeader('contentFeatures.dlna.org', 'DLNA.ORG_OP=00;DLNA.ORG_CI=1;DLNA.ORG_FLAGS=01700000000000000000000000000000');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'HEAD') return void res.end();
    let from = this.start;
    let k = 0;
    let closed = false;
    let current: ChildProcess | null = null;
    req.on('close', () => {
      closed = true;
      current?.kill('SIGKILL');
    });
    while (!closed && !this.stopped) {
      const covered = this.coveredUntil(from);
      let to: number | null = covered === null ? null : from + Math.max(SEG * 8, Math.floor((covered - from) / SEG) * SEG);
      if (to !== null && this.duration && to >= this.duration - 1) to = null;
      const args = [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        ...(await this.encodeArgs(from, to, k++)),
        '-copyts', '-muxdelay', '0', '-muxpreload', '0', '-output_ts_offset', String(TS_OFFSET),
        '-f', 'mpegts', 'pipe:1',
      ];
      const ff = spawn(config.ffmpegPath, args, { cwd: this.dir });
      current = ff;
      ff.stderr.on('data', () => undefined);
      ff.stdout.pipe(res, { end: false });
      const code = await new Promise<number | null>((r) => ff.on('close', r));
      current = null;
      if (closed || code !== 0 || to === null) break;
      from = to;
      for (let i = 0; i < 90 && !closed; i++) {
        const c = this.coveredUntil(from);
        if (c === null || c >= from + SEG * 8) break;
        await sleep(1000);
      }
    }
    res.end();
  }

  /** The original file, with the headers DLNA TVs look for. */
  serveDirect(req: Request, res: Response, subtitleUrl: string | null): void {
    res.setHeader('transferMode.dlna.org', 'Streaming');
    res.setHeader('contentFeatures.dlna.org', 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000');
    if (subtitleUrl) res.setHeader('CaptionInfo.sec', subtitleUrl);
    serveRangeForCast(req, res, this.src);
  }

  stop(): void {
    this.stopped = true;
    this.ac.abort();
    for (const r of this.runs) r.proc?.kill('SIGKILL');
    setTimeout(() => fs.rm(this.dir, { recursive: true, force: true }, () => undefined), 2000).unref();
  }

  get produced(): number {
    const segs = this.segments();
    const last = segs.at(-1);
    return last ? last.at + last.dur : this.start;
  }
}

function firstPts(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    const ff = spawn(config.ffprobePath, ['-v', 'error', '-show_entries', 'format=start_time', '-of', 'default=nw=1:nk=1', file]);
    let out = '';
    ff.stdout.on('data', (d: Buffer) => (out += d.toString()));
    ff.on('error', () => resolve(null));
    ff.on('close', () => {
      const n = Number(out.trim());
      resolve(Number.isFinite(n) ? n : null);
    });
  });
}

// Provided by the stream router (loopback URL + range serving), set at startup to avoid an import cycle.
let internalStreamUrl: (kind: string, a: string, b?: string) => string = () => {
  throw new Error('cast media is not wired');
};
let serveRangeForCast: (req: Request, res: Response, src: MediaSource) => void = () => {
  throw new Error('cast media is not wired');
};
export function wireCastMedia(urlFn: typeof internalStreamUrl, rangeFn: typeof serveRangeForCast): void {
  internalStreamUrl = urlFn;
  serveRangeForCast = rangeFn;
}

// ---------------------------------------------------------------- registry

const sessions = new Map<string, CastMedia>();

setInterval(() => {
  const now = Date.now();
  for (const [token, m] of sessions) {
    if (now - m.lastAccess > 10 * 60_000) {
      m.stop();
      sessions.delete(token);
    }
  }
}, 60_000).unref();

/** Starts producing a cast stream. One per account: casting something new ends the previous one. */
export async function createCastMedia(opts: CastMediaOptions): Promise<CastMedia> {
  const [kind, a, b] = opts.source.split('/');
  const src = kind && a ? resolveSource(kind, a, b) : null;
  if (!src) throw new HttpError(404, 'This source is no longer available; reopen it first');
  for (const [token, m] of sessions) {
    if (m.owner === opts.owner) {
      m.stop();
      sessions.delete(token);
    }
  }
  const media = new CastMedia(opts, src);
  sessions.set(media.token, media);
  try {
    await media.prepare(opts.subtitle);
    await media.ready();
  } catch (e) {
    media.stop();
    sessions.delete(media.token);
    throw e;
  }
  return media;
}

export function castMedia(token: string): CastMedia | null {
  const m = sessions.get(token) ?? null;
  if (m) m.lastAccess = Date.now();
  return m;
}

export function endCastMedia(token: string): void {
  sessions.get(token)?.stop();
  sessions.delete(token);
}
