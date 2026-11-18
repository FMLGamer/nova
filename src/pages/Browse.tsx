import { useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { api } from '../lib/api';
import { HERO_HEIGHT, Hero, pickHero } from '../components/Hero';
import { PosterGrid } from '../components/media';
import { BrowseFilters, BrowseSection } from '../components/BrowseSection';

const SORTS = [
  { value: 'popularity.desc', label: 'Popular' },
  { value: 'vote_average.desc', label: 'Top rated' },
  { value: 'newest', label: 'Newest' },
] as const;

/** Search params as filter state (replace, so filters don't pile up in history). */
export function useFilterParams() {
  const [params, setParams] = useSearchParams();
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true, preventScrollReset: true });
  };
  return [params, set] as const;
}

export function Browse({ kind }: { kind: 'movies' | 'shows' }) {
  const [params, set] = useFilterParams();
  const genre = params.get('genre') ?? '';
  const sort = params.get('sort') ?? 'popularity.desc';
  const apiSort = sort === 'newest' ? (kind === 'movies' ? 'primary_release_date.desc' : 'first_air_date.desc') : sort;

  const genres = useQuery({ queryKey: ['genres', kind], queryFn: () => api.catalog.genres(kind === 'movies' ? 'movie' : 'tv'), staleTime: Infinity });
  const q = useInfiniteQuery({
    queryKey: ['browse', kind, genre, apiSort],
    queryFn: ({ pageParam }) => api.catalog.browse(kind, { page: pageParam, genre: genre || undefined, sort: apiSort }),
    initialPageParam: 1,
    getNextPageParam: (last, all) => (last.length ? all.length + 1 : undefined),
    staleTime: 10 * 60_000,
  });
  const items = q.data?.pages.flat() ?? [];
  const firstPage = q.data?.pages[0];
  const featured = useMemo(() => pickHero(firstPage), [firstPage]);

  return (
    <div>
      <h1 className="sr-only">{kind === 'movies' ? 'Movies' : 'Shows'}</h1>
      {featured ? (
        <Hero item={featured} compact eyebrow={kind === 'movies' ? 'Featured film' : 'Featured series'} />
      ) : (
        q.isLoading && <div className={`${HERO_HEIGHT.compact} skeleton`} />
      )}
      <BrowseSection
        top={!featured && !q.isLoading}
        className={featured || q.isLoading ? 'mt-12' : undefined}
        title={kind === 'movies' ? 'Browse movies' : 'Browse shows'}
        filters={
          <BrowseFilters
            sort={sort as (typeof SORTS)[number]['value']}
            sorts={SORTS}
            onSort={(v) => set('sort', v === 'popularity.desc' ? '' : v)}
            genre={genre}
            genres={(genres.data ?? []).map((g) => ({ value: String(g.id), label: g.name }))}
            onGenre={(v) => set('genre', v)}
          />
        }
      >
        <PosterGrid items={items} loading={q.isLoading || q.isFetchingNextPage} done={!q.hasNextPage} onEnd={() => q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage()} />
      </BrowseSection>
    </div>
  );
}
