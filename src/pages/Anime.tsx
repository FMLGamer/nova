import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Clock, Columns3, Rows3 } from 'lucide-react';
import { api } from '../lib/api';
import { cls, fmtAirTime, titlePath } from '../lib/format';
import { useMyList, usePrefs, useSavePrefs, useSummary } from '../lib/queries';
import type { AiringEntry } from '../lib/types';
import { PosterCard, PosterGrid, Rail, RailSkeleton } from '../components/media';
import { Chip, Segmented, Spinner } from '../components/ui';
import { HERO_HEIGHT, Hero, pickHero } from '../components/Hero';
import { PageHeader } from './Browse';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const todayIdx = () => (new Date().getDay() + 6) % 7;

function AiringCard({ e, compact }: { e: AiringEntry; compact?: boolean }) {
  const aired = e.airingAt * 1000 <= Date.now();
  return (
    <Link to={titlePath(e.item.id)} className={cls('group flex gap-3 rounded-2xl p-2 transition-colors hover:bg-white/6', aired && 'opacity-70 hover:opacity-100')}>
      <div className={cls('relative shrink-0 overflow-hidden rounded-xl bg-ink-800', compact ? 'h-16 w-11' : 'h-20 w-14')}>
        {e.item.poster && <img src={e.item.poster} alt="" loading="lazy" className="size-full object-cover transition-transform duration-300 group-hover:scale-110" />}
      </div>
      <div className="min-w-0 py-0.5">
        <div className={cls('text-xs font-semibold tabular-nums', aired ? 'text-faint' : 'text-accent')}>{fmtAirTime(e.airingAt)}</div>
        <div className="line-clamp-2 text-[13px] leading-snug font-semibold">{e.item.title}</div>
        <div className="text-xs text-faint">Episode {e.episode}</div>
      </div>
    </Link>
  );
}

