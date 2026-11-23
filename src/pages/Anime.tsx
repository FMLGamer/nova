import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Clock, Columns3 } from 'lucide-react';
import { api } from '../lib/api';
import { cls, fmtAirTime, titlePath } from '../lib/format';
import { useMyList, usePrefs, useSavePrefs, useSummary } from '../lib/queries';
import type { AiringEntry } from '../lib/types';
import { PosterCard, PosterGrid, Rail } from '../components/media';
import { Chip, Menu, MenuItem, Segmented, Spinner } from '../components/ui';
import { Hero, pickHero } from '../components/Hero';
import { BrowseFilters, BrowseSection, FilterMenu } from '../components/BrowseSection';
import { HeroSkeleton, PageLayout } from '../components/PageLayout';
import { AiringRail, ContinueRail, ForYouRail, LatestEpisodesRail, MyListRail, UpNextRail } from '../components/Sections';
import { useTrackedAnime } from '../components/Tracking';
import { useFilterParams } from './Browse';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_MS = 86_400_000;
const todayIdx = () => (new Date().getDay() + 6) % 7;
const localDay = (sec: number) => (new Date(sec * 1000).getDay() + 6) % 7;
/** Local midnight of the Monday `weeks` weeks from this one. */
function mondayOf(weeks: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - todayIdx() + weeks * 7);
  return d;
}
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Whether an airing episode is one you've seen: in Nova, or according to your AniList / MyAnimeList. */
function useWatchedEpisode() {
  const summary = useSummary();
  const tracked = useTrackedAnime();
  return (e: AiringEntry) => Boolean(summary.data?.get(e.item.id)?.watchedEpisodes.includes(e.episode) || (tracked.get(e.item.id)?.progress ?? 0) >= e.episode);
}

function AiringCard({ e, compact, watched }: { e: AiringEntry; compact?: boolean; watched: boolean }) {
  const aired = e.airingAt * 1000 <= Date.now();
  return (
    <Link to={titlePath(e.item.id)} className={cls('group flex gap-3 rounded-2xl p-2 transition-colors hover:bg-white/6', watched && 'opacity-55 hover:opacity-100')}>
      <div className={cls('relative shrink-0 overflow-hidden rounded-xl bg-ink-800', compact ? 'h-16 w-11' : 'h-20 w-14')}>
        {e.item.poster && <img src={e.item.poster} alt="" loading="lazy" className="size-full object-cover transition-transform duration-300 group-hover:scale-110" />}
        {watched && (
          <span className="absolute inset-0 grid place-items-center bg-black/45">
            <span className="grid size-6 place-items-center rounded-full bg-ok text-black">
              <Check className="size-3.5" strokeWidth={3} />
            </span>
          </span>
        )}
      </div>
      <div className="min-w-0 py-0.5">
        <div className={cls('flex items-center gap-1.5 text-xs font-semibold tabular-nums', watched ? 'text-ok' : aired ? 'text-ok' : 'text-accent')}>
          {aired && !watched && <span className="size-1.5 rounded-full bg-ok" />}
          {fmtAirTime(e.airingAt)}
          {watched ? <span className="font-medium">· Watched</span> : aired && <span className="font-medium">· Out now</span>}
        </div>
        <div className="line-clamp-2 text-[13px] leading-snug font-semibold">{e.item.title}</div>
        <div className="text-xs text-faint">Episode {e.episode}</div>
      </div>
    </Link>
  );
}

function useScheduleFilter(entries: AiringEntry[]) {
  const { data: prefs } = usePrefs();
  const filter = prefs?.anime.calendarFilter ?? 'all';
  const list = useMyList();
  const summary = useSummary();
  const tracked = useQuery({ queryKey: ['tracker-watching'], queryFn: api.trackers.watching, enabled: filter === 'watching', staleTime: 5 * 60_000 });
  return useMemo(() => {
    if (filter === 'mylist') {
      const ids = new Set((list.data ?? []).map((e) => e.mediaId));
      return entries.filter((e) => ids.has(e.item.id));
    }
    // What you watch in Nova, plus what your AniList / MyAnimeList say you're watching.
    if (filter === 'watching') {
      const ids = new Set(tracked.data ?? []);
      return entries.filter((e) => summary.data?.has(e.item.id) || ids.has(e.item.id));
    }
    return entries;
  }, [entries, filter, list.data, summary.data, tracked.data]);
}

