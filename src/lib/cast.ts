/**
 * Casting from the player. Two routes to a TV:
 * - Nova finds it: the server (or the Nova app on this computer) scans the
 *   network for Chromecasts and DLNA TVs and drives them itself.
 * - The browser finds it: Chrome/Edge's own Cast menu (Google Cast SDK); Nova
 *   only provides the stream and the browser drives the Chromecast.
 */
import { req } from './api';

export interface CastDeviceInfo {
  id: string;
  name: string;
  kind: 'chromecast' | 'dlna';
  model: string | null;
  /** Added by address in the app (removable). */
  saved?: boolean;
}

export type CastSubtitle = { kind: 'embedded'; track: number } | { kind: 'text'; vtt: string; language?: string | null; label?: string | null } | null;

export interface CastStartBody {
  device: string;
  source: string;
  audioTrack: number;
  start: number;
  subtitle: CastSubtitle;
  title: string;
  subtitleLine?: string | null;
  image?: string | null;
}

export interface CastStarted {
  id: string;
  offset: number;
  duration: number | null;
  url?: string;
  contentType?: string;
  subtitles?: boolean;
}

export interface CastStatus {
  device: { name: string; kind: string } | null;
  state: 'IDLE' | 'PLAYING' | 'PAUSED' | 'BUFFERING' | 'error' | string;
  idleReason: string | null;
  position: number;
  duration: number | null;
  produced: number;
  volume: number;
  muted: boolean;
  error: string | null;
}

export const castApi = (base = '') => ({
  devices: (refresh = false) => req<{ devices: CastDeviceInfo[] }>('GET', `${base}/api/cast/devices`, undefined, refresh ? { refresh: 1 } : undefined).then((r) => r.devices),
  addDevice: (address: string) => req<{ device: CastDeviceInfo }>('POST', `${base}/api/cast/devices`, { address }).then((r) => r.device),
  removeDevice: (id: string) => req<void>('DELETE', `${base}/api/cast/devices/${encodeURIComponent(id)}`),
  start: (body: CastStartBody) => req<CastStarted>('POST', `${base}/api/cast/start`, body),
  status: (id: string) => req<CastStatus>('GET', `${base}/api/cast/${id}`),
  control: (id: string, action: 'play' | 'pause' | 'seek' | 'volume', value?: number) => req<{ ok: boolean }>('POST', `${base}/api/cast/${id}/control`, { action, value }),
  restart: (id: string, start: number) => req<{ url: string; offset: number; contentType: string }>('POST', `${base}/api/cast/${id}/restart`, { start }),
  stop: (id: string) => req<void>('DELETE', `${base}/api/cast/${id}`),
});

// ---------------------------------------------------------------- Google Cast SDK (Chrome / Edge)

