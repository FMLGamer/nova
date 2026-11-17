/**
 * Covers for books, comics and manga that came from a folder rather than a catalogue: a cover
 * image next to the files, else the first page of the first archive (or an EPUB's cover).
 * Results are cached in DATA_DIR/covers, including "there is none".
 */
import fs from 'node:fs';
import path from 'node:path';
import { Unzip, UnzipInflate, unzipSync } from 'fflate';
import { config } from '../config.js';
import { filesOf, libraryFilePath } from './library.js';

const IMG = /\.(jpe?g|png|webp|gif|avif)$/i;
const FOLDER_COVERS = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp', 'folder.jpg', 'folder.png', 'poster.jpg', 'poster.png'];
const dir = path.join(config.dataDir, 'covers');

const typeOf = (name: string) => {
  const ext = path.extname(name).toLowerCase();
  return ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : ext === '.avif' ? 'image/avif' : 'image/jpeg';
};

/** The first image in a comic archive, read only as far as needed. */
function firstArchiveImage(file: string): Promise<{ data: Buffer; name: string } | null> {
  return new Promise((resolve) => {
    let done = false;
    const stream = fs.createReadStream(file, { highWaterMark: 256 * 1024 });
    const finish = (v: { data: Buffer; name: string } | null) => {
      if (done) return;
      done = true;
      stream.destroy();
      resolve(v);
    };
    const uz = new Unzip();
    uz.register(UnzipInflate);
    uz.onfile = (f) => {
      if (done || !IMG.test(f.name) || f.name.startsWith('__MACOSX')) return;
      const chunks: Uint8Array[] = [];
      f.ondata = (err, chunk, final) => {
        if (err) return finish(null);
        chunks.push(chunk);
        if (final) finish({ data: Buffer.concat(chunks), name: f.name });
      };
      f.start();
    };
    stream.on('data', (c) => {
      try {
        uz.push(c as Buffer);
      } catch {
        finish(null);
      }
    });
    stream.on('end', () => finish(null));
    stream.on('error', () => finish(null));
  });
}

function epubCover(file: string): { data: Buffer; name: string } | null {
  try {
    if (fs.statSync(file).size > 80 * 1024 * 1024) return null;
    const files = unzipSync(new Uint8Array(fs.readFileSync(file)), { filter: (f) => IMG.test(f.name) });
    const names = Object.keys(files);
    const pick = names.find((n) => /cover/i.test(n)) ?? names[0];
    return pick ? { data: Buffer.from(files[pick]!), name: pick } : null;
  } catch {
    return null;
  }
}

async function findCover(itemId: string, folder: string | null): Promise<{ data: Buffer; name: string } | null> {
  if (folder) {
    for (const n of FOLDER_COVERS) {
      const p = libraryFilePath(`${folder}/${n}`);
      if (p && fs.existsSync(p)) return { data: fs.readFileSync(p), name: n };
    }
  }
  const files = filesOf(itemId).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  for (const f of files.slice(0, 3)) {
    const abs = libraryFilePath(f.path);
    if (!abs) continue;
    if (/\.(cbz|zip)$/i.test(abs)) {
      const img = await firstArchiveImage(abs);
      if (img) return img;
    } else if (/\.epub$/i.test(abs)) {
      const img = epubCover(abs);
      if (img) return img;
    }
  }
  return null;
}

export async function itemCover(itemId: string, folder: string | null): Promise<{ data: Buffer; type: string } | null> {
  fs.mkdirSync(dir, { recursive: true });
  const cached = fs.readdirSync(dir).find((n) => n.startsWith(`${itemId}.`));
  if (cached) return cached.endsWith('.none') ? null : { data: fs.readFileSync(path.join(dir, cached)), type: typeOf(cached) };
  const found = await findCover(itemId, folder);
  const ext = found ? path.extname(found.name).toLowerCase() || '.jpg' : '.none';
  fs.writeFileSync(path.join(dir, `${itemId}${ext}`), found?.data ?? '');
  return found ? { data: found.data, type: typeOf(found.name) } : null;
}
