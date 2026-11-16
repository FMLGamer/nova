import type { ClientTorrent } from './types';

/**
 * Last-resort playback when the server doesn't stream torrents and the Nova app
 * isn't running here: WebTorrent in the browser. Browsers can only reach peers
 * that speak WebRTC, so plenty of torrents won't start this way.
 */

// Trackers WebRTC peers announce on; regular UDP/HTTP trackers are useless to a browser.
const WEB_TRACKERS = ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev', 'wss://tracker.btorrent.xyz', 'wss://tracker.files.fm:7073/announce'];
const VIDEO = /\.(mp4|m4v|webm|mkv|mov)$/i;

interface WtFile {
  name: string;
  length: number;
  streamURL: string;
}
interface WtTorrent {
  infoHash: string;
  files: WtFile[];
  on(ev: 'error', cb: (e: Error) => void): void;
}
interface WtClient {
  add(id: string | Uint8Array, opts: { announce: string[] }, cb: (t: WtTorrent) => void): WtTorrent;
  get(id: string): Promise<WtTorrent | null> | WtTorrent | null;
  createServer(opts: { controller: ServiceWorkerRegistration }): unknown;
}

let clientPromise: Promise<WtClient> | null = null;

function getClient(): Promise<WtClient> {
  clientPromise ??= (async () => {
    if (!('serviceWorker' in navigator)) throw new Error('This browser cannot stream torrents');
    const { default: WebTorrent } = (await import('webtorrent/dist/webtorrent.min.js')) as { default: new () => WtClient };
    const client = new WebTorrent();
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Reload the page once to enable in-browser streaming')), 4000)),
    ]);
    client.createServer({ controller: reg });
    return client;
  })();
  clientPromise.catch(() => (clientPromise = null));
  return clientPromise;
}

function pickFile(t: WtTorrent, hint: ClientTorrent): WtFile | undefined {
  if (hint.fileIdx != null && t.files[hint.fileIdx]) return t.files[hint.fileIdx];
  const videos = t.files.filter((f) => VIDEO.test(f.name));
  const ep = hint.episode?.episode;
  if (ep != null && videos.length > 1) {
    const se = hint.episode?.season;
    const pad = String(ep).padStart(2, '0');
    const patterns = [se != null ? new RegExp(`s0*${se}[ ._-]*e0*${ep}(?!\\d)`, 'i') : null, new RegExp(`(?:^|[ ._\\-\\[(])e?0*${ep}(?:v\\d)?(?=[ ._\\-\\])]|$)`, 'i'), new RegExp(`\\b${pad}\\b`)].filter(Boolean) as RegExp[];
    for (const re of patterns) {
      const hit = videos.find((f) => re.test(f.name.replace(/\.[^.]+$/, '')));
      if (hit) return hit;
    }
  }
  return [...videos].sort((a, b) => b.length - a.length)[0] ?? t.files[0];
}

export async function browserTorrent(t: ClientTorrent): Promise<{ url: string; name: string; size: number }> {
  const client = await getClient();
  const id = t.magnet ?? (t.torrent ? Uint8Array.from(atob(t.torrent), (c) => c.charCodeAt(0)) : null);
  if (!id) throw new Error('Nothing to stream');
  const existing = t.infoHash ? await client.get(t.infoHash) : null;
  const torrent =
    existing ??
    (await new Promise<WtTorrent>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('No browser-reachable peers for this torrent. Install the Nova app to stream it.')), 40_000);
      const added = client.add(id, { announce: WEB_TRACKERS }, (tt) => {
        window.clearTimeout(timer);
        resolve(tt);
      });
      added.on('error', (e) => {
        window.clearTimeout(timer);
        reject(e);
      });
    }));
  const file = pickFile(torrent, t);
  if (!file) throw new Error('No playable file in this torrent');
  return { url: file.streamURL, name: file.name, size: file.length };
}
