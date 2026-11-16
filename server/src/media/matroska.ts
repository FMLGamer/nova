/**
 * A small, dependency-free Matroska (MKV/WebM) reader.
 *
 * It exists so that tracks, chapters, font attachments and embedded subtitles
 * are available instantly instead of by demuxing the whole file with ffmpeg:
 *  - the track table, chapters and attachment index sit in the first few
 *    hundred KB, so probing reads almost nothing;
 *  - subtitle events are pulled out of the clusters around the playhead (found
 *    through the Cues index), i.e. the very bytes playback is fetching anyway.
 *
 * All access goes through a ByteReader, so the same code works on files on
 * disk, torrents that are still downloading, and remote HTTP sources.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';

// ---------------------------------------------------------------- byte access

export interface ByteReader {
  size: number;
  read(pos: number, len: number): Promise<Buffer>;
  close?(): Promise<void>;
}

export function fileReader(path: string, size: number): ByteReader {
  let handle: Promise<fs.promises.FileHandle> | null = null;
  return {
    size,
    async read(pos, len) {
      handle ??= fs.promises.open(path, 'r');
      const fh = await handle;
      const buf = Buffer.allocUnsafe(Math.max(0, Math.min(len, size - pos)));
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      return buf.subarray(0, bytesRead);
    },
    async close() {
      if (handle) await (await handle).close().catch(() => undefined);
      handle = null;
    },
  };
}

export function streamReader(size: number, open: (start: number, end: number) => Readable): ByteReader {
  return {
    size,
    read(pos, len) {
      const end = Math.min(size, pos + len) - 1;
      if (end < pos) return Promise.resolve(Buffer.alloc(0));
      return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        const s = open(pos, end);
        s.on('data', (c: Buffer) => chunks.push(c));
        s.on('end', () => resolve(Buffer.concat(chunks)));
        s.on('error', reject);
      });
    },
  };
}

/** Caches one window of the file so header-sized reads don't each hit the source. */
class Window {
  private start = 0;
  private buf: Buffer = Buffer.alloc(0);
  constructor(
    readonly reader: ByteReader,
    private readonly windowSize: number,
  ) {}

  async bytes(pos: number, len: number): Promise<Buffer> {
    if (pos >= this.start && pos + len <= this.start + this.buf.length) {
      return this.buf.subarray(pos - this.start, pos - this.start + len);
    }
    const want = Math.max(len, this.windowSize);
    this.buf = await this.reader.read(pos, Math.min(want, this.reader.size - pos));
    this.start = pos;
    if (this.buf.length < len) throw new EndOfData();
    return this.buf.subarray(0, len);
  }
}

class EndOfData extends Error {
  constructor() {
    super('end of data');
  }
}

// ---------------------------------------------------------------- EBML

const ID = {
  EBML: 0x1a45dfa3,
  DocType: 0x4282,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  FlagEnabled: 0xb9,
  FlagDefault: 0x88,
  FlagForced: 0x55aa,
  DefaultDuration: 0x23e383,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Language: 0x22b59c,
  LanguageBCP47: 0x22b59d,
  Name: 0x536e,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Colour: 0x55b0,
  TransferCharacteristics: 0x55ba,
  Audio: 0xe1,
  Channels: 0x9f,
  ContentEncodings: 0x6d80,
  ContentEncoding: 0x6240,
  ContentEncodingType: 0x5033,
  ContentCompression: 0x5034,
  ContentCompAlgo: 0x4254,
  ContentCompSettings: 0x4255,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueClusterPosition: 0xf1,
  Attachments: 0x1941a469,
  AttachedFile: 0x61a7,
  FileName: 0x466e,
  FileMimeType: 0x4660,
  FileData: 0x465c,
  Chapters: 0x1043a770,
  EditionEntry: 0x45b9,
  EditionFlagHidden: 0x45bd,
  EditionFlagDefault: 0x45db,
  ChapterAtom: 0xb6,
  ChapterTimeStart: 0x91,
  ChapterTimeEnd: 0x92,
  ChapterFlagHidden: 0x98,
  ChapterDisplay: 0x80,
  ChapString: 0x85,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
} as const;

