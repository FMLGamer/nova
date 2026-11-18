import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { BookOpen, Headphones, HardDrive, Search } from 'lucide-react';
import { api } from '../lib/api';
import { resolveAudio, useAudio } from '../lib/audio';
import { useContributions, usePrefs, useSession } from '../lib/queries';
import { readerPath } from '../lib/reader';
import { errorText, toast } from '../lib/store';
import type { Book, HeroSize, LibraryFile, LibraryItem, ReadFormat } from '../lib/types';
import { Rail, RailSkeleton } from '../components/media';
import { Spotlight } from '../components/Hero';
import { BrowseFilters, BrowseSection, FilterMenu } from '../components/BrowseSection';
import { HeroSkeleton, PageLayout } from '../components/PageLayout';
import { FORMAT_LABEL, ReadGrid, readTitlePath } from '../components/ReadCard';
import { PluginRails, ReadingRail } from '../components/Sections';
import { Badge, Button, Modal, Spinner } from '../components/ui';
import { useFilterParams } from './Browse';

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
export async function openServerItem(item: LibraryItem, navigate: ReturnType<typeof useNavigate>, pick: (files: LibraryFile[]) => void) {
  const full = await api.server.item(item.id);
  const files = [...full.files].sort(byName);
  if (!files.length) throw new Error('No readable file in this item');
  if (files.length === 1) readFile(item, files[0]!, navigate);
  else pick(files);
}

export function VolumePicker({ item, files, onClose }: { item: LibraryItem; files: LibraryFile[]; onClose: () => void }) {
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

const READ_SORTS = [
  { value: 'trending', label: 'Trending' },
  { value: 'popular', label: 'Popular' },
  { value: 'top', label: 'Top rated' },
  { value: 'new', label: 'Newest' },
] as const;
const READ_FORMATS: { value: ReadFormat; label: string }[] = [
  { value: 'manga', label: 'Manga' },
  { value: 'manhwa', label: 'Manhwa' },
  { value: 'manhua', label: 'Manhua' },
  { value: 'novel', label: 'Light novels' },
  { value: 'oneshot', label: 'One-shots' },
  { value: 'book', label: 'Books' },
];

function BrowseRead() {
  const [params, set] = useFilterParams();
  const sort = params.get('sort') ?? 'trending';
  const format = (params.get('format') ?? 'manga') as ReadFormat;
  const genre = params.get('genre') ?? '';
  const genres = useQuery({ queryKey: ['read-genres', format === 'book' ? 'book' : 'manga'], queryFn: () => api.catalog.readGenres(format), staleTime: Infinity });
  const q = useInfiniteQuery({
    queryKey: ['read-browse', format, sort, genre],
    queryFn: ({ pageParam }) => api.catalog.readBrowse({ page: pageParam, format, sort, genre: genre || undefined }),
    initialPageParam: 1,
    getNextPageParam: (last, all) => (last.length ? all.length + 1 : undefined),
    staleTime: 15 * 60_000,
  });
  return (
    <BrowseSection
      title="Browse manga & books"
      filters={
        <BrowseFilters
          sort={sort as (typeof READ_SORTS)[number]['value']}
          sorts={READ_SORTS}
          onSort={(v) => set('sort', v === 'trending' ? '' : v)}
          extra={
            <FilterMenu
              value={format}
              options={READ_FORMATS}
              onChange={(v) => {
                // Books and manga have different genres.
                if ((v === 'book') !== (format === 'book')) set('genre', '');
                set('format', v === 'manga' ? '' : v);
              }}
            />
          }
          genre={genre}
          genres={(genres.data ?? []).map((g) => ({ value: g, label: g }))}
          onGenre={(v) => set('genre', v)}
        />
      }
    >
      <ReadGrid items={q.data?.pages.flat() ?? []} loading={q.isLoading || q.isFetchingNextPage} done={!q.hasNextPage} onEnd={() => q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage()} />
    </BrowseSection>
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
  const freeBooks = Boolean(session?.settings.musicBooksEnabled && prefs?.ui.musicAndBooks);
  const reading = (progress.data ?? []).filter((r) => r.percent < 0.99);
  const navigate = useNavigate();
  const [series, setSeries] = useState<{ item: LibraryItem; files: LibraryFile[] } | null>(null);
  const shelf = useMemo(() => [...(books.data ?? []), ...(comics.data ?? []), ...(manga.data ?? [])], [books.data, comics.data, manga.data]);
  const featuredShelf = useMemo(() => (shelf.length ? shelf[Math.floor(Math.random() * Math.min(shelf.length, 12))]! : null), [shelf]);
  const current = reading[0];
  const trending = useQuery({ queryKey: ['read-browse', 'manga', 'trending', '', 'hero'], queryFn: () => api.catalog.readBrowse({ page: 1, format: 'manga', sort: 'trending' }), enabled: !current && !featuredShelf, staleTime: 30 * 60_000 });
  const featuredCatalog = useMemo(() => {
    const pool = (trending.data ?? []).filter((i) => i.backdrop && i.overview).slice(0, 10);
    return pool.length ? pool[Math.floor(Math.random() * pool.length)]! : null;
  }, [trending.data]);

  const hero = (size: HeroSize) =>
    current ? (
      <Spotlight
        size={size}
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
        size={size}
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
    ) : featuredCatalog ? (
      <Spotlight
        size={size}
        backdrop={featuredCatalog.backdrop}
        art={featuredCatalog.poster}
        eyebrow={`Trending ${FORMAT_LABEL[featuredCatalog.format].toLowerCase()}`}
        title={featuredCatalog.title}
        meta={[featuredCatalog.author, featuredCatalog.year].filter(Boolean).length ? <span>{[featuredCatalog.author, featuredCatalog.year].filter(Boolean).join(' · ')}</span> : undefined}
        description={featuredCatalog.overview}
        actions={
          <Button variant="white" icon={<BookOpen className="size-5" />} onClick={() => navigate(readTitlePath(featuredCatalog.id))}>
            Details
          </Button>
        }
      />
    ) : progress.isLoading || trending.isLoading ? (
      <HeroSkeleton size={size} />
    ) : null;

  const shelfRail = (items: LibraryItem[] | undefined, label: string) =>
    items?.length ? (
      <Rail title={<span className="flex items-center gap-2"><HardDrive className="size-5 text-accent" /> {label}</span>} dense>
        {items.map((i) => (
          <ServerItem key={i.id} item={i} />
        ))}
      </Rail>
    ) : null;

  return (
    <>
      <PageLayout
        page="read"
        title="Read"
        hero={hero}
        sections={{
          reading: <ReadingRail />,
          server: (
            <div className="space-y-12">
              {shelfRail(books.data, 'Books on your server')}
              {shelfRail(comics.data, 'Comics on your server')}
              {shelfRail(manga.data, 'Manga on your server')}
            </div>
          ),
          plugins: <PluginRails types={readable} limit={12} />,
          freebooks: freeBooks ? <FreeBooks /> : null,
          finished: <ReadingRail finished />,
          browse: <BrowseRead />,
        }}
      />
      {series && <VolumePicker item={series.item} files={series.files} onClose={() => setSeries(null)} />}
    </>
  );
}
