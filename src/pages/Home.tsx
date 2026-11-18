import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../lib/api';
import { greeting } from '../lib/format';
import { useProfile } from '../lib/queries';
import type { CatalogItem, Row } from '../lib/types';
import { Hero } from '../components/Hero';
import { HeroSkeleton, PageLayout } from '../components/PageLayout';
import {
  AiringRail,
  BecauseRail,
  CollectionRails,
  ContinueRail,
  ForYouRail,
  LatestEpisodesRail,
  LiveRail,
  MyListRail,
  PluginRails,
  ReadingRail,
  TrendingRows,
  UpNextRail,
} from '../components/Sections';
import { Empty } from '../components/ui';

const FEATURE_ROWS = ['now-playing', 'on-the-air', 'seasonal-anime', 'trending-anime', 'trending-movies', 'trending-tv'];

function pickFeatured(rows: Row[]): CatalogItem | null {
  const seen = new Set<string>();
  const pool: CatalogItem[] = [];
  for (const id of FEATURE_ROWS) {
    for (const it of rows.find((r) => r.id === id)?.items ?? []) {
      if (it.backdrop && it.overview && !seen.has(it.id)) {
        seen.add(it.id);
        pool.push(it);
      }
    }
  }
  return pool.length ? pool[Math.floor(Math.random() * pool.length)]! : (rows.flatMap((r) => r.items).find((i) => i.backdrop) ?? null);
}

export function Home() {
  const { data: rows, isLoading, isError } = useQuery({ queryKey: ['home'], queryFn: api.catalog.home, staleTime: 10 * 60_000 });
  const profile = useProfile();
  const featured = useMemo(() => (rows ? pickFeatured(rows) : null), [rows]);

  return (
    <PageLayout
      page="home"
      title="Home"
      hero={(size) => (featured ? <Hero item={featured} size={size} eyebrow={`${greeting()}, ${profile?.name ?? ''}`} /> : isLoading ? <HeroSkeleton size={size} /> : null)}
      sections={{
        continue: <ContinueRail />,
        upnext: <UpNextRail />,
        collections: <CollectionRails />,
        live: <LiveRail />,
        reading: <ReadingRail />,
        mylist: <MyListRail />,
        foryou: <ForYouRail />,
        because: <BecauseRail />,
        new: <LatestEpisodesRail title="Fresh episodes" action={<Link to="/anime" className="text-sm text-muted hover:text-fg">Anime</Link>} />,
        airing: <AiringRail />,
        plugins: <PluginRails />,
        trending:
          isError && !rows?.length ? (
            <Empty title="The catalogue is warming up">
              Nova couldn't reach its metadata sources. Check your internet connection and try again in a moment.
            </Empty>
          ) : (
            <TrendingRows ranked />
          ),
      }}
    />
  );
}