/** Level-1 children of Segment: an unknown-size Cluster ends where one of these begins. */
const TOP_LEVEL = new Set<number>([ID.SeekHead, ID.Info, ID.Tracks, ID.Cues, ID.Attachments, ID.Chapters, ID.Cluster, 0x1254c367]);

interface Header {
  id: number;
  /** -1 = unknown size (streamed files). */
  size: number;
  dataStart: number;
  end: number;
}

async function readHeader(w: Window, pos: number, limit: number): Promise<Header | null> {
  if (pos >= limit) return null;
  const head = await w.bytes(pos, Math.min(12, limit - pos)).catch(() => null);
  if (!head || head.length < 2) return null;
  const b0 = head[0]!;
  let idLen = 1;
  while (idLen <= 4 && !(b0 & (0x80 >> (idLen - 1)))) idLen++;
  if (idLen > 4 || head.length < idLen + 1) return null;
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + head[i]!;
  const s0 = head[idLen]!;
  let sizeLen = 1;
  while (sizeLen <= 8 && !(s0 & (0x80 >> (sizeLen - 1)))) sizeLen++;
  if (sizeLen > 8 || head.length < idLen + sizeLen) return null;
  let size = s0 & (0xff >> sizeLen);
  let allOnes = size === 0xff >> sizeLen;
  for (let i = 1; i < sizeLen; i++) {
    const b = head[idLen + i]!;
    size = size * 256 + b;
    if (b !== 0xff) allOnes = false;
  }
  const dataStart = pos + idLen + sizeLen;
  if (allOnes) return { id, size: -1, dataStart, end: limit };
  return { id, size, dataStart, end: dataStart + size };
}

function uint(b: Buffer): number {
  let v = 0;
  for (const x of b) v = v * 256 + x;
  return v;
}

function float(b: Buffer): number {
  if (b.length === 4) return b.readFloatBE(0);
  if (b.length === 8) return b.readDoubleBE(0);
  return 0;
}

function str(b: Buffer): string {
  const z = b.indexOf(0);
  return (z >= 0 ? b.subarray(0, z) : b).toString('utf8').trim();
}

/** Iterates the children of a master element. */
async function* children(w: Window, start: number, end: number): AsyncGenerator<Header> {
  let pos = start;
  while (pos < end) {
    const h = await readHeader(w, pos, end);
    if (!h || h.size < 0) return;
    yield h;
    pos = h.end;
  }
}

async function data(w: Window, h: Header, max = 1 << 20): Promise<Buffer> {
  return w.bytes(h.dataStart, Math.min(h.size, max));
}

// ---------------------------------------------------------------- model

export interface MkvTrack {
  number: number;
  type: 'video' | 'audio' | 'subtitle' | 'other';
  codecId: string;
  /** ffmpeg-style codec name, e.g. h264, eac3, ass, subrip. */
  codec: string;
  language: string | null;
  name: string | null;
  default: boolean;
  forced: boolean;
  width: number | null;
  height: number | null;
  channels: number | null;
  hdr: boolean;
  defaultDurationNs: number | null;
  /** Only kept for subtitle tracks (the ASS header lives here). */
  codecPrivate: Buffer | null;
  compression: { algo: number; settings: Buffer | null } | null;
  encrypted: boolean;
}

export interface MkvAttachment {
  index: number;
  name: string;
  mime: string;
  pos: number;
  size: number;
}

export interface MkvChapter {
  start: number;
  end: number | null;
  title: string;
}

export interface MkvInfo {
  docType: string;
  segmentStart: number;
  segmentEnd: number;
  /** Nanoseconds per timestamp tick (default 1ms). */
  timestampScale: number;
  duration: number | null;
  tracks: MkvTrack[];
  attachments: MkvAttachment[];
  chapters: MkvChapter[];
  firstCluster: number | null;
  /** Absolute position of the Cues element, loaded lazily. */
  cuesPos: number | null;
  cues: { time: number; pos: number }[] | null;
}

const VIDEO_CODECS: Record<string, string> = {
  'V_MPEG4/ISO/AVC': 'h264',
  'V_MPEGH/ISO/HEVC': 'hevc',
  V_AV1: 'av1',
  V_VP9: 'vp9',
  V_VP8: 'vp8',
  V_MPEG2: 'mpeg2video',
  'V_MPEG4/ISO/ASP': 'mpeg4',
  'V_MPEG4/ISO/SP': 'mpeg4',
  'V_MS/VFW/FOURCC': 'vfw',
};

