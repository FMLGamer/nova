import { cached, forget } from '../lib/cache.js';
import { newId } from '../lib/crypto.js';
import { mediaContext, stremioTarget, textContext } from '../core/ids.js';
import { buildMagnet, dedupeReleases, normalizeStream, type Release } from '../core/release.js';
import { rankReleases, type RankPrefs } from '../core/ranking.js';
import type { MediaContext, ResolveResult, Stream } from './protocol.js';
import { activePlugins, callPlugin, supports, getPlugin, type Plugin } from './manager.js';

export interface SourceRequest {
  mediaId: string;
  season?: number | null;
  episode?: number | null;
  kind?: 'video' | 'audio' | 'book' | 'comic';
  /** Music/books: free-text lookup. */
  title?: string | null;
  creator?: string | null;
}

export interface PluginRun {
  pluginId: string;
  name: string;
  status: 'running' | 'done' | 'error' | 'skipped';
  count: number;
  ms: number;
  error?: string;
}

export interface SourceSearch {
  id: string;
  context: MediaContext;
  runs: PluginRun[];
  releases: Release[];
  noDub: boolean;
  done: boolean;
}

/** Releases handed to clients, so play/download requests can only name a release we produced. */
const releaseCache = new Map<string, { release: Release; context: MediaContext; expires: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of releaseCache) if (v.expires < now) releaseCache.delete(k);
}, 10 * 60_000).unref();

export function rememberRelease(release: Release, context: MediaContext): void {
  releaseCache.set(release.id, { release, context, expires: Date.now() + 6 * 60 * 60_000 });
}

export function lookupRelease(id: string): { release: Release; context: MediaContext } | null {
  return releaseCache.get(id) ?? null;
}

function stremioTypeFor(ctx: MediaContext): string {
  if (ctx.kind === 'movie') return 'movie';
  if (ctx.kind === 'tv') return 'series';
  if (ctx.kind === 'anime') return ctx.format === 'MOVIE' ? 'movie' : 'series';
  return ctx.kind;
}

function pluginTarget(p: Plugin, ctx: MediaContext): { type: string; id: string } | null {
  const res = supports(p.manifest, 'stream');
  if (!res) return null;
  const types = res.types ?? p.manifest.types ?? [];
  const prefixes = res.idPrefixes ?? p.manifest.idPrefixes;
  if (ctx.kind === 'music' || ctx.kind === 'book' || ctx.kind === 'comic') {
    // Only Nova-native plugins can answer free-text media lookups.
    if (p.kind !== 'local' || !types.includes(ctx.kind)) return null;
    return { type: ctx.kind, id: ctx.mediaId };
  }
  const target = stremioTarget(ctx, prefixes, types);
  if (target) return target;
  if (p.kind === 'local') {
    const t = stremioTypeFor(ctx);
    if (types.length && !types.includes(t) && !(ctx.kind === 'anime' && types.includes('anime'))) return null;
    return { type: t, id: ctx.mediaId };
  }
  return null;
}

async function buildContext(req: SourceRequest): Promise<MediaContext> {
  if (req.kind === 'audio' || req.kind === 'book' || req.kind === 'comic') {
    const k = req.kind === 'audio' ? 'music' : req.kind;
    return textContext(k, req.title ?? '', req.creator ?? null, req.mediaId);
  }
  return cached(`ctx:${req.mediaId}:${req.season ?? ''}:${req.episode ?? ''}`, 6 * 60 * 60_000, () =>
    mediaContext(req.mediaId, req.season ?? null, req.episode ?? null),
  );
}

function mediaKindOf(ctx: MediaContext): Release['kind'] {
  if (ctx.kind === 'music') return 'audio';
  if (ctx.kind === 'book') return 'book';
  if (ctx.kind === 'comic') return 'comic';
  return 'video';
}

