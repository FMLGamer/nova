import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { HttpError } from '../lib/http.js';
import { seal, unseal } from '../lib/crypto.js';
import { notifyAdmins } from '../services/notifications.js';
import type { ConfigField, ManifestResource, Permissions, PluginManifest, ResourceName } from './protocol.js';
import { SDK_VERSION } from './protocol.js';
import { stremioCall } from './stremio.js';
import { PluginWorker, sandboxAvailable, type LogLine } from './worker.js';
import { hostCall } from './hostApi.js';

export type PluginKind = 'local' | 'stremio';

interface PluginRow {
  id: string;
  kind: PluginKind;
  source_url: string | null;
  manifest: string;
  version: string;
  enabled: number;
  status: 'pending' | 'approved';
  granted: string;
  config: string;
  bundle_sha256: string | null;
  priority: number;
  pending_update: string | null;
  installed_by: string | null;
  installed_at: string;
  updated_at: string;
}

export interface PermissionSummary {
  network: string[];
  fs: { path: string; access: 'read' | 'write' }[];
  storage: boolean;
  api: string[];
}

export interface Plugin {
  id: string;
  kind: PluginKind;
  sourceUrl: string | null;
  manifest: PluginManifest;
  enabled: boolean;
  status: 'pending' | 'approved';
  granted: PermissionSummary;
  config: Record<string, unknown>;
  priority: number;
  pendingUpdate: { manifest: PluginManifest; permissions: PermissionSummary } | null;
  installedAt: string;
}

const manifestSchema = z
  .object({
    id: z.string().min(2).max(120).regex(/^[a-zA-Z0-9._-]+$/, 'id may only contain letters, digits and . _ -'),
    version: z.string().min(1).max(40),
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    types: z.array(z.string()).default([]),
    resources: z.array(z.union([z.string(), z.object({ name: z.string() }).passthrough()])).default([]),
  })
  .passthrough();

// ---------------------------------------------------------------- helpers

function safeDir(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function pluginRoot(id: string): string {
  return path.join(config.plugins.dir, safeDir(id));
}

export function resourcesOf(manifest: PluginManifest): ManifestResource[] {
  return manifest.resources.map((r) => (typeof r === 'string' ? { name: r } : r));
}

export function supports(manifest: PluginManifest, resource: ResourceName): ManifestResource | null {
  return resourcesOf(manifest).find((r) => r.name === resource) ?? null;
}

function configFields(manifest: PluginManifest): ConfigField[] {
  return manifest.nova?.config ?? [];
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return null;
  }
}

/** Env overrides: PLUGIN_<ID>_<KEY>, e.g. PLUGIN_NOVA_PROWLARR_APIKEY. */
function envConfig(id: string, fields: ConfigField[]): Record<string, string> {
  const prefix = `PLUGIN_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_`;
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = process.env[prefix + f.key.toUpperCase().replace(/[^A-Z0-9]+/g, '_')];
    if (v !== undefined && v !== '') out[f.key] = v;
  }
  return out;
}

function effectiveConfig(id: string, manifest: PluginManifest, stored: Record<string, unknown>): Record<string, unknown> {
  const fields = configFields(manifest);
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = stored[f.key];
    out[f.key] = v === undefined || v === '' ? f.default ?? '' : f.type === 'password' ? unseal(String(v)) : v;
  }
  return { ...out, ...envConfig(id, fields) };
}

export function requestedPermissions(
  manifest: PluginManifest,
  kind: PluginKind,
  sourceUrl: string | null,
  cfg: Record<string, unknown> = {},
): PermissionSummary {
  if (kind === 'stremio') {
    const h = sourceUrl ? hostOf(sourceUrl) : null;
    return { network: h ? [h] : [], fs: [], storage: false, api: [] };
  }
  const p: Permissions = manifest.nova?.permissions ?? {};
  const network = new Set(p.network ?? []);
  for (const f of configFields(manifest)) {
    if (f.type === 'url' && f.network) {
      const v = (cfg[f.key] as string | undefined) || (f.default as string | undefined);
      const h = v ? hostOf(v) : null;
      if (h) network.add(h);
    }
  }
  return {
    network: [...network],
    fs: (p.fs ?? []).map((g) => ({ path: g.path, access: g.access })),
    storage: Boolean(p.storage),
    api: p.api ?? [],
  };
}

