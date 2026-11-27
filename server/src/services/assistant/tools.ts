import { db } from '../../db/index.js';
import { newId } from '../../lib/crypto.js';
import { HttpError } from '../../lib/http.js';
import { listDownloads, requestDownload, cancelDownload } from '../../library/downloads.js';
import { applyMatch, listItems, libraryEnabled } from '../../library/library.js';
import { upsertRule } from '../../library/rules.js';
import { activePlugins, callPlugin } from '../../plugins/manager.js';
import { lookupRelease, searchSources } from '../../plugins/sources.js';
import { detailFor, searchAll } from '../catalog.js';
import { addToCollection, createCollection, deleteCollection, listCollections, removeFromCollection } from '../collections.js';
import { addToList, removeFromList } from '../library.js';
import { guide, listChannels } from '../live.js';
import type { Preferences } from '../profiles.js';
import type { ToolSpec } from './providers.js';

export interface ToolContext {
  accountId: string;
  profileId: string;
  isAdmin: boolean;
  prefs: Preferences;
  threadId: string;
}

export interface ToolOutcome {
  result: unknown;
  receipt?: { id: string; summary: string; status: 'applied' | 'pending' };
}

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required });
const str = (description: string) => ({ type: 'string', description });

export const BUILTIN_TOOLS: (ToolSpec & { mutates: 'none' | 'personal' | 'shared'; admin?: boolean })[] = [
  { name: 'search_catalog', description: 'Search movies, shows and anime by title or keywords.', parameters: obj({ query: str('Search text') }, ['query']), mutates: 'none' },
  { name: 'get_title', description: 'Details of one title by media id (e.g. movie:603, tv:1399, anime:21).', parameters: obj({ mediaId: str('Media id') }, ['mediaId']), mutates: 'none' },
  { name: 'add_to_my_list', description: "Add a title to the user's My List.", parameters: obj({ mediaId: str('Media id') }, ['mediaId']), mutates: 'personal' },
  { name: 'remove_from_my_list', description: "Remove a title from the user's My List.", parameters: obj({ mediaId: str('Media id') }, ['mediaId']), mutates: 'personal' },
  { name: 'list_collections', description: "The user's collections with their titles.", parameters: obj({}), mutates: 'none' },
  {
    name: 'create_collection',
    description: 'Create a collection, optionally filled with titles and pinned to Home.',
    parameters: obj({ name: str('Collection name'), mediaIds: { type: 'array', items: { type: 'string' } }, pinned: { type: 'boolean' } }, ['name']),
    mutates: 'personal',
  },
  {
    name: 'add_to_collection',
    description: 'Add titles to an existing collection.',
    parameters: obj({ collectionId: str('Collection id'), mediaIds: { type: 'array', items: { type: 'string' } } }, ['collectionId', 'mediaIds']),
    mutates: 'personal',
  },
  {
    name: 'find_sources',
    description: 'Search playable releases for a movie or an episode. Returns release ids usable with request_download.',
    parameters: obj({ mediaId: str('Media id'), season: { type: 'number' }, episode: { type: 'number' } }, ['mediaId']),
    mutates: 'none',
  },
  { name: 'request_download', description: 'Download a release (from find_sources) to the server library.', parameters: obj({ releaseId: str('Release id') }, ['releaseId']), mutates: 'shared' },
  { name: 'list_downloads', description: 'Server download queue for this account.', parameters: obj({}), mutates: 'none' },
  { name: 'cancel_download', description: 'Cancel a server download.', parameters: obj({ downloadId: str('Download id') }, ['downloadId']), mutates: 'shared' },
  {
    name: 'auto_download',
    description: 'Automatically download new (or all missing) episodes of a series as they air.',
    parameters: obj({ mediaId: str('Series media id'), mode: { type: 'string', enum: ['new', 'missing'] } }, ['mediaId']),
    mutates: 'shared',
  },
  { name: 'library_review', description: 'Library items whose metadata match is uncertain (admin).', parameters: obj({}), mutates: 'none', admin: true },
  {
    name: 'fix_match',
    description: 'Match a library item (and optionally its whole season folder) to a catalogue title (admin).',
    parameters: obj({ itemId: str('Library item id'), mediaId: str('Correct media id'), wholeSeason: { type: 'boolean' } }, ['itemId', 'mediaId']),
    mutates: 'shared',
    admin: true,
  },
  { name: 'whats_on_tv', description: 'What is airing on live TV now and next.', parameters: obj({ query: str('Optional channel or programme filter') }), mutates: 'none' },
];

/** Plugin-registered assistant tools, namespaced by plugin. */
export function pluginTools(): (ToolSpec & { pluginId: string; mutates: 'none' | 'personal' | 'shared' })[] {
  return activePlugins('tool').flatMap((p) =>
    (p.manifest.nova?.tools ?? []).map((t) => ({
      name: `${p.id.replace(/[^a-zA-Z0-9]/g, '_')}__${t.name}`.slice(0, 64),
      description: `[${p.manifest.name}] ${t.description}`,
      parameters: t.parameters,
      mutates: t.mutates ?? 'none',
      pluginId: p.id,
    })),
  );
}

