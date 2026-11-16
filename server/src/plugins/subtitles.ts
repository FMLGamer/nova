/**
 * Subtitles from plugins that serve the Stremio `subtitles` resource (e.g. the
 * OpenSubtitles v3 addon). Files are fetched through the server, converted to
 * WebVTT, and only ever by an opaque token, so clients can't make the server
 * fetch arbitrary URLs.
 */
import { cached } from '../lib/cache.js';
import { randomToken } from '../lib/crypto.js';
import { HttpError } from '../lib/http.js';
import { ISO3 } from '../lib/lang.js';
import { mediaContext, stremioTarget } from '../core/ids.js';
import type { MediaContext } from './protocol.js';
import { activePlugins, callPlugin, supports, type Plugin } from './manager.js';

export interface PluginSubtitle {
  token: string;
  language: string;
  release: string;
  plugin: string;
}

interface StremioSubtitle {
  id?: string;
  url?: string;
  lang?: string;
  subtitleFileName?: string;
  movieReleaseName?: string;
}


const links = new Map<string, { url: string; expires: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of links) if (v.expires < now) links.delete(k);
}, 30 * 60_000).unref();

function targetFor(p: Plugin, ctx: MediaContext): { type: string; id: string } | null {
  const res = supports(p.manifest, 'subtitles');
  if (!res) return null;
  const types = res.types ?? p.manifest.types ?? [];
  const target = stremioTarget(ctx, res.idPrefixes ?? p.manifest.idPrefixes, types);
  if (target) return target;
  if (p.kind !== 'local') return null;
  return { type: ctx.kind === 'movie' || (ctx.kind === 'anime' && ctx.format === 'MOVIE') ? 'movie' : 'series', id: ctx.mediaId };
}

export async function pluginSubtitles(mediaId: string, season: number | null, episode: number | null): Promise<PluginSubtitle[]> {
  const plugins = activePlugins('subtitles');
  if (!plugins.length) return [];
  return cached(`plugin-subs:${mediaId}:${season ?? ''}:${episode ?? ''}:${plugins.map((p) => p.id).join(',')}`, 30 * 60_000, async () => {
    const ctx = await cached(`ctx:${mediaId}:${season ?? ''}:${episode ?? ''}`, 6 * 60 * 60_000, () => mediaContext(mediaId, season, episode));
    const results = await Promise.all(
      plugins.map(async (p) => {
        const target = targetFor(p, ctx);
        if (!target) return [];
        try {
          const res = await callPlugin<{ subtitles?: StremioSubtitle[] }>(p, 'subtitles', { type: target.type, id: target.id, extra: {}, nova: ctx }, 15_000);
          const name = p.manifest.nova?.shortName ?? p.manifest.name;
          return (res?.subtitles ?? [])
            .filter((s) => s.url && /^https?:\/\//i.test(s.url))
            .map((s): PluginSubtitle => {
              const token = randomToken(18);
              // Outlives the 30-minute cache of this list, so a listed file can always be opened.
              links.set(token, { url: s.url!, expires: Date.now() + 2 * 60 * 60_000 });
              const lang = (s.lang ?? '').toLowerCase();
              return {
                token,
                language: ISO3[lang] ?? (lang || 'und'),
                release: (s.movieReleaseName || s.subtitleFileName || name).replace(/\.(srt|vtt|ass|ssa|sub)$/i, ''),
                plugin: name,
              };
            });
        } catch {
          return [];
        }
      }),
    );
    const seen = new Set<string>();
    return results.flat().filter((s) => {
      const key = `${s.language}|${s.release.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
}

export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/^\uFEFF/, '')
    .replace(/\r+/g, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body}`;
}

export async function pluginSubtitleVtt(token: string): Promise<string> {
  const link = links.get(token);
  if (!link) throw new HttpError(404, 'This subtitle link expired; reopen the subtitle list');
  let res: Response;
  try {
    res = await fetch(link.url, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'Nova/2 (+stremio-compatible)' } });
  } catch {
    throw new HttpError(502, 'The subtitle file could not be downloaded');
  }
  if (!res.ok) throw new HttpError(502, `The subtitle host answered ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) throw new HttpError(502, 'Subtitle file is too large');
  const text = buf.toString('utf8');
  return /^\uFEFF?WEBVTT/.test(text) ? text : srtToVtt(text);
}
