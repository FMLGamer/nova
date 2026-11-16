import { Router } from 'express';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { requireAdmin, requireAuth, requireProfile } from '../auth/middleware.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { asyncHandler } from '../lib/async.js';
import { HttpError, parse, publicUrl } from '../lib/http.js';
import {
  activePlugins,
  approvePlugin,
  browseRegistries,
  callPlugin,
  checkUpdate,
  configView,
  getPlugin,
  installFromUrl,
  installUploaded,
  listPlugins,
  previewInstall,
  requestedPermissions,
  resourcesOf,
  setPluginEnabled,
  setPluginPriority,
  supports,
  uninstallPlugin,
  updatePluginConfig,
  workerInfo,
  type Plugin,
} from '../plugins/manager.js';
import type { ActionResult, Meta, MetaPreview, PageImage, PluginManifest, ViewNode } from '../plugins/protocol.js';
import { sandboxAvailable } from '../plugins/worker.js';
import { searchSources } from '../plugins/sources.js';
import { DEFAULT_PREFERENCES } from '../services/profiles.js';

function pluginDTO(p: Plugin) {
  const runtime = workerInfo(p.id);
  return {
    id: p.id,
    kind: p.kind,
    name: p.manifest.name,
    shortName: p.manifest.nova?.shortName ?? null,
    version: p.manifest.version,
    description: p.manifest.description ?? '',
    logo: p.manifest.logo ?? null,
    sourceUrl: p.sourceUrl,
    enabled: p.enabled,
    status: p.status,
    priority: p.priority,
    types: p.manifest.types,
    resources: resourcesOf(p.manifest).map((r) => r.name),
    requested: requestedPermissions(p.manifest, p.kind, p.sourceUrl, {}),
    granted: p.granted,
    config: configView(p),
    pendingUpdate: p.pendingUpdate
      ? { version: p.pendingUpdate.manifest.version, permissions: p.pendingUpdate.permissions }
      : null,
    runtime: runtime
      ? { status: runtime.status, lastError: runtime.lastError, handlers: runtime.resources }
      : { status: p.kind === 'stremio' ? 'remote' : p.enabled ? 'stopped' : 'disabled', lastError: null, handlers: [] },
    configurable: Boolean(p.manifest.behaviorHints?.configurable),
    installedAt: p.installedAt,
  };
}

// ================================================================ admin

export const adminPluginsRouter = Router();
adminPluginsRouter.use(requireAuth, requireAdmin);

adminPluginsRouter.get('/', (_req, res) => {
  res.json({ plugins: listPlugins().map(pluginDTO), sandbox: sandboxAvailable });
});

adminPluginsRouter.get(
  '/registry',
  asyncHandler(async (_req, res) => {
    const installed = new Map(listPlugins().map((p) => [p.sourceUrl, p.id]));
    const ids = new Set(listPlugins().map((p) => p.id));
    const entries = await browseRegistries();
    res.json({
      entries: entries.map((e) => ({ ...e, installed: installed.has(e.manifest) || ids.has(e.id) })),
    });
  }),
);

const urlSchema = z.object({ url: z.string().url().max(2000) });

adminPluginsRouter.post(
  '/preview',
  asyncHandler(async (req, res) => {
    const { url } = parse(urlSchema, req.body);
    res.json({ preview: await previewInstall(url) });
  }),
);

const installSchema = z.object({
  url: z.string().url().max(2000),
  config: z.record(z.unknown()).optional(),
});

adminPluginsRouter.post(
  '/install',
  asyncHandler(async (req, res) => {
    const body = parse(installSchema, req.body);
    // Installing from the admin UI happens after the permission dialog, so it is the approval.
    const p = await installFromUrl(body.url, { approve: true, by: req.account!.id, config: body.config });
    res.status(201).json({ plugin: pluginDTO(p) });
  }),
);

const uploadSchema = z.object({ manifest: z.record(z.unknown()), code: z.string().min(1).max(25 * 1024 * 1024) });

