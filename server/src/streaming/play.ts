import type { MediaContext } from '../plugins/protocol.js';
import { magnetInfoHash, type Release } from '../core/release.js';
import { config } from '../config.js';
import { resolveRelease } from '../plugins/sources.js';
import { addTorrent, type CacheOwner, type EpisodeHint, type MediaKind } from '../services/torrentEngine.js';
import { urlToken } from './source.js';

export interface PlayFile {
  index: number;
  name: string;
  size: number;
  mime: string;
  path: string;
}

/** A torrent the viewer's own device streams (TORRENT_MODE=client). */
export interface ClientTorrent {
  magnet: string | null;
  /** A .torrent file, base64, when the source had no magnet. */
  torrent: string | null;
  infoHash: string | null;
  fileIdx: number | null;
  episode: EpisodeHint | null;
}

/** Where the player should read from, plus every file of the requested kind (album tracks, book parts). */
export interface PlaySource {
  kind: 't' | 'l' | 'u' | 'c';
  a: string;
  b?: string;
  path: string;
  name: string;
  size: number;
  mime: string;
  files: PlayFile[];
  /** What to store as "resume from here". */
  link: string;
  torrent?: ClientTorrent;
}

const FILE_PARAM = /[&?]nova_file=(\d+)/;

/** Resume links are magnets carrying the chosen file index as an extra parameter. */
export function resumeLink(magnet: string, fileIdx: number | null): string {
  const clean = magnet.replace(FILE_PARAM, '');
  return fileIdx == null ? clean : `${clean}&nova_file=${fileIdx}`;
}

function fromTorrent(p: Awaited<ReturnType<typeof addTorrent>>, link: string): PlaySource {
  const files = p.files.map((f) => ({
    index: f.index,
    name: f.name,
    size: f.size,
    mime: f.mime,
    path: `/stream/t/${p.infoHash}/${f.index}`,
  }));
  return {
    kind: 't',
    a: p.infoHash,
    b: String(p.fileIndex),
    path: `/stream/t/${p.infoHash}/${p.fileIndex}`,
    name: p.fileName,
    size: p.size,
    mime: p.mime,
    files,
    link: resumeLink(link, p.fileIndex),
  };
}

function forClient(t: ClientTorrent, name: string, size: number): PlaySource {
  return {
    kind: 'c',
    a: t.infoHash ?? '',
    path: '',
    name,
    size,
    mime: /\.mkv$/i.test(name) ? 'video/x-matroska' : 'video/mp4',
    files: [],
    link: t.magnet ? resumeLink(t.magnet, t.fileIdx) : '',
    torrent: t,
  };
}

export async function prepareFromRelease(
  release: Release,
  context: MediaContext,
  owner: CacheOwner | undefined,
  kind: MediaKind,
): Promise<PlaySource> {
  const resolved = await resolveRelease(release, context);
  if (resolved.url) {
    const name = release.fileName ?? release.title;
    const token = urlToken(resolved.url, resolved.headers, name, release.sizeBytes);
    return {
      kind: 'u',
      a: token,
      path: `/stream/u/${token}`,
      name,
      size: release.sizeBytes,
      mime: /\.mkv$/i.test(name) ? 'video/x-matroska' : 'video/mp4',
      files: [],
      link: '',
    };
  }
  const episode: EpisodeHint | null =
    (context.kind === 'tv' || context.kind === 'anime') && context.episode != null
      ? { kind: context.kind, season: context.kind === 'tv' ? context.season : null, episode: context.episode }
      : null;
  if (config.torrentMode === 'client') {
    const magnet = resolved.magnet ?? null;
    return forClient(
      {
        magnet,
        torrent: resolved.torrent ? resolved.torrent.toString('base64') : null,
        infoHash: release.infoHash ?? (magnet ? magnetInfoHash(magnet) : null),
        fileIdx: release.fileIdx ?? null,
        episode,
      },
      release.fileName ?? release.title,
      release.sizeBytes,
    );
  }
  const prepared = await addTorrent(
    { magnet: resolved.magnet, torrent: resolved.torrent, fileIdx: release.fileIdx, episode },
    owner,
    kind,
  );
  return fromTorrent(prepared, resolved.magnet ?? '');
}

/** Resume from a stored link (magnets only; anything else means "search again"). */
export async function prepareFromLink(
  link: string,
  owner: CacheOwner | undefined,
  kind: MediaKind,
  hint: { episode?: EpisodeHint | null; torrent?: Buffer | null } = {},
): Promise<PlaySource> {
  if (!link.startsWith('magnet:') && !hint.torrent) throw new Error('This source cannot be resumed');
  const m = link.match(FILE_PARAM);
  const fileIdx = m ? Number(m[1]) : null;
  const magnet = link.startsWith('magnet:') ? link.replace(FILE_PARAM, '') : null;
  if (config.torrentMode === 'client') {
    return forClient(
      { magnet, torrent: hint.torrent?.toString('base64') ?? null, infoHash: magnet ? magnetInfoHash(magnet) : null, fileIdx, episode: hint.episode ?? null },
      'Torrent',
      0,
    );
  }
  const prepared = await addTorrent({ magnet, torrent: hint.torrent ?? null, fileIdx, episode: hint.episode ?? null }, owner, kind);
  return fromTorrent(prepared, magnet ?? '');
}