function codecName(type: MkvTrack['type'], id: string): string {
  if (type === 'video') return VIDEO_CODECS[id] ?? id.replace(/^V_/, '').toLowerCase();
  if (type === 'audio') {
    if (id.startsWith('A_AAC')) return 'aac';
    if (id === 'A_AC3' || id === 'A_AC3/BSID9' || id === 'A_AC3/BSID10') return 'ac3';
    if (id === 'A_EAC3') return 'eac3';
    if (id.startsWith('A_DTS')) return 'dts';
    if (id === 'A_TRUEHD') return 'truehd';
    if (id === 'A_MLP') return 'mlp';
    if (id === 'A_OPUS') return 'opus';
    if (id === 'A_VORBIS') return 'vorbis';
    if (id === 'A_FLAC') return 'flac';
    if (id === 'A_MPEG/L3') return 'mp3';
    if (id === 'A_MPEG/L2' || id === 'A_MPEG/L1') return 'mp2';
    if (id.startsWith('A_PCM')) return 'pcm';
    return id.replace(/^A_/, '').toLowerCase();
  }
  if (type === 'subtitle') {
    if (id === 'S_TEXT/UTF8' || id === 'S_TEXT/ASCII') return 'subrip';
    if (id === 'S_TEXT/ASS' || id === 'S_ASS') return 'ass';
    if (id === 'S_TEXT/SSA' || id === 'S_SSA') return 'ssa';
    if (id === 'S_TEXT/WEBVTT') return 'webvtt';
    if (id === 'S_HDMV/PGS') return 'hdmv_pgs_subtitle';
    if (id === 'S_VOBSUB') return 'dvd_subtitle';
    if (id === 'S_DVBSUB') return 'dvb_subtitle';
    if (id === 'S_HDMV/TEXTST') return 'hdmv_text_subtitle';
    return id.replace(/^S_/, '').toLowerCase();
  }
  return id;
}

export const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'ass', 'ssa', 'webvtt']);

async function parseTrack(w: Window, entry: Header): Promise<MkvTrack> {
  const t: MkvTrack = {
    number: 0,
    type: 'other',
    codecId: '',
    codec: '',
    language: 'eng', // the Matroska default when the element is absent
    name: null,
    default: true,
    forced: false,
    width: null,
    height: null,
    channels: null,
    hdr: false,
    defaultDurationNs: null,
    codecPrivate: null,
    compression: null,
    encrypted: false,
  };
  let bcp47: string | null = null;
  let priv: Header | null = null;
  for await (const c of children(w, entry.dataStart, entry.end)) {
    switch (c.id) {
      case ID.TrackNumber:
        t.number = uint(await data(w, c));
        break;
      case ID.TrackType: {
        const v = uint(await data(w, c));
        t.type = v === 1 ? 'video' : v === 2 ? 'audio' : v === 17 ? 'subtitle' : 'other';
        break;
      }
      case ID.FlagDefault:
        t.default = uint(await data(w, c)) === 1;
        break;
      case ID.FlagForced:
        t.forced = uint(await data(w, c)) === 1;
        break;
      case ID.DefaultDuration:
        t.defaultDurationNs = uint(await data(w, c));
        break;
      case ID.CodecID:
        t.codecId = str(await data(w, c));
        break;
      case ID.CodecPrivate:
        priv = c;
        break;
      case ID.Language:
        t.language = str(await data(w, c)) || 'eng';
        break;
      case ID.LanguageBCP47:
        bcp47 = str(await data(w, c)) || null;
        break;
      case ID.Name:
        t.name = str(await data(w, c)) || null;
        break;
      case ID.Video:
        for await (const v of children(w, c.dataStart, c.end)) {
          if (v.id === ID.PixelWidth) t.width = uint(await data(w, v));
          else if (v.id === ID.PixelHeight) t.height = uint(await data(w, v));
          else if (v.id === ID.Colour) {
            for await (const col of children(w, v.dataStart, v.end)) {
              if (col.id === ID.TransferCharacteristics) {
                const tc = uint(await data(w, col));
                t.hdr = tc === 16 || tc === 18;
              }
            }
          }
        }
        break;
      case ID.Audio:
        for await (const a of children(w, c.dataStart, c.end)) {
          if (a.id === ID.Channels) t.channels = uint(await data(w, a));
        }
        break;
      case ID.ContentEncodings:
        for await (const enc of children(w, c.dataStart, c.end)) {
          if (enc.id !== ID.ContentEncoding) continue;
          let type = 0;
          let comp: MkvTrack['compression'] = null;
          for await (const e of children(w, enc.dataStart, enc.end)) {
            if (e.id === ID.ContentEncodingType) type = uint(await data(w, e));
            else if (e.id === ID.ContentCompression) {
              comp = { algo: 0, settings: null };
              for await (const cc of children(w, e.dataStart, e.end)) {
                if (cc.id === ID.ContentCompAlgo) comp.algo = uint(await data(w, cc));
                else if (cc.id === ID.ContentCompSettings) comp.settings = Buffer.from(await data(w, cc));
              }
            }
          }
          if (type === 1) t.encrypted = true;
          else if (comp) t.compression = comp;
        }
        break;
    }
  }
  if (bcp47) t.language = bcp47;
  if (t.language === 'und') t.language = null;
  t.codec = codecName(t.type, t.codecId);
  if (priv && t.type === 'subtitle') t.codecPrivate = Buffer.from(await data(w, priv, 4 << 20));
  // The first bytes of an avcC/hvcC record name the profile (10-bit H.264 can't be cast as-is).
  if (priv && t.type === 'video') t.codecPrivate = Buffer.from(await data(w, priv, 32));
  return t;
}