function receipt(ctx: ToolContext, summary: string, status: 'applied' | 'pending', data: { undo?: unknown; plan?: unknown }): ToolOutcome['receipt'] {
  const id = newId();
  db.prepare('INSERT INTO assistant_receipts (id, profile_id, thread_id, summary, plan, undo, status) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    ctx.profileId,
    ctx.threadId,
    summary,
    data.plan ? JSON.stringify(data.plan) : null,
    data.undo ? JSON.stringify(data.undo) : null,
    status,
  );
  return { id, summary, status };
}

async function titleInfo(mediaId: string) {
  const d = await detailFor(mediaId);
  return { mediaId, mediaType: d.mediaType, title: d.title, poster: d.poster, year: d.year };
}

/** Executes one tool call. Shared changes return a pending plan instead of acting. */
export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const spec = BUILTIN_TOOLS.find((t) => t.name === name);
  if (spec?.admin && !ctx.isAdmin) return { result: { error: 'Only administrators can do that.' } };
  if (spec?.mutates === 'shared') {
    const summary = await describePlan(name, args);
    return { result: { status: 'proposed', note: 'Shown to the user for confirmation. Do not claim it is done.' }, receipt: receipt(ctx, summary, 'pending', { plan: { name, args } }) };
  }
  switch (name) {
    case 'search_catalog': {
      const r = await searchAll(String(args.query ?? ''));
      const pick = (list: { id: string; title: string; year: number | null; overview: string }[]) =>
        list.slice(0, 5).map((i) => ({ mediaId: i.id, title: i.title, year: i.year, overview: i.overview.slice(0, 140) }));
      return { result: { movies: pick(r.movies), shows: pick(r.shows), anime: pick(r.anime) } };
    }
    case 'get_title': {
      const d = await detailFor(String(args.mediaId));
      return {
        result: {
          mediaId: d.id,
          title: d.title,
          year: d.year,
          genres: d.genres,
          rating: d.rating,
          overview: d.overview.slice(0, 600),
          seasons: d.seasons.map((s) => ({ season: s.season, episodes: s.episodeCount })),
          totalEpisodes: d.totalEpisodes,
          status: d.status,
        },
      };
    }
    case 'add_to_my_list': {
      const t = await titleInfo(String(args.mediaId));
      addToList(ctx.profileId, t);
      return { result: { ok: true }, receipt: receipt(ctx, `Added ${t.title} to My List`, 'applied', { undo: { name: 'remove_from_my_list', args: { mediaId: t.mediaId, mediaType: t.mediaType } } }) };
    }
    case 'remove_from_my_list': {
      const t = await titleInfo(String(args.mediaId));
      removeFromList(ctx.profileId, t.mediaType, t.mediaId);
      return { result: { ok: true }, receipt: receipt(ctx, `Removed ${t.title} from My List`, 'applied', { undo: { name: 'add_to_my_list', args: t } }) };
    }
    case 'list_collections':
      return { result: listCollections(ctx.profileId, 30).map((c) => ({ id: c.id, name: c.name, pinned: c.pinned, titles: c.items.map((i) => `${i.title} (${i.mediaId})`) })) };
    case 'create_collection': {
      const c = createCollection(ctx.profileId, { name: String(args.name ?? 'New collection'), pinned: Boolean(args.pinned) });
      for (const id of (args.mediaIds as string[] | undefined) ?? []) {
        const t = await titleInfo(id).catch(() => null);
        if (t) addToCollection(c.id, ctx.profileId, t);
      }
      return { result: { collectionId: c.id }, receipt: receipt(ctx, `Created collection “${c.name}”`, 'applied', { undo: { name: '_delete_collection', args: { id: c.id } } }) };
    }
    case 'add_to_collection': {
      const added: string[] = [];
      for (const id of (args.mediaIds as string[] | undefined) ?? []) {
        const t = await titleInfo(id).catch(() => null);
        if (!t) continue;
        addToCollection(String(args.collectionId), ctx.profileId, t);
        added.push(t.mediaId);
      }
      return {
        result: { added: added.length },
        receipt: receipt(ctx, `Added ${added.length} title(s) to a collection`, 'applied', { undo: { name: '_remove_from_collection', args: { id: args.collectionId, mediaIds: added } } }),
      };
    }
    case 'find_sources': {
      const s = await searchSources(
        { mediaId: String(args.mediaId), season: args.season ? Number(args.season) : null, episode: args.episode ? Number(args.episode) : null },
        ctx.prefs,
      );
      return {
        result: s.releases.slice(0, 6).map((r) => ({
          releaseId: r.id,
          name: r.title,
          quality: r.quality,
          sizeGb: Math.round((r.sizeBytes / 1e9) * 10) / 10,
          seeders: r.seeders,
          source: r.pluginName,
        })),
      };
    }
    case 'list_downloads':
      return { result: listDownloads({ accountId: ctx.accountId }).slice(0, 20).map((d) => ({ id: d.id, title: d.title, status: d.status, progress: Math.round(d.progress * 100) })) };
    case 'library_review':
      return { result: listItems(ctx.accountId, { status: 'review' }).slice(0, 25).map((i) => ({ itemId: i.id, parsedTitle: i.title, folder: i.folder, candidates: i.candidates.slice(0, 3) })) };
    case 'whats_on_tv': {
      const now = Math.floor(Date.now() / 1000);
      const q = String(args.query ?? '').toLowerCase();
      const channels = listChannels({ profileId: ctx.profileId }).slice(0, 300);
      const progs = guide(now, now + 3 * 3600, channels.map((c) => c.epgId).filter((x): x is string => Boolean(x)));
      const rows = channels
        .map((c) => {
          const mine = progs.filter((p) => p.epgId === c.epgId);
          return { channel: c.name, now: mine.find((p) => p.start <= now)?.title ?? null, next: mine.find((p) => p.start > now)?.title ?? null };
        })
        .filter((r) => !q || r.channel.toLowerCase().includes(q) || (r.now ?? '').toLowerCase().includes(q) || (r.next ?? '').toLowerCase().includes(q));
      return { result: rows.slice(0, 25) };
    }
  }
  const plugin = pluginTools().find((t) => t.name === name);
  if (plugin) {
    const p = activePlugins('tool').find((x) => x.id === plugin.pluginId)!;
    const toolName = name.split('__').slice(1).join('__');
    const value = await callPlugin(p, 'tool', {
      type: 'tool',
      id: toolName,
      name: toolName,
      args,
      user: { accountId: ctx.accountId, profileId: ctx.profileId },
    });
    return { result: value };
  }
  return { result: { error: `Unknown tool ${name}` } };
}

