/**
 * A small Chromecast (Cast v2) sender: TLS to port 8009, length-prefixed
 * protobuf CastMessages carrying JSON. Enough to launch the Default Media
 * Receiver, load a stream with subtitles and drive playback.
 */
import { EventEmitter } from 'node:events';
import tls from 'node:tls';

const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
};
const DEFAULT_MEDIA_RECEIVER = 'CC1AD845';
const SENDER = 'sender-nova';

// ---------------------------------------------------------------- protobuf (CastMessage)

function varint(n: number): Buffer {
  const out: number[] = [];
  let v = n >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}

function field(num: number, value: string | number): Buffer {
  if (typeof value === 'number') return Buffer.concat([varint((num << 3) | 0), varint(value)]);
  const data = Buffer.from(value, 'utf8');
  return Buffer.concat([varint((num << 3) | 2), varint(data.length), data]);
}

function encode(source: string, destination: string, namespace: string, payload: object): Buffer {
  const body = Buffer.concat([field(1, 0), field(2, source), field(3, destination), field(4, namespace), field(5, 0), field(6, JSON.stringify(payload))]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, body]);
}

interface Message {
  source: string;
  destination: string;
  namespace: string;
  data: Record<string, unknown> | null;
}

function decode(buf: Buffer): Message {
  const m: Message = { source: '', destination: '', namespace: '', data: null };
  let i = 0;
  const readVarint = () => {
    let shift = 0;
    let out = 0;
    for (;;) {
      const b = buf[i++]!;
      out += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return out;
      shift += 7;
    }
  };
  while (i < buf.length) {
    const key = readVarint();
    const num = key >>> 3;
    const wire = key & 7;
    if (wire === 0) {
      readVarint();
      continue;
    }
    if (wire !== 2) break;
    const len = readVarint();
    const val = buf.subarray(i, i + len);
    i += len;
    if (num === 2) m.source = val.toString('utf8');
    else if (num === 3) m.destination = val.toString('utf8');
    else if (num === 4) m.namespace = val.toString('utf8');
    else if (num === 6) {
      try {
        m.data = JSON.parse(val.toString('utf8')) as Record<string, unknown>;
      } catch {
        m.data = null;
      }
    }
  }
  return m;
}

// ---------------------------------------------------------------- session

export interface CastTrack {
  trackId: number;
  type: 'TEXT';
  subtype: 'SUBTITLES';
  trackContentId: string;
  trackContentType: string;
  name: string;
  language: string;
}

export interface LoadRequest {
  url: string;
  contentType: string;
  hls?: boolean;
  duration?: number | null;
  title: string;
  subtitle?: string | null;
  image?: string | null;
  tracks?: CastTrack[];
  /** Turn on the stream's own (in-manifest) subtitle track once it is known. */
  enableManifestText?: boolean;
}

export interface MediaStatus {
  playerState: 'IDLE' | 'PLAYING' | 'PAUSED' | 'BUFFERING' | string;
  idleReason?: string;
  currentTime: number;
  duration: number | null;
  volume: number;
  muted: boolean;
}

