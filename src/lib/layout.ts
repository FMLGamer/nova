// Which sections each page offers, which are on by default, and how a profile's changes apply to them.
import type { HeroSize, PageLayoutPrefs, Preferences } from './types';

export type PageId = 'home' | 'movies' | 'shows' | 'anime' | 'live' | 'read';

export interface SectionDef {
  id: string;
  label: string;
  hint: string;
  /** Shown without the profile adding it. */
  on: boolean;
}

export interface PageDef {
  label: string;
  heroLabel: string;
  heroSize: HeroSize;
  /** In their default order; sections added later go back to this place. */
  sections: SectionDef[];
}

const s = (id: string, label: string, hint: string, on = false): SectionDef => ({ id, label, hint, on });

export const PAGES: Record<PageId, PageDef> = {
  home: {
    label: 'Home',
    heroLabel: 'Featured title',
    heroSize: 'full',
    sections: [
      s('continue', 'Continue watching', 'Pick up where you left off', true),
      s('upnext', 'Up next', 'The next episode of shows you keep up with'),
      s('collections', 'Pinned collections', 'Collections you pinned in your library', true),
      s('live', 'Live TV favourites', "What's on your favourite channels", true),
      s('reading', 'Keep reading', 'Books and comics you started', true),
      s('mylist', 'My List', 'Everything you saved', true),
      s('foryou', 'For you', 'Picked from what you watch', true),
      s('trending', 'Trending & popular', "What everyone's watching", true),
      s('because', 'Because you watched', 'More like your recent favourites', true),
      s('new', 'Fresh episodes', 'Anime episodes out this week', true),
      s('airing', 'Airing this week', 'New episodes of the shows you follow', true),
      s('plugins', 'Plugin catalogues', 'Rows from your plugins', true),
    ],
  },
  movies: {
    label: 'Movies',
    heroLabel: 'Featured film',
    heroSize: 'medium',
    sections: [
      s('continue', 'Continue watching', 'Films you started'),
      s('mylist', 'My List', 'Films you saved'),
      s('foryou', 'For you', 'Films picked from what you watch'),
      s('trending', 'Trending & popular', 'Trending, in cinemas and top rated'),
      s('browse', 'Browse movies', 'Every film, by genre', true),
    ],
  },
  shows: {
    label: 'Shows',
    heroLabel: 'Featured series',
    heroSize: 'medium',
    sections: [
      s('continue', 'Continue watching', 'Series you started'),
      s('upnext', 'Up next', 'The next episode of series you keep up with'),
      s('airing', 'Airing this week', 'New episodes of the series you follow'),
      s('mylist', 'My List', 'Series you saved'),
      s('foryou', 'For you', 'Series picked from what you watch'),
      s('trending', 'Trending & popular', 'Trending, popular and on the air'),
      s('browse', 'Browse shows', 'Every series, by genre', true),
    ],
  },
  anime: {
    label: 'Anime',
    heroLabel: 'This season',
    heroSize: 'medium',
    sections: [
      s('continue', 'Continue watching', 'Anime you started'),
      s('upnext', 'Up next', 'The next episode of anime you keep up with'),
      s('latest', 'Latest episodes', 'Everything with a new episode this week', true),
      s('schedule', 'Schedule', "This week's episodes, day by day", true),
      s('airing', 'Airing this week', 'New episodes of the anime you follow'),
      s('season', 'This season', 'The season ranked', true),
      s('mylist', 'My List', 'Anime you saved'),
      s('foryou', 'For you', 'Anime picked from what you watch'),
      s('browse', 'Browse anime', 'Every anime, by genre and format', true),
    ],
  },
  live: {
    label: 'Live TV',
    heroLabel: 'On now',
    heroSize: 'medium',
    sections: [],
  },
  read: {
    label: 'Read',
    heroLabel: 'Featured read',
    heroSize: 'medium',
    sections: [
      s('reading', 'Keep reading', 'Books and comics you started', true),
      s('server', 'On your server', 'Books, comics and manga in your library', true),
      s('plugins', 'Plugin catalogues', 'Rows from your reading plugins', true),
      s('freebooks', 'Free books', 'Public-domain books and audiobooks', true),
      s('finished', 'Finished', 'What you read to the end', true),
      s('browse', 'Browse manga & books', 'The whole catalogue', true),
    ],
  },
};

export interface ResolvedLayout {
  hero: boolean;
  heroSize: HeroSize;
  sections: string[];
}

/** Puts `id` back where it sits in the page's default order, relative to what is already shown. */
function insertAt(page: PageId, order: string[], id: string): string[] {
  const defs = PAGES[page].sections.map((d) => d.id);
  const before = defs.slice(0, defs.indexOf(id)).reverse().find((x) => order.includes(x));
  const out = [...order];
  out.splice(before ? out.indexOf(before) + 1 : 0, 0, id);
  return out;
}

export function resolveLayout(page: PageId, saved: PageLayoutPrefs | undefined): ResolvedLayout {
  const def = PAGES[page];
  const known = new Set(def.sections.map((d) => d.id));
  const removed = new Set(saved?.removed ?? []);
  let sections = def.sections.filter((d) => d.on).map((d) => d.id);
  if (saved?.sections) {
    sections = saved.sections.filter((id) => known.has(id));
    // Sections new since the profile last changed this page join in their default place.
    for (const d of def.sections) if (d.on && !sections.includes(d.id) && !removed.has(d.id)) sections = insertAt(page, sections, d.id);
  }
  return { hero: saved?.hero !== false, heroSize: saved?.heroSize ?? def.heroSize, sections };
}

export function pageLayout(page: PageId, prefs: Preferences | undefined): ResolvedLayout {
  return resolveLayout(page, prefs?.layout?.[page]);
}

/** The preference patch for a change to one page. */
export function layoutPatch(page: PageId, current: ResolvedLayout, saved: PageLayoutPrefs | undefined, change: { add?: string; remove?: string; move?: [number, number]; hero?: boolean; heroSize?: HeroSize; reset?: boolean }) {
  if (change.reset) return { layout: { [page]: { sections: null, removed: [], hero: true, heroSize: null } } };
  let sections = current.sections;
  let removed = saved?.removed ?? [];
  if (change.add) {
    sections = insertAt(page, sections.filter((x) => x !== change.add), change.add);
    removed = removed.filter((x) => x !== change.add);
  }
  if (change.remove) {
    sections = sections.filter((x) => x !== change.remove);
    removed = [...new Set([...removed, change.remove])];
  }
  if (change.move) {
    const [i, d] = change.move;
    sections = [...sections];
    const [x] = sections.splice(i, 1);
    sections.splice(i + d, 0, x!);
  }
  return { layout: { [page]: { sections, removed, hero: change.hero ?? current.hero, heroSize: change.heroSize ?? saved?.heroSize ?? null } } };
}
