import type { AppConfig, CatalogItem, MediaType } from './types';

export function fmtClock(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

export function fmtRuntime(min: number | null | undefined): string | null {
  if (!min || min <= 0) return null;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

export function fmtLeft(position: number, duration: number | null | undefined): string | null {
  if (!duration || duration <= 0) return null;
  const left = Math.max(0, Math.round((duration - position) / 60));
  return left < 1 ? 'Almost done' : `${fmtRuntime(left)} left`;
}

export function fmtBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${u[i]}`;
}

export const fmtSpeed = (bps: number) => `${fmtBytes(bps)}/s`;

export function relTime(iso: unknown): string {
  let t: number;
  if (typeof iso === 'number') t = iso < 1e12 ? iso * 1000 : iso;
  else if (typeof iso === 'string' && iso) t = Date.parse(/[TZ]/.test(iso) ? iso : `${iso.replace(' ', 'T')}Z`);
  else if (iso instanceof Date) t = iso.getTime();
  else return '';
  if (!Number.isFinite(t)) return '';
  const d = (t - Date.now()) / 1000;
  const abs = Math.abs(d);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 60) return rtf.format(Math.round(d), 'second');
  if (abs < 3600) return rtf.format(Math.round(d / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(d / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(d / 86400), 'day');
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtAirTime(unix: number, allDay = false): string {
  const d = new Date(unix * 1000);
  return allDay ? d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Anime are numbered by episode only (no season) everywhere in the UI. */
export function episodeLabel(mediaType: string, season: number | null | undefined, episode: number | null | undefined, long = false): string | null {
  if (episode == null) return null;
  if (mediaType === 'anime' || season == null) return long ? `Episode ${episode}` : `E${episode}`;
  return long ? `Season ${season} · Episode ${episode}` : `S${season} · E${episode}`;
}

export function itemKeyFor(mediaId: string, season: number | null | undefined, episode: number | null | undefined): string {
  if (episode == null) return mediaId;
  return mediaId.startsWith('anime:') ? `${mediaId}:e${episode}` : `${mediaId}:s${season ?? 1}e${episode}`;
}

export const mediaTypeOf = (mediaId: string): MediaType => (mediaId.split(':')[0] as MediaType) ?? 'movie';

export const titlePath = (mediaId: string, at?: { season?: number | null; episode?: number | null }) => {
  const [t, id] = mediaId.split(':');
  if (at?.episode == null) return `/title/${t}/${id}`;
  return `/title/${t}/${id}?${at.season != null ? `s=${at.season}&` : ''}e=${at.episode}`;
};

export interface WatchTarget {
  mediaId: string;
  season?: number | null;
  episode?: number | null;
}

export function watchPath(t: WatchTarget, extra?: Record<string, string>): string {
  const p = new URLSearchParams();
  if (t.season != null && !t.mediaId.startsWith('anime:')) p.set('s', String(t.season));
  if (t.episode != null) p.set('e', String(t.episode));
  for (const [k, v] of Object.entries(extra ?? {})) p.set(k, v);
  const [type, id] = t.mediaId.split(':');
  const q = p.toString();
  return `/watch/${type}/${id}${q ? `?${q}` : ''}`;
}

/** A new issue on the project's tracker, with the details a bug report needs filled in. */
export function reportIssueUrl(cfg: Pick<AppConfig, 'projectUrl' | 'version' | 'mode' | 'torrentMode'>): string {
  const body = [
    '**What happened?**',
    '',
    '',
    '**What did you expect to happen?**',
    '',
    '',
    '**Steps to reproduce**',
    '1. ',
    '',
    '---',
    `Nova ${cfg.version} · ${cfg.mode === 'desktop' ? 'desktop app' : `server (torrents: ${cfg.torrentMode})`}`,
    `Browser: ${navigator.userAgent}`,
  ].join('\n');
  return `${cfg.projectUrl}/issues/new?${new URLSearchParams({ body })}`;
}

export const HOME_SECTIONS = ['hero', 'continue', 'upnext', 'collections', 'live', 'reading', 'mylist', 'foryou', 'trending', 'because', 'new', 'airing'];

/** A profile's saved Home order, with sections added since it was saved slotted in where they belong. */
export function homeSectionOrder(saved: string[] | undefined): string[] {
  if (!saved) return HOME_SECTIONS;
  const out = [...saved];
  HOME_SECTIONS.forEach((id, i) => {
    if (out.includes(id)) return;
    const before = HOME_SECTIONS.slice(0, i).reverse().find((p) => out.includes(p));
    out.splice(before ? out.indexOf(before) + 1 : 0, 0, id);
  });
  return out;
}

export function kindLabel(t: string): string {
  return t === 'movie' ? 'Movie' : t === 'tv' ? 'Series' : t === 'anime' ? 'Anime' : t;
}

export function metaLine(item: Pick<CatalogItem, 'year' | 'runtime' | 'mediaType'>): string {
  return [item.year, fmtRuntime(item.runtime), kindLabel(item.mediaType)].filter(Boolean).join(' · ');
}

const LANG_NAMES: Record<string, string> = {
  en: 'English', ja: 'Japanese', nl: 'Dutch', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese',
  ru: 'Russian', ko: 'Korean', zh: 'Chinese', ar: 'Arabic', hi: 'Hindi', pl: 'Polish', sv: 'Swedish', no: 'Norwegian',
  da: 'Danish', fi: 'Finnish', tr: 'Turkish', cs: 'Czech', el: 'Greek', he: 'Hebrew', hu: 'Hungarian', id: 'Indonesian',
  th: 'Thai', vi: 'Vietnamese', uk: 'Ukrainian', ro: 'Romanian',
};
export const LANGUAGES = Object.entries(LANG_NAMES).map(([code, name]) => ({ code, name }));

const ISO3: Record<string, string> = {
  eng: 'en', jpn: 'ja', dut: 'nl', nld: 'nl', ger: 'de', deu: 'de', fre: 'fr', fra: 'fr', spa: 'es', ita: 'it', por: 'pt',
  rus: 'ru', kor: 'ko', chi: 'zh', zho: 'zh', ara: 'ar', hin: 'hi', pol: 'pl', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi',
  tur: 'tr', cze: 'cs', ces: 'cs', gre: 'el', ell: 'el', heb: 'he', hun: 'hu', ind: 'id', tha: 'th', vie: 'vi', ukr: 'uk',
  rum: 'ro', ron: 'ro',
};

export function langCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const l = raw.toLowerCase().split(/[-_]/)[0]!;
  return l.length === 3 ? (ISO3[l] ?? l) : l;
}

export const langName = (raw: string | null | undefined) => {
  const c = langCode(raw);
  return c ? (LANG_NAMES[c] ?? c.toUpperCase()) : 'Unknown';
};

/** Does a track (language tag and/or title) match a 2-letter language preference? */
export function matchesLanguage(want: string, language: string | null | undefined, title?: string | null): boolean {
  if (langCode(language) === want) return true;
  const name = LANG_NAMES[want];
  return Boolean(name && title && title.toLowerCase().includes(name.toLowerCase()));
}

export function cls(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
