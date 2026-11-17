/**
 * Finds things to cast to on the local network: Chromecasts / Google TVs over
 * mDNS (`_googlecast._tcp`) and DLNA/UPnP media renderers (smart TVs, Kodi,
 * receivers) over SSDP. Only works when this server shares a network with
 * them (the Windows app, or Docker with host networking).
 */
import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';
import makeMdns from 'multicast-dns';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { HttpError } from '../lib/http.js';

export interface CastDevice {
  id: string;
  name: string;
  kind: 'chromecast' | 'dlna';
  host: string;
  port: number;
  model: string | null;
  /** DLNA: absolute SOAP control URLs. */
  avTransport?: string;
  renderingControl?: string;
  /** Added by hand in the app (can be removed there). */
  saved?: boolean;
}

/** IPv4 addresses of this machine's real network interfaces. */
export function lanAddresses(): { address: string; netmask: string }[] {
  const out: { address: string; netmask: string }[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) out.push({ address: i.address, netmask: i.netmask });
    }
  }
  return out;
}

const toInt = (ip: string) => ip.split('.').reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;

/** The local address on the same subnet as `peer` (what the device must use to reach us), if any. */
export function addressFacing(peer: string): string | null {
  const p = toInt(peer);
  const same = lanAddresses().find((a) => ((toInt(a.address) & toInt(a.netmask)) >>> 0) === ((p & toInt(a.netmask)) >>> 0));
  return same?.address ?? null;
}

// ---------------------------------------------------------------- mDNS (Chromecast)

function txtMap(data: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const list = Array.isArray(data) ? data : [data];
  for (const b of list) {
    const s = Buffer.isBuffer(b) ? b.toString('utf8') : String(b ?? '');
    const eq = s.indexOf('=');
    if (eq > 0) out[s.slice(0, eq)] = s.slice(eq + 1);
  }
  return out;
}

function scanChromecasts(ms: number): Promise<CastDevice[]> {
  return new Promise((resolve) => {
    const found = new Map<string, CastDevice>();
    const hosts = new Map<string, string>();
    const pending = new Map<string, { target: string; port: number; txt: Record<string, string> }>();
    const instances = lanAddresses().map((a) => a.address);
    const sockets = (instances.length ? instances : [undefined]).map((iface) => {
      try {
        return makeMdns({ interface: iface, reuseAddr: true });
      } catch {
        return null;
      }
    });
    const settle = () => {
      for (const [name, s] of pending) {
        const host = hosts.get(s.target);
        if (!host) continue;
        const id = s.txt.id ? `cc:${s.txt.id}` : `cc:${host}:${s.port}`;
        found.set(id, {
          id,
          name: s.txt.fn || name.replace(/\._googlecast\._tcp\.local$/, ''),
          kind: 'chromecast',
          host,
          port: s.port,
          model: s.txt.md || null,
        });
      }
    };
    for (const m of sockets) {
      if (!m) continue;
      m.on('error', () => undefined);
      m.on('response', (res) => {
        const records = [...res.answers, ...res.additionals];
        for (const r of records) {
          if (r.type === 'A') hosts.set(r.name, r.data as string);
        }
        for (const r of records) {
          if (r.type !== 'SRV' || !r.name.includes('_googlecast._tcp')) continue;
          const srv = r.data as { target: string; port: number };
          const txt = records.find((x) => x.type === 'TXT' && x.name === r.name) as { data?: unknown } | undefined;
          pending.set(r.name, { target: srv.target, port: srv.port, txt: txt ? txtMap(txt.data) : pending.get(r.name)?.txt ?? {} });
        }
        settle();
      });
      m.query({ questions: [{ name: '_googlecast._tcp.local', type: 'PTR' }] });
      setTimeout(() => m.query({ questions: [{ name: '_googlecast._tcp.local', type: 'PTR' }] }), 600).unref();
    }
    setTimeout(() => {
      settle();
      for (const m of sockets) m?.destroy();
      resolve([...found.values()]);
    }, ms).unref();
  });
}

// ---------------------------------------------------------------- SSDP (DLNA)

const SSDP_ADDR = '239.255.255.250';
const RENDERER = 'urn:schemas-upnp-org:device:MediaRenderer:1';