async function parseChapters(w: Window, h: Header): Promise<MkvChapter[]> {
  const editions: { hidden: boolean; isDefault: boolean; chapters: MkvChapter[] }[] = [];
  for await (const ed of children(w, h.dataStart, h.end)) {
    if (ed.id !== ID.EditionEntry) continue;
    const edition = { hidden: false, isDefault: false, chapters: [] as MkvChapter[] };
    for await (const a of children(w, ed.dataStart, ed.end)) {
      if (a.id === ID.EditionFlagHidden) edition.hidden = uint(await data(w, a)) === 1;
      else if (a.id === ID.EditionFlagDefault) edition.isDefault = uint(await data(w, a)) === 1;
      else if (a.id === ID.ChapterAtom) {
        let start = 0;
        let end: number | null = null;
        let hidden = false;
        let title = '';
        for await (const f of children(w, a.dataStart, a.end)) {
          if (f.id === ID.ChapterTimeStart) start = uint(await data(w, f)) / 1e9;
          else if (f.id === ID.ChapterTimeEnd) end = uint(await data(w, f)) / 1e9;
          else if (f.id === ID.ChapterFlagHidden) hidden = uint(await data(w, f)) === 1;
          else if (f.id === ID.ChapterDisplay && !title) {
            for await (const d of children(w, f.dataStart, f.end)) {
              if (d.id === ID.ChapString) title = str(await data(w, d));
            }
          }
        }
        if (!hidden) edition.chapters.push({ start, end, title });
      }
    }
    editions.push(edition);
  }
  const pick = editions.find((e) => e.isDefault && !e.hidden) ?? editions.find((e) => !e.hidden) ?? editions[0];
  const list = (pick?.chapters ?? []).sort((a, b) => a.start - b.start);
  return list.map((c, i) => ({ ...c, end: c.end ?? list[i + 1]?.start ?? null }));
}

async function parseAttachments(w: Window, h: Header): Promise<MkvAttachment[]> {
  const out: MkvAttachment[] = [];
  for await (const f of children(w, h.dataStart, h.end)) {
    if (f.id !== ID.AttachedFile) continue;
    const a: MkvAttachment = { index: out.length, name: '', mime: '', pos: 0, size: 0 };
    for await (const c of children(w, f.dataStart, f.end)) {
      if (c.id === ID.FileName) a.name = str(await data(w, c));
      else if (c.id === ID.FileMimeType) a.mime = str(await data(w, c));
      else if (c.id === ID.FileData) {
        a.pos = c.dataStart;
        a.size = c.size;
      }
    }
    out.push(a);
  }
  return out;
}

