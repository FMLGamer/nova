# Nova: guide for AI agents and contributors

Nova is a self-hosted media app with three parts:

- **Frontend:** a React PWA in `src/`.
- **Server:** Express + SQLite in `server/`.
- **Desktop app:** a Windows Electron shell in `desktop/` that runs that same server locally.

## Architecture

- **Single port:** the server handles everything on one port: JSON API, `/stream/*` media, `/live/*`, the room WebSocket
  (`/ws/rooms/:code`) and the built SPA (`WEB_DIR`). In dev, Vite on :5173 proxies these.
- **Modes** (`server/src/config.ts`):
  - `NOVA_MODE=server` (default): multi-user with invite-key accounts.
  - `NOVA_MODE=desktop`: one owner, loopback only, and a Host-header guard. The Electron shell gets the owner's session
    from `POST /api/desktop/session` using its per-launch key.
  - `TORRENT_MODE=client`: the server never creates a WebTorrent client. `/api/play/prepare` returns `kind: 'c'` with the
    magnet. The browser then hands it to the user's Nova desktop app (paired via `/api/engine/pair` and used through
    `/engine/<token>/...`), or falls back to in-browser WebTorrent.
- **Auth:**
  - The session JWT lives in the `stream_session` cookie. API tokens are `nova_*`. Share guests get the `nova_guest`
    cookie.
  - The profile is selected per request with `X-Profile-Id`, or `?profile=` for EventSource and WebSocket.
- **Data:**
  - SQLite at `DATA_DIR/stream.db`, with forward-only migrations in `server/src/db/index.ts` (`PRAGMA user_version`).
  - Plugins live in `DATA_DIR/plugins` and backups in `DATA_DIR/backups`.
  - Runtime API keys are stored sealed in `server_settings` (`services/integrations.ts`). Environment variables take
    priority.
- **Sources are plugins:**
  - Stremio add-ons run remotely over HTTP. Nova plugins are bundles that run in a sandboxed worker with Node
    `--permission`, and the worker needs the **compiled** `dist/plugins/runtime/child.js`.
  - `plugins/sources.ts` aggregates and ranks releases (`core/ranking.ts`) and streams them over SSE.
  - Ranking: torrent preferences are *requirements* (allowed qualities/codecs/audio/formats, HDR, size, seeders). Score
    is correctness only (title/year, episode, language, debrid-cached); then seeders. Misfits get `tier: 1` and a
    `misses` list. Old ranked keys are migrated by `migrateTorrentPrefs`.
- **Streaming:**
  - Paths are `/stream/{t/<hash>/<idx>|l/<fileId>|u/<token>}`, plus `/audio` (AAC remux), `/transcode`,
    `/subs/:track` (Matroska subtitles as NDJSON, from `?from=`), `/subs/:track/vtt` and `/font/:index`.
  - Piped variants can't seek; the player reloads them with `start=` and keeps an offset.
  - The `/audio` remux copies video, so a start between keyframes needs `delay_moov` (the moov then carries the edit
    list that keeps picture and sound together). Don't drop it.
  - WebTorrent never seeds (`uploads: 0`) and is imported lazily (it is the slowest module to load at startup).
- **Library:** `LIBRARY_DIR` (downloads) plus "reading folders" (`library_sources`): read-only folders of books, comics
  and manga whose files are stored as `@<source id>/<path>`; resolve paths with `libraryFilePath()`.
- **Anime tracking** (`services/trackers.ts`): per-profile AniList (pasted token) and MyAnimeList (OAuth + PKCE, signed
  `state`) accounts; finished anime episodes are pushed from the progress route. App credentials are integrations.
- **Matroska:**
  - `server/src/media/matroska.ts` reads tracks, chapters and attachments from the header. It pulls subtitle blocks from
    the clusters near a time, using Cues.
  - `services/embeddedSubs.ts` caches blocks per track along with the byte ranges already covered.
  - ASS tracks render client-side with JASSUB (`src/components/player/ass.ts`). Its canvas must not be
    `desynchronized` (Vite plugin `jassubSynchronized` patches that) and the `<video>` ref callback must stay stable,
    or the renderer is torn down every render.
- **Metadata:** TMDB when a key is set, otherwise Cinemeta (`services/cinemeta.ts`, ids `movie:tt…`/`tv:tt…`;
  `services/tmdb.ts` delegates). Anime: AniList + ani.zip (`services/anizip.ts`) for episodes and cross-ids.
- **Casting** (`server/src/cast/`): mDNS/SSDP discovery, a minimal Cast v2 sender and a DLNA SOAP client. Streams are
  HLS from ffmpeg (`-copyts`, TS offset 10s) with a WebVTT rendition; ASS is burned in with the `ass` filter, in chunks
  that follow the subtitle reader on torrents. TVs fetch `/cast/<token>/…` (capability URLs, CORS `*`); the Windows
  app serves those on a separate LAN port.

## Conventions

- Backend is ESM + NodeNext: relative imports end in `.js`.
- Frontend has `verbatimModuleSyntax` on: type-only imports use `import type`.
- Tailwind v4: tokens live in `@theme` in `src/index.css`. Never build class names dynamically.
- Preferences have one source of truth: `DEFAULT_PREFERENCES` in `server/src/services/profiles.ts`, deep-merged. Mirror
  any shape change in `src/lib/types.ts`.
- Hooks stay above every early `return`.
- Run both builds before calling a change done: `npm run build` and `npm --prefix server run build`.

## Release

- Pushing to `main` builds `ghcr.io/<owner>/nova:latest` (target `server`) and `:client` (target `client`).
- Tagging `v*` also builds the Windows installer and portable exe and attaches them to the GitHub release.
