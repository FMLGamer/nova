import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { SubtitleStyle } from '../../lib/types';

export interface Cue {
  start: number;
  end: number;
  text: string;
}

function toSec(s: string): number {
  const p = s.replace(',', '.').split(':').map(Number);
  return p.length === 3 ? p[0]! * 3600 + p[1]! * 60 + p[2]! : p[0]! * 60 + p[1]!;
}

const TIME = /(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})/;

export function parseVtt(text: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of text.replace(/\r/g, '').split('\n\n')) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const m = TIME.exec(lines[at]!);
    if (!m) continue;
    const body = lines
      .slice(at + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\{\\[^}]*\}/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .trim();
    if (body) cues.push({ start: toSec(m[1]!), end: toSec(m[2]!), text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** Binary search for the cue(s) at time t. */
export function cuesAt(cues: Cue[], t: number): string {
  let lo = 0;
  let hi = cues.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid]!.start <= t) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const out: string[] = [];
  for (let i = idx; i >= 0 && i > idx - 6; i--) {
    const c = cues[i]!;
    if (c.start <= t && t < c.end) out.unshift(c.text);
  }
  return out.join('\n');
}

export interface SubtitleSource {
  id: string;
  label: string;
  lang: string | null;
  url: string;
  /** Embedded tracks stream in while the file is demuxed. */
  embedded?: boolean;
  /** A Matroska track read natively around the playhead (instant, seekable). */
  mkv?: { path: string; track: number; codec: string; fonts: string[] };
  /** When set, the fetched text is passed through this (machine translation). */
  transform?: (vtt: string) => Promise<string>;
}

/** Raw Matroska block: [startMs, durationMs, text]. ASS blocks keep their ReadOrder/Style fields. */
export type SubBlock = [number, number, string];

/** The dialogue text of a Matroska ASS block, or '' for drawings. Signs are dropped when `dialogueOnly`. */
export function assToPlain(block: string, dialogueOnly = true): string {
  let rest = block;
  for (let i = 0; i < 8; i++) {
    const c = rest.indexOf(',');
    if (c < 0) return '';
    rest = rest.slice(c + 1);
  }
  if (/\{[^}]*\\p[1-9]/.test(rest)) return '';
  if (dialogueOnly && /\{[^}]*\\(pos|move)\(/.test(rest)) return '';
  return rest
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\[Nn]/g, '\n')
    .replace(/\\h/g, ' ')
    .trim();
}

function plainCue(codec: string, [start, dur, text]: SubBlock): Cue | null {
  const body = codec === 'ass' || codec === 'ssa' ? assToPlain(text) : text.replace(/\r/g, '').replace(/<[^>]+>/g, '').trim();
  return body ? { start: start / 1000, end: (start + dur) / 1000, text: body } : null;
}

/**
 * Streams a Matroska subtitle track from around the playhead. Whatever the
 * server has already read comes first; when you seek somewhere that hasn't been
 * read yet, a new stream starts there, so cues are always where you are.
 */
function useMkvTrack(source: SubtitleSource | null, timeRef: { current: number }) {
  const mkv = source?.mkv ?? null;
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [covered, setCovered] = useState(true);
  const blocks = useRef<SubBlock[]>([]);
  const cues = useRef<Cue[]>([]);
  const header = useRef<string | null>(null);

  useEffect(() => {
    blocks.current = [];
    cues.current = [];
    header.current = null;
    setVersion(0);
    setError(null);
    setComplete(false);
    if (!mkv) return;
    const seen = new Set<string>();
    let ranges: [number, number][] = [];
    let done = false;
    let ctrl: AbortController | null = null;
    let session: { from: number; ended: boolean; at: number } | null = null;
    let disposed = false;

    const connect = async (from: number) => {
      ctrl?.abort();
      const c = new AbortController();
      ctrl = c;
      const s = { from, ended: false, at: Date.now() };
      session = s;
      try {
        const res = await fetch(`${mkv.path}/subs/${mkv.track}?from=${from.toFixed(1)}`, { credentials: 'include', signal: c.signal });
        if (!res.ok || !res.body) throw new Error('Subtitles unavailable');
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done: eof, value } = await reader.read();
          if (eof) break;
          buf += dec.decode(value, { stream: true });
          let nl = buf.indexOf('\n');
          let changed = false;
          while (nl >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            nl = buf.indexOf('\n');
            if (!line) continue;
            const m = JSON.parse(line) as { t: string; header?: string | null; e?: SubBlock[]; r?: [number, number][]; done?: boolean };
            if (m.t === 'h') header.current = m.header ?? null;
            else if (m.t === 'e' && m.e) {
              for (const b of m.e) {
                const key = `${b[0]}|${b[2]}`;
                if (seen.has(key)) continue;
                seen.add(key);
                blocks.current.push(b);
                const cue = plainCue(mkv.codec, b);
                if (cue) cues.current.push(cue);
                changed = true;
              }
            } else if (m.t === 'cov' && m.r) {
              ranges = m.r;
              if (m.done) done = true;
            }
          }
          if (changed) {
            cues.current.sort((a, b) => a.start - b.start);
            if (!disposed) setVersion((v) => v + 1);
          }
        }
        s.ended = true;
        if (done && !disposed) setComplete(true);
      } catch (e) {
        s.ended = true;
        if (!disposed && !(e instanceof DOMException)) setError(e instanceof Error ? e.message : 'Subtitles failed');
      }
    };

    void connect(Math.max(0, timeRef.current));
    const tick = window.setInterval(() => {
      if (done || !session) return;
      const t = timeRef.current;
      const inside = ranges.some(([a, b]) => t >= a - 2 && t <= b + 10);
      if (!disposed) setCovered(inside);
      if (inside) return;
      // The current stream is still catching up to a point just ahead of it: let it.
      const own = ranges.find(([a, b]) => session!.from >= a - 5 && session!.from <= b + 10);
      if (!session.ended && own && t > own[1] && t - own[1] < 60) return;
      if (!session.ended && !own && Date.now() - session.at < 8000 && Math.abs(t - session.from) < 30) return;
      if (Date.now() - session.at > 1500) void connect(Math.max(0, t - 2));
    }, 700);

    return () => {
      disposed = true;
      window.clearInterval(tick);
      ctrl?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mkv?.path, mkv?.track]);

  return { version, error, complete, covered, blocks, cues, header };
}

