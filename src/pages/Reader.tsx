import '../lib/reading-fonts';
import { AnimatePresence, motion } from 'motion/react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { unzipSync } from 'fflate';
import { ArrowLeft, Bookmark, BookmarkCheck, ChevronLeft, ChevronRight, Download, ListTree, NotebookPen, Trash2, Type, X } from 'lucide-react';
import { api } from '../lib/api';
import { publicImage, setPresence } from '../lib/desktop';
import { cls } from '../lib/format';
import { offlineFile, useOffline } from '../lib/offline';
import { usePrefs, useSavePrefs } from '../lib/queries';
import { READING_FONTS } from '../lib/reading-fonts';
import { chapterOf, readerKey, readerPath, type ReaderSource } from '../lib/reader';
import { errorText, toast } from '../lib/store';
import type { Annotation, Preferences, ReadingKind } from '../lib/types';
import { themeColors, type ReaderHandle } from '../components/reader/common';
import { Button, Empty, Segmented, Slider, Spinner, Switch, TextArea } from '../components/ui';

const EpubView = lazy(() => import('../components/reader/EpubView').then((m) => ({ default: m.EpubView })));
const PdfView = lazy(() => import('../components/reader/PdfView').then((m) => ({ default: m.PdfView })));
const ComicView = lazy(() => import('../components/reader/ComicView').then((m) => ({ default: m.ComicView })));

type Loaded = { format: 'epub' | 'pdf'; buffer: ArrayBuffer } | { format: 'comic'; pages: string[] };

const IMG = /\.(jpe?g|png|webp|gif|avif)$/i;

function sniff(buf: ArrayBuffer, name: string): 'epub' | 'pdf' | 'cbz' {
  const b = new Uint8Array(buf, 0, 4);
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf';
  if (/\.epub$/i.test(name)) return 'epub';
  if (/\.(cbz|zip)$/i.test(name)) return 'cbz';
  // A zip with META-INF/container.xml is an EPUB; otherwise treat it as a comic archive.
  try {
    const files = unzipSync(new Uint8Array(buf), { filter: (f) => f.name === 'META-INF/container.xml' });
    return Object.keys(files).length ? 'epub' : 'cbz';
  } catch {
    return 'epub';
  }
}

function comicPages(buf: ArrayBuffer): string[] {
  const files = unzipSync(new Uint8Array(buf), { filter: (f) => IMG.test(f.name) && !f.name.startsWith('__MACOSX') });
  return Object.keys(files)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((n) => URL.createObjectURL(new Blob([files[n]! as BlobPart])));
}

async function load(src: ReaderSource): Promise<Loaded> {
  if (src.type === 'plugin') {
    const pages = await api.plugins.pages(src.pluginId, src.metaType, src.videoId);
    return { format: 'comic', pages: pages.map((p) => p.url) };
  }
  let buf: ArrayBuffer;
  let name = '';
  if (src.type === 'offline') {
    const f = await offlineFile(src.itemKey);
    if (!f) throw new Error('This offline copy is gone');
    buf = await f.arrayBuffer();
    name = `x.${src.format}`;
  } else {
    const url = src.type === 'library' ? `/stream/l/${src.fileId}` : api.media.fetchUrl(src.url);
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error('Could not open this file');
    buf = await res.arrayBuffer();
    name = src.type === 'library' ? (src.name ?? '') : `x.${src.format}`;
  }
  const fmt = sniff(buf, name);
  if (fmt === 'cbz') return { format: 'comic', pages: comicPages(buf) };
  return { format: fmt, buffer: buf };
}

const HL_COLORS = ['#fde047', '#86efac', '#93c5fd', '#f9a8d4'];

