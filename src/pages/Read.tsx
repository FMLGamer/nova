import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, FileText, Headphones, HardDrive, Search } from 'lucide-react';
import { api } from '../lib/api';
import { resolveAudio, useAudio } from '../lib/audio';
import { useContributions, usePrefs, useSession } from '../lib/queries';
import { readerPath } from '../lib/reader';
import { errorText, toast } from '../lib/store';
import type { Book, LibraryFile, LibraryItem } from '../lib/types';
import { Rail, RailSkeleton } from '../components/media';
import { Spotlight } from '../components/Hero';
import { Badge, Button, Empty, Modal, Spinner } from '../components/ui';
import { PageHeader } from './Browse';
import { PluginRail } from './PluginMeta';

function Cover({ src, title, badge }: { src: string | null; title: string; badge?: React.ReactNode }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-gradient-to-br from-ink-700 to-ink-900 ring-1 ring-white/6 transition-[translate,box-shadow] duration-200 group-hover:-translate-y-1 group-hover:ring-white/20">
      {src && !broken ? (
        <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} className="size-full object-cover" />
      ) : (
        <div className="grid size-full place-items-center p-3 text-center font-display text-sm text-muted">{title}</div>
      )}
      {badge && <div className="absolute top-2 left-2">{badge}</div>}
    </div>
  );
}

const byName = (a: LibraryFile, b: LibraryFile) => a.path.localeCompare(b.path, undefined, { numeric: true });
const fileName = (f: LibraryFile) => f.path.split('/').pop() ?? f.path;

function readFile(item: LibraryItem, file: LibraryFile, navigate: ReturnType<typeof useNavigate>) {
  navigate(readerPath({ type: 'library', fileId: file.id, title: item.title, cover: item.poster, name: fileName(file), manga: item.kind === 'manga' || undefined }));
}

/** One file opens straight away; a series (volumes, chapters) asks which one. */
async function openServerItem(item: LibraryItem, navigate: ReturnType<typeof useNavigate>, pick: (files: LibraryFile[]) => void) {
  const full = await api.server.item(item.id);
  const files = [...full.files].sort(byName);
  if (!files.length) throw new Error('No readable file in this item');
  if (files.length === 1) readFile(item, files[0]!, navigate);
  else pick(files);
}

