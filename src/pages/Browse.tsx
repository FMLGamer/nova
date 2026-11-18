import { useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { api } from '../lib/api';
import { Hero, pickHero } from '../components/Hero';
import { PosterGrid } from '../components/media';
import { BrowseFilters, BrowseSection } from '../components/BrowseSection';
import { HeroSkeleton, PageLayout } from '../components/PageLayout';
import { AiringRail, ContinueRail, ForYouRail, MyListRail, TrendingRows, UpNextRail } from '../components/Sections';

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
  const type = kind === 'movies' ? 'movie' : 'tv';

  return (
    <PageLayout
      page={kind}
      title={kind === 'movies' ? 'Movies' : 'Shows'}
      hero={(size) =>
        featured ? <Hero item={featured} size={size} eyebrow={kind === 'movies' ? 'Featured film' : 'Featured series'} /> : q.isLoading ? <HeroSkeleton size={size} /> : null
      }
      sections={{
        continue: <ContinueRail type={type} />,
        upnext: <UpNextRail type={type} />,
        airing: <AiringRail type={type} />,
        mylist: <MyListRail type={type} />,
        foryou: <ForYouRail type={type} />,
        trending: <TrendingRows ids={kind === 'movies' ? ['trending-movies', 'now-playing', 'top-movies'] : ['trending-tv', 'popular-tv', 'on-the-air']} />,
        browse: (
          <BrowseSection
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
        ),
      }}
    />
  );
}