async function describePlan(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'request_download': {
      const hit = lookupRelease(String(args.releaseId));
      return hit
        ? `Download ${hit.context.title}${hit.context.episode ? ` episode ${hit.context.episode}` : ''} — ${hit.release.title} (${(hit.release.sizeBytes / 1e9).toFixed(1)} GB) to the server library`
        : 'Download a release to the server library';
    }
    case 'cancel_download':
      return `Cancel download ${String(args.downloadId).slice(0, 8)}`;
    case 'auto_download': {
      const t = await detailFor(String(args.mediaId)).catch(() => null);
      return `Auto-download ${args.mode === 'missing' ? 'all missing' : 'new'} episodes of ${t?.title ?? args.mediaId}`;
    }
    case 'fix_match': {
      const t = await detailFor(String(args.mediaId)).catch(() => null);
      return `Match library item to ${t?.title ?? args.mediaId}${args.wholeSeason ? ' (whole folder)' : ''}`;
    }
  }
  return `${name} ${JSON.stringify(args).slice(0, 120)}`;
}

/** Runs an approved plan (shared changes) on the user's behalf, with their permissions. */
export async function applyPlan(plan: { name: string; args: Record<string, unknown> }, ctx: ToolContext): Promise<string> {
  const a = plan.args;
  switch (plan.name) {
    case 'request_download': {
      const hit = lookupRelease(String(a.releaseId));
      if (!hit) throw new HttpError(410, 'That release expired; ask again');
      const d = requestDownload({ accountId: ctx.accountId, profileId: ctx.profileId, release: hit.release, context: hit.context, itemKey: null, poster: null });
      return d.status === 'pending' ? 'Requested — waiting for an admin to approve.' : 'Download queued.';
    }
    case 'cancel_download':
      cancelDownload(String(a.downloadId), ctx.accountId, ctx.isAdmin);
      return 'Download cancelled.';
    case 'auto_download': {
      if (!libraryEnabled()) throw new HttpError(503, 'No library volume configured');
      const t = await titleInfo(String(a.mediaId));
      await upsertRule({ accountId: ctx.accountId, profileId: ctx.profileId, mediaId: t.mediaId, title: t.title, poster: t.poster, qualityProfileId: null, mode: a.mode === 'missing' ? 'missing' : 'new', enabled: true });
      return 'Auto-download rule saved.';
    }
    case 'fix_match': {
      if (!ctx.isAdmin) throw new HttpError(403, 'Admins only');
      const n = await applyMatch(String(a.itemId), String(a.mediaId), Boolean(a.wholeSeason));
      return `Matched ${n} item(s).`;
    }
  }
  throw new HttpError(400, 'Unknown plan');
}

/** Reverts a personal change from its receipt. */
export async function undo(u: { name: string; args: Record<string, unknown> }, ctx: ToolContext): Promise<void> {
  const a = u.args;
  switch (u.name) {
    case 'remove_from_my_list':
      removeFromList(ctx.profileId, String(a.mediaType), String(a.mediaId));
      return;
    case 'add_to_my_list':
      addToList(ctx.profileId, a as unknown as Parameters<typeof addToList>[1]);
      return;
    case '_delete_collection':
      deleteCollection(String(a.id), ctx.profileId);
      return;
    case '_remove_from_collection':
      for (const m of (a.mediaIds as string[]) ?? []) removeFromCollection(String(a.id), ctx.profileId, m);
      return;
  }
  throw new HttpError(400, 'This change cannot be undone');
}