export function isFont(a: MkvAttachment): boolean {
  return /font|truetype|opentype|sfnt/i.test(a.mime) || /\.(ttf|otf|ttc|woff2?)$/i.test(a.name);
}

/** Reads the header (tracks, chapters, attachment index). Null when not Matroska. */
export async function readMkvInfo(reader: ByteReader): Promise<MkvInfo | null> {
  const w = new Window(reader, 256 * 1024);
  const ebml = await readHeader(w, 0, reader.size);
  if (!ebml || ebml.id !== ID.EBML) return null;
  let docType = 'matroska';
  for await (const c of children(w, ebml.dataStart, ebml.end)) {
    if (c.id === ID.DocType) docType = str(await data(w, c));
  }
  if (docType !== 'matroska' && docType !== 'webm') return null;
  const seg = await readHeader(w, ebml.end, reader.size);
  if (!seg || seg.id !== ID.Segment) return null;

  const info: MkvInfo = {
    docType,
    segmentStart: seg.dataStart,
    segmentEnd: Math.min(seg.end, reader.size),
    timestampScale: 1_000_000,
    duration: null,
    tracks: [],
    attachments: [],
    chapters: [],
    firstCluster: null,
    cuesPos: null,
    cues: null,
  };
  const seek = new Map<number, number>();
  const seen = new Set<number>();

  const parseTop = async (h: Header) => {
    seen.add(h.id);
    if (h.id === ID.SeekHead) {
      for await (const s of children(w, h.dataStart, h.end)) {
        if (s.id !== ID.Seek) continue;
        let sid = 0;
        let spos = -1;
        for await (const f of children(w, s.dataStart, s.end)) {
          if (f.id === ID.SeekID) sid = uint(await data(w, f));
          else if (f.id === ID.SeekPosition) spos = uint(await data(w, f));
        }
        if (sid && spos >= 0 && !seek.has(sid)) seek.set(sid, info.segmentStart + spos);
      }
    } else if (h.id === ID.Info) {
      let dur: number | null = null;
      for await (const c of children(w, h.dataStart, h.end)) {
        if (c.id === ID.TimestampScale) info.timestampScale = uint(await data(w, c)) || 1_000_000;
        else if (c.id === ID.Duration) dur = float(await data(w, c));
      }
      if (dur) info.duration = (dur * info.timestampScale) / 1e9;
    } else if (h.id === ID.Tracks) {
      for await (const e of children(w, h.dataStart, h.end)) {
        if (e.id === ID.TrackEntry) info.tracks.push(await parseTrack(w, e));
      }
    } else if (h.id === ID.Chapters) {
      info.chapters = await parseChapters(w, h);
    } else if (h.id === ID.Attachments) {
      info.attachments = await parseAttachments(w, h);
    }
  };

  // Walk the level-1 elements up to the first Cluster: Info, Tracks, Chapters
  // and (with mkvmerge) Attachments all live there.
  let pos = seg.dataStart;
  for (let i = 0; i < 64 && pos < info.segmentEnd; i++) {
    const h = await readHeader(w, pos, info.segmentEnd);
    if (!h) break;
    if (h.id === ID.Cluster) {
      info.firstCluster = pos;
      break;
    }
    if (h.size < 0) break;
    if (h.id === ID.Cues) info.cuesPos = pos;
    else await parseTop(h);
    pos = h.end;
  }
  // Anything the SeekHead points at beyond the clusters (Cues; sometimes chapters/attachments).
  for (const [id, at] of seek) {
    if (id === ID.Cues) {
      info.cuesPos ??= at;
      continue;
    }
    if (seen.has(id) || (id !== ID.Chapters && id !== ID.Attachments && id !== ID.Tracks && id !== ID.Info)) continue;
    const h = await readHeader(w, at, info.segmentEnd).catch(() => null);
    if (h && h.id === id && h.size >= 0) await parseTop(h).catch(() => undefined);
  }
  return info;
}

