import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new Database(path.join(config.dataDir, 'stream.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

interface Migration {
  version: number;
  up: (d: Database.Database) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    up: (d) => {
      d.exec(`
        CREATE TABLE accounts (
          id            TEXT PRIMARY KEY,
          username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
          password_hash TEXT NOT NULL,
          is_admin      INTEGER NOT NULL DEFAULT 0,
          invite_id     TEXT,
          created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE invite_keys (
          id         TEXT PRIMARY KEY,
          code       TEXT NOT NULL UNIQUE,
          note       TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          used_by    TEXT,
          used_at    TEXT,
          revoked    INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE profiles (
          id         TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          name       TEXT NOT NULL,
          avatar     TEXT NOT NULL DEFAULT 'red',
          is_kids    INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_profiles_account ON profiles(account_id);

        CREATE TABLE preferences (
          profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
          data       TEXT NOT NULL DEFAULT '{}',
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE watch_progress (
          profile_id       TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          item_key         TEXT NOT NULL,
          media_type       TEXT NOT NULL,
          media_id         TEXT NOT NULL,
          season           INTEGER,
          episode          INTEGER,
          position_seconds REAL NOT NULL DEFAULT 0,
          duration_seconds REAL,
          finished         INTEGER NOT NULL DEFAULT 0,
          title            TEXT,
          updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (profile_id, item_key)
        );
        CREATE INDEX idx_progress_profile ON watch_progress(profile_id, updated_at DESC);

        CREATE TABLE my_list (
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          media_type TEXT NOT NULL,
          media_id   TEXT NOT NULL,
          added_at   TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (profile_id, media_type, media_id)
        );
      `);
    },
  },
  {
    // Cache poster/title on progress + list rows so cards render without a
    // round-trip to the metadata providers.
    version: 2,
    up: (d) => {
      d.exec(`
        ALTER TABLE watch_progress ADD COLUMN poster TEXT;
        ALTER TABLE watch_progress ADD COLUMN backdrop TEXT;
        ALTER TABLE my_list ADD COLUMN title TEXT;
        ALTER TABLE my_list ADD COLUMN poster TEXT;
        ALTER TABLE my_list ADD COLUMN year INTEGER;
      `);
    },
  },
  {
    // Remember the source (for Resume) and year (for card metadata) per item.
    version: 3,
    up: (d) => {
      d.exec(`
        ALTER TABLE watch_progress ADD COLUMN source_link TEXT;
        ALTER TABLE watch_progress ADD COLUMN year INTEGER;
      `);
    },
  },
  {
    // Per-account entitlements (what an account is allowed to do + how much
    // scratch cache it may hold) and the cache ledger that tracks which torrent
    // is cached for whom, so the admin dashboard can report and flush it.
    version: 4,
    up: (d) => {
      d.exec(`
        CREATE TABLE account_settings (
          account_id          TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
          multi_profile       INTEGER NOT NULL DEFAULT 0,
          downloads_enabled   INTEGER NOT NULL DEFAULT 0,
          transcoding_enabled INTEGER NOT NULL DEFAULT 0,
          cache_mb            INTEGER NOT NULL DEFAULT 4096,
          max_profiles        INTEGER NOT NULL DEFAULT 1,
          updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE cache_entries (
          info_hash   TEXT PRIMARY KEY,
          account_id  TEXT REFERENCES accounts(id) ON DELETE CASCADE,
          item_key    TEXT,
          title       TEXT,
          file_index  INTEGER NOT NULL DEFAULT 0,
          file_name   TEXT,
          size_bytes  INTEGER NOT NULL DEFAULT 0,
          bytes_on_disk INTEGER NOT NULL DEFAULT 0,
          source_link TEXT,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          last_access TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_cache_account ON cache_entries(account_id, last_access DESC);

        -- Existing accounts keep the previous behaviour (admins fully enabled);
        -- their current profile count is grandfathered so nobody loses access.
        INSERT INTO account_settings (account_id, multi_profile, downloads_enabled, transcoding_enabled, cache_mb, max_profiles)
        SELECT a.id,
               CASE WHEN a.is_admin = 1 OR p.n > 1 THEN 1 ELSE 0 END,
               CASE WHEN a.is_admin = 1 THEN 1 ELSE 0 END,
               CASE WHEN a.is_admin = 1 THEN 1 ELSE 0 END,
               CASE WHEN a.is_admin = 1 THEN 8192 ELSE 4096 END,
               CASE WHEN a.is_admin = 1 THEN 5 ELSE MAX(1, p.n) END
        FROM accounts a
        LEFT JOIN (SELECT account_id, COUNT(*) AS n FROM profiles GROUP BY account_id) p
          ON p.account_id = a.id;
      `);
    },
  },
  {
    // Music and e-books are opt-in per account. Nobody gets them automatically,
    // including existing accounts and admins — an admin grants access per user.
    version: 5,
    up: (d) => {
      d.exec(`
        ALTER TABLE account_settings ADD COLUMN music_books_enabled INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
  {
    // Nova 2: plugins, server library + downloads, collections, live TV,
    // reading, sharing, watch rooms, the assistant and notifications.
    version: 6,
    up: (d) => {
      d.exec(`
        CREATE TABLE plugins (
          id             TEXT PRIMARY KEY,
          kind           TEXT NOT NULL,
          source_url     TEXT,
          manifest       TEXT NOT NULL,
          version        TEXT NOT NULL,
          enabled        INTEGER NOT NULL DEFAULT 1,
          status         TEXT NOT NULL DEFAULT 'pending',
          granted        TEXT NOT NULL DEFAULT '{}',
          config         TEXT NOT NULL DEFAULT '{}',
          bundle_sha256  TEXT,
          priority       INTEGER NOT NULL DEFAULT 100,
          pending_update TEXT,
          installed_by   TEXT,
          installed_at   TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE plugin_kv (
          plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
          key       TEXT NOT NULL,
          value     TEXT NOT NULL,
          PRIMARY KEY (plugin_id, key)
        );

        CREATE TABLE plugin_user_grants (
          plugin_id  TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          scopes     TEXT NOT NULL DEFAULT '[]',
          granted_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (plugin_id, account_id)
        );

        CREATE TABLE api_tokens (
          id           TEXT PRIMARY KEY,
          account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          name         TEXT NOT NULL,
          token_hash   TEXT NOT NULL UNIQUE,
          scopes       TEXT NOT NULL DEFAULT '[]',
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          last_used_at TEXT
        );

        CREATE TABLE collections (
          id          TEXT PRIMARY KEY,
          profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          name        TEXT NOT NULL,
          description TEXT,
          pinned      INTEGER NOT NULL DEFAULT 0,
          sort_order  INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_collections_profile ON collections(profile_id, sort_order);

        CREATE TABLE collection_items (
          collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
          media_id      TEXT NOT NULL,
          media_type    TEXT NOT NULL,
          title         TEXT,
          poster        TEXT,
          year          INTEGER,
          position      INTEGER NOT NULL DEFAULT 0,
          added_at      TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (collection_id, media_id)
        );

        CREATE TABLE private_titles (
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          media_id   TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (account_id, media_id)
        );

        CREATE TABLE library_items (
          id                 TEXT PRIMARY KEY,
          media_id           TEXT,
          kind               TEXT NOT NULL,
          title              TEXT NOT NULL,
          year               INTEGER,
          poster             TEXT,
          backdrop           TEXT,
          overview           TEXT,
          metadata           TEXT NOT NULL DEFAULT '{}',
          overrides          TEXT NOT NULL DEFAULT '{}',
          match_status       TEXT NOT NULL DEFAULT 'matched',
          match_confidence   REAL,
          match_candidates   TEXT,
          folder             TEXT,
          private_account_id TEXT,
          added_by           TEXT,
          added_at           TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_library_media ON library_items(media_id);
        CREATE INDEX idx_library_status ON library_items(match_status);

        CREATE TABLE library_files (
          id       TEXT PRIMARY KEY,
          item_id  TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
          path     TEXT NOT NULL UNIQUE,
          size     INTEGER NOT NULL DEFAULT 0,
          season   INTEGER,
          episode  INTEGER,
          kind     TEXT NOT NULL,
          mime     TEXT,
          added_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_library_files_item ON library_files(item_id, season, episode);

        CREATE TABLE quality_profiles (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL,
          data       TEXT NOT NULL,
          is_default INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE download_rules (
          id                 TEXT PRIMARY KEY,
          account_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          profile_id         TEXT REFERENCES profiles(id) ON DELETE SET NULL,
          media_id           TEXT NOT NULL,
          title              TEXT NOT NULL,
          poster             TEXT,
          quality_profile_id TEXT REFERENCES quality_profiles(id) ON DELETE SET NULL,
          mode               TEXT NOT NULL DEFAULT 'new',
          enabled            INTEGER NOT NULL DEFAULT 1,
          last_checked_at    TEXT,
          created_at         TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (account_id, media_id)
        );

        CREATE TABLE downloads (
          id              TEXT PRIMARY KEY,
          account_id      TEXT REFERENCES accounts(id) ON DELETE SET NULL,
          profile_id      TEXT,
          media_id        TEXT,
          item_key        TEXT,
          kind            TEXT NOT NULL DEFAULT 'video',
          title           TEXT NOT NULL,
          poster          TEXT,
          season          INTEGER,
          episode         INTEGER,
          release         TEXT NOT NULL,
          status          TEXT NOT NULL,
          progress        REAL NOT NULL DEFAULT 0,
          bytes_done      INTEGER NOT NULL DEFAULT 0,
          bytes_total     INTEGER NOT NULL DEFAULT 0,
          speed           INTEGER NOT NULL DEFAULT 0,
          error           TEXT,
          info_hash       TEXT,
          library_item_id TEXT,
          rule_id         TEXT,
          approved_by     TEXT,
          created_at      TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at    TEXT
        );
        CREATE INDEX idx_downloads_status ON downloads(status, created_at);

        CREATE TABLE live_sources (
          id                TEXT PRIMARY KEY,
          kind              TEXT NOT NULL,
          name              TEXT NOT NULL,
          config            TEXT NOT NULL DEFAULT '{}',
          epg_url           TEXT,
          enabled           INTEGER NOT NULL DEFAULT 1,
          channel_count     INTEGER NOT NULL DEFAULT 0,
          last_refreshed_at TEXT,
          error             TEXT,
          created_at        TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE live_channels (
          id        TEXT PRIMARY KEY,
          source_id TEXT NOT NULL REFERENCES live_sources(id) ON DELETE CASCADE,
          name      TEXT NOT NULL,
          number    TEXT,
          logo      TEXT,
          grp       TEXT,
          url       TEXT NOT NULL,
          epg_id    TEXT,
          catchup   TEXT,
          country   TEXT,
          languages TEXT,
          hidden    INTEGER NOT NULL DEFAULT 0,
          sort      INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_live_channels_source ON live_channels(source_id, sort);

        CREATE TABLE epg_programmes (
          epg_id      TEXT NOT NULL,
          start       INTEGER NOT NULL,
          stop        INTEGER NOT NULL,
          title       TEXT NOT NULL,
          subtitle    TEXT,
          description TEXT,
          category    TEXT,
          image       TEXT,
          PRIMARY KEY (epg_id, start)
        );
        CREATE INDEX idx_epg_time ON epg_programmes(start, stop);

        CREATE TABLE live_favorites (
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          channel_id TEXT NOT NULL,
          PRIMARY KEY (profile_id, channel_id)
        );

        CREATE TABLE reading_progress (
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          item_key   TEXT NOT NULL,
          kind       TEXT NOT NULL,
          title      TEXT,
          cover      TEXT,
          author     TEXT,
          locator    TEXT,
          percent    REAL NOT NULL DEFAULT 0,
          source     TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (profile_id, item_key)
        );

        CREATE TABLE annotations (
          id         TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          item_key   TEXT NOT NULL,
          kind       TEXT NOT NULL,
          locator    TEXT NOT NULL,
          text       TEXT,
          note       TEXT,
          color      TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_annotations_item ON annotations(profile_id, item_key);

        CREATE TABLE shares (
          id           TEXT PRIMARY KEY,
          token_hash   TEXT NOT NULL UNIQUE,
          account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          scope        TEXT NOT NULL,
          target       TEXT NOT NULL,
          label        TEXT,
          expires_at   TEXT,
          revoked      INTEGER NOT NULL DEFAULT 0,
          uses         INTEGER NOT NULL DEFAULT 0,
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          last_used_at TEXT
        );

        CREATE TABLE assistant_providers (
          id          TEXT PRIMARY KEY,
          kind        TEXT NOT NULL,
          name        TEXT NOT NULL,
          base_url    TEXT,
          api_key_enc TEXT,
          model       TEXT NOT NULL,
          enabled     INTEGER NOT NULL DEFAULT 1,
          account_id  TEXT REFERENCES accounts(id) ON DELETE CASCADE,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE assistant_threads (
          id         TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          title      TEXT,
          context    TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE assistant_messages (
          id         TEXT PRIMARY KEY,
          thread_id  TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
          role       TEXT NOT NULL,
          content    TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_assistant_messages ON assistant_messages(thread_id, created_at);

        CREATE TABLE assistant_receipts (
          id         TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          thread_id  TEXT,
          summary    TEXT NOT NULL,
          plan       TEXT,
          undo       TEXT,
          status     TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE notifications (
          id         TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          kind       TEXT NOT NULL,
          title      TEXT NOT NULL,
          body       TEXT,
          link       TEXT,
          read       INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_notifications ON notifications(account_id, read, created_at DESC);

        ALTER TABLE account_settings ADD COLUMN auto_approve_downloads INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE account_settings ADD COLUMN assistant_enabled INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE account_settings ADD COLUMN live_tv_enabled INTEGER NOT NULL DEFAULT 1;
        UPDATE account_settings SET auto_approve_downloads = 1
          WHERE account_id IN (SELECT id FROM accounts WHERE is_admin = 1);
      `);
    },
  },
  {
    // Server-wide settings an admin can change at runtime (API keys for metadata/subtitles).
    version: 7,
    up: (db) => {
      db.exec(`
        CREATE TABLE server_settings (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    // Up next cards a profile removed (one episode each; the following episode shows up again).
    version: 8,
    up: (db) => {
      db.exec(`
        CREATE TABLE upnext_dismissed (
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          item_key   TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (profile_id, item_key)
        );
      `);
    },
  },
  {
    // Extra folders of books, comics and manga that Nova reads from (and never writes to).
    version: 9,
    up: (db) => {
      db.exec(`
        CREATE TABLE library_sources (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL,
          path       TEXT NOT NULL UNIQUE,
          kind       TEXT NOT NULL CHECK (kind IN ('book', 'comic', 'manga')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    // AniList / MyAnimeList accounts a profile tracks its anime with (tokens sealed).
    version: 10,
    up: (db) => {
      db.exec(`
        CREATE TABLE tracker_accounts (
          profile_id    TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          service       TEXT NOT NULL CHECK (service IN ('anilist', 'mal')),
          token         TEXT NOT NULL,
          refresh_token TEXT,
          expires_at    INTEGER,
          user_id       TEXT,
          user_name     TEXT,
          avatar        TEXT,
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (profile_id, service)
        );
      `);
    },
  },
];

function migrate(): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (const m of migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version)) {
    const run = db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    });
    run();
  }
}

migrate();
