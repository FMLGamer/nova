import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { msUntilUtcHour } from '../lib/scheduler.js';

export interface BackupFile {
  name: string;
  size: number;
  createdAt: string;
}

export function listBackups(): BackupFile[] {
  try {
    return fs
      .readdirSync(config.backups.dir)
      .filter((f) => /^nova-.*\.db$/.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(config.backups.dir, f));
        return { name: f, size: st.size, createdAt: st.mtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

/** Consistent online snapshot of the SQLite database (WAL-safe), then retention. */
export async function runBackup(reason: 'scheduled' | 'manual' = 'manual'): Promise<BackupFile> {
  fs.mkdirSync(config.backups.dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `nova-${stamp}-${reason}.db`;
  const target = path.join(config.backups.dir, name);
  await db.backup(target);
  const keep = Math.max(1, config.backups.keep);
  for (const old of listBackups().slice(keep)) fs.rmSync(path.join(config.backups.dir, old.name), { force: true });
  const st = fs.statSync(target);
  return { name, size: st.size, createdAt: st.mtime.toISOString() };
}

export function backupPath(name: string): string | null {
  if (!/^nova-[\w-]+\.db$/.test(name)) return null;
  const p = path.join(config.backups.dir, name);
  return fs.existsSync(p) ? p : null;
}

export function scheduleBackups(): void {
  const arm = () => {
    setTimeout(() => {
      runBackup('scheduled')
        .then((b) => console.log(`[backup] ${b.name} (${Math.round(b.size / 1024)} KB)`))
        .catch((err: Error) => console.error('[backup] failed:', err.message))
        .finally(arm);
    }, msUntilUtcHour(config.backups.hourUtc)).unref();
  };
  arm();
}