function WeekView({ week, view }: { week: number; view: 'columns' | 'timeline' }) {
  const { data, isLoading } = useQuery({ queryKey: ['schedule', week], queryFn: () => api.catalog.schedule(week), staleTime: 30 * 60_000 });
  const { data: prefs } = usePrefs();
  const filtered = useScheduleFilter(data ?? []);
  const isWatched = useWatchedEpisode();
  const [day, setDay] = useState(todayIdx());
  const nowLine = useRef<HTMLDivElement>(null);
  const filter = prefs?.anime.calendarFilter ?? 'all';

  // Days are local days: an episode just after midnight belongs to the next one here.
  const byDay = useMemo(() => {
    const start = mondayOf(week).getTime();
    const inWeek = filtered.filter((e) => e.airingAt * 1000 >= start && e.airingAt * 1000 < start + 7 * DAY_MS);
    return DAYS.map((_, i) => inWeek.filter((e) => localDay(e.airingAt) === i).sort((a, b) => a.airingAt - b.airingAt));
  }, [filtered, week]);
  const today = week === 0 ? todayIdx() : -1;

  // The timeline only spans the hours something airs in.
  const hours = useMemo(() => {
    const all = byDay.flat().map((e) => {
      const d = new Date(e.airingAt * 1000);
      return d.getHours() + d.getMinutes() / 60;
    });
    if (!all.length) return { from: 0, to: 24 };
    return { from: Math.floor(Math.min(...all)), to: Math.min(24, Math.ceil(Math.max(...all) + 1)) };
  }, [byDay]);

  useEffect(() => {
    if (view === 'timeline') nowLine.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [view]);

  const HOUR = 56;
  const nowHours = new Date().getHours() + new Date().getMinutes() / 60;
  const showNow = today >= 0 && nowHours >= hours.from && nowHours <= hours.to;

  if (isLoading)
    return (
      <div className="grid h-80 place-items-center">
        <Spinner className="size-6" />
      </div>
    );

  return (
    <>
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
            <AiringCard key={`${e.item.id}:${e.episode}`} e={e} watched={isWatched(e)} />
          ))}
          {!byDay[day]!.length && <p className="py-8 text-center text-sm text-muted">Nothing airing{filter !== 'all' ? ' from your shows' : ''}.</p>}
        </div>
      </div>

      {/* desktop */}
      {view === 'columns' ? (
        <div className="hidden grid-cols-7 gap-2 lg:grid">
          {DAYS.map((d, i) => (
            <div key={d} className={cls('flex min-w-0 flex-col rounded-3xl border p-2', i === today ? 'border-accent/50 bg-accent/[0.08] ring-1 ring-accent/20' : 'border-line bg-white/[0.02]')}>
              <div className="px-2 pt-1.5 pb-2">
                <div className={cls('text-sm font-semibold', i === today && 'text-gradient')}>{i === today ? 'Today' : d}</div>
                <div className="text-xs text-faint">{byDay[i]!.length} episodes</div>
              </div>
              <div className="scrollbar-none max-h-[560px] snap-y snap-mandatory space-y-0.5 overflow-y-auto">
                {byDay[i]!.map((e) => (
                  <div key={`${e.item.id}:${e.episode}`} className="snap-start">
                    <AiringCard e={e} compact watched={isWatched(e)} />
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
          <div className="relative grid grid-cols-[56px_repeat(7,minmax(0,1fr))]" style={{ height: HOUR * (hours.to - hours.from) }}>
            <div className="relative">
              {Array.from({ length: hours.to - hours.from }).map((_, k) => (
                <div key={k} className="absolute right-2 text-[11px] text-faint tabular-nums" style={{ top: k * HOUR + (k ? -6 : 2) }}>
                  {String(hours.from + k).padStart(2, '0')}:00
                </div>
              ))}
            </div>
            {DAYS.map((d, i) => (
              <div key={d} className={cls('relative border-l border-line', i === today && 'bg-accent/[0.04]')}>
                {Array.from({ length: hours.to - hours.from }).map((_, k) => (
                  <div key={k} className="absolute inset-x-0 border-t border-white/[0.04]" style={{ top: k * HOUR }} />
                ))}
                {byDay[i]!.map((e) => {
                  const dt = new Date(e.airingAt * 1000);
                  const top = (dt.getHours() + dt.getMinutes() / 60 - hours.from) * HOUR;
                  const watched = isWatched(e);
                  return (
                    <Link
                      key={`${e.item.id}:${e.episode}`}
                      to={titlePath(e.item.id)}
                      className={cls('glass absolute inset-x-1 flex gap-2 overflow-hidden rounded-xl p-1.5 transition hover:z-10 hover:scale-[1.03] hover:bg-white/15', watched && 'opacity-55 hover:opacity-100')}
                      style={{ top, height: HOUR - 4 }}
                    >
                      {e.item.poster && <img src={e.item.poster} alt="" className="h-full w-8 shrink-0 rounded-md object-cover" />}
                      <div className="min-w-0">
                        <div className="truncate text-[11px] font-semibold">{e.item.title}</div>
                        <div className={cls('flex items-center gap-1 text-[10px]', watched ? 'text-ok' : 'text-faint')}>
                          {watched && <Check className="size-3" strokeWidth={3} />}
                          {fmtAirTime(e.airingAt)} · E{e.episode}
                        </div>
                      </div>
                    </Link>
                  );
                })}
                {i === today && showNow && (
                  <div ref={nowLine} className="pointer-events-none absolute inset-x-0 z-20 h-0.5 bg-red-500" style={{ top: (nowHours - hours.from) * HOUR }}>
                    <span className="absolute -top-1 -left-1 size-2.5 rounded-full bg-red-500" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** Beta: a whole month at a glance (AniList's schedule reaches about a month either way). */
function MonthView({ month, onOpenWeek }: { month: number; onOpenWeek: (week: number) => void }) {
  const first = useMemo(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth() + month, 1);
  }, [month]);
  const gridStart = useMemo(() => {
    const d = new Date(first);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d;
  }, [first]);
  const weeksShown = Math.ceil(((new Date(first.getFullYear(), first.getMonth() + 1, 0).getTime() - gridStart.getTime()) / DAY_MS + 1) / 7);
  const firstWeek = Math.round((gridStart.getTime() - mondayOf(0).getTime()) / (7 * DAY_MS));
  const weeks = Array.from({ length: weeksShown }, (_, i) => firstWeek + i);
  const results = useQueries({ queries: weeks.map((w) => ({ queryKey: ['schedule', w], queryFn: () => api.catalog.schedule(w), staleTime: 30 * 60_000 })) });
  const all = useMemo(() => {
    const seen = new Set<string>();
    return results.flatMap((r) => r.data ?? []).filter((e) => {
      const k = `${e.item.id}:${e.episode}`;
      return !seen.has(k) && seen.add(k);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.map((r) => r.dataUpdatedAt).join(',')]);
  const filtered = useScheduleFilter(all);
  const isWatched = useWatchedEpisode();
  const days = Array.from({ length: weeksShown * 7 }, (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
  const onDay = (d: Date) => filtered.filter((e) => sameDay(new Date(e.airingAt * 1000), d)).sort((a, b) => a.airingAt - b.airingAt);
  const now = new Date();
  const loading = results.some((r) => r.isLoading);
  const MAX = 4;

  return (
    <>
      {loading && (
        <div className="mb-3 flex items-center gap-2 text-sm text-muted">
          <Spinner className="size-4" /> Loading the month…
        </div>
      )}
      <div className="hidden grid-cols-7 gap-1.5 lg:grid">
        {DAYS.map((d) => (
          <div key={d} className="px-2 pb-1 text-xs font-semibold tracking-wider text-faint uppercase">
            {d.slice(0, 3)}
          </div>
        ))}
        {days.map((d, i) => {
          const list = onDay(d);
          const inMonth = d.getMonth() === first.getMonth();
          const today = sameDay(d, now);
          return (
            <div key={i} className={cls('flex min-h-32 min-w-0 flex-col rounded-2xl border p-1.5', today ? 'border-accent/50 bg-accent/[0.08]' : 'border-line bg-white/[0.02]', !inMonth && 'opacity-45')}>
              <div className={cls('px-1.5 pb-1 text-sm font-semibold tabular-nums', today && 'text-gradient')}>{d.getDate()}</div>
              <div className="space-y-0.5">
                {list.slice(0, MAX).map((e) => {
                  const watched = isWatched(e);
                  return (
                    <Link key={`${e.item.id}:${e.episode}`} to={titlePath(e.item.id)} className={cls('flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[11.5px] hover:bg-white/8', watched && 'opacity-55')} title={`${e.item.title} · Episode ${e.episode}`}>
                      {watched ? <Check className="size-3 shrink-0 text-ok" strokeWidth={3} /> : <span className="shrink-0 text-faint tabular-nums">{fmtAirTime(e.airingAt)}</span>}
                      <span className="truncate font-medium">{e.item.title}</span>
                      <span className="shrink-0 text-faint">{e.episode}</span>
                    </Link>
                  );
                })}
                {list.length > MAX && (
                  <button onClick={() => onOpenWeek(firstWeek + Math.floor(i / 7))} className="px-1.5 text-[11px] font-medium text-muted hover:text-fg">
                    +{list.length - MAX} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {/* phones: the days of the month that have something, one under the other */}
      <div className="space-y-4 lg:hidden">
        {days
          .filter((d) => d.getMonth() === first.getMonth())
          .map((d) => ({ d, list: onDay(d) }))
          .filter(({ list }) => list.length)
          .map(({ d, list }) => (
            <div key={d.toISOString()}>
              <div className={cls('mb-1 text-sm font-semibold', sameDay(d, now) && 'text-gradient')}>{d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })}</div>
              {list.map((e) => (
                <AiringCard key={`${e.item.id}:${e.episode}`} e={e} compact watched={isWatched(e)} />
              ))}
            </div>
          ))}
      </div>
    </>
  );
}

function Schedule() {
  const { data: prefs } = usePrefs();
  const savePrefs = useSavePrefs();
  const monthBeta = Boolean(prefs?.beta?.monthSchedule);
  const range = prefs?.anime.scheduleRange ?? 'week';
  const setRange = (v: 'week' | 'month') => savePrefs.mutate({ anime: { scheduleRange: v } });
  const [week, setWeek] = useState(0);
  const [month, setMonth] = useState(0);
  const view = prefs?.anime.scheduleView ?? 'columns';
  const setView = (v: 'columns' | 'timeline') => savePrefs.mutate({ anime: { scheduleView: v } });
  const filter = prefs?.anime.calendarFilter ?? 'all';
  const mode = monthBeta ? range : 'week';
  const offset = mode === 'week' ? week : month;
  const step = (d: number) => (mode === 'week' ? setWeek((w) => Math.max(-8, Math.min(8, w + d))) : setMonth((m) => Math.max(-1, Math.min(1, m + d))));
  const label =
    mode === 'week'
      ? week === 0 ? 'This week' : week > 0 ? `In ${week} week${week > 1 ? 's' : ''}` : `${-week} week${week < -1 ? 's' : ''} ago`
      : month === 0 ? 'This month' : new Date(new Date().getFullYear(), new Date().getMonth() + month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <section id="schedule" className="scroll-mt-24 px-5 sm:px-10">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h2 className="mr-auto font-display text-2xl font-semibold sm:text-3xl">{mode === 'month' ? 'Schedule' : "This week's schedule"}</h2>
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
        {mode === 'week' && (
          <Segmented
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: 'columns', label: <Columns3 className="size-4" /> },
              { value: 'timeline', label: <Clock className="size-4" /> },
            ]}
          />
        )}
        <div className="flex items-center gap-1">
          <button onClick={() => step(-1)} disabled={mode === 'month' ? month <= -1 : week <= -8} aria-label={mode === 'week' ? 'Previous week' : 'Previous month'} className="grid size-9 place-items-center rounded-full hover:bg-white/8 disabled:opacity-30">
            <ChevronLeft className="size-5" />
          </button>
          {monthBeta ? (
            <Menu
              align="right"
              width="w-44"
              trigger={(_o, toggle) => (
                <button onClick={toggle} className="flex min-w-28 items-center justify-center gap-1 text-sm text-muted hover:text-fg">
                  {label} <ChevronDown className="size-4" />
                </button>
              )}
            >
              {(close) => (
                <>
                  {(['week', 'month'] as const).map((r) => (
                    <MenuItem
                      key={r}
                      active={mode === r && offset === 0}
                      onClick={() => {
                        close();
                        setRange(r);
                        setWeek(0);
                        setMonth(0);
                      }}
                    >
                      {r === 'week' ? 'This week' : 'This month'}
                    </MenuItem>
                  ))}
                </>
              )}
            </Menu>
          ) : (
            <button onClick={() => setWeek(0)} className="min-w-24 text-sm text-muted hover:text-fg">
              {label}
            </button>
          )}
          <button onClick={() => step(1)} disabled={mode === 'month' ? month >= 1 : week >= 8} aria-label={mode === 'week' ? 'Next week' : 'Next month'} className="grid size-9 place-items-center rounded-full hover:bg-white/8 disabled:opacity-30">
            <ChevronRight className="size-5" />
          </button>
        </div>
      </div>
      {mode === 'week' ? (
        <WeekView week={week} view={view} />
      ) : (
        <MonthView
          month={month}
          onOpenWeek={(w) => {
            setRange('week');
            setWeek(w);
          }}
        />
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
  const [params, set] = useFilterParams();
  const sort = params.get('sort') ?? 'trending';
  const genre = params.get('genre') ?? '';
  const format = params.get('format') ?? '';
  const genres = useQuery({ queryKey: ['anime-genres'], queryFn: api.catalog.animeGenres, staleTime: Infinity });
  const q = useInfiniteQuery({
    queryKey: ['anime-browse', sort, genre, format],
    queryFn: ({ pageParam }) => api.catalog.animeBrowse({ page: pageParam, sort, genre: genre || undefined, format: format || undefined }),
    initialPageParam: 1,
    getNextPageParam: (last, all) => (last.length ? all.length + 1 : undefined),
    staleTime: 15 * 60_000,
  });
  return (
    <BrowseSection
      title="Browse anime"
      filters={
        <BrowseFilters
          sort={sort as (typeof SORTS)[number]['value']}
          sorts={SORTS}
          onSort={(v) => set('sort', v === 'trending' ? '' : v)}
          extra={<FilterMenu value={format} options={FORMATS} onChange={(v) => set('format', v)} />}
          genre={genre}
          genres={(genres.data ?? []).map((g) => ({ value: g.id, label: g.name }))}
          onGenre={(v) => set('genre', v)}
        />
      }
    >
      <PosterGrid items={q.data?.pages.flat() ?? []} loading={q.isLoading || q.isFetchingNextPage} done={!q.hasNextPage} onEnd={() => q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage()} />
    </BrowseSection>
  );
}

export default function Anime() {
  const seasonal = useQuery({ queryKey: ['anime-row', 'seasonal'], queryFn: () => api.catalog.anime('seasonal'), staleTime: 30 * 60_000 });
  const featured = useMemo(() => pickHero(seasonal.data, 20), [seasonal.data]);
  useEffect(() => {
    if (location.hash === '#schedule') window.setTimeout(() => document.getElementById('schedule')?.scrollIntoView({ behavior: 'smooth' }), 400);
  }, []);

  return (
    <PageLayout
      page="anime"
      title="Anime"
      hero={(size) => (featured ? <Hero item={featured} size={size} eyebrow="This season" /> : seasonal.isLoading ? <HeroSkeleton size={size} /> : null)}
      sections={{
        continue: <ContinueRail type="anime" />,
        upnext: <UpNextRail type="anime" />,
        latest: <LatestEpisodesRail />,
        schedule: <Schedule />,
        airing: <AiringRail type="anime" />,
        season: seasonal.data?.length ? (
          <Rail title="This season">
            {seasonal.data.map((i, n) => (
              <PosterCard key={i.id} item={i} rank={n < 10 ? n + 1 : undefined} />
            ))}
          </Rail>
        ) : null,
        mylist: <MyListRail type="anime" />,
        foryou: <ForYouRail type="anime" />,
        browse: <BrowseAnime />,
      }}
    />
  );
}