// Used by `nova-plugin dev` (bearer API token) for hot reload on a running server.
adminPluginsRouter.post('/upload', (req, res) => {
  const body = parse(uploadSchema, req.body);
  const p = installUploaded(body.manifest as unknown as PluginManifest, body.code, req.account!.id);
  res.json({ plugin: pluginDTO(p) });
});

adminPluginsRouter.post('/:id/approve', (req, res) => {
  res.json({ plugin: pluginDTO(approvePlugin(req.params.id)) });
});

const patchSchema = z.object({
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
  config: z.record(z.unknown()).optional(),
});

adminPluginsRouter.patch('/:id', (req, res) => {
  const body = parse(patchSchema, req.body);
  if (!getPlugin(req.params.id)) throw new HttpError(404, 'Plugin not found');
  if (body.priority !== undefined) setPluginPriority(req.params.id, body.priority);
  if (body.config) updatePluginConfig(req.params.id, body.config);
  if (body.enabled !== undefined) setPluginEnabled(req.params.id, body.enabled);
  res.json({ plugin: pluginDTO(getPlugin(req.params.id)!) });
});

adminPluginsRouter.post(
  '/:id/update',
  asyncHandler(async (req, res) => {
    const result = await checkUpdate(req.params.id);
    res.json({ result, plugin: pluginDTO(getPlugin(req.params.id)!) });
  }),
);

adminPluginsRouter.delete('/:id', (req, res) => {
  uninstallPlugin(req.params.id);
  res.status(204).end();
});

adminPluginsRouter.get('/:id/logs', (req, res) => {
  res.json({ logs: workerInfo(req.params.id)?.logs ?? [] });
});

/** Runs a known search through just this plugin, to check it is wired up. */
adminPluginsRouter.post(
  '/:id/test',
  asyncHandler(async (req, res) => {
    const p = getPlugin(req.params.id);
    if (!p) throw new HttpError(404, 'Plugin not found');
    if (!supports(p.manifest, 'stream')) {
      res.json({ ok: true, message: 'Nothing to test for this plugin type' });
      return;
    }
    const started = Date.now();
    const s = await searchSources({ mediaId: 'movie:603' }, DEFAULT_PREFERENCES);
    const run = s.runs.find((r) => r.pluginId === p.id);
    res.json({
      ok: run?.status === 'done' && run.count > 0,
      message:
        run?.status === 'done'
          ? `${run.count} releases for The Matrix (1999) in ${(run.ms / 1000).toFixed(1)}s`
          : run?.error ?? run?.status ?? 'not run',
      ms: Date.now() - started,
    });
  }),
);

// ================================================================ users

export const pluginsRouter = Router();

function hookKey(pluginId: string, jobId: string): string {
  return crypto.createHmac('sha256', config.sessionSecret).update(`${pluginId}:${jobId}`).digest('hex').slice(0, 32);
}

export function webhookUrl(pluginId: string, jobId: string): string {
  return new URL(`/api/plugins/${encodeURIComponent(pluginId)}/webhook/${encodeURIComponent(jobId)}?key=${hookKey(pluginId, jobId)}`, publicUrl()).toString();
}

// Webhooks authenticate with their own key (no session).
pluginsRouter.post(
  '/:id/webhook/:job',
  asyncHandler(async (req, res) => {
    const p = getPlugin(req.params.id);
    const key = String(req.query.key ?? '');
    const expected = hookKey(req.params.id, req.params.job);
    if (!p || key.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected))) {
      throw new HttpError(404, 'Not found');
    }
    await callPlugin(p, 'job', { type: 'job', id: req.params.job, job: req.params.job, payload: req.body ?? null });
    res.json({ ok: true });
  }),
);

pluginsRouter.use(requireAuth);

function active(id: string): Plugin {
  const p = getPlugin(id);
  if (!p || !p.enabled || p.status !== 'approved') throw new HttpError(404, 'Plugin not available');
  return p;
}

