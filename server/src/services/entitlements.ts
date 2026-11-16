import { db } from '../db/index.js';
import { config } from '../config.js';

/**
 * Per-account entitlements. Everything a new (invited) account gets is
 * deliberately conservative: one profile, no offline downloads, no transcoding.
 * The admin dashboard opens these up per account.
 */
export interface AccountSettings {
  multiProfile: boolean;
  /** Offline copies on the device and server download requests. */
  downloadsEnabled: boolean;
  /** Server downloads skip the admin approval queue. */
  autoApproveDownloads: boolean;
  transcodingEnabled: boolean;
  /** Access to the music and e-book sections. Off until an admin grants it. */
  musicBooksEnabled: boolean;
  liveTvEnabled: boolean;
  assistantEnabled: boolean;
  cacheMb: number;
  maxProfiles: number;
}

interface SettingsRow {
  account_id: string;
  multi_profile: number;
  downloads_enabled: number;
  auto_approve_downloads: number;
  transcoding_enabled: number;
  music_books_enabled: number;
  live_tv_enabled: number;
  assistant_enabled: number;
  cache_mb: number;
  max_profiles: number;
}

const DEFAULTS: AccountSettings = {
  multiProfile: false,
  downloadsEnabled: false,
  autoApproveDownloads: false,
  transcodingEnabled: false,
  musicBooksEnabled: false,
  liveTvEnabled: true,
  assistantEnabled: true,
  cacheMb: config.cache.defaultAccountMb,
  maxProfiles: 1,
};

const ADMIN_DEFAULTS: AccountSettings = {
  multiProfile: true,
  downloadsEnabled: true,
  autoApproveDownloads: true,
  transcodingEnabled: true,
  musicBooksEnabled: false,
  liveTvEnabled: true,
  assistantEnabled: true,
  cacheMb: config.cache.defaultAccountMb * 2,
  maxProfiles: config.maxProfiles,
};

function toDTO(row: SettingsRow): AccountSettings {
  return {
    multiProfile: row.multi_profile === 1,
    downloadsEnabled: row.downloads_enabled === 1,
    autoApproveDownloads: row.auto_approve_downloads === 1,
    transcodingEnabled: row.transcoding_enabled === 1,
    musicBooksEnabled: row.music_books_enabled === 1,
    liveTvEnabled: row.live_tv_enabled === 1,
    assistantEnabled: row.assistant_enabled === 1,
    cacheMb: row.cache_mb,
    maxProfiles: row.max_profiles,
  };
}

const bit = (v: boolean) => (v ? 1 : 0);

/** Reads an account's entitlements, seeding the row on first access. */
export function getAccountSettings(accountId: string, isAdmin = false): AccountSettings {
  const row = db.prepare('SELECT * FROM account_settings WHERE account_id = ?').get(accountId) as
    | SettingsRow
    | undefined;
  if (row) return toDTO(row);
  const seed = isAdmin ? ADMIN_DEFAULTS : DEFAULTS;
  db.prepare(
    `INSERT INTO account_settings
       (account_id, multi_profile, downloads_enabled, auto_approve_downloads, transcoding_enabled,
        music_books_enabled, live_tv_enabled, assistant_enabled, cache_mb, max_profiles)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO NOTHING`,
  ).run(
    accountId,
    bit(seed.multiProfile),
    bit(seed.downloadsEnabled),
    bit(seed.autoApproveDownloads),
    bit(seed.transcodingEnabled),
    bit(seed.musicBooksEnabled),
    bit(seed.liveTvEnabled),
    bit(seed.assistantEnabled),
    seed.cacheMb,
    seed.maxProfiles,
  );
  return seed;
}

export function updateAccountSettings(
  accountId: string,
  patch: Partial<AccountSettings>,
): AccountSettings {
  const current = getAccountSettings(accountId);
  const next: AccountSettings = {
    multiProfile: patch.multiProfile ?? current.multiProfile,
    downloadsEnabled: patch.downloadsEnabled ?? current.downloadsEnabled,
    autoApproveDownloads: patch.autoApproveDownloads ?? current.autoApproveDownloads,
    transcodingEnabled: patch.transcodingEnabled ?? current.transcodingEnabled,
    musicBooksEnabled: patch.musicBooksEnabled ?? current.musicBooksEnabled,
    liveTvEnabled: patch.liveTvEnabled ?? current.liveTvEnabled,
    assistantEnabled: patch.assistantEnabled ?? current.assistantEnabled,
    // Clamp the cache allowance to what the node can actually hold.
    cacheMb: Math.max(
      config.cache.minAccountMb,
      Math.min(config.cache.totalMb, Math.round(patch.cacheMb ?? current.cacheMb)),
    ),
    maxProfiles: Math.max(1, Math.min(config.maxProfiles, Math.round(patch.maxProfiles ?? current.maxProfiles))),
  };
  // A single-profile account can never have a >1 allowance, and vice versa.
  if (!next.multiProfile) next.maxProfiles = 1;
  else if (next.maxProfiles < 2) next.maxProfiles = Math.min(config.maxProfiles, 2);

  db.prepare(
    `UPDATE account_settings
        SET multi_profile = ?, downloads_enabled = ?, auto_approve_downloads = ?, transcoding_enabled = ?,
            music_books_enabled = ?, live_tv_enabled = ?, assistant_enabled = ?, cache_mb = ?,
            max_profiles = ?, updated_at = datetime('now')
      WHERE account_id = ?`,
  ).run(
    bit(next.multiProfile),
    bit(next.downloadsEnabled),
    bit(next.autoApproveDownloads),
    bit(next.transcodingEnabled),
    bit(next.musicBooksEnabled),
    bit(next.liveTvEnabled),
    bit(next.assistantEnabled),
    next.cacheMb,
    next.maxProfiles,
    accountId,
  );
  return next;
}
