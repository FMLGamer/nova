/**
 * Keys for outside services. Environment variables win (for operators who
 * manage config declaratively); otherwise an admin can set them in the app,
 * where they are stored sealed in the database.
 */
import { config } from '../config.js';
import { db } from '../db/index.js';
import { seal, unseal } from '../lib/crypto.js';

export const INTEGRATION_KEYS = ['tmdbApiKey', 'openSubtitlesApiKey', 'openSubtitlesUsername', 'openSubtitlesPassword', 'deeplApiKey'] as const;
export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];

const fromEnv: Record<IntegrationKey, () => string> = {
  tmdbApiKey: () => config.tmdbApiKey,
  openSubtitlesApiKey: () => config.openSubtitles.apiKey,
  openSubtitlesUsername: () => config.openSubtitles.username,
  openSubtitlesPassword: () => config.openSubtitles.password,
  deeplApiKey: () => config.deeplApiKey,
};

const memo = new Map<IntegrationKey, string>();

export function integration(key: IntegrationKey): string {
  const env = fromEnv[key]();
  if (env) return env;
  if (memo.has(key)) return memo.get(key)!;
  const row = db.prepare('SELECT value FROM server_settings WHERE key = ?').get(`integration.${key}`) as { value: string } | undefined;
  const v = row ? unseal(row.value) : '';
  memo.set(key, v);
  return v;
}

export function setIntegration(key: IntegrationKey, value: string): void {
  const v = value.trim();
  if (v) {
    db.prepare(
      `INSERT INTO server_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    ).run(`integration.${key}`, seal(v));
  } else db.prepare('DELETE FROM server_settings WHERE key = ?').run(`integration.${key}`);
  memo.delete(key);
}

/** Which keys are set, and whether the environment fixes them (read-only in the UI). Never the values. */
export function integrationStatus(): Record<IntegrationKey, { set: boolean; fromEnv: boolean }> {
  const out = {} as Record<IntegrationKey, { set: boolean; fromEnv: boolean }>;
  for (const k of INTEGRATION_KEYS) out[k] = { set: Boolean(integration(k)), fromEnv: Boolean(fromEnv[k]()) };
  return out;
}