function ReaderSettings({ prefs, comic, onClose }: { prefs: Preferences['reader']; comic: boolean; onClose: () => void }) {
  const save = useSavePrefs();
  const set = (p: Partial<Preferences['reader']>) => save.mutate({ reader: p });
  return (
    <SidePanel title="Reading" onClose={onClose}>
      {!comic && (
        <div className="space-y-5">
          <div className="grid gap-1.5">
            {(Object.keys(READING_FONTS) as (keyof typeof READING_FONTS)[]).map((k) => (
              <button key={k} onClick={() => set({ typeface: k })} className={cls('rounded-xl px-3 py-2.5 text-left transition', prefs.typeface === k ? 'bg-white text-black' : 'bg-white/6 hover:bg-white/10')} style={{ fontFamily: READING_FONTS[k].css }}>
                {READING_FONTS[k].label} <span className="opacity-60">— The quick brown fox</span>
              </button>
            ))}
          </div>
          <div>
            <div className="mb-1 text-xs text-muted">Size</div>
            <Slider value={prefs.fontSize} min={70} max={200} step={5} onChange={(v) => set({ fontSize: v })} format={(v) => `${v}%`} />
          </div>
          <div>
            <div className="mb-1 text-xs text-muted">Line spacing</div>
            <Slider value={prefs.lineHeight} min={1.1} max={2.4} step={0.05} onChange={(v) => set({ lineHeight: v })} format={(v) => v.toFixed(2)} />
          </div>
          <div>
            <div className="mb-1 text-xs text-muted">Margins</div>
            <Slider value={prefs.margins} min={0} max={25} onChange={(v) => set({ margins: v })} format={(v) => `${v}%`} />
          </div>
          <label className="flex items-center justify-between text-sm">
            Justify text <Switch checked={prefs.justify} onChange={(v) => set({ justify: v })} />
          </label>
        </div>
      )}
      {comic && (
        <div className="space-y-4">
          <div>
            <div className="mb-1.5 text-xs text-muted">Layout</div>
            <Segmented value={prefs.comicMode} onChange={(v) => set({ comicMode: v })} options={[{ value: 'single', label: 'Single' }, { value: 'double', label: 'Spread' }, { value: 'scroll', label: 'Scroll' }]} />
          </div>
          <div>
            <div className="mb-1.5 text-xs text-muted">Direction</div>
            <Segmented value={prefs.comicDirection} onChange={(v) => set({ comicDirection: v })} options={[{ value: 'ltr', label: 'Left → right' }, { value: 'rtl', label: 'Right → left' }]} />
          </div>
          <div>
            <div className="mb-1.5 text-xs text-muted">Fit</div>
            <Segmented value={prefs.comicFit} onChange={(v) => set({ comicFit: v })} options={[{ value: 'height', label: 'Height' }, { value: 'width', label: 'Width' }, { value: 'original', label: 'Original' }]} />
          </div>
        </div>
      )}
      <div className="mt-6">
        <div className="mb-2 text-xs text-muted">Theme</div>
        <div className="grid grid-cols-4 gap-2">
          {(['night', 'sepia', 'paper', 'custom'] as const).map((t) => {
            const c = themeColors({ ...prefs, theme: t });
            return (
              <button key={t} onClick={() => set({ theme: t })} className={cls('aspect-square rounded-2xl text-sm font-semibold capitalize ring-2 transition', prefs.theme === t ? 'ring-accent' : 'ring-transparent')} style={{ background: c.bg, color: c.fg }}>
                Aa
                <div className="text-[10px] font-normal opacity-70">{t}</div>
              </button>
            );
          })}
        </div>
        {prefs.theme === 'custom' && (
          <div className="mt-3 flex gap-4 text-sm">
            <label className="flex items-center gap-2">
              Background <input type="color" value={prefs.customBg} onChange={(e) => set({ customBg: e.target.value })} />
            </label>
            <label className="flex items-center gap-2">
              Text <input type="color" value={prefs.customFg} onChange={(e) => set({ customFg: e.target.value })} />
            </label>
          </div>
        )}
      </div>
    </SidePanel>
  );
}

function SidePanel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <motion.aside
      initial={{ x: 30, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 30, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 900, damping: 60 }}
      className="glass-strong absolute top-3 right-3 bottom-3 z-40 flex w-[min(380px,calc(100%-1.5rem))] flex-col overflow-hidden rounded-3xl text-fg shadow-2xl"
    >
      <div className="flex items-center justify-between px-5 pt-4 pb-2">
        <h3 className="font-display text-lg font-semibold">{title}</h3>
        <button onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-full text-muted hover:bg-white/10">
          <X className="size-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-5 pb-5">{children}</div>
    </motion.aside>
  );
}