function ssdpLocations(ms: number): Promise<Set<string>> {
  return new Promise((resolve) => {
    const locations = new Set<string>();
    const msg = Buffer.from(
      ['M-SEARCH * HTTP/1.1', `HOST: ${SSDP_ADDR}:1900`, 'MAN: "ssdp:discover"', 'MX: 2', `ST: ${RENDERER}`, '', ''].join('\r\n'),
    );
    const addrs = lanAddresses().map((a) => a.address);
    const sockets = (addrs.length ? addrs : ['0.0.0.0']).map((addr) => {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      s.on('error', () => undefined);
      s.on('message', (buf) => {
        const loc = /^location:\s*(\S+)/im.exec(buf.toString('utf8'))?.[1];
        if (loc) locations.add(loc);
      });
      s.bind(0, addr === '0.0.0.0' ? undefined : addr, () => {
        try {
          if (addr !== '0.0.0.0') s.setMulticastInterface(addr);
          s.setMulticastTTL(2);
          s.send(msg, 1900, SSDP_ADDR);
          setTimeout(() => s.send(msg, 1900, SSDP_ADDR), 500).unref();
        } catch {
          /* interface without multicast */
        }
      });
      return s;
    });
    setTimeout(() => {
      for (const s of sockets) s.close();
      resolve(locations);
    }, ms).unref();
  });
}

const tag = (xml: string, name: string) => new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`, 'i').exec(xml)?.[1]?.trim() ?? null;

async function describe(location: string): Promise<CastDevice | null> {
  try {
    const res = await fetch(location, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const xml = await res.text();
    if (!/MediaRenderer/i.test(xml)) return null;
    const base = tag(xml, 'URLBase') ?? location;
    const service = (type: string) => {
      for (const m of xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)) {
        if (new RegExp(`service:${type}:`, 'i').test(m[1]!)) {
          const ctl = tag(m[1]!, 'controlURL');
          return ctl ? new URL(ctl, base).toString() : undefined;
        }
      }
      return undefined;
    };
    const avTransport = service('AVTransport');
    if (!avTransport) return null;
    const url = new URL(location);
    const udn = tag(xml, 'UDN') ?? location;
    return {
      id: `dlna:${udn.replace(/^uuid:/, '')}`,
      name: tag(xml, 'friendlyName') ?? url.hostname,
      kind: 'dlna',
      host: url.hostname,
      port: Number(url.port) || 80,
      model: [tag(xml, 'manufacturer'), tag(xml, 'modelName')].filter(Boolean).join(' ') || null,
      avTransport,
      renderingControl: service('RenderingControl'),
    };
  } catch {
    return null;
  }
}

async function scanDlna(ms: number): Promise<CastDevice[]> {
  const locations = await ssdpLocations(ms);
  const devices = await Promise.all([...locations].map(describe));
  const byId = new Map<string, CastDevice>();
  for (const d of devices) if (d) byId.set(d.id, d);
  return [...byId.values()];
}

// ---------------------------------------------------------------- devices added by hand (CAST_DEVICES + the app)

interface SavedDevice {
  /** Same format as CAST_DEVICES: "chromecast:host[:port]" or "dlna:<description URL>". */
  entry: string;
  name: string;
  id: string;
  host: string;
}

const SAVED_KEY = 'cast.devices';

function savedDevices(): SavedDevice[] {
  const row = db.prepare('SELECT value FROM server_settings WHERE key = ?').get(SAVED_KEY) as { value: string } | undefined;
  try {
    return row ? (JSON.parse(row.value) as SavedDevice[]) : [];
  } catch {
    return [];
  }
}

function writeSaved(list: SavedDevice[]): void {
  db.prepare(
    `INSERT INTO server_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(SAVED_KEY, JSON.stringify(list));
  last = null;
}

function chromecastEntry(value: string, name: string | null, saved: boolean): CastDevice {
  const [host, port] = value.split(':');
  return { id: `cc:manual:${host}`, name: name ?? `Chromecast (${host})`, kind: 'chromecast', host: host!, port: Number(port) || 8009, model: null, saved };
}

async function manualDevices(): Promise<CastDevice[]> {
  const entries = [
    ...config.castDevices.map((entry) => ({ entry, name: null as string | null, saved: false })),
    ...savedDevices().map((s) => ({ ...s, saved: true })),
  ];
  const out = await Promise.all(
    entries.map(async ({ entry, name, saved }): Promise<CastDevice | null> => {
      const [kind, ...rest] = entry.split(':');
      const value = rest.join(':');
      if (kind === 'dlna') {
        const d = await describe(value);
        return d ? { ...d, saved } : null;
      }
      return kind === 'chromecast' && value ? chromecastEntry(value, name, saved) : null;
    }),
  );
  return out.filter((d): d is CastDevice => d !== null);
}

