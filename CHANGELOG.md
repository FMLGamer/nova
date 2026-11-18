# Changelog

What changed in each Nova release. Each release on GitHub shows its section of this file.

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
