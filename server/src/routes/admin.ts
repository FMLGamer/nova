import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../lib/async.js';
import { HttpError, parse } from '../lib/http.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { cacheLimits, countAdmins, deleteAccount, listAdminAccounts } from '../services/admin.js';
import { updateAccountSettings } from '../services/entitlements.js';
import { cacheTotals, flushAccountCache, flushAllCache } from '../services/torrentEngine.js';
import { getAccountById } from '../services/accounts.js';
import { backupPath, listBackups, runBackup } from '../services/backups.js';
import { lastScan, libraryEnabled, storageStats } from '../library/library.js';
import { listPlugins } from '../plugins/manager.js';
import { sandboxAvailable } from '../plugins/worker.js';
import { INTEGRATION_KEYS, integrationStatus, setIntegration } from '../services/integrations.js';
import { VERSION } from './system.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

adminRouter.get('/integrations', (_req, res) => {
  res.json({ integrations: integrationStatus() });
});

adminRouter.put('/integrations', (req, res) => {
  const body = parse(z.object(Object.fromEntries(INTEGRATION_KEYS.map((k) => [k, z.string().max(500).optional()]))), req.body) as Partial<Record<(typeof INTEGRATION_KEYS)[number], string>>;
  for (const k of INTEGRATION_KEYS) if (body[k] !== undefined) setIntegration(k, body[k]!);
  res.json({ integrations: integrationStatus() });
});

adminRouter.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const plugins = listPlugins();
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    res.json({
      accounts: listAdminAccounts(),
      cache: { ...cacheTotals(), ...cacheLimits() },
      limits: { maxProfiles: config.maxProfiles, maxTranscodes: config.maxTranscodes },
      server: {
        version: VERSION,
        mode: config.mode,
        torrentMode: config.torrentMode,
        sandbox: sandboxAvailable,
        hwAccel: config.hwAccel || null,
        library: { enabled: libraryEnabled(), storage: storageStats(), lastScan },
        plugins: { total: plugins.length, pending: plugins.filter((p) => p.status === 'pending' || p.pendingUpdate).length },
        approvals: count("SELECT COUNT(*) AS n FROM downloads WHERE status = 'pending'"),
        review: count("SELECT COUNT(*) AS n FROM library_items WHERE match_status = 'review'"),
        liveChannels: count('SELECT COUNT(*) AS n FROM live_channels'),
        backups: listBackups().slice(0, 1),
      },
    });
  }),
);

adminRouter.get('/backups', (_req, res) => {
  res.json({ backups: listBackups(), keep: config.backups.keep, hourUtc: config.backups.hourUtc });
});

adminRouter.post(
  '/backups',
  asyncHandler(async (_req, res) => {
    res.status(201).json({ backup: await runBackup('manual') });
  }),
);

adminRouter.get('/backups/:name', (req, res) => {
  const p = backupPath(req.params.name);
  if (!p) throw new HttpError(404, 'Backup not found');
  res.download(p, req.params.name);
});

const settingsSchema = z.object({
  multiProfile: z.boolean().optional(),
  downloadsEnabled: z.boolean().optional(),
  autoApproveDownloads: z.boolean().optional(),
  transcodingEnabled: z.boolean().optional(),
  musicBooksEnabled: z.boolean().optional(),
  liveTvEnabled: z.boolean().optional(),
  assistantEnabled: z.boolean().optional(),
  cacheMb: z.number().int().min(0).max(1024 * 1024).optional(),
  maxProfiles: z.number().int().min(1).max(20).optional(),
});

adminRouter.patch(
  '/accounts/:id',
  asyncHandler(async (req, res) => {
    const target = getAccountById(req.params.id);
    if (!target) throw new HttpError(404, 'Account not found');
    const patch = parse(settingsSchema, req.body);
    res.json({ settings: updateAccountSettings(target.id, patch) });
  }),
);

adminRouter.post(
  '/accounts/:id/cache/flush',
  asyncHandler(async (req, res) => {
    const target = getAccountById(req.params.id);
    if (!target) throw new HttpError(404, 'Account not found');
    res.json({ flushed: flushAccountCache(target.id) });
  }),
);

adminRouter.delete(
  '/accounts/:id',
  asyncHandler(async (req, res) => {
    const target = getAccountById(req.params.id);
    if (!target) throw new HttpError(404, 'Account not found');
    if (target.id === req.account!.id) throw new HttpError(400, 'You cannot delete your own account');
    if (target.is_admin === 1 && countAdmins() <= 1) {
      throw new HttpError(400, 'The last admin account cannot be deleted');
    }
    flushAccountCache(target.id);
    deleteAccount(target.id);
    res.status(204).end();
  }),
);

adminRouter.post(
  '/cache/flush',
  asyncHandler(async (_req, res) => {
    res.json({ flushed: flushAllCache() });
  }),
);