export class Chromecast extends EventEmitter {
  private socket: tls.TLSSocket | null = null;
  private buffer = Buffer.alloc(0);
  private requestId = 1;
  private waiting = new Map<number, { resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private heartbeat: NodeJS.Timeout | null = null;
  private transportId: string | null = null;
  private appSessionId: string | null = null;
  private mediaSessionId: number | null = null;
  private wantText = false;
  /** A growing HLS playlist may start at its live edge; pull it back to the start once. */
  private rewind = false;
  status: MediaStatus = { playerState: 'IDLE', currentTime: 0, duration: null, volume: 1, muted: false };
  closed = false;

  constructor(
    private host: string,
    private port = 8009,
  ) {
    super();
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const s = tls.connect({ host: this.host, port: this.port, rejectUnauthorized: false }, () => resolve());
      s.setTimeout(30_000);
      s.on('timeout', () => s.destroy(new Error('Chromecast stopped responding')));
      s.on('error', (e) => {
        reject(e);
        this.fail(e);
      });
      s.on('close', () => this.fail(new Error('Connection to the Chromecast closed')));
      s.on('data', (d) => this.onData(d));
      this.socket = s;
    });
    this.send('receiver-0', NS.connection, { type: 'CONNECT' });
    this.heartbeat = setInterval(() => this.send('receiver-0', NS.heartbeat, { type: 'PING' }), 5000);
  }

  private fail(e: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.reject(e);
    }
    this.waiting.clear();
    this.emit('closed', e);
  }

  private send(destination: string, namespace: string, payload: object): void {
    if (!this.socket || this.closed) return;
    this.socket.write(encode(SENDER, destination, namespace, payload));
  }

  private request(destination: string, namespace: string, payload: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    const requestId = this.requestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        reject(new Error('The Chromecast did not answer'));
      }, timeoutMs);
      this.waiting.set(requestId, { resolve, reject, timer });
      this.send(destination, namespace, { ...payload, requestId });
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + len) break;
      const msg = decode(this.buffer.subarray(4, 4 + len));
      this.buffer = this.buffer.subarray(4 + len);
      this.onMessage(msg);
    }
  }

  private onMessage(m: Message): void {
    const d = m.data;
    if (!d) return;
    if (m.namespace === NS.heartbeat && d.type === 'PING') return this.send(m.source, NS.heartbeat, { type: 'PONG' });
    if (m.namespace === NS.connection && d.type === 'CLOSE') return this.fail(new Error('The Chromecast ended the session'));
    if (m.namespace === NS.receiver && d.type === 'RECEIVER_STATUS') {
      const st = d.status as { volume?: { level?: number; muted?: boolean }; applications?: { appId: string }[] } | undefined;
      if (st?.volume) this.status = { ...this.status, volume: st.volume.level ?? this.status.volume, muted: Boolean(st.volume.muted) };
      // Someone started another app on the TV: our session is over.
      if (this.transportId && !st?.applications?.some((a) => a.appId === DEFAULT_MEDIA_RECEIVER)) this.fail(new Error('Casting was stopped on the TV'));
    }
    if (m.namespace === NS.media && d.type === 'MEDIA_STATUS') this.onMediaStatus(d);
    const id = typeof d.requestId === 'number' ? d.requestId : null;
    const w = id != null ? this.waiting.get(id) : undefined;
    if (w) {
      clearTimeout(w.timer);
      this.waiting.delete(id!);
      if (d.type === 'LOAD_FAILED' || d.type === 'LAUNCH_ERROR' || d.type === 'INVALID_REQUEST' || d.type === 'LOAD_CANCELLED') {
        w.reject(new Error(`The Chromecast refused the stream (${String(d.reason ?? d.type)})`));
      } else w.resolve(d);
    }
  }

  private onMediaStatus(d: Record<string, unknown>): void {
    const list = (d.status as Record<string, unknown>[] | undefined) ?? [];
    const s = list[0];
    if (!s) return;
    if (typeof s.mediaSessionId === 'number') this.mediaSessionId = s.mediaSessionId;
    const media = s.media as { duration?: number; tracks?: { trackId: number; type: string }[] } | undefined;
    const vol = s.volume as { level?: number; muted?: boolean } | undefined;
    this.status = {
      playerState: String(s.playerState ?? this.status.playerState),
      idleReason: s.idleReason ? String(s.idleReason) : undefined,
      currentTime: typeof s.currentTime === 'number' ? s.currentTime : this.status.currentTime,
      duration: media?.duration ?? this.status.duration,
      volume: vol?.level ?? this.status.volume,
      muted: vol?.muted ?? this.status.muted,
    };
    const text = media?.tracks?.find((t) => t.type === 'TEXT');
    if (this.rewind && this.mediaSessionId != null && (this.status.playerState === 'PLAYING' || this.status.playerState === 'PAUSED')) {
      this.rewind = false;
      if (this.status.currentTime > 15) {
        this.send(this.transportId!, NS.media, { type: 'SEEK', mediaSessionId: this.mediaSessionId, currentTime: 0, requestId: this.requestId++ });
      }
    }
    if (this.wantText && text && this.mediaSessionId != null) {
      this.wantText = false;
      this.send(this.transportId!, NS.media, { type: 'EDIT_TRACKS_INFO', mediaSessionId: this.mediaSessionId, activeTrackIds: [text.trackId], requestId: this.requestId++ });
    }
    this.emit('status', this.status);
  }

  private async launch(): Promise<void> {
    const status = await this.request('receiver-0', NS.receiver, { type: 'LAUNCH', appId: DEFAULT_MEDIA_RECEIVER }, 25_000);
    const apps = ((status.status as { applications?: { appId: string; transportId: string; sessionId: string }[] } | undefined)?.applications ?? []).filter(
      (a) => a.appId === DEFAULT_MEDIA_RECEIVER,
    );
    const app = apps[0];
    if (!app) throw new Error('The Chromecast could not start its media player');
    this.transportId = app.transportId;
    this.appSessionId = app.sessionId;
    this.send(this.transportId, NS.connection, { type: 'CONNECT' });
  }

  async load(req: LoadRequest): Promise<void> {
    if (!this.transportId) await this.launch();
    this.wantText = Boolean(req.enableManifestText);
    this.rewind = Boolean(req.hls);
    const media: Record<string, unknown> = {
      contentId: req.url,
      contentUrl: req.url,
      contentType: req.contentType,
      streamType: 'BUFFERED',
      metadata: { metadataType: 0, title: req.title, subtitle: req.subtitle ?? undefined, images: req.image ? [{ url: req.image }] : [] },
      ...(req.duration ? { duration: req.duration } : {}),
      ...(req.hls ? { hlsSegmentFormat: 'ts', hlsVideoSegmentFormat: 'mpeg2_ts' } : {}),
      ...(req.tracks?.length
        ? {
            tracks: req.tracks,
            textTrackStyle: { backgroundColor: '#00000000', foregroundColor: '#FFFFFFFF', edgeType: 'OUTLINE', edgeColor: '#000000FF', fontScale: 1.1 },
          }
        : {}),
    };
    this.mediaSessionId = null;
    await this.request(this.transportId!, NS.media, {
      type: 'LOAD',
      media,
      autoplay: true,
      currentTime: 0,
      ...(req.tracks?.length ? { activeTrackIds: [req.tracks[0]!.trackId] } : {}),
    }, 45_000);
  }

  private media(type: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!this.transportId || this.mediaSessionId == null) return Promise.reject(new Error('Nothing is playing on the Chromecast'));
    return this.request(this.transportId, NS.media, { type, mediaSessionId: this.mediaSessionId, ...extra });
  }

  play = () => this.media('PLAY');
  pause = () => this.media('PAUSE');
  seek = (seconds: number) => this.media('SEEK', { currentTime: seconds, resumeState: 'PLAYBACK_START' });

  async setVolume(level: number): Promise<void> {
    await this.request('receiver-0', NS.receiver, { type: 'SET_VOLUME', volume: { level: Math.max(0, Math.min(1, level)) } });
  }

  async stop(): Promise<void> {
    try {
      await this.media('STOP').catch(() => undefined);
      if (this.appSessionId) await this.request('receiver-0', NS.receiver, { type: 'STOP', sessionId: this.appSessionId }, 5000).catch(() => undefined);
    } finally {
      this.close();
    }
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    try {
      if (this.transportId) this.send(this.transportId, NS.connection, { type: 'CLOSE' });
      this.send('receiver-0', NS.connection, { type: 'CLOSE' });
    } catch {
      /* already gone */
    }
    this.closed = true;
    this.socket?.destroy();
  }
}