function samePermissions(a: PermissionSummary, b: PermissionSummary): boolean {
  const norm = (p: PermissionSummary) =>
    JSON.stringify({
      n: [...p.network].sort(),
      f: p.fs.map((g) => `${g.path}:${g.access}`).sort(),
      s: p.storage,
      a: [...p.api].sort(),
    });
  return norm(a) === norm(b);
}

function rowToPlugin(r: PluginRow): Plugin {
  return {
    id: r.id,
    kind: r.kind,
    sourceUrl: r.source_url,
    manifest: JSON.parse(r.manifest) as PluginManifest,
    enabled: r.enabled === 1,
    status: r.status,
    granted: JSON.parse(r.granted) as PermissionSummary,
    config: JSON.parse(r.config) as Record<string, unknown>,
    priority: r.priority,
    pendingUpdate: r.pending_update ? (JSON.parse(r.pending_update) as Plugin['pendingUpdate']) : null,
    installedAt: r.installed_at,
  };
}

async function fetchText(url: string, maxBytes: number): Promise<string> {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, 'Only http(s) URLs can be installed');
  let res: Response;
  try {
    res = await fetch(u, { signal: AbortSignal.timeout(20_000), headers: { Accept: 'application/json, */*' } });
  } catch {
    throw new HttpError(502, `Could not reach ${u.host}`);
  }
  if (!res.ok) throw new HttpError(502, `${u.host} answered ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new HttpError(400, 'Download is too large');
  return buf.toString('utf8');
}

function parseManifest(text: string): PluginManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'That URL did not return a JSON manifest');
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, `Invalid manifest: ${parsed.error.issues[0]?.message ?? 'unknown error'}`);
  const m = parsed.data as unknown as PluginManifest;
  if (m.nova?.sdk && m.nova.sdk > SDK_VERSION) {
    throw new HttpError(400, `This plugin needs a newer Nova (plugin SDK v${m.nova.sdk})`);
  }
  return m;
}

// ---------------------------------------------------------------- runtime

const workers = new Map<string, PluginWorker>();

function getRow(id: string): PluginRow | undefined {
  return db.prepare('SELECT * FROM plugins WHERE id = ?').get(id) as PluginRow | undefined;
}

export function getPlugin(id: string): Plugin | null {
  const r = getRow(id);
  return r ? rowToPlugin(r) : null;
}

export function listPlugins(): Plugin[] {
  return (db.prepare('SELECT * FROM plugins ORDER BY priority, installed_at').all() as PluginRow[]).map(rowToPlugin);
}

/** Enabled + approved plugins, optionally only those serving `resource`. */
export function activePlugins(resource?: ResourceName): Plugin[] {
  return listPlugins().filter(
    (p) => p.enabled && p.status === 'approved' && (!resource || supports(p.manifest, resource) !== null),
  );
}

function fsGrantPaths(p: Plugin): { path: string; access: 'read' | 'write' }[] {
  const out: { path: string; access: 'read' | 'write' }[] = [];
  for (const g of p.granted.fs) {
    if (g.path === 'library' && config.library.dir) out.push({ path: config.library.dir, access: g.access });
  }
  return out;
}

function startWorker(p: Plugin): PluginWorker | null {
  if (p.kind !== 'local' || !p.enabled || p.status !== 'approved') return null;
  const existing = workers.get(p.id);
  if (existing) return existing;
  const root = pluginRoot(p.id);
  const entry = path.join(root, 'bundle', 'index.mjs');
  if (!fs.existsSync(entry)) return null;
  const cfg = effectiveConfig(p.id, p.manifest, p.config);
  // URLs an administrator typed into the plugin's settings are implicitly approved.
  const configHosts = configFields(p.manifest)
    .filter((f) => f.type === 'url' && f.network)
    .map((f) => hostOf(String(cfg[f.key] ?? '')))
    .filter((h): h is string => Boolean(h));
  const allowed = new Set([...p.granted.network, ...configHosts]);
  const w = new PluginWorker(
    p.id,
    entry,
    path.join(root, 'data'),
    p.manifest,
    cfg,
    [...allowed],
    fsGrantPaths(p),
    (method, args) => hostCall(p, method, args),
  );
  workers.set(p.id, w);
  w.start().catch((err: Error) => console.error(`[plugins] ${p.id} failed to start:`, err.message));
  return w;
}

function stopWorker(id: string): void {
  workers.get(id)?.stop();
  workers.delete(id);
}

function restartWorker(id: string): void {
  stopWorker(id);
  const p = getPlugin(id);
  if (p) startWorker(p);
}

export function workerInfo(id: string): { status: string; lastError: string | null; logs: LogLine[]; resources: string[] } | null {
  const w = workers.get(id);
  return w ? { status: w.status, lastError: w.lastError, logs: w.logs, resources: w.resources } : null;
}

/**
 * Calls one resource on one plugin, whatever kind it is. Stremio addons are
 * remote HTTP services; local plugins are sandboxed processes.
 */
export async function callPlugin<T>(
  p: Plugin,
  resource: ResourceName,
  args: { type: string; id: string; extra?: Record<string, string>; [k: string]: unknown },
  timeoutMs?: number,
): Promise<T> {
  if (p.kind === 'stremio') {
    if (!p.sourceUrl) throw new Error('addon has no URL');
    return stremioCall<T>(p.sourceUrl, resource, args.type, args.id, args.extra ?? {}, timeoutMs);
  }
  const w = startWorker(p);
  if (!w) throw new Error('plugin is not running');
  return w.call<T>(resource, { extra: {}, ...args }, timeoutMs);
}

// ---------------------------------------------------------------- install / manage

export interface InstallPreview {
  kind: PluginKind;
  sourceUrl: string;
  manifest: PluginManifest;
  permissions: PermissionSummary;
  installed: boolean;
  sandbox: boolean;
}

export async function previewInstall(url: string): Promise<InstallPreview> {
  const manifest = parseManifest(await fetchText(url, 512 * 1024));
  const kind: PluginKind = manifest.nova?.entry ? 'local' : 'stremio';
  return {
    kind,
    sourceUrl: url,
    manifest,
    permissions: requestedPermissions(manifest, kind, url),
    installed: Boolean(getRow(manifest.id)),
    sandbox: sandboxAvailable,
  };
}

async function downloadBundle(manifest: PluginManifest, manifestUrl: string): Promise<{ code: string; sha: string }> {
  const entryUrl = new URL(manifest.nova!.entry!, manifestUrl).toString();
  const code = await fetchText(entryUrl, 25 * 1024 * 1024);
  return { code, sha: crypto.createHash('sha256').update(code).digest('hex') };
}

function writeBundle(id: string, manifest: PluginManifest, code: string): void {
  const dir = path.join(pluginRoot(id), 'bundle');
  const tmp = `${dir}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'index.mjs'), code);
  fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
}

