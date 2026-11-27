import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Search as SearchIcon, X } from 'lucide-react';
import { api } from '../lib/api';
import { useContributions } from '../lib/queries';
import { PosterCard } from '../components/media';
import { ReadCard } from '../components/ReadCard';
import { Empty, Segmented, Spinner } from '../components/ui';
import { MetaCard } from './PluginMeta';

type Tab = 'all' | 'movies' | 'shows' | 'anime' | 'read';

export default function Search() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const type = params.get('type');
  const [text, setText] = useState(q);
  const [tab, setTab] = useState<Tab>(type === 'movies' || type === 'shows' || type === 'anime' || type === 'read' ? type : 'all');
  const { data: contrib } = useContributions();

  useEffect(() => {
    const t = window.setTimeout(() => {
      if (text.trim() !== q) setParams(text.trim() ? { q: text.trim(), ...(type ? { type } : {}) } : {}, { replace: true });
    }, 300);
    return () => window.clearTimeout(t);
  }, [text, q, type, setParams]);

  const res = useQuery({ queryKey: ['search', q], queryFn: () => api.catalog.search(q), enabled: q.length >= 2, staleTime: 5 * 60_000 });
  const reads = useQuery({ queryKey: ['search-read', q], queryFn: () => api.catalog.readSearch(q), enabled: q.length >= 2, staleTime: 5 * 60_000 });
  const plugins = useQuery({
    queryKey: ['search-plugins', q],
    enabled: q.length >= 2 && Boolean(contrib?.searchCatalogs.length),
    queryFn: async () =>
      (
        await Promise.all(
          (contrib?.searchCatalogs ?? []).map((c) =>
            api.plugins
              .catalog(c.pluginId, c.type, c.id, { search: q })
              .then((metas) => ({ c, metas }))
              .catch(() => ({ c, metas: [] })),
          ),
        )
      ).filter((x) => x.metas.length),
  });

  const top = res.data?.top ?? [];
  const firstIn = (items: { id: string }[]) => {
    const i = top.findIndex((t) => items.some((x) => x.id === t.id));
    return i < 0 ? 99 : i;
  };
  const groups = [
    { key: 'movies' as const, title: 'Movies', items: res.data?.movies ?? [] },
    { key: 'shows' as const, title: 'Shows', items: res.data?.shows ?? [] },
    { key: 'anime' as const, title: 'Anime', items: res.data?.anime ?? [] },
  ]
    .filter((g) => g.items.length && (tab === 'all' || tab === g.key))
    .sort((a, b) => firstIn(a.items) - firstIn(b.items));
  const readItems = tab === 'all' || tab === 'read' ? (reads.data ?? []) : [];
  const total = (res.data?.movies.length ?? 0) + (res.data?.shows.length ?? 0) + (res.data?.anime.length ?? 0) + (reads.data?.length ?? 0);

  return (
    <div className="px-5 pt-24 sm:px-10 sm:pt-28">
      <div className="relative">
        <SearchIcon className="absolute top-1/2 left-0 size-7 -translate-y-1/2 text-faint" />
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search movies, shows, anime…"
          className="h-20 w-full border-b border-line bg-transparent pr-12 pl-11 font-display text-3xl font-semibold placeholder:text-faint/60 focus:border-white/40 focus:outline-none sm:text-5xl"
        />
        {text && (
          <button onClick={() => setText('')} aria-label="Clear" className="absolute top-1/2 right-0 grid size-10 -translate-y-1/2 place-items-center rounded-full text-muted hover:bg-white/8">
            <X className="size-5" />
          </button>
        )}
      </div>

      {q.length >= 2 && total > 0 && (
        <Segmented
          className="mt-6"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'all', label: `All ${total}` },
            { value: 'movies', label: `Movies ${res.data?.movies.length ?? 0}` },
            { value: 'shows', label: `Shows ${res.data?.shows.length ?? 0}` },
            { value: 'anime', label: `Anime ${res.data?.anime.length ?? 0}` },
            { value: 'read', label: `Manga & books ${reads.data?.length ?? 0}` },
          ]}
        />
      )}

      {res.isFetching && (
        <div className="grid h-40 place-items-center">
          <Spinner className="size-6" />
        </div>
      )}

      <div className="mt-8 space-y-12">
        {tab === 'all' && top.length > 0 && (
          <section>
            <h2 className="mb-4 font-display text-xl font-semibold">Top results</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-x-4 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(168px,1fr))]">
              {top.slice(0, 6).map((it) => (
                <PosterCard key={it.id} item={it} />
              ))}
            </div>
          </section>
        )}
        {groups.map((g) => (
          <section key={g.key}>
            <h2 className="mb-4 font-display text-xl font-semibold">{g.title}</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-x-4 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(168px,1fr))]">
              {g.items.map((it) => (
                <PosterCard key={it.id} item={it} />
              ))}
            </div>
          </section>
        ))}
        {readItems.length > 0 && (
          <section>
            <h2 className="mb-4 font-display text-xl font-semibold">Manga & books</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-x-4 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(168px,1fr))]">
              {readItems.map((it) => (
                <ReadCard key={it.id} item={it} />
              ))}
            </div>
          </section>
        )}
        {tab === 'all' &&
          plugins.data?.map(({ c, metas }) => (
            <section key={`${c.pluginId}:${c.id}`}>
              <h2 className="mb-4 font-display text-xl font-semibold">
                {c.name} <span className="text-sm font-normal text-faint">· {c.pluginName}</span>
              </h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-x-4 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(168px,1fr))]">
                {metas.slice(0, 18).map((m) => (
                  <MetaCard key={m.id} pluginId={c.pluginId} meta={m} />
                ))}
              </div>
            </section>
          ))}
      </div>

      {q.length >= 2 && res.isSuccess && !total && !plugins.data?.length && <Empty icon={<SearchIcon />} title={`Nothing for “${q}”`}>Check the spelling, or try the original title.</Empty>}
      {q.length < 2 && <p className="mt-10 text-muted">Start typing — results appear as you go. Press Ctrl K anywhere for quick search.</p>}
    </div>
  );
}
