/**
 * Bring a viewing history over from another service. Exports are CSV files:
 *   Netflix     "Title,Date"  e.g. "The Show: Season 2: The Episode","11/18/26" (season word in the account's language)
 *   Letterboxd  "Date,Name,Year,Letterboxd URI[,...]" (watched.csv / diary.csv)
 *   anything else with a title (or name) column, and optionally a date column.
 * Titles are matched against the catalogue, episodes by their names, and everything matched is saved as
 * watched on the date it was watched. Nothing already in the profile's history is overwritten.
 */
import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { HttpError } from '../lib/http.js';
import type { CatalogItem, Episode } from '../media/types.js';
import { anilistSearch } from './anilist.js';
import { detailFor, episodesFor } from './catalog.js';
import { tmdbSearch } from './tmdb.js';

export type ImportSource = 'netflix' | 'letterboxd' | 'generic';

export interface ImportJob {
  id: string;
  profileId: string;
  source: ImportSource;
  state: 'running' | 'done' | 'failed';
  /** Titles to look up, and how many are done. */
  total: number;
  done: number;
  movies: number;
  episodes: number;
  /** Shows whose episodes all matched, or partly. */
  shows: number;
  unmatched: string[];
  error: string | null;
  startedAt: number;
}

const jobs = new Map<string, ImportJob>();

// ---------------------------------------------------------------- CSV

/** RFC 4180: quoted fields, doubled quotes, commas and line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

/** "11/18/26", "18-11-2026", "2026-11-18" -> ISO date (US order for slashes, like Netflix's export). */
export function parseDate(s: string | undefined): string | null {
  const t = s?.trim();
  if (!t) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{2,4})$/.exec(t);
  if (!m) return null;
  let [a, b] = [+m[1]!, +m[3]!];
  const year = m[4]!.length === 2 ? 2000 + +m[4]! : +m[4]!;
  // Slashes are month-first unless that can't be; dashes and dots are day-first.
  const monthFirst = m[2] === '/' ? a <= 12 : b > 12;
  if (!monthFirst) [a, b] = [b, a];
  return iso(year, a, b);
}

function iso(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')} 20:00:00`;
}

// ---------------------------------------------------------------- titles

// "Season 2", "Seizoen 2", "Staffel 2", "Part 1", "Limited Series", ... in the languages Netflix exports.
const SEASON_WORD =
  /^(season|series|seizoen|staffel|saison|temporada|stagione|sezon|s\u00e4song|sesong|s\u00e6son|kausi|s\u00e9rie|seria|evad|part|parte|partie|deel|teil|volume|vol\.?|book|boek|buch|libro|livre|collection|limited series|miniseries|miniserie|mini-series|miniss\u00e9rie)\b\.?\s*(\d+)?$/i;

interface Watch {
  title: string;
  date: string | null;
}

interface ShowGroup {
  name: string;
  /** null: the export didn't say which season. */
  seasons: Map<number | null, Watch[]>;
}

interface Parsed {
  source: ImportSource;
  movies: Map<string, { year: number | null; date: string | null }>;
  shows: Map<string, ShowGroup>;
  rows: number;
}

function addEpisode(shows: Map<string, ShowGroup>, name: string, season: number | null, w: Watch) {
  const key = name.toLowerCase();
  const g = shows.get(key) ?? { name, seasons: new Map() };
  g.seasons.set(season, [...(g.seasons.get(season) ?? []), w]);
  shows.set(key, g);
}

function addMovie(movies: Parsed['movies'], title: string, year: number | null, date: string | null) {
  const have = movies.get(title);
  if (!have || (date && (!have.date || date > have.date))) movies.set(title, { year, date });
}