function sealConfig(manifest: PluginManifest, values: Record<string, unknown>, previous: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...previous };
  for (const f of configFields(manifest)) {
    if (!(f.key in values)) continue;
    const v = values[f.key];
    // null: back to the plugin's default.
    if (v === null) {
      delete out[f.key];
      continue;
    }
    if (f.type === 'password') {
      // An unchanged mask means "keep the stored secret".
      if (v === '••••••••') continue;
      out[f.key] = v ? seal(String(v)) : '';
    } else if (f.type === 'number') out[f.key] = Number(v);
    else if (f.type === 'checkbox') out[f.key] = Boolean(v);
    else out[f.key] = String(v ?? '');
  }
  return out;
}

export async function installFromUrl(
  url: string,
  opts: { approve: boolean; by: string | null; config?: Record<string, unknown> },
): Promise<Plugin> {
  const preview = await previewInstall(url);
  const { manifest, kind } = preview;
  if (getRow(manifest.id)) throw new HttpError(409, `${manifest.name} is already installed`);
  let sha: string | null = null;
  if (kind === 'local') {
    const bundle = await downloadBundle(manifest, url);
    writeBundle(manifest.id, manifest, bundle.code);
    sha = bundle.sha;
  }
  const cfg = sealConfig(manifest, opts.config ?? {});
  const granted = requestedPermissions(manifest, kind, url, effectiveConfig(manifest.id, manifest, cfg));
  const priority = kind === 'stremio' ? 200 : 100;
  db.prepare(
    `INSERT INTO plugins (id, kind, source_url, manifest, version, enabled, status, granted, config, bundle_sha256, priority, installed_by)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    manifest.id,
    kind,
    url,
    JSON.stringify(manifest),
    manifest.version,
    opts.approve ? 'approved' : 'pending',
    JSON.stringify(opts.approve ? granted : { network: [], fs: [], storage: false, api: [] }),
    JSON.stringify(cfg),
    sha,
    priority,
    opts.by,
  );
  const p = getPlugin(manifest.id)!;
  startWorker(p);
  return p;
}

/** Dev / upload path: a manifest + bundle pushed straight to the server (hot reload). */
export function installUploaded(manifest: PluginManifest, code: string, by: string): Plugin {
  const m = parseManifest(JSON.stringify(manifest));
  const kind: PluginKind = m.nova?.entry ? 'local' : 'stremio';
  if (kind !== 'local') throw new HttpError(400, 'Only code plugins can be uploaded');
  writeBundle(m.id, m, code);
  const sha = crypto.createHash('sha256').update(code).digest('hex');
  const existing = getPlugin(m.id);
  if (existing) {
    const requested = requestedPermissions(m, kind, null, effectiveConfig(m.id, m, existing.config));
    const needsApproval = !samePermissions(requested, existing.granted);
    db.prepare(
      `UPDATE plugins SET manifest = ?, version = ?, bundle_sha256 = ?, status = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(JSON.stringify(m), m.version, sha, needsApproval ? 'pending' : existing.status, m.id);
  } else {
    db.prepare(
      `INSERT INTO plugins (id, kind, source_url, manifest, version, enabled, status, granted, config, bundle_sha256, installed_by)
       VALUES (?, 'local', NULL, ?, ?, 1, 'pending', ?, '{}', ?, ?)`,
    ).run(m.id, JSON.stringify(m), m.version, JSON.stringify({ network: [], fs: [], storage: false, api: [] }), sha, by);
  }
  restartWorker(m.id);
  return getPlugin(m.id)!;
}