/** Loads the Cues index (lazily: it usually sits at the very end of the file). */
export async function loadCues(reader: ByteReader, info: MkvInfo): Promise<{ time: number; pos: number }[]> {
  if (info.cues) return info.cues;
  const out: { time: number; pos: number }[] = [];
  if (info.cuesPos != null) {
    const w = new Window(reader, 512 * 1024);
    const h = await readHeader(w, info.cuesPos, info.segmentEnd).catch(() => null);
    if (h && h.id === ID.Cues && h.size >= 0) {
      for await (const cp of children(w, h.dataStart, h.end)) {
        if (cp.id !== ID.CuePoint) continue;
        let time = -1;
        let cpos = -1;
        for await (const c of children(w, cp.dataStart, cp.end)) {
          if (c.id === ID.CueTime) time = uint(await data(w, c));
          else if (c.id === ID.CueTrackPositions && cpos < 0) {
            for await (const tp of children(w, c.dataStart, c.end)) {
              if (tp.id === ID.CueClusterPosition) cpos = uint(await data(w, tp));
            }
          }
        }
        if (time >= 0 && cpos >= 0) out.push({ time: (time * info.timestampScale) / 1e9, pos: info.segmentStart + cpos });
      }
    }
  }
  out.sort((a, b) => a.time - b.time || a.pos - b.pos);
  info.cues = out.filter((c, i) => i === 0 || c.pos !== out[i - 1]!.pos);
  return info.cues;
}

/** Scans forward for the next Cluster header at or after `from`. */
async function resyncCluster(reader: ByteReader, from: number, limit: number): Promise<number | null> {
  const sig = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
  const w = new Window(reader, 256 * 1024);
  for (let pos = from; pos < limit; ) {
    const chunk = await reader.read(pos, Math.min(1 << 20, limit - pos)).catch(() => null);
    if (!chunk?.length) return null;
    let at = chunk.indexOf(sig);
    while (at >= 0) {
      const h = await readHeader(w, pos + at, limit).catch(() => null);
      if (h && h.id === ID.Cluster) {
        const first = await readHeader(w, h.dataStart, h.size < 0 ? limit : h.end).catch(() => null);
        if (first && (first.id === ID.Timestamp || first.id === 0xbf || first.id === 0xec)) return pos + at;
      }
      at = chunk.indexOf(sig, at + 1);
    }
    pos += Math.max(1, chunk.length - 3);
  }
  return null;
}

/** Byte position of the cluster to start reading from for a given time (seconds). */
export async function clusterFor(reader: ByteReader, info: MkvInfo, seconds: number): Promise<number | null> {
  if (info.firstCluster == null) return null;
  if (seconds <= 0) return info.firstCluster;
  const cues = await loadCues(reader, info).catch(() => []);
  if (cues.length) {
    let lo = 0;
    let hi = cues.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid]!.time <= seconds) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return cues[best]!.pos;
  }
  // No index: estimate from the average bitrate, then step back until we land before `seconds`.
  if (!info.duration) return info.firstCluster;
  const span = info.segmentEnd - info.firstCluster;
  let guess = info.firstCluster + Math.floor((seconds / info.duration) * span) - (2 << 20);
  for (let tries = 0; tries < 6 && guess > info.firstCluster; tries++) {
    const at = await resyncCluster(reader, guess, info.segmentEnd);
    if (at == null) break;
    const t = await clusterTime(reader, info, at);
    if (t != null && t <= seconds) return at;
    guess -= 8 << 20;
  }
  return info.firstCluster;
}

async function clusterTime(reader: ByteReader, info: MkvInfo, pos: number): Promise<number | null> {
  const w = new Window(reader, 4096);
  const h = await readHeader(w, pos, info.segmentEnd);
  if (!h || h.id !== ID.Cluster) return null;
  const first = await readHeader(w, h.dataStart, h.size < 0 ? info.segmentEnd : h.end);
  if (!first || first.id !== ID.Timestamp) return null;
  return (uint(await data(w, first)) * info.timestampScale) / 1e9;
}

// ---------------------------------------------------------------- subtitle extraction

export interface SubtitleBlock {
  /** Milliseconds. */
  start: number;
  duration: number;
  text: string;
}

export interface ClusterSpan {
  pos: number;
  end: number;
  /** Seconds. */
  time: number;
}

function decode(track: MkvTrack, payload: Buffer): Buffer {
  const c = track.compression;
  if (!c) return payload;
  if (c.algo === 3) return c.settings ? Buffer.concat([c.settings, payload]) : payload;
  if (c.algo === 0) {
    try {
      return zlib.inflateSync(payload);
    } catch {
      return Buffer.alloc(0);
    }
  }
  return payload;
}

