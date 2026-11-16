// Stalker / Ministra middleware portals (MAG set-top-box API). A portal hands out
// short-lived stream links, so channels are stored as `stalker:<cmd>` and resolved
// to a real URL each time someone presses play.

const UA = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';

export interface StalkerConfig {
  portal: string;
  mac: string;
}

interface Session {
  token: string;
  api: string;
  at: number;
}

const sessions = new Map<string, Session>();

/** `http://host/stalker_portal/c/` -> `http://host/stalker_portal/server/load.php`; bare hosts use `/portal.php`. */
function apiUrl(portal: string): string {
  const u = new URL(portal.trim());
  if (/\/c\/?$/.test(u.pathname)) return new URL(u.pathname.replace(/\/c\/?$/, '/server/load.php'), u.origin).toString();
  if (/load\.php$|portal\.php$/.test(u.pathname)) return u.toString().split('?')[0]!;
  return new URL('/portal.php', u.origin).toString();
}

export function stalkerHeaders(cfg: StalkerConfig, token?: string): Record<string, string> {
  const mac = cfg.mac.trim().toUpperCase();
  return {
    'User-Agent': UA,
    'X-User-Agent': 'Model: MAG250; Link: WiFi',
    Cookie: `mac=${encodeURIComponent(mac)}; stb_lang=en; timezone=UTC`,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function call<T>(cfg: StalkerConfig, s: Session | null, params: Record<string, string>): Promise<T> {
  const base = s?.api ?? apiUrl(cfg.portal);
  const qs = new URLSearchParams({ ...params, JsHttpRequest: '1-xml' });
  const res = await fetch(`${base}?${qs}`, { headers: stalkerHeaders(cfg, s?.token), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Portal answered ${res.status}`);
  const body = (await res.json()) as { js?: T };
  if (body.js === undefined) throw new Error('Portal returned no data');
  return body.js;
}

async function session(cfg: StalkerConfig): Promise<Session> {
  const key = `${cfg.portal}|${cfg.mac}`;
  const hit = sessions.get(key);
  if (hit && Date.now() - hit.at < 25 * 60_000) return hit;
  const shake = await call<{ token?: string }>(cfg, null, { type: 'stb', action: 'handshake', token: '' });
  if (!shake.token) throw new Error('Portal refused the handshake — check the MAC address');
  const s: Session = { token: shake.token, api: apiUrl(cfg.portal), at: Date.now() };
  await call(cfg, s, { type: 'stb', action: 'get_profile', hd: '1', sn: '', stb_type: 'MAG250', ver: 'ImageDescription: 0.2.18-r23-250' }).catch(() => undefined);
  sessions.set(key, s);
  return s;
}

export interface StalkerEntry {
  name: string;
  url: string;
  tvgId: string | null;
  logo: string | null;
  group: string | null;
  number: string | null;
  country: null;
  catchup: null;
}

export async function stalkerChannels(cfg: StalkerConfig): Promise<StalkerEntry[]> {
  const s = await session(cfg);
  const [genres, channels] = await Promise.all([
    call<{ id: string; title: string }[]>(cfg, s, { type: 'itv', action: 'get_genres' }).catch(() => []),
    call<{ data: { id: string; name: string; number?: string; logo?: string; cmd: string; tv_genre_id?: string; xmltv_id?: string }[] }>(cfg, s, {
      type: 'itv',
      action: 'get_all_channels',
    }),
  ]);
  const genre = new Map(genres.map((g) => [String(g.id), g.title]));
  const origin = new URL(cfg.portal).origin;
  return channels.data.map((c) => ({
    name: c.name,
    url: `stalker:${c.cmd}`,
    tvgId: c.xmltv_id || null,
    logo: c.logo ? (/^https?:/.test(c.logo) ? c.logo : `${origin}/stalker_portal/misc/logos/320/${c.logo}`) : null,
    group: genre.get(String(c.tv_genre_id)) ?? null,
    number: c.number ? String(c.number) : null,
    country: null,
    catchup: null,
  }));
}

/** Exchanges a channel's `cmd` for a playable (short-lived) URL. */
export async function stalkerLink(cfg: StalkerConfig, cmd: string): Promise<string> {
  const s = await session(cfg);
  const r = await call<{ cmd?: string }>(cfg, s, { type: 'itv', action: 'create_link', cmd, forced_storage: 'undefined', disable_ad: '0' });
  const link = (r.cmd ?? cmd).replace(/^(ffmpeg|ffrt\d?|auto)\s+/i, '').trim();
  if (!/^https?:\/\//i.test(link)) throw new Error('Portal returned no stream link');
  return link;
}