export function parseHistory(text: string): Parsed {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new HttpError(400, 'That file has no rows to import');
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const body = rows.slice(1);
  const movies: Parsed['movies'] = new Map();
  const shows = new Map<string, ShowGroup>();

  const name = col('name');
  const year = col('year');
  if (name >= 0 && year >= 0) {
    // Letterboxd: films only.
    const date = col('watched date', 'date');
    for (const r of body) if (r[name]?.trim()) addMovie(movies, r[name]!.trim(), Number(r[year]) || null, parseDate(r[date]));
    return { source: 'letterboxd', movies, shows, rows: body.length };
  }

  const title = col('title', 'name', 'titel', 'titre', 'título', 'titolo');
  if (title < 0) throw new HttpError(400, "Couldn't find a Title column in that file");
  const date = col('date', 'datum', 'fecha', 'data', 'watched', 'watched at', 'start time');
  const netflix = header.length === 2 && header[0] === 'title' && header[1] === 'date';
  const entries = body.map((r) => ({ title: (r[title] ?? '').trim(), date: parseDate(r[date]) })).filter((e) => e.title);
  // A two-part title is an episode if its first part appears more than once ("UNTAMED: Gold Rush"),
  // otherwise a film with a subtitle ("Wake Up Dead Man: A Knives Out Mystery").
  // Empty parts are dropped: "Archer:  : Episode 9".
  const split = (t: string) => t.split(': ').filter((s, i) => i === 0 || s.trim());
  const prefixes = new Map<string, number>();
  // "Cyberpunk: Edgerunners: Let You Down": a show whose name has a colon repeats both parts on every episode.
  const pairs = new Map<string, number>();
  for (const e of entries) {
    const p = split(e.title);
    if (p.length >= 2) prefixes.set(p[0]!.toLowerCase(), (prefixes.get(p[0]!.toLowerCase()) ?? 0) + 1);
    if (p.length >= 3) pairs.set(`${p[0]}: ${p[1]}`.toLowerCase(), (pairs.get(`${p[0]}: ${p[1]}`.toLowerCase()) ?? 0) + 1);
  }
  for (const e of entries) {
    const p = split(e.title);
    // Netflix sometimes exports an episode without its show (": Episode 3"): nothing to go on.
    if (!p[0]!.trim()) continue;
    const w = (episode: string) => ({ title: episode, date: e.date });
    if (p.length >= 3) {
      const s = SEASON_WORD.exec(p[1]!);
      const numbered = new RegExp(`^${p[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(\\d+)$`, 'i').exec(p[1]!);
      if (s) addEpisode(shows, p[0]!, s[2] ? Number(s[2]) : 1, w(p.slice(2).join(': ')));
      else if (numbered) addEpisode(shows, p[0]!, Number(numbered[1]), w(p.slice(2).join(': ')));
      else if (p.length >= 4 && SEASON_WORD.exec(p[2]!)) addEpisode(shows, `${p[0]}: ${p[1]}`, Number(SEASON_WORD.exec(p[2]!)![2] ?? 1), w(p.slice(3).join(': ')));
      else if ((pairs.get(`${p[0]}: ${p[1]}`.toLowerCase()) ?? 0) > 1) addEpisode(shows, `${p[0]}: ${p[1]}`, null, w(p.slice(2).join(': ')));
      else addEpisode(shows, p[0]!, null, w(p.slice(1).join(': ')));
    } else if (p.length === 2 && (prefixes.get(p[0]!.toLowerCase()) ?? 0) > 1) addEpisode(shows, p[0]!, null, w(p[1]!));
    else addMovie(movies, e.title, null, e.date);
  }
  return { source: netflix ? 'netflix' : 'generic', movies, shows, rows: entries.length };
}

// ---------------------------------------------------------------- matching

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    // "Chapter Forty-Seven: ...", "Hoofdstuk vier: ..." (Stranger Things) and "Part 2" / "(2)" spell the same thing differently.
    .replace(/^(chapter|hoofdstuk|kapitel|chapitre|cap[i\u00ed]tulo|capitolo)\s+[^:]{1,30}:\s*/, '')
    .replace(/\b(part|deel|teil|partie|parte)\s+(\d+)\b/g, '$2')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
  return m;
}

/** Dice similarity of two normalised strings, 0..1. */
function similar(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const x = bigrams(a);
  const y = bigrams(b);
  let both = 0;
  for (const [k, n] of x) both += Math.min(n, y.get(k) ?? 0);
  return (2 * both) / (a.length - 1 + (b.length - 1));
}

function bestTitle(items: CatalogItem[], title: string, year: number | null): CatalogItem | null {
  const t = norm(title);
  let best: { item: CatalogItem; score: number } | null = null;
  for (const [rank, item] of items.slice(0, 8).entries()) {
    const c = norm(item.title);
    // "House, M.D." is "House" in the catalogue: a clear prefix counts nearly as much as a match.
    const prefix = c.length >= 4 && c.length >= t.length * 0.6 && t.startsWith(c) ? 0.84 : 0;
    let score = Math.max(similar(c, t), prefix) - rank * 0.02;
    if (year && item.year) score += item.year === year ? 0.15 : Math.abs(item.year - year) <= 1 ? 0.05 : -0.2;
    if (!best || score > best.score) best = { item, score };
  }
  return best && best.score >= 0.82 ? best.item : null;
}

