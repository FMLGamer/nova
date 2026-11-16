import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { api } from '../lib/api';
import { PosterGrid } from '../components/media';
import { Chip, Segmented } from '../components/ui';

const SORTS = [
  { value: 'popularity.desc', label: 'Popular' },
  { value: 'vote_average.desc', label: 'Top rated' },
  { value: 'newest', label: 'Newest' },
] as const;

export function Kicker({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return (
    <div className="mb-2.5 flex items-center gap-2.5 text-[11px] font-semibold tracking-[0.24em] text-muted uppercase">
      <span className="h-[3px] w-5 rounded-full" style={{ background: tone ?? 'var(--a1)' }} />
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  kicker,
  tone,
  children,
}: {
  title: string;
  subtitle?: string;
  kicker?: string;
  /** Per-tab signature colour for the kicker rule. */
  tone?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="px-5 pt-24 pb-6 sm:px-10 sm:pt-28">
      {kicker && <Kicker tone={tone}>{kicker}</Kicker>}
      <h1 className="font-display text-4xl font-bold tracking-tight sm:text-6xl">{title}</h1>
      {subtitle && <p className="mt-2 max-w-xl text-muted">{subtitle}</p>}
      {children && <div className="mt-6">{children}</div>}
    </div>
  );
}

export function Browse({ kind }: { kind: 'movies' | 'shows' }) {
  const [params, setParams] = useSearchParams();
  const genre = params.get('genre') ?? '';
  const sort = params.get('sort') ?? 'popularity.desc';
  const apiSort = sort === 'newest' ? (kind === 'movies' ? 'primary_release_date.desc' : 'first_air_date.desc') : sort;
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };

  const genres = useQuery({ queryKey: ['genres', kind], queryFn: () => api.catalog.genres(kind === 'movies' ? 'movie' : 'tv'), staleTime: Infinity });
  const q = useInfiniteQuery({
    queryKey: ['browse', kind, genre, apiSort],
    queryFn: ({ pageParam }) => api.catalog.browse(kind, { page: pageParam, genre: genre || undefined, sort: apiSort }),
    initialPageParam: 1,
    getNextPageParam: (last, all) => (last.length ? all.length + 1 : undefined),
    staleTime: 10 * 60_000,
  });
  const items = q.data?.pages.flat() ?? [];

  return (
    <div>
      <PageHeader
        title={kind === 'movies' ? 'Movies' : 'Shows'}
        kicker={kind === 'movies' ? 'Feature films' : 'Series & seasons'}
        tone={kind === 'movies' ? '#f5b544' : '#4fb3ff'}
      >
        <div className="flex flex-col gap-4">
          <Segmented value={sort} onChange={(v) => set('sort', v === 'popularity.desc' ? '' : v)} options={SORTS.map((s) => ({ value: s.value, label: s.label }))} className="self-start" />
          <div className="scrollbar-none -mx-5 flex gap-2 overflow-x-auto px-5 sm:-mx-10 sm:px-10">
            <Chip active={!genre} onClick={() => set('genre', '')}>
              All
            </Chip>
            {genres.data?.map((g) => (
              <Chip key={g.id} active={genre === String(g.id)} onClick={() => set('genre', String(g.id))}>
                {g.name}
              </Chip>
            ))}
          </div>
        </div>
      </PageHeader>
      <PosterGrid items={items} loading={q.isLoading || q.isFetchingNextPage} done={!q.hasNextPage} onEnd={() => q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage()} />
    </div>
  );
}
