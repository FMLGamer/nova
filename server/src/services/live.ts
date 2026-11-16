import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { db } from '../db/index.js';
import { cached } from '../lib/cache.js';
import { newId } from '../lib/crypto.js';
import { HttpError } from '../lib/http.js';
import { activePlugins, callPlugin, getPlugin } from '../plugins/manager.js';
import type { LiveChannel as PluginChannel } from '../plugins/protocol.js';
import { stalkerChannels } from './stalker.js';

export type LiveSourceKind = 'm3u' | 'xtream' | 'hdhomerun' | 'stalker' | 'iptvorg' | 'plugin';

export interface LiveSource {
  id: string;
  kind: LiveSourceKind;
  name: string;
  config: Record<string, string>;
  epgUrl: string | null;
  enabled: boolean;
  channelCount: number;
  lastRefreshedAt: string | null;
  error: string | null;
}

export interface Catchup {
  type: 'default' | 'append' | 'shift' | 'flussonic' | 'xtream';
  source?: string;
  days?: number;
}

export interface Channel {
  id: string;
  sourceId: string;
  name: string;
  number: string | null;
  logo: string | null;
  group: string | null;
  url: string;
  epgId: string | null;
  catchup: Catchup | null;
  country: string | null;
  hidden: boolean;
}

interface SourceRow {
  id: string;
  kind: LiveSourceKind;
  name: string;
  config: string;
  epg_url: string | null;
  enabled: number;
  channel_count: number;
  last_refreshed_at: string | null;
  error: string | null;
}

interface ChannelRow {
  id: string;
  source_id: string;
  name: string;
  number: string | null;
  logo: string | null;
  grp: string | null;
  url: string;
  epg_id: string | null;
  catchup: string | null;
  country: string | null;
  hidden: number;
}

const toSource = (r: SourceRow): LiveSource => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  config: JSON.parse(r.config) as Record<string, string>,
  epgUrl: r.epg_url,
  enabled: r.enabled === 1,
  channelCount: r.channel_count,
  lastRefreshedAt: r.last_refreshed_at,
  error: r.error,
});

const toChannel = (r: ChannelRow): Channel => ({
  id: r.id,
  sourceId: r.source_id,
  name: r.name,
  number: r.number,
  logo: r.logo,
  group: r.grp,
  url: r.url,
  epgId: r.epg_id,
  catchup: r.catchup ? (JSON.parse(r.catchup) as Catchup) : null,
  country: r.country,
  hidden: r.hidden === 1,
});

/** Never expose credentials (Xtream passwords live inside URLs and config). */
export function publicSource(s: LiveSource): LiveSource {
  const config = { ...s.config };
  if (config.password) config.password = '••••••••';
  return { ...s, config };
}

async function fetchText(url: string, timeoutMs = 30_000): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'Nova/2' } });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.text();
}

// ---------------------------------------------------------------- M3U

export interface ParsedEntry {
  name: string;
  url: string;
  tvgId: string | null;
  logo: string | null;
  group: string | null;
  number: string | null;
  catchup: Catchup | null;
  country: string | null;
}

export function parseM3u(text: string): { entries: ParsedEntry[]; epgUrl: string | null } {
  const lines = text.replace(/\r/g, '').split('\n');
  const header = lines[0]?.startsWith('#EXTM3U') ? lines[0] : '';
  const epgUrl = header.match(/(?:url-tvg|x-tvg-url)="([^"]+)"/)?.[1]?.split(',')[0] ?? null;
  const entries: ParsedEntry[] = [];
  let pending: Omit<ParsedEntry, 'url'> | null = null;
  const attr = (line: string, key: string) => line.match(new RegExp(`${key}="([^"]*)"`, 'i'))?.[1] || null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const comma = line.lastIndexOf(',');
      const catchupType = attr(line, 'catchup');
      const days = attr(line, 'catchup-days') ?? attr(line, 'timeshift');
      pending = {
        name: (comma >= 0 ? line.slice(comma + 1) : '').trim() || attr(line, 'tvg-name') || 'Channel',
        tvgId: attr(line, 'tvg-id'),
        logo: attr(line, 'tvg-logo'),
        group: attr(line, 'group-title'),
        number: attr(line, 'tvg-chno') ?? attr(line, 'channel-number'),
        country: attr(line, 'tvg-country'),
        catchup: catchupType
          ? {
              type: (['default', 'append', 'shift', 'flussonic'].includes(catchupType) ? catchupType : 'default') as Catchup['type'],
              source: attr(line, 'catchup-source') ?? undefined,
              days: days ? Number(days) : undefined,
            }
          : null,
      };
      continue;
    }
    if (line.startsWith('#')) continue;
    if (pending && /^(https?|rtmp|udp|rtp):\/\//i.test(line)) {
      entries.push({ ...pending, url: line });
      pending = null;
    }
  }
  return { entries, epgUrl };
}