export function approvePlugin(id: string): Plugin {
  const p = getPlugin(id);
  if (!p) throw new HttpError(404, 'Plugin not found');
  if (p.pendingUpdate) {
    db.prepare(
      `UPDATE plugins SET manifest = ?, version = ?, granted = ?, pending_update = NULL, status = 'approved', updated_at = datetime('now') WHERE id = ?`,
    ).run(JSON.stringify(p.pendingUpdate.manifest), p.pendingUpdate.manifest.version, JSON.stringify(p.pendingUpdate.permissions), id);
    const staged = path.join(pluginRoot(id), 'staged.mjs');
    if (fs.existsSync(staged)) {
      writeBundle(id, p.pendingUpdate.manifest, fs.readFileSync(staged, 'utf8'));
      fs.rmSync(staged, { force: true });
    }
  } else {
    const granted = requestedPermissions(p.manifest, p.kind, p.sourceUrl, effectiveConfig(id, p.manifest, p.config));
    db.prepare(`UPDATE plugins SET status = 'approved', granted = ?, updated_at = datetime('now') WHERE id = ?`).run(
      JSON.stringify(granted),
      id,
    );
  }
  restartWorker(id);
  return getPlugin(id)!;
}

export function setPluginEnabled(id: string, enabled: boolean): Plugin {
  if (!getRow(id)) throw new HttpError(404, 'Plugin not found');
  db.prepare(`UPDATE plugins SET enabled = ?, updated_at = datetime('now') WHERE id = ?`).run(enabled ? 1 : 0, id);
  if (enabled) restartWorker(id);
  else stopWorker(id);
  return getPlugin(id)!;
}

export function setPluginPriority(id: string, priority: number): void {
  db.prepare('UPDATE plugins SET priority = ? WHERE id = ?').run(Math.round(priority), id);
}

