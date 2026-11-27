# Changelog

What changed in each Nova release. Each release on GitHub shows its section of this file.

## [2.7.0] - 2026-11-27

### New
- **Run Nova on your phone**: Nova for Android can now run the Nova server on the phone itself, like the desktop app
  (choose "Run Nova on this phone" when the app asks for a server). One owner, no sign-in; it streams torrents on the
  phone and keeps your history, lists and downloads there. There's no ffmpeg on the phone yet, so files with audio the
  phone can't play (AC3, DTS) don't play, embedded subtitles aren't read and casting isn't available. ARM phones,
  tablets and TV boxes (64- and 32-bit); the app is bigger now because it carries Node.js.
- **Download buttons on episodes**: every episode has a download button in its bottom-right corner (like the watched
  check in the top right) that shows its progress and removes the download again.
- The **Download** button on a title (it was called Save) downloads this episode, the whole season you're looking at,
  every missing episode, or turns on **Auto-download new episodes**: only episodes that come out after you turn it on,
  while Nova is open. Downloads run two at a time; the rest wait their turn.
- **Search in Settings and Server settings**: type to find any setting, typos forgiven ("subtitel size" finds the
  subtitle Size).
- **Skip without intro data** (Settings → Playback): when Nova doesn't know where an episode's intro or credits are,
  the Skip button jumps ahead a set number of seconds (85 by default, or off).
- A back button on the "getting ready" screen, and a "Choose another source" button there, so a slow source never
  locks you in.

### Changed
- **Settings and Server settings are reorganised** into clear groups (You, Watching & reading, Look & feel, Nova; and
  Server, Content, Maintenance), with the settings only some people need under a separate **Advanced** page: source
  filters, compatibility, custom CSS, API tokens and Beta in Settings; the port, API keys and server downloads in Server
  settings. Old links still land in the right place.
- **Downloading to the server** is now only offered when an admin turns it on (Server → Advanced → Downloads); otherwise
  Download means this device. "New episodes" rules on the server, too, only fetch episodes that come out after the rule
  was turned on.