// ---------------------------------------------------------------- source loaders

async function loadChannels(s: LiveSource): Promise<{ entries: ParsedEntry[]; epgUrl: string | null }> {
  switch (s.kind) {
    case 'm3u':
    case 'iptvorg': {
      if (s.kind === 'iptvorg' && !s.config.url) return { entries: [], epgUrl: null };
      return parseM3u(await fetchText(s.config.url!));
    }
    case 'xtream': {
      const base = s.config.server!.replace(/\/+$/, '');
      const auth = `username=${encodeURIComponent(s.config.username!)}&password=${encodeURIComponent(s.config.password!)}`;
      const [streams, cats] = await Promise.all([
        fetchText(`${base}/player_api.php?${auth}&action=get_live_streams`).then((t) => JSON.parse(t) as {
          stream_id: number;
          name: string;
          stream_icon?: string;
          epg_channel_id?: string;
          category_id?: string;
          num?: number;
          tv_archive?: number;
          tv_archive_duration?: number;
        }[]),
        fetchText(`${base}/player_api.php?${auth}&action=get_live_categories`)
          .then((t) => JSON.parse(t) as { category_id: string; category_name: string }[])
          .catch(() => []),
      ]);
      const catName = new Map(cats.map((c) => [String(c.category_id), c.category_name]));
      const ext = s.config.output === 'ts' ? 'ts' : 'm3u8';
      return {
        epgUrl: `${base}/xmltv.php?${auth}`,
        entries: streams.map((x) => ({
          name: x.name,
          url: `${base}/live/${encodeURIComponent(s.config.username!)}/${encodeURIComponent(s.config.password!)}/${x.stream_id}.${ext}`,
          tvgId: x.epg_channel_id || null,
          logo: x.stream_icon || null,
          group: catName.get(String(x.category_id)) ?? null,
          number: x.num ? String(x.num) : null,
          country: null,
          catchup: x.tv_archive ? { type: 'xtream', source: String(x.stream_id), days: x.tv_archive_duration ?? 1 } : null,
        })),
      };
    }
    case 'hdhomerun': {
      const host = s.config.host!.replace(/^https?:\/\//, '').replace(/\/+$/, '');
      const lineup = JSON.parse(await fetchText(`http://${host}/lineup.json`, 10_000)) as {
        GuideNumber: string;
        GuideName: string;
        URL: string;
        HD?: number;
      }[];
      return {
        epgUrl: null,
        entries: lineup.map((c) => ({
          name: c.GuideName,
          url: c.URL,
          tvgId: null,
          logo: null,
          group: c.HD ? 'HD' : 'Tuner',
          number: c.GuideNumber,
          country: null,
          catchup: null,
        })),
      };
    }
    case 'stalker':
      return { epgUrl: null, entries: await stalkerChannels({ portal: s.config.portal!, mac: s.config.mac! }) };
    case 'plugin': {
      const p = getPlugin(s.config.pluginId!);
      if (!p) throw new Error('plugin not installed');
      const data = await callPlugin<{ channels?: PluginChannel[]; epgUrl?: string }>(p, 'live', { type: 'channel', id: 'lineup' });
      return {
        epgUrl: data.epgUrl ?? null,
        entries: (data.channels ?? []).map((c) => ({
          name: c.name,
          url: c.url,
          tvgId: c.epgId ?? null,
          logo: c.logo ?? null,
          group: c.group ?? null,
          number: c.number ?? null,
          country: null,
          catchup: null,
        })),
      };
    }
  }
}

export function listSources(): LiveSource[] {
  return (db.prepare('SELECT * FROM live_sources ORDER BY created_at').all() as SourceRow[]).map(toSource);
}

function getSource(id: string): LiveSource {
  const r = db.prepare('SELECT * FROM live_sources WHERE id = ?').get(id) as SourceRow | undefined;
  if (!r) throw new HttpError(404, 'Live source not found');
  return toSource(r);
}

export async function refreshSource(id: string): Promise<LiveSource> {
  const s = getSource(id);
  try {
    const { entries, epgUrl } = await loadChannels(s);
    // Keep user choices (hidden) across refreshes by keying channels on source + url/name.
    const hidden = new Set(
      (db.prepare('SELECT name FROM live_channels WHERE source_id = ? AND hidden = 1').all(id) as { name: string }[]).map((r) => r.name),
    );
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM live_channels WHERE source_id = ?').run(id);
      const ins = db.prepare(
        `INSERT INTO live_channels (id, source_id, name, number, logo, grp, url, epg_id, catchup, country, hidden, sort)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      entries.slice(0, 20_000).forEach((e, i) => {
        ins.run(
          `${id.slice(0, 8)}-${i}-${Buffer.from(e.url).toString('base64url').slice(-12)}`,
          id,
          e.name,
          e.number,
          e.logo,
          e.group,
          e.url,
          e.tvgId,
          e.catchup ? JSON.stringify(e.catchup) : null,
          e.country,
          hidden.has(e.name) ? 1 : 0,
          i,
        );
      });
      db.prepare(
        "UPDATE live_sources SET channel_count = ?, last_refreshed_at = datetime('now'), error = NULL, epg_url = COALESCE(epg_url, ?) WHERE id = ?",
      ).run(entries.length, epgUrl, id);
    });
    tx();
  } catch (err) {
    db.prepare('UPDATE live_sources SET error = ? WHERE id = ?').run((err as Error).message.slice(0, 300), id);
  }
  return getSource(id);
}

export async function addSource(input: { kind: LiveSourceKind; name: string; config: Record<string, string>; epgUrl?: string | null }): Promise<LiveSource> {
  const need: Record<LiveSourceKind, string[]> = {
    m3u: ['url'],
    xtream: ['server', 'username', 'password'],
    hdhomerun: ['host'],
    stalker: ['portal', 'mac'],
    iptvorg: [],
    plugin: ['pluginId'],
  };
  for (const k of need[input.kind]) if (!input.config[k]) throw new HttpError(400, `Missing ${k}`);
  const id = newId();
  db.prepare('INSERT INTO live_sources (id, kind, name, config, epg_url) VALUES (?, ?, ?, ?, ?)').run(
    id,
    input.kind,
    input.name,
    JSON.stringify(input.config),
    input.epgUrl ?? null,
  );
  const s = await refreshSource(id);
  if (s.epgUrl) void refreshEpg(id).catch(() => undefined);
  return s;
}

export function updateSource(id: string, patch: { name?: string; enabled?: boolean; epgUrl?: string | null }): LiveSource {
  const s = getSource(id);
  db.prepare('UPDATE live_sources SET name = ?, enabled = ?, epg_url = ? WHERE id = ?').run(
    patch.name ?? s.name,
    patch.enabled === undefined ? (s.enabled ? 1 : 0) : patch.enabled ? 1 : 0,
    patch.epgUrl === undefined ? s.epgUrl : patch.epgUrl,
    id,
  );
  return getSource(id);
}

export function deleteSource(id: string): void {
  db.prepare('DELETE FROM live_sources WHERE id = ?').run(id);
}

export function setChannelHidden(id: string, hidden: boolean): void {
  db.prepare('UPDATE live_channels SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id);
}

export function getChannel(id: string): Channel {
  const r = db.prepare('SELECT * FROM live_channels WHERE id = ?').get(id) as ChannelRow | undefined;
  if (!r) throw new HttpError(404, 'Channel not found');
  return toChannel(r);
}

export function listChannels(opts: { includeHidden?: boolean; profileId?: string } = {}): (Channel & { favorite: boolean })[] {
  const favs = new Set(
    opts.profileId
      ? (db.prepare('SELECT channel_id FROM live_favorites WHERE profile_id = ?').all(opts.profileId) as { channel_id: string }[]).map((r) => r.channel_id)
      : [],
  );
  const rows = db
    .prepare(
      `SELECT c.* FROM live_channels c JOIN live_sources s ON s.id = c.source_id
        WHERE s.enabled = 1 ${opts.includeHidden ? '' : 'AND c.hidden = 0'}
        ORDER BY s.created_at, CAST(c.number AS REAL), c.sort`,
    )
    .all() as ChannelRow[];
  return rows.map((r) => ({ ...toChannel(r), favorite: favs.has(r.id) })).sort((a, b) => Number(b.favorite) - Number(a.favorite));
}

export function toggleFavorite(profileId: string, channelId: string, on: boolean): void {
  if (on) db.prepare('INSERT OR IGNORE INTO live_favorites (profile_id, channel_id) VALUES (?, ?)').run(profileId, channelId);
  else db.prepare('DELETE FROM live_favorites WHERE profile_id = ? AND channel_id = ?').run(profileId, channelId);
}

// ---------------------------------------------------------------- EPG (XMLTV)

export interface Programme {
  epgId: string;
  start: number;
  stop: number;
  title: string;
  subtitle: string | null;
  description: string | null;
  category: string | null;
  image: string | null;
}

function xmltvTime(s: string): number {
  // 20240101120000 +0100
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/);
  if (!m) return 0;
  const [, y, mo, d, h, mi, se, tz] = m;
  let t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se ?? 0));
  if (tz) {
    const sign = tz.startsWith('-') ? -1 : 1;
    t -= sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5))) * 60_000;
  }
  return Math.floor(t / 1000);
}

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();

/**
 * Streams an XMLTV guide (optionally gzipped) and keeps only programmes for
 * channels in our lineup within a -6h..+48h window, so a 200 MB guide never
 * sits in memory.
 */
export async function refreshEpg(sourceId: string): Promise<number> {
  const s = getSource(sourceId);
  if (!s.epgUrl) return 0;
  const wanted = new Set(
    (db.prepare('SELECT DISTINCT epg_id FROM live_channels WHERE source_id = ? AND epg_id IS NOT NULL').all(sourceId) as { epg_id: string }[]).map((r) => r.epg_id),
  );
  if (!wanted.size) return 0;
  const res = await fetch(s.epgUrl, { signal: AbortSignal.timeout(180_000), headers: { 'User-Agent': 'Nova/2' } });
  if (!res.ok || !res.body) throw new Error(`EPG answered ${res.status}`);
  let stream: Readable = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
  const gz = /\.gz($|\?)/.test(s.epgUrl) || res.headers.get('content-type')?.includes('gzip');
  if (gz) stream = stream.pipe(createGunzip());
  const now = Math.floor(Date.now() / 1000);
  const from = now - 6 * 3600;
  const to = now + 48 * 3600;
  const ins = db.prepare(
    `INSERT OR REPLACE INTO epg_programmes (epg_id, start, stop, title, subtitle, description, category, image)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let buf = '';
  let count = 0;
  let batch: Programme[] = [];
  const flush = () => {
    const rows = batch;
    batch = [];
    db.transaction(() => {
      for (const p of rows) ins.run(p.epgId, p.start, p.stop, p.title, p.subtitle, p.description, p.category, p.image);
    })();
  };
  stream.setEncoding('utf8');
  for await (const chunk of stream as AsyncIterable<string>) {
    buf += chunk;
    let end: number;
    while ((end = buf.indexOf('</programme>')) >= 0) {
      const startIdx = buf.lastIndexOf('<programme', end);
      const block = startIdx >= 0 ? buf.slice(startIdx, end) : '';
      buf = buf.slice(end + 12);
      const channel = block.match(/channel="([^"]+)"/)?.[1];
      if (!channel || !wanted.has(channel)) continue;
      const start = xmltvTime(block.match(/start="([^"]+)"/)?.[1] ?? '');
      const stop = xmltvTime(block.match(/stop="([^"]+)"/)?.[1] ?? '');
      if (stop < from || start > to) continue;
      batch.push({
        epgId: channel,
        start,
        stop,
        title: decode(block.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? 'Programme'),
        subtitle: block.match(/<sub-title[^>]*>([\s\S]*?)<\/sub-title>/)?.[1] ? decode(block.match(/<sub-title[^>]*>([\s\S]*?)<\/sub-title>/)![1]!) : null,
        description: block.match(/<desc[^>]*>([\s\S]*?)<\/desc>/)?.[1] ? decode(block.match(/<desc[^>]*>([\s\S]*?)<\/desc>/)![1]!).slice(0, 1200) : null,
        category: block.match(/<category[^>]*>([\s\S]*?)<\/category>/)?.[1] ? decode(block.match(/<category[^>]*>([\s\S]*?)<\/category>/)![1]!) : null,
        image: block.match(/<icon\s+src="([^"]+)"/)?.[1] ?? null,
      });
      count++;
      if (batch.length >= 500) flush();
    }
    if (buf.length > 4_000_000) buf = buf.slice(-200_000);
  }
  if (batch.length) flush();
  db.prepare('DELETE FROM epg_programmes WHERE stop < ?').run(now - 7 * 86400);
  return count;
}

export function guide(fromSec: number, toSec: number, epgIds: string[]): Programme[] {
  if (!epgIds.length) return [];
  const out: Programme[] = [];
  for (let i = 0; i < epgIds.length; i += 400) {
    const chunk = epgIds.slice(i, i + 400);
    out.push(
      ...(db
        .prepare(
          `SELECT epg_id AS epgId, start, stop, title, subtitle, description, category, image FROM epg_programmes
            WHERE stop > ? AND start < ? AND epg_id IN (${chunk.map(() => '?').join(',')}) ORDER BY start`,
        )
        .all(fromSec, toSec, ...chunk) as Programme[]),
    );
  }
  return out;
}

/** Upcoming airings whose title matches (linked from library title pages). */
export function airingsFor(title: string, days = 7): (Programme & { channelId: string; channelName: string; channelLogo: string | null })[] {
  const now = Math.floor(Date.now() / 1000);
  return db
    .prepare(
      `SELECT p.epg_id AS epgId, p.start, p.stop, p.title, p.subtitle, p.description, p.category, p.image,
              c.id AS channelId, c.name AS channelName, c.logo AS channelLogo
         FROM epg_programmes p JOIN live_channels c ON c.epg_id = p.epg_id
        WHERE p.stop > ? AND p.start < ? AND p.title LIKE ? AND c.hidden = 0
        ORDER BY p.start LIMIT 12`,
    )
    .all(now, now + days * 86400, title.trim()) as (Programme & { channelId: string; channelName: string; channelLogo: string | null })[];
}

// ---------------------------------------------------------------- catch-up

function fmtUtc(sec: number, pattern: string): string {
  const d = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return pattern
    .replace(/Y/g, String(d.getUTCFullYear()))
    .replace(/m/g, pad(d.getUTCMonth() + 1))
    .replace(/d/g, pad(d.getUTCDate()))
    .replace(/H/g, pad(d.getUTCHours()))
    .replace(/M/g, pad(d.getUTCMinutes()))
    .replace(/S/g, pad(d.getUTCSeconds()));
}

/** Builds a catch-up URL for a past programme, per the channel's catch-up flavour. */
export function catchupUrl(ch: Channel, start: number, stop: number, source: LiveSource): string {
  const c = ch.catchup;
  if (!c) throw new HttpError(400, 'This channel has no catch-up');
  const now = Math.floor(Date.now() / 1000);
  const duration = Math.max(60, stop - start);
  if (c.days && start < now - c.days * 86400) throw new HttpError(400, 'That broadcast is older than the catch-up window');
  const fill = (tpl: string) =>
    tpl
      .replace(/\$\{start\}|\{utc\}|\{start\}/g, String(start))
      .replace(/\$\{end\}|\{utcend\}|\{end\}/g, String(stop))
      .replace(/\$\{timestamp\}|\{lutc\}|\$\{now\}/g, String(now))
      .replace(/\$\{duration\}|\{duration\}/g, String(duration))
      .replace(/\{offset:(\d+)\}/g, (_m, n) => String(Math.floor((now - start) / Number(n))))
      .replace(/\{utc:([^}]+)\}|\$\{\(b\)([^}]+)\}/g, (_m, a, b) => fmtUtc(start, String(a ?? b)))
      .replace(/\{utcend:([^}]+)\}|\$\{\(e\)([^}]+)\}/g, (_m, a, b) => fmtUtc(stop, String(a ?? b)));
  switch (c.type) {
    case 'xtream': {
      const base = source.config.server!.replace(/\/+$/, '');
      const ts = fmtUtc(start, 'Y-m-d:H-M');
      return `${base}/timeshift/${encodeURIComponent(source.config.username!)}/${encodeURIComponent(source.config.password!)}/${Math.ceil(duration / 60)}/${ts}/${c.source}.ts`;
    }
    case 'shift':
      return `${ch.url}${ch.url.includes('?') ? '&' : '?'}utc=${start}&lutc=${now}`;
    case 'flussonic':
      return ch.url.replace(/\/(index|video|mpegts|mono)[^/]*\.(m3u8|ts)$/, `/$1-${start}-${duration}.$2`);
    case 'append':
      return ch.url + fill(c.source ?? '');
    default:
      return c.source ? fill(c.source) : `${ch.url}${ch.url.includes('?') ? '&' : '?'}utc=${start}&lutc=${now}`;
  }
}