/* The Cast sender SDK has no bundled types; this is the slice Nova uses. */
interface CastFramework {
  CastContext: { getInstance(): CastContextLike };
  RemotePlayer: new () => RemotePlayerLike;
  RemotePlayerController: new (p: RemotePlayerLike) => RemotePlayerControllerLike;
  RemotePlayerEventType: { ANY_CHANGE: string };
  CastContextEventType: { SESSION_STATE_CHANGED: string };
  SessionState: { SESSION_ENDED: string };
}
interface CastContextLike {
  setOptions(o: Record<string, unknown>): void;
  requestSession(): Promise<unknown>;
  getCurrentSession(): CastSessionLike | null;
  addEventListener(type: string, fn: (e: { sessionState: string }) => void): void;
  removeEventListener(type: string, fn: (e: { sessionState: string }) => void): void;
}
interface CastSessionLike {
  loadMedia(r: unknown): Promise<unknown>;
  getMediaSession(): { media?: { tracks?: { trackId: number; type: string }[] }; editTracksInfo(r: unknown, ok: () => void, err: () => void): void } | null;
  getCastDevice(): { friendlyName: string };
  endSession(stopCasting: boolean): void;
}
interface RemotePlayerLike {
  isConnected: boolean;
  isPaused: boolean;
  currentTime: number;
  duration: number;
  volumeLevel: number;
  isMuted: boolean;
  playerState: string | null;
}
interface RemotePlayerControllerLike {
  playOrPause(): void;
  seek(): void;
  setVolumeLevel(): void;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

type CastWindow = Window & {
  __onGCastApiAvailable?: (ok: boolean) => void;
  cast?: { framework: CastFramework };
  chrome?: { cast?: { media: Record<string, unknown> & { DEFAULT_MEDIA_RECEIVER_APP_ID: string }; AutoJoinPolicy: { ORIGIN_SCOPED: string }; Image: new (url: string) => unknown } };
};

let sdk: Promise<boolean> | null = null;

/** Loads Chrome's Cast SDK (only in Chrome/Edge over HTTPS or localhost; never in the Nova app). */
export function loadCastSdk(): Promise<boolean> {
  sdk ??= new Promise<boolean>((resolve) => {
    const w = window as CastWindow;
    const ua = navigator.userAgent;
    if (!window.isSecureContext || /Electron/i.test(ua) || !/Chrome\//.test(ua) || /Firefox|OPR\//.test(ua)) return resolve(false);
    const t = window.setTimeout(() => resolve(false), 8000);
    w.__onGCastApiAvailable = (ok) => {
      window.clearTimeout(t);
      if (ok && w.cast && w.chrome?.cast) {
        w.cast.framework.CastContext.getInstance().setOptions({
          receiverApplicationId: w.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
          autoJoinPolicy: w.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
        });
      }
      resolve(Boolean(ok));
    };
    const s = document.createElement('script');
    s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
    s.async = true;
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
  return sdk;
}

export interface BrowserCast {
  deviceName: string;
  load(url: string, opts: { duration: number | null; title: string; subtitle?: string | null; image?: string | null; subtitles: boolean }): Promise<void>;
  playOrPause(): void;
  seek(seconds: number): void;
  setVolume(level: number): void;
  stop(): void;
  state(): { connected: boolean; paused: boolean; time: number; duration: number; volume: number; playerState: string | null };
  onChange(fn: () => void): () => void;
}

/** Opens Chrome's device picker and returns a handle to the chosen Chromecast. */
export async function browserCast(): Promise<BrowserCast> {
  const w = window as CastWindow;
  if (!(await loadCastSdk()) || !w.cast || !w.chrome?.cast) throw new Error("This browser can't cast");
  const fw = w.cast.framework;
  const media = w.chrome.cast.media as Record<string, unknown> & Record<string, Record<string, string>>;
  const ctx = fw.CastContext.getInstance();
  await ctx.requestSession();
  const session = ctx.getCurrentSession();
  if (!session) throw new Error('No Chromecast was picked');
  const player = new fw.RemotePlayer();
  const ctl = new fw.RemotePlayerController(player);
  const chromeCast = w.chrome.cast;
  return {
    deviceName: session.getCastDevice().friendlyName,
    async load(url, o) {
      const MediaInfo = media.MediaInfo as unknown as new (id: string, type: string) => Record<string, unknown>;
      const Meta = media.GenericMediaMetadata as unknown as new () => Record<string, unknown>;
      const LoadRequest = media.LoadRequest as unknown as new (m: unknown) => Record<string, unknown>;
      const info = new MediaInfo(url, 'application/x-mpegURL');
      info.streamType = media.StreamType!.BUFFERED;
      info.hlsSegmentFormat = media.HlsSegmentFormat!.TS;
      info.hlsVideoSegmentFormat = media.HlsVideoSegmentFormat!.MPEG2_TS;
      if (o.duration) info.duration = o.duration;
      const meta = new Meta();
      meta.title = o.title;
      if (o.subtitle) meta.subtitle = o.subtitle;
      if (o.image) meta.images = [new chromeCast.Image(o.image)];
      info.metadata = meta;
      const request = new LoadRequest(info);
      request.autoplay = true;
      await session.loadMedia(request);
      // A still-growing playlist can start at its live edge: bring it back to the start.
      window.setTimeout(() => {
        if (player.currentTime > 15) {
          player.currentTime = 0;
          ctl.seek();
        }
      }, 2500);
      if (!o.subtitles) return;
      // The subtitle rendition is in the stream; switch it on once the TV has listed it.
      const EditTracks = media.EditTracksInfoRequest as unknown as new (ids: number[]) => unknown;
      for (let i = 0; i < 20; i++) {
        const ms = session.getMediaSession();
        const text = ms?.media?.tracks?.find((t) => t.type === 'TEXT');
        if (ms && text) {
          ms.editTracksInfo(new EditTracks([text.trackId]), () => undefined, () => undefined);
          return;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    },
    playOrPause: () => ctl.playOrPause(),
    seek(seconds) {
      player.currentTime = seconds;
      ctl.seek();
    },
    setVolume(level) {
      player.volumeLevel = level;
      ctl.setVolumeLevel();
    },
    stop: () => ctx.getCurrentSession()?.endSession(true),
    state: () => ({
      connected: player.isConnected,
      paused: player.isPaused,
      time: player.currentTime,
      duration: player.duration,
      volume: player.volumeLevel,
      playerState: player.playerState,
    }),
    onChange(fn) {
      ctl.addEventListener(fw.RemotePlayerEventType.ANY_CHANGE, fn);
      return () => ctl.removeEventListener(fw.RemotePlayerEventType.ANY_CHANGE, fn);
    },
  };
}
