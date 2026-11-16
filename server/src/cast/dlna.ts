/** UPnP AV (DLNA) renderer control: AVTransport + RenderingControl over SOAP. */
import type { CastDevice } from './discovery.js';

const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
const RC = 'urn:schemas-upnp-org:service:RenderingControl:1';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function soap(url: string, service: string, action: string, args: Record<string, string | number>): Promise<string> {
  const body =
    `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>` +
    `<u:${action} xmlns:u="${service}">${Object.entries(args)
      .map(([k, v]) => `<${k}>${esc(String(v))}</${k}>`)
      .join('')}</u:${action}></s:Body></s:Envelope>`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${service}#${action}"` },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) {
    const code = /<errorDescription>([^<]*)</i.exec(text)?.[1] ?? `HTTP ${res.status}`;
    throw new Error(`The TV refused ${action}: ${code}`);
  }
  return text;
}

const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`, 'i').exec(xml)?.[1] ?? '';

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function seconds(c: string): number | null {
  const m = /^(\d+):(\d{2}):(\d{2})/.exec(c);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

export interface DlnaLoad {
  url: string;
  mime: string;
  title: string;
  subtitleUrl?: string | null;
  /** Live transcodes can't be seeked or sized by the TV. */
  streaming?: boolean;
}

export class DlnaRenderer {
  status = { playerState: 'IDLE', currentTime: 0, duration: null as number | null, volume: 1, muted: false };

  constructor(private device: CastDevice) {}

  async load(m: DlnaLoad): Promise<void> {
    const flags = m.streaming ? 'DLNA.ORG_OP=00;DLNA.ORG_CI=1;DLNA.ORG_FLAGS=01700000000000000000000000000000' : 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';
    const subs = m.subtitleUrl
      ? `<res protocolInfo="http-get:*:text/srt:*">${esc(m.subtitleUrl)}</res><sec:CaptionInfoEx sec:type="srt">${esc(m.subtitleUrl)}</sec:CaptionInfoEx>`
      : '';
    const didl =
      `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
      `xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:sec="http://www.sec.co.kr/">` +
      `<item id="0" parentID="-1" restricted="1"><dc:title>${esc(m.title)}</dc:title><upnp:class>object.item.videoItem</upnp:class>` +
      `<res protocolInfo="http-get:*:${m.mime}:${flags}">${esc(m.url)}</res>${subs}</item></DIDL-Lite>`;
    await soap(this.device.avTransport!, AVT, 'Stop', { InstanceID: 0 }).catch(() => undefined);
    await soap(this.device.avTransport!, AVT, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: m.url, CurrentURIMetaData: didl });
    await this.play();
  }

  async play(): Promise<void> {
    await soap(this.device.avTransport!, AVT, 'Play', { InstanceID: 0, Speed: 1 });
  }

  async pause(): Promise<void> {
    await soap(this.device.avTransport!, AVT, 'Pause', { InstanceID: 0 });
  }

  async seek(sec: number): Promise<void> {
    await soap(this.device.avTransport!, AVT, 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: clock(sec) });
  }

  async stop(): Promise<void> {
    await soap(this.device.avTransport!, AVT, 'Stop', { InstanceID: 0 }).catch(() => undefined);
  }

  async setVolume(level: number): Promise<void> {
    if (!this.device.renderingControl) throw new Error('This TV does not allow changing its volume');
    await soap(this.device.renderingControl, RC, 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: Math.round(Math.max(0, Math.min(1, level)) * 100) });
    this.status.volume = level;
  }

  async poll(): Promise<typeof this.status> {
    const [info, pos] = await Promise.all([
      soap(this.device.avTransport!, AVT, 'GetTransportInfo', { InstanceID: 0 }),
      soap(this.device.avTransport!, AVT, 'GetPositionInfo', { InstanceID: 0 }),
    ]);
    const state = tag(info, 'CurrentTransportState');
    this.status = {
      ...this.status,
      playerState: state === 'PLAYING' ? 'PLAYING' : state === 'PAUSED_PLAYBACK' ? 'PAUSED' : state === 'TRANSITIONING' ? 'BUFFERING' : 'IDLE',
      currentTime: seconds(tag(pos, 'RelTime')) ?? this.status.currentTime,
      duration: seconds(tag(pos, 'TrackDuration')) || this.status.duration,
    };
    if (this.device.renderingControl) {
      const v = await soap(this.device.renderingControl, RC, 'GetVolume', { InstanceID: 0, Channel: 'Master' }).catch(() => '');
      const n = Number(tag(v, 'CurrentVolume'));
      if (v && Number.isFinite(n)) this.status.volume = n / 100;
    }
    return this.status;
  }
}