export function sourceOf(ch: Channel): LiveSource {
  return getSource(ch.sourceId);
}

// ---------------------------------------------------------------- iptv-org directory

const IPTV_API = 'https://iptv-org.github.io/api';
const IPTV_LISTS = 'https://iptv-org.github.io/iptv';

export async function iptvDirectory(): Promise<{
  countries: { code: string; name: string; flag: string }[];
  categories: { id: string; name: string }[];
  languages: { code: string; name: string }[];
}> {
  return cached('iptvorg:directory', 24 * 3600_000, async () => {
    const [countries, categories, languages] = await Promise.all([
      fetchText(`${IPTV_API}/countries.json`).then((t) => JSON.parse(t) as { code: string; name: string; flag: string }[]),
      fetchText(`${IPTV_API}/categories.json`).then((t) => JSON.parse(t) as { id: string; name: string }[]),
      fetchText(`${IPTV_API}/languages.json`).then((t) => JSON.parse(t) as { code: string; name: string }[]),
    ]);
    return {
      countries: countries.map((c) => ({ code: c.code.toLowerCase(), name: c.name, flag: c.flag })),
      categories: categories.map((c) => ({ id: c.id, name: c.name })),
      languages: languages.map((l) => ({ code: l.code, name: l.name })),
    };
  });
}

