// The rows pages are built from. Each takes an optional media type so Movies, Shows and Anime can show
// their own slice of the same thing Home shows for everything.
import { Link } from 'react-router';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Radio, X } from 'lucide-react';
import { api } from '../lib/api';
import { episodeLabel, fmtAirTime, fmtLeft, titlePath, watchPath } from '../lib/format';
import { useCollections, useContinue, useContributions, useMyList, useSession, useUpNext } from '../lib/queries';
import { useApp } from '../lib/store';
import type { CatalogItem, MediaType, ReadingProgress, Recommendations } from '../lib/types';
import { PosterCard, Rail, RailSkeleton, WideCard } from './media';
import { PluginRail } from '../pages/PluginMeta';

type Typed = { type?: MediaType };
const of = (type: MediaType | undefined) => (t: string) => !type || t === type;

export function ContinueRail({ type }: Typed) {
  const qc = useQueryClient();
  const { data } = useContinue();
  const items = data?.filter((p) => of(type)(p.mediaType));
  if (!items?.length) return null;
  return (
    <Rail title="Continue watching" wide>
      {items.map((p) => (
        <WideCard
          key={p.itemKey}
          to={watchPath({ mediaId: p.mediaId, season: p.season, episode: p.episode })}
          image={p.backdrop ?? p.poster}
          title={p.title ?? 'Untitled'}
          subtitle={[episodeLabel(p.mediaType, p.season, p.episode), fmtLeft(p.positionSeconds, p.durationSeconds)].filter(Boolean).join(' · ')}
          progress={p.durationSeconds ? p.positionSeconds / p.durationSeconds : 0}
          detailsTo={titlePath(p.mediaId, { season: p.season, episode: p.episode })}
          onRemove={async () => {
            await api.progress.remove(p.itemKey);
            qc.invalidateQueries({ queryKey: ['continue'] });
          }}
        />
      ))}
    </Rail>
  );
}

export function UpNextRail({ type }: Typed) {
  const qc = useQueryClient();
  const { data } = useUpNext();
  const items = data?.filter((u) => of(type)(u.mediaType));
  if (!items?.length) return null;
  return (
    <Rail title="Up next" wide>
      {items.map((u) => (
        <WideCard
          key={u.itemKey}
          to={watchPath({ mediaId: u.mediaId, season: u.season, episode: u.episode })}
          image={u.still ?? u.backdrop ?? u.poster}
          title={u.title}
          subtitle={[episodeLabel(u.mediaType, u.season, u.episode), u.episodeTitle].filter(Boolean).join(' · ')}
          badge={<span className="bg-gradient-accent rounded-md px-1.5 py-0.5 text-[10px] font-bold text-on-accent uppercase">New</span>}
          detailsTo={titlePath(u.mediaId, { season: u.season, episode: u.episode })}
          removeLabel="Remove from Up next"
          onRemove={async () => {
            qc.setQueriesData<typeof data>({ queryKey: ['upnext'] }, (old) => old?.filter((x) => x.itemKey !== u.itemKey));
            await api.me.dismissUpNext(u.itemKey);
            qc.invalidateQueries({ queryKey: ['upnext'] });
          }}
        />
      ))}
    </Rail>
  );
}

export function MyListRail({ type }: Typed) {
  const { data } = useMyList();
  const items = data?.filter((e) => of(type)(e.mediaType));
  if (!items?.length) return null;
  return (
    <Rail title="My List" action={<Link to="/library" className="text-sm text-muted hover:text-fg">See all</Link>}>
      {items.map((e) => (
        <PosterCard key={e.mediaId} item={{ id: e.mediaId, mediaType: e.mediaType, title: e.title ?? 'Untitled', year: e.year, poster: e.poster }} />
      ))}
    </Rail>
  );
}

export function CollectionRails() {
  const { data } = useCollections();
  return (
    <>
      {data
        ?.filter((c) => c.pinned && c.items.length)
        .map((c) => (
          <Rail key={c.id} title={c.name} action={<Link to={`/collection/${c.id}`} className="text-sm text-muted hover:text-fg">Open</Link>}>
            {c.items.map((i) => (
              <PosterCard key={i.mediaId} item={{ id: i.mediaId, mediaType: i.mediaType as CatalogItem['mediaType'], title: i.title ?? 'Untitled', year: i.year, poster: i.poster }} />
            ))}
          </Rail>
        ))}
    </>
  );
}