export default function Reader() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: prefsAll } = usePrefs();
  const offline = useOffline();
  const view = useRef<ReaderHandle>(null);
  const [chrome, setChrome] = useState(true);
  const [panel, setPanel] = useState<'settings' | 'notes' | 'toc' | null>(null);
  const [loc, setLoc] = useState<{ locator: string; percent: number; label?: string } | null>(null);
  const [toc, setToc] = useState<{ label: string; href: string }[]>([]);
  const [sel, setSel] = useState<{ locator: string; text: string; x: number; y: number } | null>(null);
  const [noteFor, setNoteFor] = useState<{ locator: string; text: string; color: string } | null>(null);
  const [noteText, setNoteText] = useState('');
  const saveTimer = useRef(0);

  // The source comes from ?src= (fresh open) or ?key= (resume from saved progress).
  const keyParam = params.get('key');
  const srcParam = params.get('src');
  const stored = useQuery({ queryKey: ['reading-item', keyParam], queryFn: () => api.reading.get(keyParam!), enabled: Boolean(keyParam && !srcParam) });
  const source: ReaderSource | null = useMemo(() => {
    if (srcParam) {
      try {
        return JSON.parse(srcParam) as ReaderSource;
      } catch {
        return null;
      }
    }
    const offlineEntry = keyParam ? offline.entries.find((e) => e.itemKey === keyParam) : undefined;
    if (offlineEntry) return { type: 'offline', itemKey: offlineEntry.itemKey, format: /pdf/.test(offlineEntry.mime) ? 'pdf' : offlineEntry.kind === 'comic' ? 'cbz' : 'epub', title: offlineEntry.title, cover: offlineEntry.poster };
    return (stored.data?.source as ReaderSource | undefined) ?? null;
  }, [srcParam, keyParam, stored.data, offline.entries]);
  const itemKey = source ? (keyParam ?? readerKey(source)) : null;

  const content = useQuery({ queryKey: ['reader-content', itemKey], queryFn: () => load(source!), enabled: Boolean(source), staleTime: Infinity, gcTime: 0, retry: false });
  const progress = useQuery({ queryKey: ['reading-item', itemKey], queryFn: () => api.reading.get(itemKey!), enabled: Boolean(itemKey) });
  const notes = useQuery({ queryKey: ['annotations', itemKey], queryFn: () => api.reading.annotations(itemKey!), enabled: Boolean(itemKey) });
  const series = useQuery({
    queryKey: ['plugin-meta', source?.type === 'plugin' ? source.pluginId : '', source?.type === 'plugin' ? source.metaType : '', source?.type === 'plugin' ? source.metaId : ''],
    queryFn: () => (source?.type === 'plugin' ? api.plugins.meta(source.pluginId, source.metaType, source.metaId!) : null),
    enabled: source?.type === 'plugin' && Boolean(source.metaId),
    staleTime: 10 * 60_000,
  });
  const nextChapter = useMemo(() => {
    if (source?.type !== 'plugin' || !series.data?.videos) return null;
    const vids = [...series.data.videos].sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
    const i = vids.findIndex((v) => v.id === source.videoId);
    return i >= 0 ? (vids[i + 1] ?? null) : null;
  }, [series.data, source]);
  const openNext = () => {
    if (source?.type !== 'plugin' || !nextChapter) return;
    navigate(readerPath({ ...source, videoId: nextChapter.id, title: `${source.series ?? series.data?.name ?? ''} — ${nextChapter.title}`, chapter: chapterOf(nextChapter) }), { replace: true });
  };

  useEffect(() => {
    const d = content.data;
    return () => {
      if (d?.format === 'comic') d.pages.filter((p) => p.startsWith('blob:')).forEach((p) => URL.revokeObjectURL(p));
    };
  }, [content.data]);

  const kind: ReadingKind =
    content.data?.format === 'pdf'
      ? 'pdf'
      : content.data?.format === 'comic'
        ? source?.type === 'plugin' || (source?.type === 'library' && source.manga)
          ? 'manga'
          : 'comic'
        : 'book';
  const onLocation = useCallback(
    (locator: string, percent: number, label?: string) => {
      setLoc({ locator, percent, label });
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        if (!itemKey || !source) return;
        void api.reading
          .save({ itemKey, kind, title: source.title, cover: source.cover, author: 'author' in source ? (source.author ?? null) : null, locator, percent, source: source as unknown as Record<string, unknown> })
          .then(() => qc.invalidateQueries({ queryKey: ['reading-progress'] }));
      }, 1500);
    },
    [itemKey, source, kind, qc],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const rtl = prefsAll?.reader.comicDirection === 'rtl' && content.data?.format === 'comic';
      if (e.key === 'ArrowRight' || e.key === ' ') (rtl ? view.current?.prev() : view.current?.next());
      else if (e.key === 'ArrowLeft') (rtl ? view.current?.next() : view.current?.prev());
      else if (e.key === 'Escape') panel ? setPanel(null) : navigate(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (!chrome || panel) return;
    const t = window.setTimeout(() => setChrome(false), 3500);
    return () => window.clearTimeout(t);
  }, [chrome, panel, loc?.locator]);

  const presenceTitle = source ? ('series' in source && source.series) || source.title : null;
  useEffect(() => {
    if (!presenceTitle) return;
    setPresence({ kind: 'reading', title: presenceTitle, subtitle: presenceTitle !== source?.title ? source?.title.replace(`${presenceTitle} — `, '') : loc?.label, image: publicImage(source?.cover), start: Math.floor(Date.now() / 1000) });
    return () => setPresence(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presenceTitle, source?.title]);

  // Finishing a chapter of a series matched to AniList moves the connected manga lists forward.
  const trackKey = source?.type === 'plugin' && source.anilist && source.chapter ? `${source.anilist}:${source.chapter}` : null;
  const finished = (loc?.percent ?? 0) >= 0.95;
  const tracked = useRef<string | null>(null);
  useEffect(() => {
    if (!trackKey || !finished || tracked.current === trackKey) return;
    tracked.current = trackKey;
    const [id, chapter] = trackKey.split(':');
    api.trackers.progress(`manga:${id}`, Math.floor(Number(chapter))).catch(() => {});
  }, [trackKey, finished]);

  if (!prefsAll) return null;
  const prefs = prefsAll.reader;
  const { bg, fg, dark } = themeColors(prefs);
  const bookmarks = (notes.data ?? []).filter((a) => a.kind === 'bookmark');
  const bookmarked = loc && bookmarks.find((b) => b.locator === loc.locator);
  const saved = itemKey ? offline.entries.some((e) => e.itemKey === itemKey) : false;

  const annotate = async (a: { kind: Annotation['kind']; locator: string; text?: string | null; note?: string | null; color?: string | null }) => {
    if (!itemKey) return;
    try {
      await api.reading.annotate({ itemKey, ...a });
      qc.invalidateQueries({ queryKey: ['annotations', itemKey] });
    } catch (e) {
      toast(errorText(e), 'bad');
    }
  };

  if (!source && !stored.isLoading) return <Empty title="Nothing to read here">Open a book or comic from the Read tab.</Empty>;

  return (
    <div className="fixed inset-0 overflow-hidden" style={{ background: bg, color: fg }}>
      <div className="absolute inset-0" style={content.data?.format === 'epub' ? { paddingInline: `${prefs.margins}%`, paddingBlock: '4.5rem' } : undefined}>
        {content.isLoading && (
          <div className="grid size-full place-items-center">
            <Spinner className="size-8" />
          </div>
        )}
        {content.error && <Empty title="Couldn't open this">{errorText(content.error)}</Empty>}
        {content.data && progress.isFetched && (
          <Suspense key={itemKey} fallback={<div className="grid size-full place-items-center"><Spinner className="size-8" /></div>}>
            {content.data.format === 'epub' && (
              <EpubView
                ref={view}
                buffer={content.data.buffer}
                prefs={prefs}
                initialLocator={progress.data?.locator ?? null}
                annotations={notes.data ?? []}
                onLocation={onLocation}
                onSelect={setSel}
                onToc={setToc}
                onTap={() => setChrome((c) => !c)}
              />
            )}
            {content.data.format === 'pdf' && (
              <PdfView ref={view} buffer={content.data.buffer} prefs={prefs} initialLocator={progress.data?.locator ?? null} annotations={[]} onLocation={onLocation} onTap={() => setChrome((c) => !c)} />
            )}
            {content.data.format === 'comic' && (
              <ComicView ref={view} pages={content.data.pages} prefs={prefs} initialLocator={progress.data?.locator ?? null} annotations={[]} onLocation={onLocation} onTap={() => setChrome((c) => !c)} />
            )}
          </Suspense>
        )}
      </div>

      {content.data && content.data.format !== 'pdf' && !(content.data.format === 'comic' && prefs.comicMode === 'scroll') && (
        <>
          <button aria-label="Previous page" onClick={() => view.current?.prev()} className={cls('absolute top-1/2 left-2 z-10 hidden size-12 -translate-y-1/2 place-items-center rounded-full transition-opacity sm:grid', chrome ? 'opacity-60 hover:opacity-100' : 'opacity-0')}>
            <ChevronLeft className="size-7" />
          </button>
          <button aria-label="Next page" onClick={() => view.current?.next()} className={cls('absolute top-1/2 right-2 z-10 hidden size-12 -translate-y-1/2 place-items-center rounded-full transition-opacity sm:grid', chrome ? 'opacity-60 hover:opacity-100' : 'opacity-0')}>
            <ChevronRight className="size-7" />
          </button>
        </>
      )}

      <AnimatePresence>
        {chrome && (
          <>
            <motion.div initial={{ y: -20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -20, opacity: 0 }} className="app-drag wco-pad absolute inset-x-0 top-0 z-30 flex items-center gap-2 pt-safe-2 pb-2 [--wco-px:0.75rem]" style={{ background: `linear-gradient(${bg}, ${bg}ee 60%, transparent)` }}>
              <button onClick={() => navigate(-1)} aria-label="Back" className="grid size-10 place-items-center rounded-full hover:bg-black/10">
                <ArrowLeft className="size-5" />
              </button>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{source?.title}</div>
                {loc?.label && <div className="truncate text-xs opacity-60">{loc.label}</div>}
              </div>
              {toc.length > 0 && (
                <button onClick={() => setPanel('toc')} aria-label="Contents" className="grid size-10 place-items-center rounded-full hover:bg-black/10">
                  <ListTree className="size-5" />
                </button>
              )}
              <button
                onClick={() => (bookmarked ? api.reading.deleteAnnotation(bookmarked.id).then(() => qc.invalidateQueries({ queryKey: ['annotations', itemKey] })) : loc && annotate({ kind: 'bookmark', locator: loc.locator, text: loc.label ?? null }))}
                aria-label="Bookmark"
                className="grid size-10 place-items-center rounded-full hover:bg-black/10"
              >
                {bookmarked ? <BookmarkCheck className="size-5 text-accent" /> : <Bookmark className="size-5" />}
              </button>
              <button onClick={() => setPanel('notes')} aria-label="Notes" className="grid size-10 place-items-center rounded-full hover:bg-black/10">
                <NotebookPen className="size-5" />
              </button>
              {source && source.type !== 'plugin' && source.type !== 'offline' && (
                <button
                  onClick={() => {
                    if (saved || !itemKey) return toast('Already on this device');
                    const path = source.type === 'library' ? `/stream/l/${source.fileId}` : api.media.fetchUrl(source.url);
                    void offline.save({ itemKey, kind: content.data?.format === 'comic' ? 'comic' : 'book', mediaId: itemKey, mediaType: kind, title: source.title, subtitle: null, poster: source.cover, season: null, episode: null }, path, source.title, content.data?.format === 'pdf' ? 'application/pdf' : 'application/epub+zip');
                    toast('Saving for offline reading');
                  }}
                  aria-label="Save offline"
                  className="grid size-10 place-items-center rounded-full hover:bg-black/10"
                >
                  <Download className={cls('size-5', saved && 'text-accent')} />
                </button>
              )}
              <button onClick={() => setPanel('settings')} aria-label="Reading settings" className="grid size-10 place-items-center rounded-full hover:bg-black/10">
                <Type className="size-5" />
              </button>
            </motion.div>
            <motion.div initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 20, opacity: 0 }} className="absolute inset-x-0 bottom-0 z-30 px-5 pt-6 pb-safe-4" style={{ background: `linear-gradient(transparent, ${bg}ee 40%, ${bg})` }}>
              <div className="mx-auto flex max-w-3xl items-center gap-4">
                <input
                  aria-label="Position"
                  type="range"
                  min={0}
                  max={1000}
                  value={Math.round((loc?.percent ?? 0) * 1000)}
                  onChange={(e) => view.current?.goToPercent(Number(e.target.value) / 1000)}
                  className="flex-1"
                  style={{ accentColor: dark ? '#a78bfa' : '#7c3aed' }}
                />
                <span className="w-12 text-right text-xs tabular-nums opacity-70">{Math.round((loc?.percent ?? 0) * 100)}%</span>
                {nextChapter && (
                  <button onClick={openNext} className="flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-semibold hover:bg-black/10">
                    Next chapter <ChevronRight className="size-4" />
                  </button>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* end of chapter */}
      <AnimatePresence>
        {nextChapter && (loc?.percent ?? 0) >= 0.999 && (
          <motion.button
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            onClick={openNext}
            className="glass-strong fixed right-6 bottom-24 z-40 flex items-center gap-3 rounded-2xl px-5 py-3.5 text-left text-fg shadow-2xl"
          >
            <span>
              <span className="block text-xs text-faint">Up next</span>
              <span className="block font-semibold">{nextChapter.title}</span>
            </span>
            <ChevronRight className="size-5" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* selection toolbar */}
      <AnimatePresence>
        {sel && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0 }}
            className="glass-strong fixed z-50 flex -translate-x-1/2 -translate-y-full items-center gap-1 rounded-2xl p-1.5 text-fg shadow-2xl"
            style={{ left: sel.x, top: Math.max(60, sel.y - 10) }}
          >
            {HL_COLORS.map((c) => (
              <button
                key={c}
                aria-label="Highlight"
                onClick={() => {
                  void annotate({ kind: 'highlight', locator: sel.locator, text: sel.text, color: c });
                  setSel(null);
                }}
                className="size-7 rounded-full ring-2 ring-white/20 transition-transform hover:scale-110"
                style={{ background: c }}
              />
            ))}
            <button
              onClick={() => {
                setNoteFor({ locator: sel.locator, text: sel.text, color: HL_COLORS[0]! });
                setNoteText('');
                setSel(null);
              }}
              className="rounded-xl px-3 py-1.5 text-sm hover:bg-white/10"
            >
              Note
            </button>
            <button onClick={() => setSel(null)} aria-label="Dismiss" className="rounded-xl p-1.5 text-muted hover:bg-white/10">
              <X className="size-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {panel === 'settings' && <ReaderSettings prefs={prefs} comic={content.data?.format === 'comic'} onClose={() => setPanel(null)} />}
        {panel === 'toc' && (
          <SidePanel title="Contents" onClose={() => setPanel(null)}>
            {toc.map((t, i) => (
              <button
                key={i}
                onClick={() => {
                  view.current?.goTo(t.href);
                  setPanel(null);
                }}
                className="block w-full truncate rounded-lg px-2 py-2 text-left text-sm hover:bg-white/8"
              >
                {t.label}
              </button>
            ))}
          </SidePanel>
        )}
        {panel === 'notes' && (
          <SidePanel title="Highlights & notes" onClose={() => setPanel(null)}>
            {!notes.data?.length && <p className="text-sm text-muted">Select text to highlight it or add a note. Bookmarks appear here too, synced across your devices.</p>}
            <div className="space-y-2">
              {notes.data?.map((a) => (
                <div key={a.id} className="group rounded-2xl border border-line p-3">
                  <button
                    onClick={() => {
                      view.current?.goTo(a.locator);
                      setPanel(null);
                    }}
                    className="block w-full text-left"
                  >
                    <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold tracking-wider text-faint uppercase">
                      {a.kind === 'highlight' && <span className="size-2.5 rounded-full" style={{ background: a.color ?? HL_COLORS[0] }} />}
                      {a.kind}
                    </div>
                    {a.text && <p className="line-clamp-4 text-sm leading-relaxed italic">“{a.text}”</p>}
                    {a.note && <p className="mt-1.5 text-sm text-fg/90">{a.note}</p>}
                  </button>
                  <button
                    onClick={async () => {
                      await api.reading.deleteAnnotation(a.id);
                      view.current?.removeHighlight?.(a.locator);
                      qc.invalidateQueries({ queryKey: ['annotations', itemKey] });
                    }}
                    aria-label="Delete"
                    className="mt-2 text-muted opacity-0 transition group-hover:opacity-100 hover:text-bad"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              ))}
            </div>
          </SidePanel>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {noteFor && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-5 text-fg backdrop-blur-sm">
            <div className="glass-strong w-full max-w-md rounded-3xl p-5">
              <p className="line-clamp-3 text-sm text-muted italic">“{noteFor.text}”</p>
              <TextArea autoFocus className="mt-3" placeholder="Your note" value={noteText} onChange={(e) => setNoteText(e.target.value)} />
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setNoteFor(null)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    void annotate({ kind: 'highlight', locator: noteFor.locator, text: noteFor.text, note: noteText.trim() || null, color: noteFor.color });
                    setNoteFor(null);
                  }}
                >
                  Save note
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