const EPISODE_NUMBER =
  /^(episode|ep\.?|aflevering|afl\.?|folge|épisode|episodio|episódio|odcinek|avsnitt|jakso|bölüm|chapter|hoofdstuk|kapitel)\s*(\d+)$/i;

// "The One Where Monica Gets a Roommate (Pilotaflevering)"
const normEpisode = (s: string) => norm(s.replace(/\s*\([^)]*\)\s*$/, ''));

function findEpisode(episodes: Episode[], title: string): Episode | null {
  // "Episode 3" in whatever language: the number is all there is.
  const n = EPISODE_NUMBER.exec(title.trim());
  if (n) return episodes.find((e) => e.episode === Number(n[2])) ?? null;
  const t = normEpisode(title);
  if (!t) return null;
  let best: { ep: Episode; score: number } | null = null;
  for (const ep of episodes) {
    const score = similar(normEpisode(ep.title), t);
    if (!best || score > best.score) best = { ep, score };
  }
  return best && best.score >= 0.75 ? best.ep : null;
}

const save = db.prepare(
  `INSERT INTO watch_progress
     (profile_id, item_key, media_type, media_id, season, episode, position_seconds, duration_seconds, finished, title, poster, backdrop, year, updated_at)
   VALUES (@profile_id, @item_key, @media_type, @media_id, @season, @episode, @seconds, @seconds, 1, @title, @poster, @backdrop, @year, @updated_at)
   ON CONFLICT(profile_id, item_key) DO NOTHING`,
);

function record(profileId: string, item: CatalogItem, ep: Episode | null, date: string | null): boolean {
  const itemKey = ep ? (item.mediaType === 'anime' ? `${item.id}:e${ep.episode}` : `${item.id}:s${ep.season}e${ep.episode}`) : item.id;
  const r = save.run({
    profile_id: profileId,
    item_key: itemKey,
    media_type: item.mediaType,
    media_id: item.id,
    season: ep?.season ?? null,
    episode: ep?.episode ?? null,
    seconds: Math.max(60, ((ep ? ep.runtime : item.runtime) ?? (ep ? 24 : 100)) * 60),
    title: item.title,
    poster: item.poster,
    backdrop: item.backdrop,
    year: item.year,
    updated_at: date ?? new Date().toISOString().replace('T', ' ').slice(0, 19),
  });
  return r.changes > 0;
}

async function findShow(name: string): Promise<CatalogItem | null> {
  // Netflix titles anime by their series too, so AniList is the second place to look.
  return (
    bestTitle(await tmdbSearch('tv', name).catch(() => [] as CatalogItem[]), name, null) ??
    bestTitle(await anilistSearch(name).catch(() => [] as CatalogItem[]), name, null)
  );
}

