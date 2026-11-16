import { every } from '../lib/scheduler.js';
import { activePlugins, callPlugin } from './manager.js';

const lastRun = new Map<string, number>();

/** Runs plugin jobs that declare `everyMinutes` (webhook jobs run via /api/plugins/:id/webhook). */
export function startPluginJobs(): void {
  every(
    'plugin-jobs',
    60_000,
    async () => {
      const now = Date.now();
      for (const p of activePlugins('job')) {
        for (const job of p.manifest.nova?.jobs ?? []) {
          if (!job.everyMinutes) continue;
          const key = `${p.id}:${job.id}`;
          if (now - (lastRun.get(key) ?? 0) < job.everyMinutes * 60_000) continue;
          lastRun.set(key, now);
          callPlugin(p, 'job', { type: 'job', id: job.id, job: job.id, payload: null }, 10 * 60_000).catch((err: Error) =>
            console.error(`[plugins] job ${key} failed:`, err.message),
          );
        }
      }
    },
    { initialDelayMs: 90_000 },
  );
}