/** UI contributions (actions, pages, media types, catalogs, themes) from active plugins. */
pluginsRouter.get('/contributions', (_req, res) => {
  const plugins = activePlugins();
  res.json({
    actions: plugins.flatMap((p) => (p.manifest.nova?.ui?.actions ?? []).map((a) => ({ ...a, pluginId: p.id, pluginName: p.manifest.name }))),
    pages: plugins.flatMap((p) => (p.manifest.nova?.ui?.pages ?? []).map((pg) => ({ ...pg, pluginId: p.id }))),
    mediaTypes: plugins.flatMap((p) => (p.manifest.nova?.mediaTypes ?? []).map((m) => ({ ...m, pluginId: p.id }))),
    catalogs: plugins
      .filter((p) => supports(p.manifest, 'catalog'))
      .flatMap((p) =>
        (p.manifest.catalogs ?? [])
          .filter((c) => !(c.extra ?? []).some((e) => e.isRequired))
          .map((c) => ({ ...c, pluginId: p.id, pluginName: p.manifest.name })),
      ),
    searchCatalogs: plugins
      .filter((p) => supports(p.manifest, 'catalog'))
      .flatMap((p) =>
        (p.manifest.catalogs ?? [])
          .filter((c) => (c.extra ?? []).some((e) => e.name === 'search'))
          .map((c) => ({ ...c, pluginId: p.id, pluginName: p.manifest.name })),
      ),
    themes: plugins.filter((p) => p.manifest.nova?.ui?.css).map((p) => ({ pluginId: p.id, url: `/api/plugins/${encodeURIComponent(p.id)}/theme.css` })),
  });
});

pluginsRouter.get('/:id/theme.css', (req, res) => {
  const p = active(req.params.id);
  res.setHeader('Content-Type', 'text/css; charset=utf-8');
  res.send(p.manifest.nova?.ui?.css ?? '');
});

/** Local plugins' artwork goes through our image proxy when its host is approved (hotlink-protected CDNs). */
function proxied<T extends { poster?: string; background?: string; logo?: string; thumbnail?: string }>(p: { id: string; kind: string; granted: { network: string[] } }, item: T): T {
  if (p.kind !== 'local') return item;
  const wrap = (u: string | undefined) => {
    if (!u || !/^https?:\/\//.test(u)) return u;
    const host = new URL(u).hostname;
    const ok = p.granted.network.some((rule) => {
      const h = rule.split(':')[0]!;
      return h === host || (h.startsWith('*.') && host.endsWith(h.slice(1)));
    });
    return ok ? `/api/plugins/${encodeURIComponent(p.id)}/image?u=${encodeURIComponent(u)}` : u;
  };
  return { ...item, poster: wrap(item.poster), background: wrap(item.background), logo: wrap(item.logo), thumbnail: wrap(item.thumbnail) };
}

pluginsRouter.get(
  '/:id/catalog/:type/:catalogId',
  asyncHandler(async (req, res) => {
    const p = active(req.params.id);
    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) if (typeof v === 'string' && v) extra[k] = v;
    const data = await callPlugin<{ metas?: MetaPreview[] }>(p, 'catalog', {
      type: req.params.type,
      id: req.params.catalogId,
      extra,
    });
    res.json({ metas: (data?.metas ?? []).map((m) => proxied(p, m)) });
  }),
);

pluginsRouter.get(
  '/:id/meta/:type/:metaId',
  asyncHandler(async (req, res) => {
    const p = active(req.params.id);
    const data = await callPlugin<{ meta?: Meta }>(p, 'meta', { type: req.params.type, id: req.params.metaId });
    if (!data?.meta) throw new HttpError(404, 'Not found');
    res.json({ meta: { ...proxied(p, data.meta), videos: data.meta.videos?.map((v) => proxied(p, v)) } });
  }),
);

pluginsRouter.get(
  '/:id/pages/:type/:videoId',
  asyncHandler(async (req, res) => {
    const p = active(req.params.id);
    const data = await callPlugin<{ pages?: PageImage[] }>(p, 'pages', { type: req.params.type, id: req.params.videoId });
    res.json({
      pages: (data?.pages ?? []).map((pg) => ({
        ...pg,
        // Page images go through our proxy (hotlink protection, referer headers).
        url: `/api/plugins/${encodeURIComponent(p.id)}/image?u=${encodeURIComponent(pg.url)}${pg.headers ? `&h=${encodeURIComponent(JSON.stringify(pg.headers))}` : ''}`,
      })),
    });
  }),
);

