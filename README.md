# Nova

A self-hosted home for everything you watch, read and listen to. Nova does these things:

- Streams movies, shows and anime from torrents, debrid services or files on your own disk.
- Reads comics, manga, EPUB and PDF.
- Plays live TV.
- Lets friends watch together in synced rooms.

Nova ships no content sources of its own. Everything that finds or fetches media is a **plugin**:

- **Stremio add-ons** such as Torrentio install straight from their manifest URL.
- **Nova plugins** cover Prowlarr, MangaDex, Jellyfin import and more. They come from
  [nova-plugins](https://github.com/FMLGamer/nova-plugins) or any registry you add.

## Ways to run it

| | What it is | Who streams torrents |
|---|---|---|
| **Nova desktop app** | For Windows, macOS and Linux: installer, `.zip`/`.tar.gz`, portable `.exe` or AppImage. Everything runs on your computer, with no account or setup. | Your computer |
| **Docker: `nova:latest`** | Multi-user server with invite-only accounts. | The server |
| **Docker: `nova:client`** | Same server, but it never joins a torrent swarm. | Each viewer's device, through the desktop app or the browser |
| **Nova for Android** | The app for phones and tablets: it opens your Nova server (any of the above), or runs Nova on the phone itself. | That server, or the phone |

### Nova desktop app

1. From [Releases](https://github.com/FMLGamer/nova/releases), download one of:
   - **Windows**
     - `Nova-Setup-x.y.z.exe`: the installer. It updates itself.
     - `Nova-x.y.z-win.zip`: unzip anywhere and run `Nova.exe`.
     - `Nova-Portable-x.y.z.exe`: a single file, but it unpacks itself on every start, so it opens slower than the other two.
   - **macOS** (Apple silicon): `Nova-x.y.z-mac-arm64.dmg` or `.zip`. The app isn't notarized by Apple. On first start,
     allow it under **System Settings → Privacy & Security → Open Anyway**, or run `xattr -cr /Applications/Nova.app`.
   - **Linux**: `Nova-x.y.z-linux-*.AppImage` (make it executable and run it; it updates itself) or the `.tar.gz`.
2. Open it.
3. Go to **Server → Plugins** to add sources.

The installed and zip versions keep their data in the system's app-data folder (`%APPDATA%\Nova`,
`~/Library/Application Support/Nova` or `~/.config/Nova`). The portable app keeps it in a `Nova Data` folder next to the `.exe`.
Media you keep goes to your Videos (Movies on macOS) folder, under `Nova`.

The Windows installer and the AppImage download new versions in the background and install them when you close Nova
(**Settings → About Nova → Updates**). The other builds tell you when a new version is out.

The app also works as a local streaming engine for `nova:client` servers. When such a site wants to play a torrent, Nova asks
you once whether to allow it. Allowed sites are listed under **Settings → Account & sharing**.

Nova's server inside the app listens on `127.0.0.1:11471`; pick another port under **Server → Advanced**.

On Windows with Auto HDR, the app keeps its interface in standard range (Windows otherwise switches it between SDR and
HDR as videos start and stop); HDR videos and RTX Video HDR still play in HDR. **Settings → Appearance → HDR** lets
Auto HDR brighten the interface instead.

### Nova for Android

Download `Nova-x.y.z-android.apk` from [Releases](https://github.com/FMLGamer/nova/releases) and install it (Android 7
or newer on a 64-bit ARM phone or tablet; allow installing from your browser or file manager when asked). Then either:

- **Connect to your Nova server**: enter its address, the same one you open in a browser, for example
  `https://nova.example.com` or `http://192.168.1.20:3000`. The app is Nova's own web interface in a native window, so it
  is always as new as your server.
- **Run Nova on this phone**: like the desktop app, the server runs on the phone itself (one owner, no sign-in) and
  streams torrents there. Your history, lists and downloads stay on the phone; media you keep goes to the app's Movies
  folder. It runs while the app is open. The phone has no ffmpeg (yet), so files the phone can't play as they are
  (for example AC3/DTS audio) don't play, embedded subtitles aren't read, and casting isn't available.

**Settings → About Nova → Switch server** goes back to this choice.

### Docker

```sh
docker run -d --name nova -p 3000:3000 \
  -v nova-data:/data -v nova-library:/library \
  ghcr.io/fmlgamer/nova:latest
docker logs nova   # prints the generated admin password on first start
```

Open http://localhost:3000 and sign in as `admin`. New accounts need an invite code, which you create under
**Server → People**. To stream torrents on viewers' devices instead, use `ghcr.io/fmlgamer/nova:client`.

`docker-compose.yml`:

```yaml
services:
  nova:
    image: ghcr.io/fmlgamer/nova:latest
    ports: ["3000:3000"]
    volumes:
      - nova-data:/data        # database, plugins, backups
      - nova-library:/library  # titles kept on the server
      - nova-cache:/cache      # torrent scratch space, safe to lose
    restart: unless-stopped
volumes: { nova-data: {}, nova-library: {}, nova-cache: {} }
```

## Configuration

Nothing is required. Movies and shows use Cinemeta (Stremio's open IMDb catalogue) and anime uses AniList and ani.zip,
so posters, episodes and artwork work without any key. A TMDB key (optional) adds TMDB's trending lists, cast photos and
recommendations; keys for TMDB, OpenSubtitles and DeepL can be entered under **Server → Overview → Integrations**.
Plugins are installed and configured under **Server → Plugins**. For subtitles without an account, install the
**OpenSubtitles v3** plugin.

If you prefer declarative config, every setting can also come from the environment, and environment values take
priority:

| Variable | Default | Purpose |
|---|---|---|
| `TORRENT_MODE` | `server` | `client` = never touch torrents; viewers' devices stream them |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Where the server listens |
| `ENGINE_PORT` | `11471` | Port browsers try for a viewer's desktop app (`nova:client`) |
| `PUBLIC_URL` | request host | Base for share links and external-player links |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / generated | First-boot admin |
| `SESSION_SECRET` | generated in `/data` | Signing key for sessions |
| `TMDB_API_KEY` | none | Optional TMDB metadata (without it, Cinemeta is used). Anime (AniList) needs no key. |
| `OPENSUBTITLES_API_KEY`, `_USERNAME`, `_PASSWORD` | none | In-player subtitle search |
| `ANILIST_CLIENT_ID` | none | One-click AniList tracking (client with redirect `https://anilist.co/api/v2/oauth/pin`) |
| `MAL_CLIENT_ID`, `MAL_CLIENT_SECRET` | none | MyAnimeList tracking (app redirect `<your Nova URL>/api/trackers/mal/callback`) |
| `PLUGINS_AUTOINSTALL` | none | Manifest URLs installed and approved on boot |
| `PLUGIN_<ID>_<KEY>` | none | Plugin config, e.g. `PLUGIN_NOVA_PROWLARR_URL`, `PLUGIN_NOVA_PROWLARR_APIKEY` |
| `PLUGIN_REGISTRIES` | nova-plugins registry | Registries offered in the plugin browser |
| `LIBRARY_DIR`, `LIBRARY_MAX_GB` | `/library`, no cap | Server library location and size cap |
| `CACHE_TOTAL_MB` | `10240` | Torrent scratch budget |
| `MAX_TRANSCODES` | `1` | Concurrent full transcodes |
| `HW_ACCEL` | none | `vaapi` for Intel/AMD hardware transcoding (pass `/dev/dri`) |
| `COOKIE_SECURE` | follows HTTPS | Force `true`/`false` |
| `CAST_DEVICES` | none | TVs to offer when discovery can't see them, e.g. `chromecast:192.168.1.40,dlna:http://192.168.1.41:9197/dmr` (admins can also add them by address in the player's Cast menu) |
| `CAST_PORT` | `11472` (desktop app) | LAN port the desktop app serves cast streams on |
| `PROJECT_URL` | this repository | Where "Report a problem", update checks and update links point (for forks) |
| `OLLAMA_URL`, `OLLAMA_MODEL` | none | Built-in local assistant model (needs tool calling) |

Back up `/data`. Everything else can be rebuilt.

## Highlights

- **Sources:** you tick which resolutions, codecs, audio and release types are fine (Settings → Sources & quality).
  Of the sources that fit, the best-seeded one plays; the rest stay one click away.
- **Playback:**
  - Custom player with Anime4K, CAS and deband shaders, picture-in-picture, screenshots and a sleep timer.
  - Keyboard shortcuts you can change (Settings → Playback).
  - Audio formats browsers can't play (E-AC-3, DTS, TrueHD) are converted on the fly.
  - Hardware transcoding.
  - External players (VLC, mpv, IINA).
  - Collections play in order (**Play all**).
- **Subtitles:**
  - Embedded Matroska tracks are read around the playhead, so they show up right away, even on a torrent that's still
    downloading.
  - ASS/SSA tracks render with libass (JASSUB), including embedded fonts, signs and karaoke.
  - Tracks with names you never want ("Signs & Songs", "Forced") are skipped when Nova picks one.
  - OpenSubtitles search and machine translation.
- **Skipping:** intro and credits through AniSkip, or the file's own chapters.
- **Casting:**
  - Finds Chromecasts / Google TVs (mDNS) and DLNA TVs (SSDP) on the network of the machine that streams; Chrome and
    Edge can also use their own Cast menu.
  - Text subtitles go to the TV as subtitles. ASS/SSA subtitles are burned into the picture while casting (one live
    encode with the file's own fonts, on the GPU when there is one).
  - A server in a container only sees TVs with host networking, or the ones listed in `CAST_DEVICES` or added by address.
- **Reading:**
  - A catalogue of manga, manhwa, manhua and light novels (AniList) and books (Open Library). Each title page shows
    where you can read it: a free public-domain edition (Project Gutenberg), your own files, or your plugins.
  - A comic reader (single page, spread or scroll, in either direction) and an EPUB/PDF reader with highlights, notes
    and dyslexia-friendly typefaces.
  - Point Nova at existing folders of e-books, comics and manga under **Server → Library → Reading folders**; it reads
    them in place, never changes them, and picks up new files as they appear.
- **Anime & manga tracking:** connect AniList and/or MyAnimeList per profile (Settings → Anime & manga tracking); with
  both, every change goes to both.
  - Episodes count as watched at a share you choose (80% by default) and manga chapters when you finish them. Shows you
    start are added as Watching.
  - Set the status, progress and score from a title's page, or mark episodes watched by hand.
  - Your lists are under **Library → Anime & manga**. The anime schedule can show only what you're watching.
  - Episode discussion threads open inside Nova.
- **For you:** recommendations on Home, built from what you watch and finish, plus a **Stats** page in your library.
- **Bring your history:** import what you watched on Netflix (Viewing activity → Download all), Letterboxd or any CSV
  of titles (Settings → Profile); it's matched to the catalogue and marked watched.
- **Make it yours:** choose the sections of every page, their order and the banner size (Settings → Customize), hide
  spoilers (titles and thumbnails of episodes you haven't seen), hide scores, custom CSS, filler episodes marked, and
  Discord status in the desktop app. Features still being shaped wait under Settings → Beta.
- **Live TV:** M3U, Xtream, Stalker/Ministra and HDHomeRun inputs, the iptv-org directory and an XMLTV guide.
- **People:** invite-only accounts, profiles, expiring guest links, and watch rooms with chat.
- **Plugins:**
  - Stremio-compatible manifests, sandboxed with Node's permission model, written with a TypeScript SDK.
  - Plugins can add sources, metadata, media types, UI actions, assistant tools and jobs.

## Development

```sh
npm install && npm --prefix server install
npm --prefix server run build            # the plugin sandbox runs the compiled runtime
DEV_AUTH=1 node server/dist/index.js     # API on :3000; DEV_AUTH signs you in as the admin
npm run dev                              # UI on :5173 (proxies /api, /stream, /live, /ws)
```

To build the desktop app, run `npm --prefix desktop install && npm --prefix desktop run dist` on the platform you build
for. The installer, archives and portable app end up in `desktop/release/`. For the Discord status, create an application
at https://discord.com/developers/applications and set its ID as `DISCORD_CLIENT_ID` when building (in CI: a repository
variable of that name); without it the Discord option stays hidden.

The Android app lives in `mobile/` (Capacitor). Build the web app and the server first, then run
`node mobile/scripts/bundle-android.mjs` on Linux (it needs `zip`, `ar`, `tar` and `readelf`): it packs the server and web
app into the app's assets and fetches Termux's Node.js build for Android with its libraries into `jniLibs`. Then
`npm --prefix mobile install`, `npx cap sync android` in `mobile/`, and build `mobile/android` with Android Studio or
`./gradlew assembleRelease -PnovaVersion=x.y.z` (JDK 21 and the Android SDK). CI signs it with the key in the
`NOVA_ANDROID_*` repository secrets, and tests the phone's own server in an emulator.

The project layout:

- `src/`: the React app.
- `server/src/`: the API, plugin host, streaming and the Matroska reader.
- `desktop/`: the Electron shell.
- `mobile/`: the Android shell.

What changed in each release is in [CHANGELOG.md](CHANGELOG.md).

## License

MIT. The Windows app bundles FFmpeg binaries, which are licensed separately under the GPL; see `bin/README.txt` in the app.