- **Search** puts the best match first: a "Top results" row ranks every kind together by how well the title matches,
  how well-liked and followed it is, and whether it has artwork, and the kinds follow in that order (search "rick and
  morty" and the show comes first, not the spin-offs). Titles without artwork get a drawn placeholder instead of a
  broken image.
- **Far fewer AniList requests**: everything Nova shows about an anime comes from one request, and titles needed
  together (recommendations, Up next, stats, auto-download) are fetched together, up to 50 per request. Searches are
  cached. This keeps Nova well under AniList's rate limit at launch and while browsing.
- Dropdowns and menus have much better contrast.
- Dragging a row of cards no longer snaps to the nearest card when you let go, except at the very start and end.
- The app update "Download" button is gone where Nova updates itself; it shows what's new instead.

### Fixed
- **The AI assistant got stuck on "Thinking…"** with every model (Ollama, Gemini and others): its answers were never
  delivered. They now arrive, and a model that only keeps looking things up still ends with an answer.
- **Long anime opened slowly**: the episode list waited up to several seconds on the filler/recap list from
  MyAnimeList (Jikan), which is often slow or unreachable. The list now shows at once and the filler marks follow, and
  they're kept between restarts.

## [2.6.0] - 2026-11-23

### New
- **HDR interface** switch for the Windows app (Settings → Appearance → HDR). Off by default: Nova now tells Windows Auto
  HDR to leave its interface alone, so it no longer flips between SDR and HDR while you scroll, switch pages or pause.
  HDR videos and RTX Video HDR still play in HDR. Turn it on if you prefer Auto HDR's brighter look (after a restart).
- When AniList, TMDB or another service Nova depends on is busy or unreachable, a message says which one, why (with the
  error code) and when Nova tries again; it then retries by itself.
- API keys under Server → Overview → Integrations can be removed again, and plugin settings can go back to their
  default.

### Changed
- Catalogue answers (AniList, TMDB, Cinemeta and others) are kept between restarts and refreshed in the background, so the
  Anime tab and Home load right away after starting Nova instead of waiting on rate limits. The Anime tab also needs far
  fewer AniList requests: Latest episodes is built from the schedule, and past weeks are fetched only once.
- The Anime tab remembers how you left the schedule (columns or timeline, week or month).
- The desktop app's port setting moved to Server → Overview, next to the other server settings. Servers show their port
  there too.

### Fixed
- A paused video on an HDR screen no longer flashes between HDR and SDR (the controls' blur took the picture off its HDR
  layer).
- YouTube's own title bar and play buttons no longer show for a few seconds when a banner trailer starts, loops or
  resumes.

## [2.5.0] - 2026-11-18

### New
- **Nova for Android**: an app (APK on the release page) that opens your own Nova server, with the same interface
  sized for phones. It remembers the server, offers recent ones, and can switch servers from Settings → About.
- **Customize** (Settings → Customize): choose the sections of Home, Movies, Shows, Anime and Read, their order, and
  how big each page's banner is (or hide it). New sections to add where they fit, like Continue watching, Up next, My
  List and For you for just that kind of title. Tabs you never use can leave the top bar.
- **Import your viewing history** from Netflix (Viewing activity → Download all), Letterboxd or any CSV with titles
  (Settings → Profile). Titles and episodes are matched to the catalogue and marked watched on the day you watched them.
- **Beta** settings, all off until switched on: a month view in the anime schedule, and watched-episode counts on
  series cards.
- Searching from a tab searches that tab's kind of titles (Movies, Shows, Anime, or manga & books on Read). A chip in
  the search box shows it; click it (or press Backspace) to search everything.
- Carousels scroll by holding and dragging with the mouse, and keep gliding when you let go.
- Latest episodes on the Anime tab keeps loading while you scroll, through the whole past week.
- The desktop app's server port can be changed (Settings → About → Server).

### Changed
- Up next is no longer on Home by default (add it back in Customize).
- The anime schedule no longer greys out past days; episodes you've watched (in Nova or on AniList/MyAnimeList) are
  marked instead. The timeline view only spans the hours something airs.
- A green check on a series now means you've watched all of it; a series you're partway through shows how far you are.
  Episodes played to (nearly) the end count as watched everywhere.
- Episodes listed as not out yet can be opened anyway (air dates are sometimes wrong); Nova uses the earliest air date
  any source gives.
- For you leaves out what's already on your AniList / MyAnimeList lists (other than Plan to watch) and learns from them.
- The search box and account buttons in the top bar match the navigation pills.
- The interface stays standard range on HDR screens; only the player's picture uses HDR, and the player's controls switch
  to high contrast next to it.
- Plugin chapters that are only published officially (such as MANGA Plus chapters on MangaDex) are listed and open on
  the publisher's site.

### Fixed
- AniList "429 Too Many Requests" right after starting Nova (wrong Watching schedule, tracking errors): Nova now queues
  AniList requests under its rate limit and waits when asked to.
- Keep reading (and Finished) items can be removed.
- Hiding a page's banner no longer puts its first row under the top bar.

## [2.4.0] - 2026-11-18

### New
- macOS (Apple silicon) and Linux (AppImage, tar.gz) desktop apps; the Windows installer and AppImage update themselves.
- AniList and MyAnimeList tracking for anime and manga: status, progress and score from a title's page, both sites at
  once, episode discussions inside Nova, and your lists under Library.
- A Read catalogue of manga, manhwa, manhua, light novels and books, with title pages that find where to read them.
- For you recommendations, library stats, player screenshots, custom keyboard shortcuts, hide spoilers and scores,
  custom CSS, filler episode badges, collection Play all, and Discord status in the desktop app.

### Changed
- The desktop window opens maximized, remembers its size, and has a slim title bar.
- Browse pages share one layout; the top bar collapses into a menu on narrow windows.

### Fixed
- Removing titles from My List, and the episode list jumping when opened in the player.

## [2.3.1] - 2026-11-17

### Fixed
- Windows release build (zip target), and a smaller portable app that starts faster.

## [2.3.0] - 2026-11-17

### New
- Reading folders, AniList/MyAnimeList tracking, casting to a TV by address, torrent preferences as requirements.

### Fixed
- Audio and video drifting apart after seeking in converted streams; trailers stealing focus.

## [2.2.0] - 2026-11-16

### New
- Casting (Chromecast, DLNA), metadata without API keys (Cinemeta, AniList), subtitle plugins.

## [2.1.0] - 2026-11-16

- First public release.