/** Image proxy limited to hosts the plugin was approved for (never an open proxy). */
pluginsRouter.get(
  '/:id/image',
  asyncHandler(async (req, res) => {
    const p = active(req.params.id);
    const target = new URL(String(req.query.u ?? ''));
    const host = target.port ? `${target.hostname}:${target.port}` : target.hostname;
    const ok = p.granted.network.some((rule) => {
      const [h] = rule.split(':');
      return h === target.hostname || host === rule || (h?.startsWith('*.') && target.hostname.endsWith(h.slice(1)));
    });
    if (!ok || !/^https?:$/.test(target.protocol)) throw new HttpError(403, 'Host not approved for this plugin');
    let headers: Record<string, string> = {};
    try {
      headers = req.query.h ? (JSON.parse(String(req.query.h)) as Record<string, string>) : {};
    } catch {
      headers = {};
    }
    const upstream = await fetch(target, { headers, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (!upstream?.ok || !upstream.body) throw new HttpError(502, 'Image unavailable');
    const type = upstream.headers.get('content-type') ?? 'image/jpeg';
    if (!type.startsWith('image/')) throw new HttpError(415, 'Not an image');
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).pipe(res);
  }),
);

const actionSchema = z.object({ action: z.string().min(1), context: z.record(z.unknown()).default({}) });

pluginsRouter.post(
  '/:id/action',
  requireProfile,
  asyncHandler(async (req, res) => {
    const p = active(req.params.id);
    const body = parse(actionSchema, req.body);
    const result = await callPlugin<ActionResult>(p, 'action', {
      type: 'action',
      id: body.action,
      action: body.action,
      context: body.context,
      user: { accountId: req.account!.id, profileId: req.profile!.id, username: req.account!.username },
    });
    res.json({ result: result ?? {} });
  }),
);

pluginsRouter.get(
  '/:id/page/:pageId',
  requireProfile,
  asyncHandler(async (req, res) => {
    const p = active(req.params.id);
    const data = await callPlugin<{ view?: ViewNode }>(p, 'page', {
      type: 'page',
      id: req.params.pageId,
      page: req.params.pageId,
      params: req.query,
      user: { accountId: req.account!.id, profileId: req.profile!.id },
    });
    res.json({ view: data?.view ?? { type: 'text', text: 'Nothing here yet.' } });
  }),
);

// Per-user consent for plugins that act on someone's behalf.
pluginsRouter.get('/grants', (req, res) => {
  const rows = db
    .prepare('SELECT plugin_id AS pluginId, scopes, granted_at AS grantedAt FROM plugin_user_grants WHERE account_id = ?')
    .all(req.account!.id) as { pluginId: string; scopes: string; grantedAt: string }[];
  res.json({ grants: rows.map((r) => ({ ...r, scopes: JSON.parse(r.scopes) as string[] })) });
});

const grantSchema = z.object({ pluginId: z.string(), scope: z.string(), allow: z.boolean() });

pluginsRouter.post('/grants', (req, res) => {
  const body = parse(grantSchema, req.body);
  active(body.pluginId);
  const row = db
    .prepare('SELECT scopes FROM plugin_user_grants WHERE plugin_id = ? AND account_id = ?')
    .get(body.pluginId, req.account!.id) as { scopes: string } | undefined;
  const scopes = new Set(row ? (JSON.parse(row.scopes) as string[]) : []);
  if (body.allow) scopes.add(body.scope);
  else scopes.delete(body.scope);
  db.prepare(
    `INSERT INTO plugin_user_grants (plugin_id, account_id, scopes) VALUES (?, ?, ?)
     ON CONFLICT(plugin_id, account_id) DO UPDATE SET scopes = excluded.scopes, granted_at = datetime('now')`,
  ).run(body.pluginId, req.account!.id, JSON.stringify([...scopes]));
  res.json({ ok: true });
});
