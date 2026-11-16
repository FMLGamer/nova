// Minimal ambient types for the subset of WebTorrent v2 this app uses.
// WebTorrent ships no types, and @types/webtorrent lags the v2 ESM API.
declare module 'webtorrent' {
  import type { Readable } from 'node:stream';

  export interface TorrentFile {
    name: string;
    path: string;
    length: number;
    downloaded: number;
    progress: number;
    createReadStream(opts?: { start?: number; end?: number }): Readable;
    select(priority?: number): void;
    deselect(): void;
  }

  export interface Torrent {
    infoHash: string;
    name: string;
    length: number;
    ready: boolean;
    done: boolean;
    path: string;
    progress: number;
    downloaded: number;
    downloadSpeed: number;
    numPeers: number;
    files: TorrentFile[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, cb: (...args: any[]) => void): this;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    once(event: string, cb: (...args: any[]) => void): this;
    destroy(opts?: { destroyStore?: boolean } | (() => void), cb?: () => void): void;
    deselect(start: number, end: number, priority?: number): void;
  }

  export interface WebTorrentOptions {
    maxConns?: number;
    downloadLimit?: number;
    uploadLimit?: number;
  }

  export interface AddOptions {
    path?: string;
    uploads?: number;
    alwaysChokeSeeders?: boolean;
    deselect?: boolean;
  }

  export default class WebTorrent {
    constructor(opts?: WebTorrentOptions);
    torrents: Torrent[];
    downloadSpeed: number;
    add(torrentId: string | Buffer, opts: AddOptions, cb: (torrent: Torrent) => void): Torrent;
    add(torrentId: string | Buffer, cb: (torrent: Torrent) => void): Torrent;
    get(torrentId: string): Promise<Torrent | null> | Torrent | null;
    remove(torrentId: string, opts?: { destroyStore?: boolean }, cb?: () => void): void;
    destroy(cb?: () => void): void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, cb: (...args: any[]) => void): this;
  }
}