/** A book or comic you started (or finished), with a way to take it off the row. */
export function ReadingCard({ r, finished }: { r: ReadingProgress; finished?: boolean }) {
  const qc = useQueryClient();
  const remove = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    qc.setQueryData<ReadingProgress[]>(['reading-progress'], (old) => old?.filter((x) => x.itemKey !== r.itemKey));
    await api.reading.remove(r.itemKey).catch(() => undefined);
    qc.invalidateQueries({ queryKey: ['reading-progress'] });
  };
  return (
    <Link to={`/reader?key=${encodeURIComponent(r.itemKey)}`} className="group block" draggable={false}>
      <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-ink-800 ring-1 ring-white/6 transition group-hover:-translate-y-1 group-hover:ring-white/20">
        {r.cover ? <img src={r.cover} alt="" loading="lazy" draggable={false} className="size-full object-cover" /> : <div className="grid size-full place-items-center text-muted"><BookOpen /></div>}
        <button
          onClick={remove}
          aria-label={finished ? 'Remove from Finished' : 'Remove from Keep reading'}
          title={finished ? 'Remove from Finished' : 'Remove from Keep reading'}
          className="absolute top-2 right-2 grid size-7 place-items-center rounded-full bg-black/60 text-white/80 opacity-0 backdrop-blur transition-opacity group-hover:opacity-100 hover:text-white max-sm:opacity-100"
        >
          <X className="size-4" />
        </button>
        {!finished && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
            <div className="h-full bg-progress" style={{ width: `${r.percent * 100}%` }} />
          </div>
        )}
      </div>
      <div className="mt-2 truncate text-[13px] font-semibold">{r.title}</div>
      <div className="truncate text-xs text-faint">{finished ? (r.author ?? r.kind) : `${Math.round(r.percent * 100)}% · ${r.author ?? r.kind}`}</div>
    </Link>
  );
}

export function ReadingRail({ finished }: { finished?: boolean }) {
  const { data } = useQuery({ queryKey: ['reading-progress'], queryFn: api.reading.progress });
  const items = data?.filter((r) => (finished ? r.percent >= 0.99 : r.percent < 0.99)).slice(0, 30);
  if (!items?.length) return null;
  return (
    <Rail title={finished ? 'Finished' : 'Keep reading'} dense>
      {items.map((r) => (
        <ReadingCard key={r.itemKey} r={r} finished={finished} />
      ))}
    </Rail>
  );
}

export function LiveRail() {
  const { data: session } = useSession();
  const enabled = Boolean(session?.settings.liveTvEnabled);
  const channels = useQuery({ queryKey: ['live-channels'], queryFn: () => api.live.channels(), enabled });
  const now = Math.floor(Date.now() / 1000);
  const guide = useQuery({ queryKey: ['live-now'], queryFn: () => api.live.guide(now - 3600, now + 3600), enabled, staleTime: 5 * 60_000 });
  const favs = (channels.data ?? []).filter((c) => c.favorite).slice(0, 16);
  if (!favs.length) return null;
  const onNow = (epgId: string | null) => guide.data?.programmes.find((p) => p.epgId === epgId && p.start <= now && p.stop > now);
  return (
    <Rail title={<span className="flex items-center gap-2"><Radio className="size-5 text-accent" /> On now</span>} action={<Link to="/live" className="text-sm text-muted hover:text-fg">Guide</Link>}>
      {favs.map((c) => {
        const p = onNow(c.epgId);
        return (
          <Link key={c.id} to={`/live?c=${encodeURIComponent(c.id)}`} className="group block" draggable={false}>
            <div className="relative grid aspect-video place-items-center overflow-hidden rounded-2xl bg-gradient-to-br from-ink-700 to-ink-900 ring-1 ring-white/6 transition group-hover:-translate-y-1 group-hover:ring-white/20">
              {c.logo ? <img src={c.logo} alt="" loading="lazy" draggable={false} className="max-h-[55%] max-w-[65%] object-contain" /> : <span className="font-display text-lg">{c.name}</span>}
              {p && (
                <div className="absolute inset-x-0 bottom-0 h-1 bg-white/10">
                  <div className="h-full bg-red-500" style={{ width: `${((now - p.start) / (p.stop - p.start)) * 100}%` }} />
                </div>
              )}
            </div>
            <div className="mt-2 truncate text-[13px] font-semibold">{p?.title ?? c.name}</div>
            <div className="truncate text-xs text-faint">{c.name}</div>
          </Link>
        );
      })}
    </Rail>
  );
}

export function useRecommendations() {
  const profileId = useApp((s) => s.profileId);
  return useQuery({ queryKey: ['recommendations', profileId], queryFn: api.me.recommendations, enabled: Boolean(profileId), staleTime: 10 * 60_000, retry: false });
}

export function ForYouRail({ type }: Typed) {
  const qc = useQueryClient();
  const profileId = useApp((s) => s.profileId);
  const { data } = useRecommendations();
  const items = data?.forYou.filter((r) => of(type)(r.item.mediaType));
  if (!items?.length) return null;
  const dismiss = async (id: string) => {
    qc.setQueryData<Recommendations>(['recommendations', profileId], (d) => (d ? { ...d, forYou: d.forYou.filter((r) => r.item.id !== id) } : d));
    await api.me.dismissRecommendation(id).catch(() => undefined);
  };
  return (
    <Rail title="For you">
      {items.map((r) => (
        <div key={r.item.id} className="group/rec relative">
          <PosterCard item={r.item} hint={r.reason} />
          <button
            onClick={() => void dismiss(r.item.id)}
            aria-label="Not interested"
            title="Not interested"
            className="absolute top-2 left-2 grid size-7 place-items-center rounded-full bg-black/60 text-white/80 opacity-0 backdrop-blur transition-opacity group-hover/rec:opacity-100 hover:text-white max-sm:opacity-100"
          >
            <X className="size-4" />
          </button>
        </div>
      ))}
    </Rail>
  );
}