function Schedule() {
  const { data: prefs } = usePrefs();
  const savePrefs = useSavePrefs();
  const [week, setWeek] = useState(0);
  const [view, setView] = useState<'columns' | 'timeline'>('columns');
  const [day, setDay] = useState(todayIdx());
  const filter = prefs?.anime.calendarFilter ?? 'all';
  const { data, isLoading } = useQuery({ queryKey: ['schedule', week], queryFn: () => api.catalog.schedule(week), staleTime: 30 * 60_000 });
  const list = useMyList();
  const summary = useSummary();
  const nowLine = useRef<HTMLDivElement>(null);

  const entries = useMemo(() => {
    const all = data ?? [];
    if (filter === 'mylist') {
      const ids = new Set((list.data ?? []).map((e) => e.mediaId));
      return all.filter((e) => ids.has(e.item.id));
    }
    if (filter === 'watching') return all.filter((e) => summary.data?.has(e.item.id));
    return all;
  }, [data, filter, list.data, summary.data]);

  const byDay = useMemo(() => DAYS.map((_, i) => entries.filter((e) => e.weekday === i).sort((a, b) => a.airingAt - b.airingAt)), [entries]);
  const today = week === 0 ? todayIdx() : -1;

  useEffect(() => {
    if (view === 'timeline') nowLine.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [view]);

  const HOUR = 56;
  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();

  return (
    <section id="schedule" className="scroll-mt-24 px-5 sm:px-10">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h2 className="mr-auto font-display text-2xl font-semibold sm:text-3xl">This week's schedule</h2>
        <Segmented
          size="sm"
          value={filter}
          onChange={(v) => savePrefs.mutate({ anime: { calendarFilter: v } })}
          options={[
            { value: 'all', label: 'All' },
            { value: 'mylist', label: 'My List' },
            { value: 'watching', label: 'Watching' },
          ]}
        />
        <Segmented
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'columns', label: <Columns3 className="size-4" /> },
            { value: 'timeline', label: <Clock className="size-4" /> },
          ]}
        />
        <div className="flex items-center gap-1">
          <button onClick={() => setWeek((w) => w - 1)} aria-label="Previous week" className="grid size-9 place-items-center rounded-full hover:bg-white/8">
            <ChevronLeft className="size-5" />
          </button>
          <button onClick={() => setWeek(0)} className="min-w-24 text-sm text-muted hover:text-fg">
            {week === 0 ? 'This week' : week > 0 ? `In ${week} week${week > 1 ? 's' : ''}` : `${-week} week${week < -1 ? 's' : ''} ago`}
          </button>
          <button onClick={() => setWeek((w) => w + 1)} aria-label="Next week" className="grid size-9 place-items-center rounded-full hover:bg-white/8">
            <ChevronRight className="size-5" />
          </button>
        </div>
      </div>

      {isLoading && (
        <div className="grid h-80 place-items-center">
          <Spinner className="size-6" />
        </div>
      )}

      {/* phones: one day at a time */}
      <div className="lg:hidden">
        <div className="scrollbar-none -mx-5 mb-3 flex gap-1.5 overflow-x-auto px-5">
          {DAYS.map((d, i) => (
            <Chip key={d} active={day === i} onClick={() => setDay(i)}>
              {i === today ? 'Today' : d.slice(0, 3)}
              <span className="text-[11px] opacity-60">{byDay[i]!.length}</span>
            </Chip>
          ))}
        </div>
        <div className="space-y-1">
          {byDay[day]!.map((e) => (
            <AiringCard key={`${e.item.id}:${e.episode}`} e={e} />
          ))}
          {!isLoading && !byDay[day]!.length && <p className="py-8 text-center text-sm text-muted">Nothing airing{filter !== 'all' ? ' from your shows' : ''}.</p>}
        </div>
      </div>

      {/* desktop */}
      {view === 'columns' ? (
        <div className="hidden grid-cols-7 gap-2 lg:grid">
          {DAYS.map((d, i) => (
            <div key={d} className={cls('flex min-w-0 flex-col rounded-3xl border p-2', i === today ? 'border-accent/40 bg-accent/[0.06]' : 'border-line bg-white/[0.02]')}>
              <div className="px-2 pt-1.5 pb-2">
                <div className={cls('text-sm font-semibold', i === today && 'text-gradient')}>{i === today ? 'Today' : d}</div>
                <div className="text-xs text-faint">{byDay[i]!.length} episodes</div>
              </div>
              <div className="scrollbar-none max-h-[560px] snap-y snap-mandatory space-y-0.5 overflow-y-auto">
                {byDay[i]!.map((e) => (
                  <div key={`${e.item.id}:${e.episode}`} className="snap-start">
                    <AiringCard e={e} compact />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="hidden max-h-[70vh] overflow-y-auto rounded-3xl border border-line lg:block">
          <div className="sticky top-0 z-10 grid grid-cols-[56px_repeat(7,minmax(0,1fr))] border-b border-line bg-bg/90 backdrop-blur">
            <div />
            {DAYS.map((d, i) => (
              <div key={d} className={cls('px-2 py-2 text-sm font-semibold', i === today && 'text-gradient')}>
                {i === today ? 'Today' : d.slice(0, 3)}
              </div>
            ))}
          </div>
          <div className="relative grid grid-cols-[56px_repeat(7,minmax(0,1fr))]" style={{ height: HOUR * 24 }}>
            <div className="relative">
              {Array.from({ length: 24 }).map((_, h) => (
                <div key={h} className="absolute right-2 text-[11px] text-faint tabular-nums" style={{ top: h * HOUR - 6 }}>
                  {String(h).padStart(2, '0')}:00
                </div>
              ))}
            </div>
            {DAYS.map((d, i) => (
              <div key={d} className={cls('relative border-l border-line', i === today && 'bg-accent/[0.04]')}>
                {Array.from({ length: 24 }).map((_, h) => (
                  <div key={h} className="absolute inset-x-0 border-t border-white/[0.04]" style={{ top: h * HOUR }} />
                ))}
                {byDay[i]!.map((e) => {
                  const dt = new Date(e.airingAt * 1000);
                  const top = ((dt.getHours() * 60 + dt.getMinutes()) / 60) * HOUR;
                  return (
                    <Link
                      key={`${e.item.id}:${e.episode}`}
                      to={titlePath(e.item.id)}
                      className="glass absolute inset-x-1 flex gap-2 overflow-hidden rounded-xl p-1.5 transition hover:z-10 hover:scale-[1.03] hover:bg-white/15"
                      style={{ top, height: HOUR - 4 }}
                    >
                      {e.item.poster && <img src={e.item.poster} alt="" className="h-full w-8 shrink-0 rounded-md object-cover" />}
                      <div className="min-w-0">
                        <div className="truncate text-[11px] font-semibold">{e.item.title}</div>
                        <div className="text-[10px] text-faint">
                          {fmtAirTime(e.airingAt)} · E{e.episode}
                        </div>
                      </div>
                    </Link>
                  );
                })}
                {i === today && (
                  <div ref={nowLine} className="pointer-events-none absolute inset-x-0 z-20 h-0.5 bg-red-500" style={{ top: (nowMinutes / 60) * HOUR }}>
                    <span className="absolute -top-1 -left-1 size-2.5 rounded-full bg-red-500" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

const SORTS = [
  { value: 'trending', label: 'Trending' },
  { value: 'popular', label: 'Popular' },
  { value: 'top', label: 'Top rated' },
  { value: 'new', label: 'Newest' },
] as const;
const FORMATS = [
  { value: '', label: 'All formats' },
  { value: 'TV', label: 'TV' },
  { value: 'MOVIE', label: 'Movies' },
  { value: 'OVA', label: 'OVA' },
  { value: 'ONA', label: 'ONA' },
];

function BrowseAnime() {
  const [params, setParams] = useSearchParams();
  const sort = params.get('sort') ?? 'trending';
  const genre = params.get('genre') ?? '';
  const format = params.get('format') ?? '';
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true, preventScrollReset: true });
  };
  const genres = useQuery({ queryKey: ['anime-genres'], queryFn: api.catalog.animeGenres, staleTime: Infinity });
  const q = useInfiniteQuery({
    queryKey: ['anime-browse', sort, genre, format],
    queryFn: ({ pageParam }) => api.catalog.animeBrowse({ page: pageParam, sort, genre: genre || undefined, format: format || undefined }),
    initialPageParam: 1,
    getNextPageParam: (last, all) => (last.length ? all.length + 1 : undefined),
    staleTime: 15 * 60_000,
  });
  return (
    <section id="browse" className="scroll-mt-20">
      <div className="mb-5 space-y-4 px-5 sm:px-10">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="mr-auto font-display text-2xl font-semibold sm:text-3xl">Browse</h2>
          <Segmented size="sm" value={sort} onChange={(v) => set('sort', v === 'trending' ? '' : v)} options={SORTS.map((s) => ({ value: s.value, label: s.label }))} />
        </div>
        <div className="scrollbar-none -mx-5 flex gap-2 overflow-x-auto px-5 sm:-mx-10 sm:px-10">
          {FORMATS.map((f) => (
            <Chip key={f.value} active={format === f.value} onClick={() => set('format', f.value)}>
              {f.label}
            </Chip>
          ))}
          <span className="mx-1 w-px shrink-0 bg-line" />
          <Chip active={!genre} onClick={() => set('genre', '')}>
            Any genre
          </Chip>
          {genres.data?.map((g) => (
            <Chip key={g.id} active={genre === g.id} onClick={() => set('genre', g.id)}>
              {g.name}
            </Chip>
          ))}
        </div>
      </div>
      <PosterGrid items={q.data?.pages.flat() ?? []} loading={q.isLoading || q.isFetchingNextPage} done={!q.hasNextPage} onEnd={() => q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage()} />
    </section>
  );
}

export default function Anime() {
  const recent = useQuery({ queryKey: ['anime-recent'], queryFn: api.catalog.animeRecent, staleTime: 15 * 60_000 });
  const seasonal = useQuery({ queryKey: ['anime-row', 'seasonal'], queryFn: () => api.catalog.anime('seasonal'), staleTime: 30 * 60_000 });
  const featured = useMemo(() => pickHero(seasonal.data, 20), [seasonal.data]);
  useEffect(() => {
    if (location.hash === '#schedule') window.setTimeout(() => document.getElementById('schedule')?.scrollIntoView({ behavior: 'smooth' }), 400);
  }, []);

  return (
    <div className="space-y-14">
      <div>
        {featured ? <Hero item={featured} compact eyebrow="This season" /> : seasonal.isLoading && <div className={`${HERO_HEIGHT.compact} skeleton`} />}
        <PageHeader
          flush={Boolean(featured) || seasonal.isLoading}
          title="Anime"
          kicker="Simulcasts & seasons"
          tone="#ff5c7a"
          subtitle="Simulcasts the moment they land, the whole season's schedule, and every classic worth starting."
        >
          <div className="flex gap-2">
            <a href="#schedule" className="glass inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm hover:bg-white/12">
              <Clock className="size-4" /> Schedule
            </a>
            <a href="#browse" className="glass inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm hover:bg-white/12">
              <Rows3 className="size-4" /> Browse all
            </a>
          </div>
        </PageHeader>
      </div>

      {recent.isLoading ? (
        <RailSkeleton />
      ) : (
        <Rail title="Latest episodes">
          {(recent.data ?? []).map((i) => (
            <PosterCard key={i.id} item={i} />
          ))}
        </Rail>
      )}

      <Schedule />

      {seasonal.data?.length ? (
        <Rail title="This season">
          {seasonal.data.map((i, n) => (
            <PosterCard key={i.id} item={i} rank={n < 10 ? n + 1 : undefined} />
          ))}
        </Rail>
      ) : null}

      <BrowseAnime />
    </div>
  );
}