/** Does a Chromecast answer on host:port? (The Cast protocol runs over TLS on 8009.) */
function chromecastAnswers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port, rejectUnauthorized: false, timeout: 2500 });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once('secureConnect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

async function chromecastName(host: string): Promise<string | null> {
  try {
    const res = await fetch(`http://${host}:8008/setup/eureka_info?params=name`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? (((await res.json()) as { name?: string }).name ?? null) : null;
  } catch {
    return null;
  }
}

/** Asks one address directly for a media renderer (SSDP search sent to the device instead of the group). */
function unicastSsdp(host: string): Promise<string | null> {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const msg = Buffer.from(['M-SEARCH * HTTP/1.1', `HOST: ${host}:1900`, 'MAN: "ssdp:discover"', 'MX: 1', `ST: ${RENDERER}`, '', ''].join('\r\n'));
    const finish = (loc: string | null) => {
      clearTimeout(timer);
      s.close();
      resolve(loc);
    };
    const timer = setTimeout(() => finish(null), 2500);
    s.on('error', () => finish(null));
    s.on('message', (buf) => {
      const loc = /^location:\s*(\S+)/im.exec(buf.toString('utf8'))?.[1];
      if (loc) finish(loc);
    });
    s.send(msg, 1900, host, (err) => err && finish(null));
    setTimeout(() => s.send(msg, 1900, host, () => undefined), 700).unref();
  });
}

const HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)(?::(\d{1,5}))?$/i;

/**
 * Adds a TV the scan can't see. Accepts an address ("192.168.1.40", "tv.lan:8009") or a DLNA
 * description URL, works out what answers there, and remembers it for everyone on this server.
 */
export async function addDevice(input: string): Promise<CastDevice> {
  const value = input.trim();
  let entry: string;
  let device: CastDevice | null = null;
  if (/^https?:\/\//i.test(value)) {
    device = await describe(value);
    entry = `dlna:${value}`;
  } else {
    const m = HOST.exec(value);
    if (!m) throw new HttpError(400, 'Enter an IP address (like 192.168.1.40) or a DLNA description URL');
    const host = m[1] ? value.slice(0, value.lastIndexOf(':')) : value;
    const port = m[1] ? Number(m[1]) : 8009;
    if (/^\d+(\.\d+){3}$/.test(host) && !net.isIP(host)) throw new HttpError(400, 'That is not a valid IP address');
    if (await chromecastAnswers(host, port)) {
      entry = `chromecast:${host}${port === 8009 ? '' : `:${port}`}`;
      device = chromecastEntry(entry.slice('chromecast:'.length), await chromecastName(host), true);
    } else {
      const location = await unicastSsdp(host);
      device = location ? await describe(location) : null;
      entry = `dlna:${location ?? ''}`;
    }
  }
  if (!device) throw new HttpError(404, `No Chromecast or DLNA TV answered at ${value}. Check that the TV is on and that this address is right.`);
  const list = savedDevices().filter((s) => s.entry !== entry && s.id !== device.id);
  writeSaved([...list, { entry, name: device.name, id: device.id, host: device.host }]);
  return { ...device, saved: true };
}

export async function removeDevice(id: string): Promise<void> {
  const list = savedDevices();
  let keep = list.filter((s) => s.id !== id);
  if (keep.length === list.length) {
    // Listed under the id discovery gave it (e.g. a saved Chromecast that also announces itself).
    const host = (await discoverDevices()).find((d) => d.id === id)?.host;
    keep = host ? list.filter((s) => s.host !== host) : list;
  }
  if (keep.length === list.length) throw new HttpError(404, 'Only TVs added in the app can be removed here');
  writeSaved(keep);
}

// ---------------------------------------------------------------- cache

let last: { at: number; devices: CastDevice[] } | null = null;
let running: Promise<CastDevice[]> | null = null;

/** Devices seen in the last scan; scans again when asked or when the list is old. */
export async function discoverDevices(force = false): Promise<CastDevice[]> {
  if (!force && last && Date.now() - last.at < 60_000) return last.devices;
  running ??= (async () => {
    try {
      const [cc, dlna, manual] = await Promise.all([scanChromecasts(2500), scanDlna(2500), manualDevices()]);
      // A Google TV answers both; casting to it works best as a Chromecast.
      const ccHosts = new Set([...cc, ...manual.filter((d) => d.kind === 'chromecast')].map((d) => d.host));
      const savedHosts = new Set(manual.filter((d) => d.saved).map((d) => d.host));
      const byId = new Map<string, CastDevice>();
      for (const d of [...manual, ...cc, ...dlna.filter((x) => !ccHosts.has(x.host))]) {
        if (d.kind === 'chromecast' && d.id.startsWith('cc:manual:') && cc.some((x) => x.host === d.host)) continue;
        if (byId.has(d.id)) continue;
        byId.set(d.id, savedHosts.has(d.host) ? { ...d, saved: true } : d);
      }
      const devices = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
      last = { at: Date.now(), devices };
      return devices;
    } finally {
      running = null;
    }
  })();
  return running;
}

export function knownDevice(id: string): CastDevice | null {
  return last?.devices.find((d) => d.id === id) ?? null;
}
