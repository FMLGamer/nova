import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQueries, useQuery } from '@tanstack/react-query';
import { BookOpen, ExternalLink, HardDrive, Library, ListChecks, MoreHorizontal, Puzzle, Star } from 'lucide-react';
import { api } from '../lib/api';
import { useContributions } from '../lib/queries';
import { readerPath } from '../lib/reader';
import { errorText, toast, useApp } from '../lib/store';
import type { LibraryFile, LibraryItem, MetaPreview, ReadDetail } from '../lib/types';
import { FORMAT_LABEL, ReadCard } from '../components/ReadCard';
import { Rail } from '../components/media';
import { TrackingModal, trackStatusLabel, useTrackEntry, useTrackersConnected } from '../components/Tracking';
import { Badge, Button, Empty, Menu, MenuItem, Spinner } from '../components/ui';
import { useOpenMeta } from './PluginMeta';
import { VolumePicker, openServerItem } from './Read';

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');
const sameTitle = (a: string, names: string[]) => {
  const x = norm(a);
  return x.length > 2 && names.some((n) => {
    const y = norm(n);
    return y.length > 2 && (x === y || x.includes(y) || y.includes(x));
  });
};

/** Where this title can be read: a free edition, your server, your plugins. */
function Sources({ d }: { d: ReadDetail }) {
  const navigate = useNavigate();
  const openMeta = useOpenMeta();
  const { data: contrib } = useContributions();
  const [volumes, setVolumes] = useState<{ item: LibraryItem; files: LibraryFile[] } | null>(null);
  const isBook = d.format === 'book';
  const names = [d.title, ...d.altTitles];

  const local = useQuery({ queryKey: ['server-items', 'search', d.title], queryFn: () => api.server.items({ q: d.title }), retry: false, staleTime: 60_000 });
  const mine = (local.data ?? []).filter((i) => (isBook ? i.kind === 'book' : i.kind === 'manga' || i.kind === 'comic') && sameTitle(i.title, names));
  // Old books may be public domain: Project Gutenberg then has an edition to read right away.
  const free = useQuery({ queryKey: ['read-free', d.title, d.author], queryFn: () => api.catalog.readFree(d.title, d.author), enabled: isBook && (!d.year || d.year < 1930), staleTime: Infinity, retry: false });
  const freeEpub = free.data ?? null;

  // Plugin catalogues that can search for something readable of this kind.
  const readerOf = (type: string) => contrib?.mediaTypes.find((m) => m.id === type)?.reader ?? (type === 'book' ? 'book' : type === 'manga' || type === 'comic' ? 'comic' : null);
  const catalogs = (contrib?.searchCatalogs ?? []).filter((c) => readerOf(c.type) === (isBook ? 'book' : 'comic'));
  const queries = [...new Set([d.title, d.altTitles.find((t) => /^[\x20-\x7e]+$/.test(t))].filter((t): t is string => Boolean(t)))];
  const found = useQueries({
    queries: catalogs.flatMap((c) =>
      queries.map((term) => ({
        queryKey: ['plugin-catalog', c.pluginId, c.type, c.id, term],
        queryFn: () => api.plugins.catalog(c.pluginId, c.type, c.id, { search: term }),
        staleTime: 30 * 60_000,
        retry: false,
      })),
    ),
  });
  const pluginHits = useMemo(() => {
    const out: { pluginId: string; pluginName: string; meta: MetaPreview }[] = [];
    const seen = new Set<string>();
    catalogs.forEach((c, ci) => {
      queries.forEach((_, qi) => {
        for (const m of (found[ci * queries.length + qi]?.data ?? []).slice(0, 4)) {
          const key = `${c.pluginId}:${m.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ pluginId: c.pluginId, pluginName: c.pluginName, meta: m });
        }
      });
    });
    // Exact title matches first.
    return out.sort((a, b) => Number(sameTitle(b.meta.name, names)) - Number(sameTitle(a.meta.name, names)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [found.map((f) => f.dataUpdatedAt).join(',')]);
  const searching = local.isLoading || free.isFetching || found.some((f) => f.isLoading);

  const row = 'flex w-full items-center gap-3 rounded-2xl border border-line p-2.5 text-left transition hover:border-line-strong hover:bg-white/4';
  const cover = (src: string | null | undefined) => <div className="h-16 w-11 shrink-0 overflow-hidden rounded-lg bg-ink-800">{src && <img src={src} alt="" loading="lazy" className="size-full object-cover" />}</div>;

  return (
    <section id="sources" className="scroll-mt-24 px-5 sm:px-10">
      <h2 className="mb-4 font-display text-2xl font-semibold">Read it</h2>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {freeEpub && (
          <button onClick={() => navigate(readerPath({ type: 'url', url: freeEpub, format: 'epub', title: d.title, cover: d.poster, author: d.author }))} className={row}>
            {cover(d.poster)}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">Free edition</span>
              <span className="block text-xs text-faint">Project Gutenberg · public domain</span>
            </span>
            <Badge tone="ok">Free</Badge>
          </button>
        )}
        {mine.map((i) => (
          <button
            key={i.id}
            onClick={() => openServerItem(i, navigate, (files) => setVolumes({ item: i, files })).catch((e) => toast(errorText(e), 'bad'))}
            className={row}
          >
            {cover(i.poster)}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{i.title}</span>
              <span className="block text-xs text-faint">On your server{i.fileCount > 1 ? ` · ${i.fileCount} files` : ''}</span>
            </span>
            <HardDrive className="size-4 text-accent" />
          </button>
        ))}
        {pluginHits.map((h) => (
          <button key={`${h.pluginId}:${h.meta.id}`} onClick={() => void openMeta(h.pluginId, h.meta, d.anilistId ?? undefined)} className={row}>
            {cover(h.meta.poster)}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{h.meta.name}</span>
              <span className="block truncate text-xs text-faint">
                {h.pluginName}
                {h.meta.releaseInfo ? ` · ${h.meta.releaseInfo}` : ''}
              </span>
            </span>
            <Puzzle className="size-4 text-faint" />
          </button>
        ))}
      </div>
      {searching && (
        <div className="mt-3 flex items-center gap-2 text-sm text-muted">
          <Spinner className="size-4" /> Looking on your server and in your plugins…
        </div>
      )}
      {!searching && !freeEpub && !mine.length && !pluginHits.length && (
        <p className="max-w-2xl text-sm text-muted">
          {catalogs.length
            ? "Your plugins didn't find this one."
            : isBook
              ? 'Nothing to read it with yet: add a folder of e-books under Server → Library → Reading folders, or a book source plugin under Server → Plugins.'
              : 'Nothing to read it with yet: add a folder of comics under Server → Library → Reading folders, or a manga source plugin (such as MangaDex) under Server → Plugins.'}
        </p>
      )}
      {volumes && <VolumePicker item={volumes.item} files={volumes.files} onClose={() => setVolumes(null)} />}
    </section>
  );
}

export default function ReadTitle() {
  const { kind = '', id = '' } = useParams();
  const setAmbient = useApp((s) => s.setAmbient);
  const { data: d, isLoading, error } = useQuery({ queryKey: ['read-detail', kind, id], queryFn: () => api.catalog.readDetail(kind, id), staleTime: 30 * 60_000 });
  const [more, setMore] = useState(false);
  const [tracking, setTracking] = useState(false);
  const connected = useTrackersConnected();
  const trackId = d?.anilistId && d.format !== 'book' ? `manga:${d.anilistId}` : null;
  const entry = useTrackEntry(trackId, connected);
  useEffect(() => setAmbient(d?.backdrop ?? d?.poster ?? null), [d?.backdrop, d?.poster, setAmbient]);

  if (isLoading) return <div className="skeleton h-[60svh] w-full" />;
  if (error || !d) return <Empty title="Couldn't load this title">{errorText(error)}</Empty>;

  const facts = [
    FORMAT_LABEL[d.format],
    d.year,
    d.status ? d.status.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : null,
    d.chapters ? `${d.chapters} chapters` : null,
    d.volumes ? `${d.volumes} volumes` : null,
  ].filter(Boolean);

  return (
    <div className="space-y-12 pb-10">
      <section className="relative min-h-[62svh] w-full overflow-hidden">
        <img src={d.backdrop ?? d.poster ?? undefined} alt="" className={d.backdrop ? 'absolute inset-0 size-full object-cover' : 'absolute inset-0 size-full scale-125 object-cover opacity-50 blur-3xl'} />
        <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/50 to-bg/10" />
        <div className="absolute inset-0 bg-gradient-to-r from-bg/90 via-bg/40 to-transparent" />
        <div className="relative flex min-h-[62svh] flex-col justify-end gap-6 px-5 pt-28 pb-8 sm:flex-row sm:items-end sm:px-10">
          {d.poster && <img src={d.poster} alt="" className="w-36 shrink-0 rounded-2xl shadow-2xl ring-1 ring-white/10 sm:w-48" />}
          <div className="min-w-0 max-w-3xl">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge>{FORMAT_LABEL[d.format]}</Badge>
              {d.rating ? (
                <span className="nova-score flex items-center gap-1 text-sm font-semibold">
                  <Star className="size-3.5 fill-amber-300 text-amber-300" /> {d.rating.toFixed(1)}
                </span>
              ) : null}
            </div>
            <h1 className="font-display text-[clamp(2rem,5vw,4rem)] leading-[1] font-bold text-balance">{d.title}</h1>
            {d.author && <div className="mt-2 text-white/80">{d.author}</div>}
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-white/70">
              {facts.slice(1).map((f) => (
                <span key={String(f)}>{f}</span>
              ))}
              {d.genres.slice(0, 5).map((g) => (
                <span key={g} className="rounded-full border border-white/20 px-2.5 py-0.5 text-xs">
                  {g}
                </span>
              ))}
            </div>
            {d.overview && (
              <p className={more ? 'mt-4 text-[15px] leading-relaxed whitespace-pre-line text-white/80' : 'mt-4 line-clamp-4 text-[15px] leading-relaxed text-white/80'} onClick={() => setMore(true)}>
                {d.overview}
              </p>
            )}
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button variant="white" size="lg" icon={<BookOpen className="size-5" />} onClick={() => document.getElementById('sources')?.scrollIntoView({ behavior: 'smooth' })}>
                Read
              </Button>
              {trackId && connected && (
                <Button size="lg" variant="ghost" icon={<ListChecks className="size-5" />} onClick={() => setTracking(true)}>
                  {(() => {
                    const e = entry.data?.anilist ?? entry.data?.mal;
                    return e?.status ? `${trackStatusLabel(e.status, 'manga')}${e.progress ? ` · ch. ${e.progress}` : ''}` : 'Track';
                  })()}
                </Button>
              )}
              <Menu
                align="left"
                up
                width="w-56"
                trigger={(_o, t) => (
                  <Button size="lg" variant="ghost" icon={<MoreHorizontal className="size-5" />} onClick={t}>
                    More
                  </Button>
                )}
              >
                {(close) =>
                  d.links.map((l) => (
                    <MenuItem
                      key={l.url}
                      icon={<ExternalLink />}
                      onClick={() => {
                        close();
                        window.open(l.url, '_blank', 'noopener');
                      }}
                    >
                      Open on {l.label}
                    </MenuItem>
                  ))
                }
              </Menu>
            </div>
          </div>
        </div>
      </section>

      <Sources d={d} />
      {tracking && trackId && <TrackingModal mediaId={trackId} total={d.chapters} kind="manga" onClose={() => setTracking(false)} />}

      {d.related.length > 0 && (
        <Rail title={<span className="flex items-center gap-2"><Library className="size-5 text-accent" /> Related & recommended</span>}>
          {d.related.map((r) => (
            <ReadCard key={r.id} item={r} hint={r.relation !== 'RECOMMENDATION' ? r.relation.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : undefined} />
          ))}
        </Rail>
      )}
    </div>
  );
}