function VolumePicker({ item, files, onClose }: { item: LibraryItem; files: LibraryFile[]; onClose: () => void }) {
  const navigate = useNavigate();
  const progress = useQuery({ queryKey: ['reading-progress'], queryFn: api.reading.progress });
  const percent = (f: LibraryFile) => progress.data?.find((p) => p.itemKey === `lib:${f.id}`)?.percent;
  return (
    <Modal open onClose={onClose} wide>
      <div className="flex items-center gap-4 pt-2">
        <div className="w-20 shrink-0">
          <Cover src={item.poster} title={item.title} />
        </div>
        <div className="min-w-0">
          <h2 className="font-display text-2xl font-bold">{item.title}</h2>
          <div className="text-sm text-muted">{files.length} files</div>
        </div>
      </div>
      <div className="mt-4 max-h-[55vh] space-y-1 overflow-y-auto">
        {files.map((f) => {
          const p = percent(f);
          return (
            <button key={f.id} onClick={() => readFile(item, f, navigate)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-white/6">
              <BookOpen className="size-4 shrink-0 text-faint" />
              <span className="min-w-0 flex-1 truncate">{fileName(f).replace(/\.[a-z0-9]+$/i, '')}</span>
              {p != null && <span className="text-xs text-faint">{p >= 0.99 ? 'Read' : `${Math.round(p * 100)}%`}</span>}
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

const KIND_BADGE: Record<string, string> = { comic: 'Comic', manga: 'Manga', book: 'Book' };

function ServerItem({ item }: { item: LibraryItem }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<LibraryFile[] | null>(null);
  const open = async () => {
    setBusy(true);
    try {
      await openServerItem(item, navigate, setFiles);
    } catch (e) {
      toast(errorText(e), 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button onClick={open} className="group block w-full text-left">
        <Cover src={item.poster} title={item.title} badge={busy ? <Spinner className="size-4" /> : <Badge>{KIND_BADGE[item.kind] ?? 'Book'}</Badge>} />
        <div className="mt-2 truncate text-[13px] font-semibold">{item.title}</div>
        <div className="truncate text-xs text-faint">{item.fileCount > 1 ? `${item.fileCount} files` : (item.year ?? '\u00a0')}</div>
      </button>
      {files && <VolumePicker item={item} files={files} onClose={() => setFiles(null)} />}
    </>
  );
}

function BookSheet({ book, onClose }: { book: Book; onClose: () => void }) {
  const navigate = useNavigate();
  const playQueue = useAudio((s) => s.playQueue);
  const { data } = useQuery({ queryKey: ['book', book.id], queryFn: () => api.media.book(book.id) });
  const [busy, setBusy] = useState(false);
  const read = () => {
    if (!book.freeUrl) return;
    navigate(readerPath({ type: 'url', url: book.freeUrl, format: book.format === 'pdf' ? 'pdf' : 'epub', title: book.title, cover: book.cover, author: book.author }));
  };
  const listen = async () => {
    setBusy(true);
    try {
      if (data?.chapters.length) {
        playQueue(
          data.chapters.map((c, i) => ({ id: `${book.id}:${i}`, title: c.title, subtitle: book.author, url: api.media.fetchUrl(c.url), cover: book.cover })),
          0,
          { title: book.title, href: '/read' },
        );
      } else {
        const tracks = await resolveAudio({ mediaId: `book:${book.id}`, title: book.title, creator: book.author, cover: book.cover, itemKey: `audiobook:${book.id}` });
        if (!tracks.length) throw new Error('No audiobook source found');
        playQueue(tracks, 0, { title: book.title, href: '/read' });
      }
      onClose();
    } catch (e) {
      toast(errorText(e), 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} wide>
      <div className="flex flex-col gap-6 pt-4 sm:flex-row">
        <div className="w-40 shrink-0 self-center sm:self-start">
          <Cover src={book.cover} title={book.title} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-2xl font-bold">{book.title}</h2>
          <div className="mt-1 text-muted">
            {book.author}
            {book.year ? ` · ${book.year}` : ''}
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {data?.subjects.slice(0, 5).map((s) => (
              <Badge key={s}>{s}</Badge>
            ))}
          </div>
          {data?.description && <p className="mt-4 line-clamp-6 text-sm leading-relaxed text-muted">{data.description}</p>}
          <div className="mt-6 flex flex-wrap gap-2">
            {book.kind === 'ebook' && book.freeUrl && (
              <Button variant="white" size="lg" icon={<BookOpen className="size-5" />} onClick={read}>
                Read now
              </Button>
            )}
            {book.kind === 'audiobook' && (
              <Button variant="white" size="lg" loading={busy} icon={<Headphones className="size-5" />} onClick={listen}>
                Listen
              </Button>
            )}
            {!book.freeUrl && book.kind === 'ebook' && <p className="text-sm text-faint">No free edition available — it can still be added to your server library.</p>}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function FreeBooks() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Book | null>(null);
  const home = useQuery({ queryKey: ['books-home'], queryFn: api.media.booksHome, staleTime: 60 * 60_000 });
  const search = useQuery({ queryKey: ['books-search', q], queryFn: () => api.media.bookSearch(q), enabled: q.length >= 2, staleTime: 10 * 60_000 });
  const card = (b: Book) => (
    <button key={b.id} onClick={() => setOpen(b)} className="group block w-full text-left">
      <Cover src={b.cover} title={b.title} badge={b.kind === 'audiobook' ? <Badge tone="accent"><Headphones className="size-3" /> Audio</Badge> : undefined} />
      <div className="mt-2 truncate text-[13px] font-semibold">{b.title}</div>
      <div className="truncate text-xs text-faint">{b.author}</div>
    </button>
  );
  return (
    <section className="space-y-8">
      <div className="px-5 sm:px-10">
        <label className="glass flex h-12 max-w-xl items-center gap-3 rounded-2xl px-4">
          <Search className="size-5 text-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search free books & audiobooks" className="flex-1 bg-transparent focus:outline-none" />
          {search.isFetching && <Spinner className="size-4" />}
        </label>
      </div>
      {q.length >= 2 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-x-4 gap-y-6 px-5 sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))] sm:px-10">{search.data?.map(card)}</div>
      ) : home.isLoading ? (
        <RailSkeleton />
      ) : (
        home.data?.map((r) => (
          <Rail key={r.id} title={r.title} dense>
            {r.items.map(card)}
          </Rail>
        ))
      )}
      {open && <BookSheet book={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

export default function Read() {
  const { data: session } = useSession();
  const { data: prefs } = usePrefs();
  const { data: contrib } = useContributions();
  const progress = useQuery({ queryKey: ['reading-progress'], queryFn: api.reading.progress });
  const books = useQuery({ queryKey: ['server-items', 'book'], queryFn: () => api.server.items({ kind: 'book' }), retry: false });
  const comics = useQuery({ queryKey: ['server-items', 'comic'], queryFn: () => api.server.items({ kind: 'comic' }), retry: false });
  const manga = useQuery({ queryKey: ['server-items', 'manga'], queryFn: () => api.server.items({ kind: 'manga' }), retry: false });
  const readable = new Set(['manga', 'comic', 'book', ...(contrib?.mediaTypes.filter((m) => m.reader === 'comic' || m.reader === 'book').map((m) => m.id) ?? [])]);
  const pluginCatalogs = (contrib?.catalogs ?? []).filter((c) => readable.has(c.type));
  const freeBooks = Boolean(session?.settings.musicBooksEnabled && prefs?.ui.musicAndBooks);
  const reading = (progress.data ?? []).filter((r) => r.percent < 0.99);
  const finished = (progress.data ?? []).filter((r) => r.percent >= 0.99);
  const nothing = !reading.length && !books.data?.length && !comics.data?.length && !manga.data?.length && !pluginCatalogs.length && !freeBooks;
  const navigate = useNavigate();
  const [series, setSeries] = useState<{ item: LibraryItem; files: LibraryFile[] } | null>(null);
  const shelf = useMemo(() => [...(books.data ?? []), ...(comics.data ?? []), ...(manga.data ?? [])], [books.data, comics.data, manga.data]);
  const featuredShelf = useMemo(() => (shelf.length ? shelf[Math.floor(Math.random() * Math.min(shelf.length, 12))]! : null), [shelf]);
  const current = reading[0];

  return (
    <div className="space-y-12 pb-10">
      <div>
        {current ? (
          <Spotlight
            art={current.cover}
            eyebrow="Keep reading"
            title={current.title ?? 'Untitled'}
            meta={
              <>
                {current.author && <span>{current.author}</span>}
                <span className="flex items-center gap-2">
                  <span className="h-1 w-24 overflow-hidden rounded-full bg-white/15">
                    <span className="block h-full bg-progress" style={{ width: `${current.percent * 100}%` }} />
                  </span>
                  {Math.round(current.percent * 100)}%
                </span>
              </>
            }
            actions={
              <Button variant="white" icon={<BookOpen className="size-5" />} onClick={() => navigate(`/reader?key=${encodeURIComponent(current.itemKey)}`)}>
                Continue reading
              </Button>
            }
          />
        ) : featuredShelf ? (
          <Spotlight
            backdrop={featuredShelf.backdrop}
            art={featuredShelf.poster}
            eyebrow={featuredShelf.kind === 'book' ? 'From your books' : featuredShelf.kind === 'manga' ? 'From your manga' : 'From your comics'}
            title={featuredShelf.title}
            meta={featuredShelf.fileCount > 1 ? <span>{featuredShelf.fileCount} files</span> : featuredShelf.year ? <span>{featuredShelf.year}</span> : undefined}
            description={featuredShelf.overview}
            actions={
              <Button
                variant="white"
                icon={<BookOpen className="size-5" />}
                onClick={() => openServerItem(featuredShelf, navigate, (files) => setSeries({ item: featuredShelf, files })).catch((e) => toast(errorText(e), 'bad'))}
              >
                Start reading
              </Button>
            }
          />
        ) : null}
        {series && <VolumePicker item={series.item} files={series.files} onClose={() => setSeries(null)} />}
        <PageHeader
          flush={Boolean(current || featuredShelf)}
          title="Read"
          kicker="Books · Comics · Manga"
          tone="#7ed67a"
          subtitle="Books, comics and manga — with your place, highlights and notes synced everywhere."
        />
      </div>
      {reading.length > 0 && (
        <Rail title="Keep reading" dense>
          {reading.map((r) => (
            <Link key={r.itemKey} to={`/reader?key=${encodeURIComponent(r.itemKey)}`} className="group block">
              <Cover src={r.cover} title={r.title ?? ''} />
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
                <div className="h-full bg-progress" style={{ width: `${r.percent * 100}%` }} />
              </div>
              <div className="mt-1.5 truncate text-[13px] font-semibold">{r.title}</div>
              <div className="truncate text-xs text-faint">{Math.round(r.percent * 100)}%</div>
            </Link>
          ))}
        </Rail>
      )}
      {(books.data?.length ?? 0) > 0 && (
        <Rail title={<span className="flex items-center gap-2"><HardDrive className="size-5 text-accent" /> Books on your server</span>} dense>
          {books.data!.map((i) => (
            <ServerItem key={i.id} item={i} />
          ))}
        </Rail>
      )}
      {(comics.data?.length ?? 0) > 0 && (
        <Rail title={<span className="flex items-center gap-2"><HardDrive className="size-5 text-accent" /> Comics on your server</span>} dense>
          {comics.data!.map((i) => (
            <ServerItem key={i.id} item={i} />
          ))}
        </Rail>
      )}
      {(manga.data?.length ?? 0) > 0 && (
        <Rail title={<span className="flex items-center gap-2"><HardDrive className="size-5 text-accent" /> Manga on your server</span>} dense>
          {manga.data!.map((i) => (
            <ServerItem key={i.id} item={i} />
          ))}
        </Rail>
      )}
      {pluginCatalogs.map((c) => (
        <PluginRail key={`${c.pluginId}:${c.type}:${c.id}`} catalog={c} />
      ))}
      {freeBooks && <FreeBooks />}
      {finished.length > 0 && (
        <Rail title="Finished" dense>
          {finished.map((r) => (
            <Link key={r.itemKey} to={`/reader?key=${encodeURIComponent(r.itemKey)}`} className="group block opacity-80 hover:opacity-100">
              <Cover src={r.cover} title={r.title ?? ''} />
              <div className="mt-2 truncate text-[13px] font-semibold">{r.title}</div>
            </Link>
          ))}
        </Rail>
      )}
      {nothing && (
        <Empty icon={<FileText />} title="Your shelf is empty">
          Add a folder of EPUB, PDF or CBZ files under Server → Library → Reading folders, install a manga plugin, or turn on free books in Settings.
        </Empty>
      )}
    </div>
  );
}
