import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

const NODE_ENV = env('NODE_ENV', 'development');
const isProd = NODE_ENV === 'production';
const DATA_DIR = env('DATA_DIR', path.resolve(process.cwd(), 'data'));

/** SESSION_SECRET if given, else one generated on first boot and kept in DATA_DIR. */
function requiredSecret(name: string): string {
  const v = process.env[name];
  if (v && v.length >= 16) return v;
  if (!isProd) return crypto.randomBytes(32).toString('hex');
  const file = path.join(DATA_DIR, 'secret.key');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved.length >= 32) return saved;
  } catch {
    /* first boot */
  }
  const fresh = crypto.randomBytes(48).toString('hex');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, fresh, { mode: 0o600 });
  return fresh;
}

export const COOKIE_NAME = 'stream_session';

/**
 * server  - a shared, multi-user install (Docker / bare metal) with invite-key accounts.
 * desktop - the Windows app: one local owner, no sign-in screen, bound to loopback.
 */
const MODE = env('NOVA_MODE', 'server') === 'desktop' ? 'desktop' : 'server';

export const config = {
  nodeEnv: NODE_ENV,
  isProd,
  mode: MODE as 'server' | 'desktop',
  port: Number(env('PORT', '3000')),
  host: env('HOST', MODE === 'desktop' ? '127.0.0.1' : '0.0.0.0'),
  dataDir: DATA_DIR,
  // Scratch space for in-progress torrent pieces; safe to wipe at any time.
  torrentDir: env('TORRENT_DIR', path.join(os.tmpdir(), 'nova-torrents')),
  /**
   * Where torrents are downloaded and streamed from:
   * server - this server streams torrents to every client (default).
   * client - this server never touches torrents; each viewer's own device does
   *          (the Nova desktop app, or in-browser WebTorrent as a fallback).
   */
  torrentMode: (env('TORRENT_MODE', 'server') === 'client' ? 'client' : 'server') as 'server' | 'client',
  // Port the Nova desktop app's local engine listens on (web clients look for it here).
  enginePort: Number(env('ENGINE_PORT', '11471')),
  // Where client-mode users are sent to get the desktop app.
  desktopDownloadUrl: env('DESKTOP_DOWNLOAD_URL', 'https://github.com/FMLGamer/nova/releases/latest'),
  webDir: env('WEB_DIR', path.resolve(process.cwd(), '..', 'dist')),
  // Leave empty to use the address each request came in on.
  publicUrl: env('PUBLIC_URL', ''),
  sessionSecret: requiredSecret('SESSION_SECRET'),
  // 'true' / 'false', or unset to follow the request (Secure behind HTTPS, plain on http://LAN).
  cookieSecure: env('COOKIE_SECURE', '') === '' ? null : env('COOKIE_SECURE') === 'true',
  sessionTtlSeconds: Number(env('SESSION_TTL_SECONDS', String(60 * 60 * 24 * 30))),
  // Session length when the user did NOT tick "remember me": the cookie is a
  // browser-session cookie and the token itself expires the same day.
  shortSessionTtlSeconds: Number(env('SHORT_SESSION_TTL_SECONDS', String(60 * 60 * 12))),
  maxProfiles: Number(env('MAX_PROFILES', '5')),
  // Uplink protection: we never seed (zero unchoke slots), and this caps any
  // remaining outgoing bytes. It must stay well above protocol overhead
  // (handshakes + piece requests share this pipe) or downloads would stall.
  // Negative = no cap.
  uploadLimitBps: Number(env('UPLOAD_LIMIT_BPS', String(256 * 1024))),
  // --- Torrent scratch cache budget (lives in TORRENT_DIR) ---
  cache: {
    totalMb: Number(env('CACHE_TOTAL_MB', '10240')), // hard ceiling across all accounts
    defaultAccountMb: Number(env('CACHE_ACCOUNT_MB', '4096')), // per-account default
    minAccountMb: Number(env('CACHE_MIN_ACCOUNT_MB', '512')),
    // How long a finished item stays cached so "pause for an hour, then resume"
    // still plays from disk instead of re-downloading.
    ttlMinutes: Number(env('CACHE_TTL_MINUTES', '240')),
    // Items kept per account beyond the one being watched right now.
    keepPerAccount: Number(env('CACHE_KEEP_PER_ACCOUNT', '2')),
  },
  // Full software transcodes are CPU-bound; raise this on a big machine.
  maxTranscodes: Number(env('MAX_TRANSCODES', '1')),
  ffmpegPath: env('FFMPEG_PATH', 'ffmpeg'),
  ffprobePath: env('FFPROBE_PATH', 'ffprobe'),
  admin: {
    username: env('ADMIN_USERNAME', 'admin'),
    password: env('ADMIN_PASSWORD', ''),
  },
  // --- Metadata + subtitles ---
  tmdbApiKey: env('TMDB_API_KEY', ''),
  openSubtitles: {
    apiKey: env('OPENSUBTITLES_API_KEY', ''),
    username: env('OPENSUBTITLES_USERNAME', ''),
    password: env('OPENSUBTITLES_PASSWORD', ''),
  },
  // --- Plugins (sources, metadata, live TV, ...) ---
  plugins: {
    dir: env('PLUGIN_DIR', path.join(DATA_DIR, 'plugins')),
    // Manifest URLs installed + approved on boot (declared by the operator, so trusted).
    autoInstall: env('PLUGINS_AUTOINSTALL', '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    registries: env(
      'PLUGIN_REGISTRIES',
      'https://raw.githubusercontent.com/FMLGamer/nova-plugins/main/registry.json',
    )
      .split(/[\s,]+/)
      .filter(Boolean),
    callTimeoutMs: Number(env('PLUGIN_CALL_TIMEOUT_MS', '60000')),
    memoryMb: Number(env('PLUGIN_MEMORY_MB', '192')),
  },
  // --- Server library (persistent downloads); disabled when unset ---
  library: {
    dir: env('LIBRARY_DIR', ''),
    maxGb: Number(env('LIBRARY_MAX_GB', '0')), // 0 = only the volume's free space limits it
    scanIntervalMinutes: Number(env('LIBRARY_SCAN_MINUTES', '360')),
    maxConcurrentDownloads: Number(env('MAX_CONCURRENT_DOWNLOADS', '2')),
  },
  // ffmpeg hardware acceleration: '' (software) | 'vaapi'
  hwAccel: env('HW_ACCEL', ''),
  vaapiDevice: env('VAAPI_DEVICE', '/dev/dri/renderD128'),
  // --- Assistant: a local model offered out of the box when set ---
  ollamaUrl: env('OLLAMA_URL', ''),
  ollamaModel: env('OLLAMA_MODEL', ''),
  // --- Backups ---
  backups: {
    dir: env('BACKUP_DIR', path.join(DATA_DIR, 'backups')),
    keep: Number(env('BACKUP_KEEP', '7')),
    hourUtc: Number(env('BACKUP_HOUR_UTC', '3')),
  },
  deeplApiKey: env('DEEPL_API_KEY', ''),
  // Dev only: auto-login as the admin so the UI can be exercised without a password.
  devAuth: !isProd && env('DEV_AUTH', '') === '1',
} as const;

export type Config = typeof config;