async function importShow(job: ImportJob, g: ShowGroup, quiet = false): Promise<boolean> {
  // "JoJo's Bizarre Adventure: Phantom Blood/Battle Tendency" is filed under the series name.
  let item = await findShow(g.name);
  if (!item && g.name.includes(': ')) item = await findShow(g.name.split(': ')[0]!);
  const watched = [...g.seasons.values()].flat();
  const lost = () => !quiet && job.unmatched.push(`${g.name} (${watched.length} episode${watched.length === 1 ? '' : 's'})`);
  if (!item) {
    // "Insidious: Chapter 2" and "Insidious: The Last Key" looked like episodes of a show: try them as films.
    if (!quiet && g.seasons.size === 1 && g.seasons.has(null) && watched.length <= 4) {
      const films = [];
      for (const w of watched) films.push(await importMovie(job, `${g.name}: ${w.title}`, { year: null, date: w.date }, true));
      if (films.every((f) => !f)) lost();
      else films.forEach((f, i) => !f && job.unmatched.push(`${g.name}: ${watched[i]!.title}`));
      return films.some(Boolean);
    }
    lost();
    return false;
  }
  // Episodes per season, fetched once; a season the export didn't name is looked for everywhere.
  const cache = new Map<number, Episode[]>();
  const seasonEpisodes = async (n: number) => {
    if (!cache.has(n)) cache.set(n, await episodesFor(item.id, n).catch(() => []));
    return cache.get(n)!;
  };
  let allSeasons: number[] | null = null;
  let matched = 0;
  let missed = 0;
  for (const [season, list] of g.seasons) {
    let pool: Episode[];
    if (item.mediaType === 'anime') pool = await seasonEpisodes(1);
    else if (season != null) pool = await seasonEpisodes(season);
    else {
      allSeasons ??= (await detailFor(item.id).catch(() => null))?.seasons.filter((s) => s.season > 0 && s.episodeCount > 0).map((s) => s.season).slice(0, 15) ?? [];
      pool = (await Promise.all(allSeasons.map(seasonEpisodes))).flat();
    }
    const found = list.map((w) => findEpisode(pool, w.title));
    // Names that don't match (the catalogue only says "Episode 3", or Netflix translated them) are placed in the order
    // they were watched, onto the episodes not matched yet - when nothing matched or the whole season was watched.
    const hits = found.filter(Boolean).length;
    if (season != null && hits < list.length && (hits === 0 || list.length >= pool.length) && list.length <= pool.length) {
      const taken = new Set(found.map((f) => f?.episode));
      const free = pool.filter((e) => !taken.has(e.episode)).sort((a, b) => a.episode - b.episode);
      const byDate = list
        .map((w, i) => ({ w, i }))
        .filter(({ i }) => !found[i])
        .sort((a, b) => (a.w.date ?? '').localeCompare(b.w.date ?? '') || b.i - a.i);
      byDate.forEach(({ i }, k) => (found[i] = free[k] ?? null));
    }
    list.forEach((w, i) => {
      const ep = found[i];
      if (!ep) {
        missed++;
        return;
      }
      matched++;
      if (record(job.profileId, item, ep, w.date)) job.episodes++;
    });
  }
  if (matched) job.shows++;
  if (missed && !quiet) job.unmatched.push(`${g.name}: ${missed} episode${missed === 1 ? '' : 's'} not recognised`);
  return matched > 0;
}

async function importMovie(job: ImportJob, title: string, m: { year: number | null; date: string | null }, quiet = false): Promise<boolean> {
  const item = bestTitle(await tmdbSearch('movie', title).catch(() => []), title, m.year);
  if (item) {
    if (record(job.profileId, item, null, m.date)) job.movies++;
    return true;
  }
  // "Good Girls: Pilot", "Ad Vitam: Episode 1": a show watched for a single episode.
  const p = title.split(': ');
  const found = !quiet && p.length === 2 && (await importShow(job, { name: p[0]!, seasons: new Map([[null, [{ title: p[1]!, date: m.date }]]]) }, true));
  if (!found && !quiet) job.unmatched.push(title);
  return found;
}

async function run(job: ImportJob, parsed: Parsed): Promise<void> {
  const tasks: (() => Promise<unknown>)[] = [
    ...[...parsed.shows.values()].map((g) => () => importShow(job, g)),
    ...[...parsed.movies.entries()].map(([t, m]) => () => importMovie(job, t, m)),
  ];
  job.total = tasks.length;
  // A few at a time: the catalogue services rate-limit.
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++]!;
      await task().catch((e: Error) => job.unmatched.push(`(${e.message})`));
      job.done++;
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
}

export function startImport(profileId: string, csv: string): ImportJob {
  if ([...jobs.values()].some((j) => j.profileId === profileId && j.state === 'running')) throw new HttpError(409, 'An import is already running for this profile');
  const parsed = parseHistory(csv);
  if (!parsed.movies.size && !parsed.shows.size) throw new HttpError(400, 'Nothing in that file looks like something watched');
  const job: ImportJob = {
    id: crypto.randomUUID(),
    profileId,
    source: parsed.source,
    state: 'running',
    total: parsed.movies.size + parsed.shows.size,
    done: 0,
    movies: 0,
    episodes: 0,
    shows: 0,
    unmatched: [],
    error: null,
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  run(job, parsed)
    .then(() => (job.state = 'done'))
    .catch((e: Error) => {
      job.state = 'failed';
      job.error = e.message;
    });
  // Finished jobs are kept for a day so the page can show the result.
  for (const [id, j] of jobs) if (j.state !== 'running' && Date.now() - j.startedAt > 86_400_000) jobs.delete(id);
  return job;
}

export function importJob(profileId: string, id: string): ImportJob {
  const job = jobs.get(id);
  if (!job || job.profileId !== profileId) throw new HttpError(404, 'No such import');
  return job;
}