function blockTrack(buf: Buffer): { track: number; headerLen: number } | null {
  const b0 = buf[0];
  if (b0 === undefined) return null;
  let len = 1;
  while (len <= 8 && !(b0 & (0x80 >> (len - 1)))) len++;
  if (len > 8 || buf.length < len + 3) return null;
  let v = b0 & (0xff >> len);
  for (let i = 1; i < len; i++) v = v * 256 + buf[i]!;
  return { track: v, headerLen: len + 3 };
}

export interface ExtractOptions {
  /** Cluster position to start at. */
  from: number;
  signal?: AbortSignal;
  onBlock: (b: SubtitleBlock) => void;
  /** Called after each cluster; return a position to jump to (already covered ground). */
  onCluster: (span: ClusterSpan) => number | void;
  /** Awaited before each cluster (used to keep a torrent read from racing far ahead). */
  pace?: (clusterSeconds: number) => Promise<void>;
  /** Stop once this byte position is reached. */
  until?: number;
}

/**
 * Walks clusters from `from`, emitting the blocks of one subtitle track. Video
 * and audio payloads are skipped without being parsed.
 */
export async function extractTrack(reader: ByteReader, info: MkvInfo, track: MkvTrack, opts: ExtractOptions): Promise<number> {
  const w = new Window(reader, 1 << 20);
  const scale = info.timestampScale / 1e6; // ticks -> ms
  const limit = Math.min(opts.until ?? info.segmentEnd, info.segmentEnd);
  const defaultMs = track.defaultDurationNs ? track.defaultDurationNs / 1e6 : 4000;
  let pos = opts.from;
  while (pos < limit) {
    if (opts.signal?.aborted) break;
    let h: Header | null;
    try {
      h = await readHeader(w, pos, info.segmentEnd);
    } catch (e) {
      if (e instanceof EndOfData) break;
      throw e;
    }
    if (!h) break;
    if (h.id !== ID.Cluster) {
      if (h.size < 0 || !TOP_LEVEL.has(h.id)) {
        // Lost sync (damaged or truncated data): find the next cluster.
        const next = await resyncCluster(reader, pos + 1, limit);
        if (next == null) break;
        pos = next;
      } else pos = h.end;
      continue;
    }
    let clusterMs = 0;
    let end = h.end;
    let cur = h.dataStart;
    let first = true;
    while (cur < end) {
      const c = await readHeader(w, cur, end).catch(() => null);
      if (!c) break;
      if (h.size < 0 && TOP_LEVEL.has(c.id)) {
        end = cur;
        break;
      }
      if (c.size < 0) break;
      if (c.id === ID.Timestamp) {
        clusterMs = uint(await data(w, c)) * scale;
        if (first && opts.pace) await opts.pace(clusterMs / 1000);
        first = false;
      } else if (c.id === ID.SimpleBlock || c.id === ID.BlockGroup) {
        let blockHeader: Header | null = c.id === ID.SimpleBlock ? c : null;
        let durTicks: number | null = null;
        if (c.id === ID.BlockGroup) {
          for await (const g of children(w, c.dataStart, c.end)) {
            if (g.id === ID.Block) blockHeader = g;
            else if (g.id === ID.BlockDuration) durTicks = uint(await data(w, g));
          }
        }
        if (blockHeader) {
          const head = await w.bytes(blockHeader.dataStart, Math.min(12, blockHeader.size));
          const bt = blockTrack(head);
          if (bt && bt.track === track.number && (head[bt.headerLen - 1]! & 0x06) === 0) {
            const rel = head.readInt16BE(bt.headerLen - 3);
            const payload = await w.bytes(blockHeader.dataStart + bt.headerLen, blockHeader.size - bt.headerLen);
            const text = decode(track, Buffer.from(payload)).toString('utf8');
            if (text.trim()) {
              opts.onBlock({
                start: Math.round(clusterMs + rel * scale),
                duration: Math.round(durTicks != null ? durTicks * scale : defaultMs),
                text,
              });
            }
          }
        }
      }
      cur = c.end;
    }
    const jump = opts.onCluster({ pos, end, time: clusterMs / 1000 });
    pos = typeof jump === 'number' && jump > end ? jump : end;
  }
  return pos;
}