/** Channels of one iptv-org public list (by country, category or language). */
export async function iptvBrowse(by: 'countries' | 'categories' | 'languages', code: string): Promise<ParsedEntry[]> {
  if (!/^[a-z0-9_-]{2,40}$/i.test(code)) throw new HttpError(400, 'Invalid list');
  return cached(`iptvorg:${by}:${code}`, 6 * 3600_000, async () => parseM3u(await fetchText(`${IPTV_LISTS}/${by}/${code.toLowerCase()}.m3u`)).entries);
}

function iptvSourceId(): string {
  const row = db.prepare("SELECT id FROM live_sources WHERE kind = 'iptvorg'").get() as { id: string } | undefined;
  if (row) return row.id;
  const id = newId();
  db.prepare("INSERT INTO live_sources (id, kind, name, config) VALUES (?, 'iptvorg', 'Public channels (iptv-org)', '{}')").run(id);
  return id;
}

/** Adds directory channels to the lineup (into the built-in iptv-org source). */
export function addDirectoryChannels(entries: ParsedEntry[]): number {
  const sourceId = iptvSourceId();
  const existing = new Set((db.prepare('SELECT url FROM live_channels WHERE source_id = ?').all(sourceId) as { url: string }[]).map((r) => r.url));
  const max = (db.prepare('SELECT COALESCE(MAX(sort), 0) AS n FROM live_channels WHERE source_id = ?').get(sourceId) as { n: number }).n;
  const ins = db.prepare(
    'INSERT INTO live_channels (id, source_id, name, number, logo, grp, url, epg_id, country, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  let added = 0;
  db.transaction(() => {
    for (const e of entries) {
      if (existing.has(e.url)) continue;
      ins.run(newId(), sourceId, e.name, null, e.logo, e.group, e.url, e.tvgId, e.country, max + ++added);
    }
    db.prepare('UPDATE live_sources SET channel_count = (SELECT COUNT(*) FROM live_channels WHERE source_id = ?) WHERE id = ?').run(sourceId, sourceId);
  })();
  return added;
}

/** Plugins that provide channel lineups (e.g. Stalker/Ministra portals). */
export function livePlugins(): { id: string; name: string }[] {
  return activePlugins('live').map((p) => ({ id: p.id, name: p.manifest.name }));
}

export async function refreshAllLive(): Promise<void> {
  for (const s of listSources().filter((x) => x.enabled && x.kind !== 'iptvorg')) {
    await refreshSource(s.id).catch(() => undefined);
  }
}

export async function refreshAllEpg(): Promise<void> {
  for (const s of listSources().filter((x) => x.enabled && x.epgUrl)) {
    await refreshEpg(s.id).catch((err: Error) => console.error(`[live] EPG ${s.name}:`, err.message));
  }
}
