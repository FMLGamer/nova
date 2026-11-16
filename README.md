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
| **Nova for Windows** | Installer or portable `.exe`. Everything runs on your PC, with no account or setup. | Your PC |
| **Docker: `nova:latest`** | Multi-user server with invite-only accounts. | The server |
| **Docker: `nova:client`** | Same server, but it never joins a torrent swarm. | Each viewer's device, through Nova for Windows or the browser |

### Nova for Windows

1. Download `Nova-Setup-x.y.z.exe` (installer) or `Nova-Portable-x.y.z.exe` (no install) from
   [Releases](https://github.com/FMLGamer/nova/releases).
2. Open it.
3. Go to **Server → Plugins** to add sources.

The installed app keeps its data in `%APPDATA%\Nova`. The portable app keeps it in a `Nova Data` folder next to the `.exe`.
Media you keep goes to `Videos\Nova`.

The app also works as a local streaming engine for `nova:client` servers. When such a site wants to play a torrent, Nova asks
you once whether to allow it. Allowed sites are listed under **Settings → Account & sharing**.

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
| `PUBLIC_URL` | request host | Base for share links and external-player links |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / generated | First-boot admin |
| `SESSION_SECRET` | generated in `/data` | Signing key for sessions |
| `TMDB_API_KEY` | none | Optional TMDB metadata (without it, Cinemeta is used). Anime (AniList) needs no key. |
| `OPENSUBTITLES_API_KEY`, `_USERNAME`, `_PASSWORD` | none | In-player subtitle search |
| `PLUGINS_AUTOINSTALL` | none | Manifest URLs installed and approved on boot |
| `PLUGIN_<ID>_<KEY>` | none | Plugin config, e.g. `PLUGIN_NOVA_PROWLARR_URL`, `PLUGIN_NOVA_PROWLARR_APIKEY` |
| `PLUGIN_REGISTRIES` | nova-plugins registry | Registries offered in the plugin browser |
| `LIBRARY_DIR`, `LIBRARY_MAX_GB` | `/library`, no cap | Server library location and size cap |
| `CACHE_TOTAL_MB` | `10240` | Torrent scratch budget |
| `MAX_TRANSCODES` | `1` | Concurrent full transcodes |
| `HW_ACCEL` | none | `vaapi` for Intel/AMD hardware transcoding (pass `/dev/dri`) |
| `COOKIE_SECURE` | follows HTTPS | Force `true`/`false` |
| `CAST_DEVICES` | none | TVs to offer when discovery can't see them, e.g. `chromecast:192.168.1.40,dlna:http://192.168.1.41:9197/dmr` |
| `CAST_PORT` | `11472` (Windows app) | LAN port the Windows app serves cast streams on |
| `OLLAMA_URL`, `OLLAMA_MODEL` | none | Built-in local assistant model (needs tool calling) |

Back up `/data`. Everything else can be rebuilt.

## Highlights

- **Playback:**
  - Custom player with Anime4K, CAS and deband shaders, picture-in-picture and a sleep timer.
  - Audio formats browsers can't play (E-AC-3, DTS, TrueHD) are converted on the fly.
  - Hardware transcoding.
  - External players (VLC, mpv, IINA).
- **Subtitles:**
  - Embedded Matroska tracks are read around the playhead, so they show up right away, even on a torrent that's still
    downloading.
  - ASS/SSA tracks render with libass (JASSUB), including embedded fonts, signs and karaoke.
  - OpenSubtitles search and machine translation.
- **Skipping:** intro and credits through AniSkip, or the file's own chapters.
- **Casting:**
  - Finds Chromecasts / Google TVs (mDNS) and DLNA TVs (SSDP) on the network of the machine that streams; Chrome and
    Edge can also use their own Cast menu.
  - Text subtitles go to the TV as subtitles. ASS/SSA subtitles are burned into the picture while casting (one live
    encode with the file's own fonts, on the GPU when there is one).
  - A server in a container only sees TVs with host networking, or the ones listed in `CAST_DEVICES`.
- **Reading:** a comic reader (single page, spread or scroll, in either direction) and an EPUB/PDF reader with highlights,
  notes and dyslexia-friendly typefaces.
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

To build the Windows app (on Windows), run `npm --prefix desktop install && npm --prefix desktop run dist`. The installer and
portable `.exe` end up in `desktop/release/`.

The project layout:

- `src/`: the React app.
- `server/src/`: the API, plugin host, streaming and the Matroska reader.
- `desktop/`: the Electron shell.

## License

MIT. The Windows app bundles FFmpeg binaries, which are licensed separately under the GPL; see `bin/README.txt` in the app.