async function runPlugin(p: Plugin, ctx: MediaContext, target: { type: string; id: string }): Promise<Release[]> {
  const key = `src:${p.id}:${p.manifest.version}:${target.type}:${target.id}:${ctx.mediaId}:${ctx.season ?? ''}:${ctx.episode ?? ''}`;
  const out = await cached(key, 10 * 60_000, async () => {
    const res = await callPlugin<{ streams?: Stream[] }>(
      p,
      'stream',
      { type: target.type, id: target.id, extra: {}, nova: ctx },
      p.kind === 'local' ? 90_000 : 20_000,
    );
    const name = p.manifest.nova?.shortName ?? p.manifest.name;
    return (res?.streams ?? [])
      .map((s) => normalizeStream(s, { id: p.id, name }, mediaKindOf(ctx)))
      .filter((r): r is Release => r !== null);
  });
  // An empty answer is nearly always a transient indexer hiccup; never cache it.
  if (!out.length) forget(key);
  return out.map((r) => ({ ...r, alsoFrom: [...r.alsoFrom], trackers: [...r.trackers] }));
}

/**
 * Asks every enabled source plugin in parallel and re-ranks after each one
 * answers, so fast sources show up immediately and slow indexers fill in.
 */
export async function searchSources(
  req: SourceRequest,
  prefs: RankPrefs,
  onUpdate?: (s: SourceSearch) => void,
): Promise<SourceSearch> {
  const context = await buildContext(req);
  const plugins = activePlugins('stream');
  const state: SourceSearch = { id: newId(), context, runs: [], releases: [], noDub: false, done: false };
  const collected: Release[] = [];
  const rank = {
    kind: context.kind,
    title: context.title,
    year: context.year,
    creator: context.creator,
    season: context.kind === 'tv' ? context.season : null,
    episode: context.kind === 'tv' || context.kind === 'anime' ? context.episode : null,
  };

  const publish = () => {
    const ranked = rankReleases(dedupeReleases(collected.map((r) => ({ ...r }))), prefs, rank);
    state.releases = ranked.releases;
    state.noDub = ranked.noDub;
    for (const r of state.releases) rememberRelease(r, context);
    onUpdate?.({ ...state, runs: state.runs.map((x) => ({ ...x })) });
  };

  const jobs = plugins.map(async (p) => {
    const run: PluginRun = {
      pluginId: p.id,
      name: p.manifest.nova?.shortName ?? p.manifest.name,
      status: 'running',
      count: 0,
      ms: 0,
    };
    state.runs.push(run);
    const target = pluginTarget(p, context);
    if (!target) {
      run.status = 'skipped';
      return;
    }
    const started = Date.now();
    try {
      const releases = await runPlugin(p, context, target);
      collected.push(...releases);
      run.status = 'done';
      run.count = releases.length;
    } catch (err) {
      run.status = 'error';
      run.error = err instanceof Error ? err.message : String(err);
    } finally {
      run.ms = Date.now() - started;
      publish();
    }
  });
  publish();
  await Promise.all(jobs);
  state.done = true;
  publish();
  return state;
}

export interface ResolvedRelease {
  magnet: string | null;
  torrent: Buffer | null;
  url: string | null;
  headers: Record<string, string> | null;
}

/** Turns a release into something the engine can open (asking its plugin when needed). */
export async function resolveRelease(release: Release, context: MediaContext): Promise<ResolvedRelease> {
  if (release.infoHash) {
    return { magnet: buildMagnet(release.infoHash, release.title, release.trackers), torrent: null, url: null, headers: null };
  }
  if (release.url && !release.resolve) return { magnet: null, torrent: null, url: release.url, headers: release.headers };
  const plugin = getPlugin(release.pluginId);
  if (!plugin || !release.resolve) throw new Error('This source can no longer be opened');
  const res = await callPlugin<ResolveResult>(
    plugin,
    'resolve',
    { type: stremioTypeFor(context), id: context.mediaId, token: release.resolve, nova: context },
    45_000,
  );
  if (res.magnet) return { magnet: res.magnet, torrent: null, url: null, headers: null };
  if (res.torrent) return { magnet: null, torrent: Buffer.from(res.torrent, 'base64'), url: null, headers: null };
  if (res.url) return { magnet: null, torrent: null, url: res.url, headers: res.headers ?? null };
  throw new Error('The source plugin could not resolve this release');
}

/** Top release for a request (auto-download rules, "play best"). */
export async function bestRelease(req: SourceRequest, prefs: RankPrefs): Promise<{ release: Release; context: MediaContext } | null> {
  const s = await searchSources(req, prefs);
  const top = s.releases.find((r) => r.tier === 0) ?? s.releases[0];
  return top ? { release: top, context: s.context } : null;
}
