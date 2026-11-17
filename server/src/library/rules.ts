import { db } from '../db/index.js';
import { newId } from '../lib/crypto.js';
import { HttpError } from '../lib/http.js';
import { bestRelease } from '../plugins/sources.js';
import { DEFAULT_PREFERENCES, migrateTorrentPrefs, type Preferences } from '../services/profiles.js';
import { requestDownload } from './downloads.js';
import { airedEpisodes } from './followed.js';
import { libraryEnabled } from './library.js';

// ---------------------------------------------------------------- quality profiles

export interface QualityProfile {
  id: string;
  name: string;
  isDefault: boolean;
  torrent: Preferences['torrent'];
  anime: Pick<Preferences['anime'], 'audioLanguages' | 'preferEmbeddedSubs'>;
}

interface ProfileRow {
  id: string;
  name: string;
  data: string;
  is_default: number;
}

function rowToProfile(r: ProfileRow): QualityProfile {
  const data = JSON.parse(r.data) as Partial<QualityProfile>;
  return {
    id: r.id,
    name: r.name,
    isDefault: r.is_default === 1,
    torrent: { ...DEFAULT_PREFERENCES.torrent, ...migrateTorrentPrefs(data.torrent as Record<string, unknown> | undefined, true) },
    anime: { audioLanguages: ['ja'], preferEmbeddedSubs: true, ...(data.anime ?? {}) },
  };
}

export function listQualityProfiles(): QualityProfile[] {
  const rows = db.prepare('SELECT * FROM quality_profiles ORDER BY is_default DESC, name').all() as ProfileRow[];
  if (rows.length) return rows.map(rowToProfile);
  // Seed sensible presets on first use.
  const seeds: [string, Partial<Preferences['torrent']>, boolean][] = [
    ['1080p (balanced)', { qualities: ['1080p', '720p'], maxSizeGb: 6 }, true],
    ['4K HDR', { qualities: ['2160p', '1080p'], maxSizeGb: 40, allowHdr: true, formats: ['remux', 'bluray', 'webdl', 'web'] }, false],
    ['Space saver 720p', { qualities: ['720p'], maxSizeGb: 2 }, false],
  ];
  for (const [name, torrent, def] of seeds) {
    db.prepare('INSERT INTO quality_profiles (id, name, data, is_default) VALUES (?, ?, ?, ?)').run(
      newId(),
      name,
      JSON.stringify({ torrent: { ...DEFAULT_PREFERENCES.torrent, ...torrent } }),
      def ? 1 : 0,
    );
  }
  return listQualityProfiles();
}

export function getQualityProfile(id: string | null): QualityProfile {
  const all = listQualityProfiles();
  return all.find((p) => p.id === id) ?? all.find((p) => p.isDefault) ?? all[0]!;
}

export function saveQualityProfile(input: { id?: string; name: string; isDefault?: boolean; torrent?: Partial<Preferences['torrent']>; anime?: QualityProfile['anime'] }): QualityProfile {
  const id = input.id ?? newId();
  const existing = input.id ? (db.prepare('SELECT * FROM quality_profiles WHERE id = ?').get(input.id) as ProfileRow | undefined) : undefined;
  const base = existing ? rowToProfile(existing) : null;
  const data = JSON.stringify({
    torrent: { ...DEFAULT_PREFERENCES.torrent, ...(base?.torrent ?? {}), ...(input.torrent ?? {}) },
    anime: { ...(base?.anime ?? {}), ...(input.anime ?? {}) },
  });
  if (input.isDefault) db.prepare('UPDATE quality_profiles SET is_default = 0').run();
  db.prepare(
    `INSERT INTO quality_profiles (id, name, data, is_default) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data, is_default = MAX(quality_profiles.is_default, excluded.is_default)`,
  ).run(id, input.name, data, input.isDefault ? 1 : 0);
  return rowToProfile(db.prepare('SELECT * FROM quality_profiles WHERE id = ?').get(id) as ProfileRow);
}

export function deleteQualityProfile(id: string): void {
  db.prepare('DELETE FROM quality_profiles WHERE id = ? AND is_default = 0').run(id);
}

function rankPrefs(q: QualityProfile): Pick<Preferences, 'torrent' | 'anime'> {
  return { torrent: q.torrent, anime: { ...DEFAULT_PREFERENCES.anime, ...q.anime } };
}

// ---------------------------------------------------------------- rules

export interface DownloadRule {
  id: string;
  accountId: string;
  mediaId: string;
  title: string;
  poster: string | null;
  qualityProfileId: string | null;
  mode: 'new' | 'missing';
  enabled: boolean;
  lastCheckedAt: string | null;
  createdAt: string;
}

interface RuleRow {
  id: string;
  account_id: string;
  profile_id: string | null;
  media_id: string;
  title: string;
  poster: string | null;
  quality_profile_id: string | null;
  mode: 'new' | 'missing';
  enabled: number;
  last_checked_at: string | null;
  created_at: string;
}

