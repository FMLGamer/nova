/**
 * Server-wide switches an admin flips under Server → Advanced. Stored as one JSON row in server_settings.
 */
import { db } from '../db/index.js';

export interface ServerOptions {
  /** Offer "Download to server" (and server auto-download rules) next to downloading to a device. */
  serverDownloads: boolean;
}

const DEFAULTS: ServerOptions = { serverDownloads: false };
const KEY = 'options';
let memo: ServerOptions | null = null;

export function serverOptions(): ServerOptions {
  if (memo) return memo;
  const row = db.prepare('SELECT value FROM server_settings WHERE key = ?').get(KEY) as { value: string } | undefined;
  let stored: Partial<ServerOptions> = {};
  try {
    stored = row ? (JSON.parse(row.value) as Partial<ServerOptions>) : {};
  } catch {
    /* a broken row falls back to the defaults */
  }
  memo = { ...DEFAULTS, ...stored };
  return memo;
}

export function setServerOptions(patch: Partial<ServerOptions>): ServerOptions {
  const next = { ...serverOptions(), ...patch };
  db.prepare(
    `INSERT INTO server_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(KEY, JSON.stringify(next));
  memo = next;
  return next;
}
