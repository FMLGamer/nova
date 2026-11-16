import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, FileText, Headphones, HardDrive, Search } from 'lucide-react';
import { api } from '../lib/api';
import { resolveAudio, useAudio } from '../lib/audio';
import { useContributions, usePrefs, useSession } from '../lib/queries';
import { readerPath } from '../lib/reader';
import { errorText, toast } from '../lib/store';
import type { Book, LibraryItem } from '../lib/types';
import { Rail, RailSkeleton } from '../components/media';
import { Badge, Button, Empty, Modal, Spinner } from '../components/ui';
import { PageHeader } from './Browse';
import { PluginRail } from './PluginMeta';

function Cover({ src, title, badge }: { src: string | null; title: string; badge?: React.ReactNode }) {
  return (
    <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-gradient-to-br from-ink-700 to-ink-900 ring-1 ring-white/6 transition-[translate,box-shadow] duration-200 group-hover:-translate-y-1 group-hover:ring-white/20">
      {src ? <img src={src} alt="" loading="lazy" className="size-full object-cover" /> : <div className="grid size-full place-items-center p-3 text-center font-display text-sm text-muted">{title}</div>}
      {badge && <div className="absolute top-2 left-2">{badge}</div>}
    </div>
  );
}

function ServerItem({ item }: { item: LibraryItem }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      const full = await api.server.item(item.id);
      const file = [...full.files].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))[0];
      if (!file) throw new Error('No readable file in this item');
      navigate(readerPath({ type: 'library', fileId: file.id, title: item.title, cover: item.poster, name: file.path.split('/').pop() }));
    } catch (e) {
      toast(errorText(e), 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button onClick={open} className="group block w-full text-left">
      <Cover src={item.poster} title={item.title} badge={busy ? <Spinner className="size-4" /> : <Badge>{item.kind === 'comic' ? 'Comic' : 'Book'}</Badge>} />
      <div className="mt-2 truncate text-[13px] font-semibold">{item.title}</div>
      <div className="truncate text-xs text-faint">{item.year ?? (item.fileCount > 1 ? `${item.fileCount} files` : '\u00a0')}</div>
    </button>
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
  const readable = new Set(['manga', 'comic', 'book', ...(contrib?.mediaTypes.filter((m) => m.reader === 'comic' || m.reader === 'book').map((m) => m.id) ?? [])]);
  const pluginCatalogs = (contrib?.catalogs ?? []).filter((c) => readable.has(c.type));
  const freeBooks = Boolean(session?.settings.musicBooksEnabled && prefs?.ui.musicAndBooks);
  const reading = (progress.data ?? []).filter((r) => r.percent < 0.99);
  const finished = (progress.data ?? []).filter((r) => r.percent >= 0.99);
  const nothing = !reading.length && !books.data?.length && !comics.data?.length && !pluginCatalogs.length && !freeBooks;

  return (
    <div className="space-y-12 pb-10">
      <PageHeader title="Read" kicker="Books · Comics · Manga" tone="#7ed67a" subtitle="Books, comics and manga — with your place, highlights and notes synced everywhere." />
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
          Put EPUB, PDF or CBZ files in the server library, install a manga plugin, or turn on free books in Settings.
        </Empty>
      )}
    </div>
  );
}