export function BecauseRail() {
  const { data: recs, isLoading } = useRecommendations();
  const { data: cont } = useContinue();
  const seed = cont?.[0];
  const fallback = !isLoading && !recs?.because.length;
  const { data } = useQuery({ queryKey: ['because', seed?.mediaId], queryFn: () => api.catalog.because(seed!.mediaId), enabled: Boolean(seed && fallback) });
  const rails = recs?.because.length ? recs.because.slice(0, 2).map((b) => ({ title: b.seed.title, items: b.items })) : data?.items.length ? [{ title: data.title, items: data.items }] : [];
  return (
    <>
      {rails.map((r) => (
        <Rail key={r.title} title={<>Because you watched <span className="text-gradient">{r.title}</span></>}>
          {r.items.map((i) => (
            <PosterCard key={i.id} item={i} />
          ))}
        </Rail>
      ))}
    </>
  );
}

/** Anime with an episode out this week; more load as you scroll to the end. */
export function LatestEpisodesRail({ title = 'Latest episodes', action }: { title?: string; action?: React.ReactNode }) {
  const q = useInfiniteRecent();
  const items = q.data?.pages.flat() ?? [];
  if (q.isLoading) return <RailSkeleton />;
  if (!items.length) return null;
  return (
    <Rail title={title} action={action} onEnd={() => q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage()} loadingMore={q.isFetchingNextPage}>
      {items.map((i) => (
        <PosterCard key={i.id} item={i} />
      ))}
    </Rail>
  );
}

function useInfiniteRecent() {
  return useInfiniteQuery({
    queryKey: ['anime-recent'],
    queryFn: ({ pageParam }) => api.catalog.animeRecent(pageParam),
    initialPageParam: 1,
    getNextPageParam: (last, all) => (last.length >= 24 ? all.length + 1 : undefined),
    staleTime: 15 * 60_000,
  });
}

export function AiringRail({ type }: Typed) {
  const now = Math.floor(Date.now() / 1000);
  const { data } = useQuery({ queryKey: ['calendar-week'], queryFn: () => api.me.calendar(now - 6 * 3600, now + 7 * 86400, 'followed'), staleTime: 10 * 60_000 });
  const upcoming = data?.filter((e) => e.airsAt > now - 6 * 3600 && of(type)(e.mediaType)).slice(0, 20);
  if (!upcoming?.length) return null;
  return (
    <Rail title="Airing this week" wide action={<Link to="/library/calendar" className="text-sm text-muted hover:text-fg">Calendar</Link>}>
      {upcoming.map((e) => (
        <WideCard
          key={`${e.mediaId}:${e.season}:${e.episode}`}
          to={titlePath(e.mediaId)}
          image={e.backdrop ?? e.poster}
          title={e.title}
          subtitle={`${episodeLabel(e.mediaType, e.season, e.episode)} · ${new Date(e.airsAt * 1000).toLocaleDateString(undefined, { weekday: 'long' })}${e.allDay ? '' : ` ${fmtAirTime(e.airsAt)}`}`}
          badge={e.airsAt <= now ? <span className="rounded-md bg-ok/90 px-1.5 py-0.5 text-[10px] font-bold text-black uppercase">Out now</span> : undefined}
        />
      ))}
    </Rail>
  );
}

/** Home's catalogue rows (trending, popular, ...), or just the ones with these ids. */
export function TrendingRows({ ids, ranked }: { ids?: string[]; ranked?: boolean }) {
  const { data: rows, isLoading } = useQuery({ queryKey: ['home'], queryFn: api.catalog.home, staleTime: 10 * 60_000 });
  const shown = ids ? (rows ?? []).filter((r) => ids.includes(r.id)) : (rows ?? []);
  return (
    <div className="space-y-10">
      {isLoading && [0, 1].map((i) => <RailSkeleton key={i} />)}
      {shown.map((r, idx) => (
        <Rail key={r.id} title={r.title}>
          {r.items.map((it, i) => (
            <PosterCard key={it.id} item={it} rank={ranked && idx === 0 && i < 10 ? i + 1 : undefined} />
          ))}
        </Rail>
      ))}
    </div>
  );
}

export function PluginRails({ types, limit = 6 }: { types?: Set<string>; limit?: number }) {
  const { data: contrib } = useContributions();
  return (
    <>
      {contrib?.catalogs
        .filter((c) => !types || types.has(c.type))
        .slice(0, limit)
        .map((c) => <PluginRail key={`${c.pluginId}:${c.type}:${c.id}`} catalog={c} />)}
    </>
  );
}