/**
 * Loads a subtitle file, streaming and re-parsing as it arrives so embedded tracks
 * show their first cues long before extraction finishes. Matroska tracks are
 * read natively around the playhead instead (see useMkvTrack).
 */
export function useSubtitleTrack(source: SubtitleSource | null, timeRef: { current: number }) {
  const native = useMkvTrack(source?.mkv && !source.transform ? source : null, timeRef);
  const legacy = useLegacyTrack(source?.mkv && !source.transform ? null : source);
  if (source?.mkv && !source.transform) {
    return {
      cues: native.cues.current,
      loading: native.version === 0 && !native.error,
      complete: native.complete,
      covered: native.covered,
      error: native.error,
      version: native.version,
      blocks: native.blocks,
      header: native.header,
    };
  }
  return { ...legacy, covered: true, version: 0, blocks: null, header: null };
}

function useLegacyTrack(source: SubtitleSource | null) {
  const [cues, setCues] = useState<Cue[]>([]);
  const [loading, setLoading] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const raw = useRef('');

  useEffect(() => {
    setCues([]);
    setComplete(false);
    setError(null);
    raw.current = '';
    if (!source) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(source.url, { credentials: 'include', signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error('Subtitles unavailable');
        if (source.transform) {
          const text = await source.transform(await res.text());
          if (!cancelled) setCues(parseVtt(text));
        } else {
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          let parsedAt = 0;
          let first = true;
          for (;;) {
            const { done, value } = await reader.read();
            if (done || cancelled) break;
            buf += dec.decode(value, { stream: true });
            if (first || buf.length - parsedAt > 24_000) {
              parsedAt = buf.length;
              const c = parseVtt(buf);
              if (c.length) {
                first = false;
                if (!cancelled) {
                  setCues(c);
                  setLoading(false);
                }
              }
            }
          }
          raw.current = buf;
          if (!cancelled) setCues(parseVtt(buf));
        }
        if (!cancelled) setComplete(true);
      } catch (e) {
        if (!cancelled && !(e instanceof DOMException)) setError(e instanceof Error ? e.message : 'Subtitles failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [source]);

  return { cues, loading, complete, error, raw };
}

const FONTS: Record<SubtitleStyle['fontFamily'], string> = {
  sans: '"Inter Variable", ui-sans-serif, system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "Cascadia Mono", "Courier New", monospace',
  rounded: '"Nunito", "Trebuchet MS", ui-rounded, sans-serif',
  atkinson: '"Atkinson Hyperlegible", sans-serif',
  dyslexic: '"OpenDyslexic", sans-serif',
};

function rgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(f, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function cueStyle(s: SubtitleStyle, scale = 1): CSSProperties {
  const edge =
    s.edge === 'outline'
      ? '0 0 2px #000,0 0 2px #000,0 0 3px #000,1px 1px 2px #000,-1px -1px 2px #000'
      : s.edge === 'shadow'
        ? '0 2px 8px rgba(0,0,0,.95),0 0 2px rgba(0,0,0,.8)'
        : s.edge === 'raised'
          ? '1px 1px 0 #000,2px 2px 0 #000'
          : s.edge === 'depressed'
            ? '-1px -1px 0 #000,1px 1px 0 rgba(255,255,255,.35)'
            : 'none';
  return {
    color: rgba(s.color, s.opacity / 100),
    backgroundColor: s.background > 0 ? `rgba(0,0,0,${s.background / 100})` : 'transparent',
    fontFamily: FONTS[s.fontFamily] ?? FONTS.sans,
    fontSize: `calc(${((s.fontSize / 100) * scale).toFixed(3)} * clamp(1.05rem, 2.5vw, 2.5rem))`,
    fontWeight: s.weight,
    textShadow: edge,
    padding: s.background > 0 ? '0.08em 0.4em' : '0',
    borderRadius: '0.2em',
    lineHeight: 1.28,
    boxDecorationBreak: 'clone',
    WebkitBoxDecorationBreak: 'clone',
  };
}