const toRule = (r: RuleRow): DownloadRule => ({
  id: r.id,
  accountId: r.account_id,
  mediaId: r.media_id,
  title: r.title,
  poster: r.poster,
  qualityProfileId: r.quality_profile_id,
  mode: r.mode,
  enabled: r.enabled === 1,
  lastCheckedAt: r.last_checked_at,
  createdAt: r.created_at,
});

export function listRules(accountId?: string): DownloadRule[] {
  const rows = (accountId
    ? db.prepare('SELECT * FROM download_rules WHERE account_id = ? ORDER BY created_at DESC').all(accountId)
    : db.prepare('SELECT * FROM download_rules ORDER BY created_at DESC').all()) as RuleRow[];
  return rows.map(toRule);
}

export function upsertRule(input: {
  accountId: string;
  profileId: string | null;
  mediaId: string;
  title: string;
  poster: string | null;
  qualityProfileId: string | null;
  mode: 'new' | 'missing';
  enabled: boolean;
}): DownloadRule {
  if (!libraryEnabled()) throw new HttpError(503, 'Auto-download needs a library volume');
  if (!/^(tv|anime):/.test(input.mediaId)) throw new HttpError(400, 'Auto-download rules are for series');
  db.prepare(
    `INSERT INTO download_rules (id, account_id, profile_id, media_id, title, poster, quality_profile_id, mode, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, media_id) DO UPDATE SET quality_profile_id = excluded.quality_profile_id,
       mode = excluded.mode, enabled = excluded.enabled, title = excluded.title, poster = excluded.poster`,
  ).run(newId(), input.accountId, input.profileId, input.mediaId, input.title, input.poster, input.qualityProfileId, input.mode, input.enabled ? 1 : 0);
  return toRule(db.prepare('SELECT * FROM download_rules WHERE account_id = ? AND media_id = ?').get(input.accountId, input.mediaId) as RuleRow);
}

export function deleteRule(id: string, accountId: string, isAdmin: boolean): void {
  const info = isAdmin
    ? db.prepare('DELETE FROM download_rules WHERE id = ?').run(id)
    : db.prepare('DELETE FROM download_rules WHERE id = ? AND account_id = ?').run(id, accountId);
  if (!info.changes) throw new HttpError(404, 'Rule not found');
}

/** Searches + queues episodes that a rule wants and nobody has fetched yet. */
export async function runRule(rule: DownloadRule, maxPerRun = 4): Promise<number> {
  const aired = await airedEpisodes(rule.mediaId);
  const since = rule.mode === 'new' ? rule.createdAt.slice(0, 10) : '';
  const have = new Set(
    (db
      .prepare(
        `SELECT season, episode FROM library_files f JOIN library_items i ON i.id = f.item_id WHERE i.media_id = ?
         UNION SELECT season, episode FROM downloads WHERE media_id = ? AND status IN ('pending','queued','downloading','completed')`,
      )
      .all(rule.mediaId, rule.mediaId) as { season: number | null; episode: number | null }[]).map((r) => `${r.season ?? 1}:${r.episode}`),
  );
  const isAnime = rule.mediaId.startsWith('anime:');
  // Anime has no reliable air dates per episode: "new" = only the latest aired one.
  const wanted = aired
    .filter((e) => !have.has(`${e.season}:${e.episode}`))
    .filter((e) => (rule.mode === 'missing' ? true : isAnime ? e.episode === aired[aired.length - 1]?.episode : (e.airDate ?? '') >= since))
    .slice(-maxPerRun);
  const quality = getQualityProfile(rule.qualityProfileId);
  let queued = 0;
  for (const e of wanted) {
    const best = await bestRelease({ mediaId: rule.mediaId, season: isAnime ? null : e.season, episode: e.episode }, rankPrefs(quality));
    if (!best) continue;
    const profileRow = db.prepare('SELECT profile_id FROM download_rules WHERE id = ?').get(rule.id) as { profile_id: string | null };
    requestDownload({
      accountId: rule.accountId,
      profileId: profileRow.profile_id,
      release: best.release,
      context: best.context,
      itemKey: isAnime ? `${rule.mediaId}:e${e.episode}` : `${rule.mediaId}:s${e.season}e${e.episode}`,
      poster: rule.poster,
      ruleId: rule.id,
    });
    queued++;
  }
  db.prepare("UPDATE download_rules SET last_checked_at = datetime('now') WHERE id = ?").run(rule.id);
  return queued;
}

export async function runAllRules(): Promise<void> {
  if (!libraryEnabled()) return;
  for (const rule of listRules().filter((r) => r.enabled)) {
    try {
      await runRule(rule);
    } catch (err) {
      console.error(`[rules] ${rule.title}:`, (err as Error).message);
    }
  }
}
