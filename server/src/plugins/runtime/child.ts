/**
 * Sandboxed plugin process. The host forks this file with Node's permission
 * model (`--permission`, fs limited to the plugin's own folders, no child
 * processes, workers or native addons) and a minimal environment, then:
 *
 *   - builtins that open raw sockets or spawn code (net, http, child_process,
 *     vm, module, ...) are refused for any module inside the plugin folder,
 *   - fetch/WebSocket only reach hosts an administrator approved, and every
 *     redirect hop is re-checked,
 *   - everything else talks to the host over IPC (storage, server API, logs).
 */
import * as nodeModule from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HostToWorker, PluginManifest, ResourceName, WorkerToHost } from '../protocol.js';

const entry = process.env.NOVA_PLUGIN_ENTRY ?? '';
const pluginDir = process.env.NOVA_PLUGIN_DIR ?? path.dirname(entry);
const pluginUrl = pathToFileURL(pluginDir + path.sep).href;

const BLOCKED = new Set([
  'net', 'tls', 'http', 'https', 'http2', 'dgram', 'dns', 'child_process', 'worker_threads',
  'cluster', 'vm', 'inspector', 'module', 'v8', 'repl', 'trace_events', 'wasi', 'async_hooks',
]);
const isBlocked = (spec: string) => BLOCKED.has(spec.replace(/^node:/, '').split('/')[0]!);

function send(msg: WorkerToHost): void {
  process.send?.(msg);
}

// ---- 1. Module firewall --------------------------------------------------
type ResolveFn = (spec: string, ctx: { parentURL?: string }, next: (s: string, c: unknown) => unknown) => unknown;
const hooks = nodeModule as unknown as { registerHooks?: (h: { resolve: ResolveFn }) => void };
if (typeof hooks.registerHooks === 'function') {
  hooks.registerHooks({
    resolve(spec, ctx, next) {
      if (isBlocked(spec) && (!ctx.parentURL || ctx.parentURL.startsWith(pluginUrl))) {
        throw new Error(`Plugin sandbox: '${spec}' is not available to plugins`);
      }
      return next(spec, ctx);
    },
  });
} else {
  send({ t: 'log', level: 'warn', msg: 'module.registerHooks unavailable; builtin firewall degraded' });
}
const proc = process as unknown as Record<string, unknown>;
const realGetBuiltin = proc.getBuiltinModule as ((id: string) => unknown) | undefined;
if (realGetBuiltin) {
  proc.getBuiltinModule = (id: string) => {
    if (isBlocked(id)) throw new Error(`Plugin sandbox: '${id}' is not available to plugins`);
    return realGetBuiltin(id);
  };
}
proc.binding = () => {
  throw new Error('Plugin sandbox: process.binding is not available');
};
proc.dlopen = () => {
  throw new Error('Plugin sandbox: native addons are not available');
};

// ---- 2. Network allowlist ------------------------------------------------
let allowed: string[] = [];

function hostAllowed(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return allowed.some((rule) => {
    const [h, p] = rule.toLowerCase().split(':');
    if (p && p !== port) return false;
    if (!h) return false;
    if (h.startsWith('*.')) return host === h.slice(2) || host.endsWith(h.slice(1));
    return host === h;
  });
}

function checkUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Plugin sandbox: protocol ${url.protocol} is not allowed`);
  }
  if (!hostAllowed(url)) {
    throw new Error(`Plugin sandbox: network access to ${url.host} was not approved by an administrator`);
  }
}

const realFetch = globalThis.fetch.bind(globalThis);

async function gatedFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  let url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  let opts: RequestInit = input instanceof Request ? { method: input.method, headers: input.headers, ...init } : { ...init };
  const follow = (opts.redirect ?? 'follow') === 'follow';
  for (let hop = 0; hop < 8; hop++) {
    checkUrl(url);
    const res = await realFetch(url, { ...opts, redirect: 'manual' });
    const location = res.headers.get('location');
    if (!follow || res.status < 300 || res.status >= 400 || !location || location.startsWith('magnet:')) {
      return res;
    }
    url = new URL(location, url);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && opts.method && opts.method !== 'GET')) {
      opts = { ...opts, method: 'GET', body: undefined };
    }
  }
  throw new Error('Plugin sandbox: too many redirects');
}
(globalThis as { fetch: typeof fetch }).fetch = gatedFetch as typeof fetch;

const RealWebSocket = (globalThis as { WebSocket?: new (u: string | URL, p?: string | string[]) => unknown }).WebSocket;
if (RealWebSocket) {
  (globalThis as Record<string, unknown>).WebSocket = function GatedWebSocket(u: string | URL, p?: string | string[]) {
    const url = new URL(String(u));
    const asHttp = new URL(url.href.replace(/^ws/, 'http'));
    checkUrl(asHttp);
    return new RealWebSocket(url, p);
  };
}
delete (globalThis as Record<string, unknown>).EventSource;

// ---- 3. Host RPC ---------------------------------------------------------
let seq = 0;
const pendingHost = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function host<T>(method: string, args: unknown): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pendingHost.set(id, { resolve: resolve as (v: unknown) => void, reject });
    send({ t: 'host', id, method, args });
    setTimeout(() => {
      if (pendingHost.delete(id)) reject(new Error(`host call ${method} timed out`));
    }, 30_000).unref();
  });
}

const fmt = (args: unknown[]) =>
  args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack ?? a.message : safeJson(a))).join(' ');
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
const log = {
  debug: (...a: unknown[]) => send({ t: 'log', level: 'debug', msg: fmt(a) }),
  info: (...a: unknown[]) => send({ t: 'log', level: 'info', msg: fmt(a) }),
  warn: (...a: unknown[]) => send({ t: 'log', level: 'warn', msg: fmt(a) }),
  error: (...a: unknown[]) => send({ t: 'log', level: 'error', msg: fmt(a) }),
};
console.log = log.info;
console.info = log.info;
console.debug = log.debug;
console.warn = log.warn;
console.error = log.error;

// ---- 4. Plugin lifecycle -------------------------------------------------
type Handler = (args: unknown, ctx: unknown) => Promise<unknown> | unknown;
interface StremioInterface {
  manifest?: PluginManifest;
  get: (resource: string, type: string, id: string, extra?: Record<string, unknown>) => Promise<unknown>;
}

let definition: Record<string, unknown> | null = null;
let ctx: Record<string, unknown> = {};

async function load(manifest: PluginManifest, config: Record<string, unknown>): Promise<void> {
  const mod = (await import(pathToFileURL(entry).href)) as { default?: unknown };
  const exported = (mod.default ?? mod) as Record<string, unknown>;
  definition = typeof exported === 'function' ? ((await (exported as () => unknown)()) as Record<string, unknown>) : exported;
  // Stremio addon-sdk builders expose getInterface(); accept those as-is.
  if (definition && typeof definition.getInterface === 'function') {
    definition = (definition.getInterface as () => Record<string, unknown>)();
  }
  ctx = {
    manifest,
    config,
    fetch: gatedFetch,
    log,
    storage: {
      get: (key: string) => host<unknown>('storage.get', { key }),
      set: (key: string, value: unknown) => host<void>('storage.set', { key, value }),
      delete: (key: string) => host<void>('storage.delete', { key }),
    },
    api: (method: string, args?: unknown) => host<unknown>(`api.${method}`, args ?? {}),
    dataDir: process.env.NOVA_PLUGIN_DATA ?? null,
  };
  const setup = definition?.setup as Handler | undefined;
  if (setup) await setup({}, ctx);
}

async function invoke(method: ResourceName, args: unknown): Promise<unknown> {
  if (!definition) throw new Error('plugin not initialised');
  const direct = definition[method] as Handler | undefined;
  if (typeof direct === 'function') return direct(args, ctx);
  const iface = definition as unknown as StremioInterface;
  if (typeof iface.get === 'function') {
    const a = args as { type: string; id: string; extra?: Record<string, unknown> };
    return iface.get(method, a.type, a.id, a.extra ?? {});
  }
  throw new Error(`plugin does not implement '${method}'`);
}

process.on('message', (raw: HostToWorker) => {
  if (raw.t === 'init') {
    allowed = raw.allowedHosts;
    load(raw.manifest, raw.config)
      .then(() => {
        const keys = definition ? Object.keys(definition).filter((k) => typeof definition![k] === 'function') : [];
        send({ t: 'ready', resources: keys });
      })
      .catch((err: unknown) => {
        log.error('failed to load plugin:', err);
        setTimeout(() => process.exit(1), 50);
      });
    return;
  }
  if (raw.t === 'reply') {
    const p = pendingHost.get(raw.id);
    if (!p) return;
    pendingHost.delete(raw.id);
    if (raw.ok) p.resolve(raw.value);
    else p.reject(new Error(raw.error ?? 'host error'));
    return;
  }
  if (raw.t === 'call') {
    Promise.resolve()
      .then(() => invoke(raw.method, raw.args))
      .then((value) => send({ t: 'result', id: raw.id, ok: true, value }))
      .catch((err: unknown) =>
        send({ t: 'result', id: raw.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
  }
});

process.on('uncaughtException', (err) => log.error('uncaught:', err));
process.on('unhandledRejection', (err) => log.error('unhandled rejection:', err));
process.on('disconnect', () => process.exit(0));