export function updatePluginConfig(id: string, values: Record<string, unknown>): Plugin {
  const p = getPlugin(id);
  if (!p) throw new HttpError(404, 'Plugin not found');
  const cfg = sealConfig(p.manifest, values, p.config);
  db.prepare(`UPDATE plugins SET config = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(cfg), id);
  restartWorker(id);
  return getPlugin(id)!;
}

export function uninstallPlugin(id: string): void {
  stopWorker(id);
  db.prepare('DELETE FROM plugins WHERE id = ?').run(id);
  fs.rmSync(pluginRoot(id), { recursive: true, force: true });
}

/** Config fields with values for the admin UI (secrets masked, env-managed flagged). */
export function configView(p: Plugin): (ConfigField & { value: unknown; managed: boolean })[] {
  const env = envConfig(p.id, configFields(p.manifest));
  return configFields(p.manifest).map((f) => {
    const stored = p.config[f.key];
    const managed = f.key in env;
    let value: unknown = managed ? env[f.key] : stored ?? f.default ?? '';
    if (f.type === 'password') value = value ? '••••••••' : '';
    return { ...f, value, managed };
  });
}

export async function checkUpdate(id: string): Promise<'none' | 'updated' | 'needs-approval'> {
  const p = getPlugin(id);
  if (!p?.sourceUrl) return 'none';
  const manifest = parseManifest(await fetchText(p.sourceUrl, 512 * 1024));
  if (manifest.id !== p.id) throw new Error('manifest id changed upstream');
  if (manifest.version === p.manifest.version && JSON.stringify(manifest) === JSON.stringify(p.manifest)) return 'none';
  const requested = requestedPermissions(manifest, p.kind, p.sourceUrl, effectiveConfig(id, manifest, p.config));
  const code = p.kind === 'local' ? await downloadBundle(manifest, p.sourceUrl) : null;
  if (!samePermissions(requested, p.granted)) {
    if (code) fs.writeFileSync(path.join(pluginRoot(id), 'staged.mjs'), code.code);
    db.prepare(`UPDATE plugins SET pending_update = ? WHERE id = ?`).run(
      JSON.stringify({ manifest, permissions: requested }),
      id,
    );
    notifyAdmins({
      kind: 'plugin-update',
      title: `${manifest.name} ${manifest.version} needs approval`,
      body: 'The update asks for different permissions.',
      link: '/admin/plugins',
    });
    return 'needs-approval';
  }
  if (code) writeBundle(id, manifest, code.code);
  db.prepare(
    `UPDATE plugins SET manifest = ?, version = ?, bundle_sha256 = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(JSON.stringify(manifest), manifest.version, code?.sha ?? null, id);
  restartWorker(id);
  return 'updated';
}

export async function checkAllUpdates(): Promise<void> {
  for (const p of listPlugins()) {
    try {
      await checkUpdate(p.id);
    } catch (err) {
      console.error(`[plugins] update check for ${p.id} failed:`, (err as Error).message);
    }
  }
}

export interface RegistryEntry {
  id: string;
  name: string;
  description?: string;
  manifest: string;
  kind?: 'nova' | 'stremio';
  configure?: string;
  logo?: string;
  tags?: string[];
  registry: string;
}

export async function browseRegistries(): Promise<RegistryEntry[]> {
  const out: RegistryEntry[] = [];
  for (const reg of config.plugins.registries) {
    try {
      const data = JSON.parse(await fetchText(reg, 1024 * 1024)) as { plugins?: Omit<RegistryEntry, 'registry'>[] };
      for (const e of data.plugins ?? []) {
        if (e.id && e.manifest) out.push({ ...e, registry: reg });
      }
    } catch (err) {
      console.error(`[plugins] registry ${reg} unavailable:`, (err as Error).message);
    }
  }
  return out;
}

/** Boot: start approved plugins and install any declared in PLUGINS_AUTOINSTALL. */
export async function bootPlugins(): Promise<void> {
  fs.mkdirSync(config.plugins.dir, { recursive: true });
  if (!sandboxAvailable) console.warn('[plugins] Node permission model unavailable; plugins run with a degraded sandbox');
  for (const p of listPlugins()) startWorker(p);
  const installed = new Set(listPlugins().map((p) => p.sourceUrl));
  for (const url of config.plugins.autoInstall) {
    if (installed.has(url)) continue;
    try {
      const preview = await previewInstall(url);
      if (getRow(preview.manifest.id)) continue;
      const p = await installFromUrl(url, { approve: true, by: 'deployment' });
      console.log(`[plugins] auto-installed ${p.manifest.name} ${p.manifest.version}`);
    } catch (err) {
      console.error(`[plugins] auto-install of ${url} failed:`, (err as Error).message);
    }
  }
}
