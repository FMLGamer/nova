import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import type { HostToWorker, PluginManifest, ResourceName, WorkerToHost } from './protocol.js';

// The sandbox child is plain JS; under `tsx` (dev) fall back to the compiled copy in dist/.
const RUNTIME = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const local = path.join(here, 'runtime', 'child.js');
  if (fs.existsSync(local)) return local;
  return path.resolve(here, '..', '..', 'dist', 'plugins', 'runtime', 'child.js');
})();

/** Which spelling of the permission flag this Node understands. */
const PERMISSION_FLAG = (() => {
  const flags = process.allowedNodeEnvironmentFlags;
  if (flags.has('--permission')) return '--permission';
  if (flags.has('--experimental-permission')) return '--experimental-permission';
  return null;
})();

export const sandboxAvailable = PERMISSION_FLAG !== null;

export interface LogLine {
  at: number;
  level: string;
  msg: string;
}

export type HostCallHandler = (method: string, args: unknown) => Promise<unknown>;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * One sandboxed plugin process. Calls are multiplexed over IPC; a crash is
 * isolated to this plugin and it is restarted with backoff.
 */
export class PluginWorker {
  private child: ChildProcess | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private readyPromise: Promise<void> | null = null;
  private crashes: number[] = [];
  private stopped = false;
  readonly logs: LogLine[] = [];
  status: 'starting' | 'running' | 'crashed' | 'stopped' = 'stopped';
  lastError: string | null = null;
  resources: string[] = [];

  constructor(
    readonly id: string,
    private entry: string,
    private dataDir: string,
    private manifest: PluginManifest,
    private pluginConfig: Record<string, unknown>,
    private allowedHosts: string[],
    private fsGrants: { path: string; access: 'read' | 'write' }[],
    private onHostCall: HostCallHandler,
  ) {}

  log(level: string, msg: string): void {
    this.logs.push({ at: Date.now(), level, msg: msg.slice(0, 2000) });
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300);
  }

  start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.stopped = false;
    this.status = 'starting';
    fs.mkdirSync(this.dataDir, { recursive: true });
    const pluginDir = path.dirname(this.entry);
    const execArgv = [`--max-old-space-size=${config.plugins.memoryMb}`];
    if (PERMISSION_FLAG) {
      execArgv.push(
        PERMISSION_FLAG,
        `--allow-fs-read=${path.dirname(RUNTIME)}`,
        `--allow-fs-read=${pluginDir}`,
        `--allow-fs-read=${this.dataDir}`,
        `--allow-fs-write=${this.dataDir}`,
      );
      for (const g of this.fsGrants) {
        execArgv.push(`--allow-fs-read=${g.path}`);
        if (g.access === 'write') execArgv.push(`--allow-fs-write=${g.path}`);
      }
    }
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const child = fork(RUNTIME, [], {
        execArgv,
        // Never leak the server's environment (session secret, API keys) into a plugin.
        env: {
          NODE_ENV: config.isProd ? 'production' : 'development',
          TZ: process.env.TZ ?? 'UTC',
          NOVA_PLUGIN_ENTRY: this.entry,
          NOVA_PLUGIN_DIR: pluginDir,
          NOVA_PLUGIN_DATA: this.dataDir,
          NOVA_PLUGIN_ID: this.id,
        },
        serialization: 'advanced',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      this.child = child;
      const bootTimer = setTimeout(() => {
        reject(new Error('plugin did not start within 20s'));
        child.kill('SIGKILL');
      }, 20_000);
      child.stdout?.on('data', (d: Buffer) => this.log('info', d.toString().trim()));
      child.stderr?.on('data', (d: Buffer) => this.log('error', d.toString().trim()));
      child.on('message', (msg: WorkerToHost) => {
        if (msg.t === 'ready') {
          clearTimeout(bootTimer);
          this.status = 'running';
          this.resources = msg.resources;
          this.log('info', `ready (${msg.resources.join(', ') || 'no handlers'})`);
          resolve();
        } else if (msg.t === 'result') {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.value);
          else p.reject(new Error(msg.error ?? 'plugin error'));
        } else if (msg.t === 'log') {
          this.log(msg.level, msg.msg);
        } else if (msg.t === 'host') {
          this.onHostCall(msg.method, msg.args)
            .then((value) => this.send({ t: 'reply', id: msg.id, ok: true, value }))
            .catch((err: unknown) =>
              this.send({ t: 'reply', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
            );
        }
      });
      child.on('exit', (code, signal) => {
        clearTimeout(bootTimer);
        this.child = null;
        this.readyPromise = null;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('plugin process exited'));
        }
        this.pending.clear();
        if (this.stopped) {
          this.status = 'stopped';
          return;
        }
        this.lastError = `exited (${signal ?? code})`;
        this.log('error', `process ${this.lastError}`);
        reject(new Error(`plugin exited during start (${signal ?? code})`));
        this.scheduleRestart();
      });
      this.send({
        t: 'init',
        manifest: this.manifest,
        config: this.pluginConfig,
        allowedHosts: this.allowedHosts,
      });
    });
    this.readyPromise.catch((err: Error) => {
      this.lastError = err.message;
    });
    return this.readyPromise;
  }

  private scheduleRestart(): void {
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < 10 * 60_000);
    this.crashes.push(now);
    if (this.crashes.length >= 5) {
      this.status = 'crashed';
      this.log('error', 'crashed 5 times in 10 minutes; not restarting until re-enabled');
      return;
    }
    this.status = 'starting';
    const delay = [1000, 3000, 10_000, 30_000][this.crashes.length - 1] ?? 60_000;
    setTimeout(() => {
      if (!this.stopped) this.start().catch(() => undefined);
    }, delay).unref();
  }

  private send(msg: HostToWorker): void {
    try {
      this.child?.send(msg);
    } catch (err) {
      this.log('error', `ipc send failed: ${(err as Error).message}`);
    }
  }

  async call<T>(method: ResourceName, args: unknown, timeoutMs = config.plugins.callTimeoutMs): Promise<T> {
    if (this.status === 'crashed') throw new Error('plugin is crashed');
    await this.start();
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ t: 'call', id, method, args });
    });
  }

  stop(): void {
    this.stopped = true;
    this.status = 'stopped';
    this.child?.kill('SIGTERM');
    const c = this.child;
    setTimeout(() => c?.kill('SIGKILL'), 3000).unref();
  }
}
