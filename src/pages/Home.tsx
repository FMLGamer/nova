import { motion, useScroll, useTransform } from 'motion/react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Check, Info, Play, Plus, Radio, Star } from 'lucide-react';
import { api } from '../lib/api';
import { cls, episodeLabel, fmtAirTime, fmtLeft, greeting, metaLine, titlePath, watchPath } from '../lib/format';
import { playIntent } from '../lib/intent';
import { useCollections, useContinue, useContributions, useDetail, useListToggle, useMediaProgress, useMyList, usePrefs, useProfile, useSession, useUpNext } from '../lib/queries';
import { useApp } from '../lib/store';
import type { CatalogItem, Row } from '../lib/types';
import { PosterCard, Rail, RailSkeleton, WideCard } from '../components/media';
import { Trailer } from '../components/Trailer';
import { Button, Empty } from '../components/ui';
import { PluginRail } from './PluginMeta';

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

export function Hero({ item, eyebrow }: { item: CatalogItem; eyebrow?: ReactNode }) {
  const navigate = useNavigate();
  const { data: prefs } = usePrefs();
  const { data: detail } = useDetail(item.id);
  const { data: progress } = useMediaProgress(item.id);
  const list = useListToggle();
  const setAmbient = useApp((s) => s.setAmbient);
  const [trailerOn, setTrailerOn] = useState(false);
  const [trailerFailed, setTrailerFailed] = useState(false);
  const intent = detail ? playIntent(detail, progress) : null;
  const { scrollY } = useScroll();
  const fadeEnd = typeof window !== 'undefined' ? window.innerHeight * 0.6 : 500;
  const heroOpacity = useTransform(scrollY, [0, fadeEnd], [1, 0]);

  useEffect(() => setAmbient(item.backdrop), [item.backdrop, setAmbient]);
  useEffect(() => {
    if (!detail?.trailer || prefs?.ui.autoplayPreviews === false) return;
    const t = window.setTimeout(() => setTrailerOn(true), 2200);
    return () => window.clearTimeout(t);
  }, [detail?.trailer, prefs?.ui.autoplayPreviews]);

  return (
    <section className="relative h-[78svh] min-h-[520px] w-full overflow-hidden sm:h-[86svh]">
      <motion.div style={{ opacity: heroOpacity }} className="absolute inset-0">
      <motion.img
        src={item.backdrop ?? undefined}
        alt=""
        initial={{ scale: 1.04, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.9, ease: [0.2, 0, 0, 1] }}
        className="absolute inset-0 size-full object-cover"
      />
      {trailerOn && detail?.trailer && !trailerFailed && <Trailer videoKey={detail.trailer.key} onFail={() => setTrailerFailed(true)} />}
      <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/30 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-bg/90 via-bg/35 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-bg to-transparent" />

      <div className="absolute inset-x-0 bottom-[12%] px-5 sm:px-10">
        <motion.div
          initial="hidden"
          animate="show"
          variants={{ hidden: {}, show: { transition: { staggerChildren: 0.04, delayChildren: 0.05 } } }}
          className="max-w-2xl"
        >
          {eyebrow && (
            <motion.div variants={rise} className="mb-3 text-xs font-semibold tracking-[0.2em] text-white/70 uppercase">
              {eyebrow}
            </motion.div>
          )}
          <motion.h1
            variants={rise}
            className={cls(
              'font-display leading-[0.95] font-bold text-balance drop-shadow-[0_4px_30px_rgb(0_0_0/0.5)]',
              item.title.length > 28 ? 'text-[clamp(2.1rem,4.4vw,3.8rem)]' : 'text-[clamp(2.4rem,6vw,5.2rem)]',
            )}
          >
            {item.title}
          </motion.h1>
          <motion.div variants={rise} className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-white/80">
            {item.rating != null && item.rating > 0 && (
              <span className="flex items-center gap-1 font-semibold text-white">
                <Star className="size-3.5 fill-amber-300 text-amber-300" /> {item.rating.toFixed(1)}
              </span>
            )}
            <span>{metaLine({ ...item, runtime: detail?.runtime ?? item.runtime })}</span>
            {item.genres.slice(0, 3).map((g) => (
              <span key={g} className="rounded-full border border-white/20 px-2.5 py-0.5 text-xs">
                {g}
              </span>
            ))}
          </motion.div>
          <motion.p variants={rise} className="mt-4 line-clamp-3 max-w-xl text-[15px] leading-relaxed text-white/75 sm:text-base">
            {item.overview}
          </motion.p>
          <motion.div variants={rise} className="mt-7 flex flex-wrap items-center gap-3">
            <Button
              size="lg"
              variant="white"
              icon={<Play className="size-5 fill-current" />}
              onClick={() => navigate(watchPath({ mediaId: item.id, season: intent?.season, episode: intent?.episode }))}
            >
              {intent?.label ?? 'Play'}
              {intent?.sub && <span className="font-normal text-black/60">· {intent.sub}</span>}
            </Button>
            <Button size="lg" variant="glass" icon={<Info className="size-5" />} onClick={() => navigate(titlePath(item.id))}>
              Details
            </Button>
            <button
              onClick={() => list.toggle(item)}
              aria-label={list.has(item.id) ? 'Remove from My List' : 'Add to My List'}
              className="glass grid size-12 place-items-center rounded-full transition hover:bg-white/15 active:scale-90"
            >
              {list.has(item.id) ? <Check className="size-5" /> : <Plus className="size-5" />}
            </button>
          </motion.div>
        </motion.div>
      </div>
      </motion.div>
    </section>
  );
}

const rise = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.28, ease: [0.2, 0, 0, 1] as const } } };

function ContinueRail() {
  const qc = useQueryClient();
  const { data } = useContinue();
  if (!data?.length) return null;
  return (
    <Rail title="Continue watching" wide>
      {data.map((p) => (
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

function UpNextRail() {
  const qc = useQueryClient();
  const { data } = useUpNext();
  if (!data?.length) return null;
  return (
    <Rail title="Up next" wide>
      {data.map((u) => (
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

function MyListRail() {
  const { data } = useMyList();
  if (!data?.length) return null;
  return (
    <Rail title="My List" action={<Link to="/library" className="text-sm text-muted hover:text-fg">See all</Link>}>
      {data.map((e) => (
        <PosterCard key={e.mediaId} item={{ id: e.mediaId, mediaType: e.mediaType, title: e.title ?? 'Untitled', year: e.year, poster: e.poster }} />
      ))}
    </Rail>
  );
}

function CollectionRails() {
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

function ReadingRail() {
  const { data } = useQuery({ queryKey: ['reading-progress'], queryFn: api.reading.progress });
  const items = data?.filter((r) => r.percent < 0.99).slice(0, 20);
  if (!items?.length) return null;
  return (
    <Rail title="Keep reading" dense>
      {items.map((r) => (
        <Link key={r.itemKey} to={`/reader?key=${encodeURIComponent(r.itemKey)}`} className="group block">
          <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-ink-800 ring-1 ring-white/6 transition group-hover:-translate-y-1 group-hover:ring-white/20">
            {r.cover ? <img src={r.cover} alt="" loading="lazy" className="size-full object-cover" /> : <div className="grid size-full place-items-center text-muted"><BookOpen /></div>}
            <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
              <div className="h-full bg-progress" style={{ width: `${r.percent * 100}%` }} />
            </div>
          </div>
          <div className="mt-2 truncate text-[13px] font-semibold">{r.title}</div>
          <div className="truncate text-xs text-faint">{Math.round(r.percent * 100)}% · {r.author ?? r.kind}</div>
        </Link>
      ))}
    </Rail>
  );
}

function LiveRail() {
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
          <Link key={c.id} to={`/live?c=${encodeURIComponent(c.id)}`} className="group block">
            <div className="relative grid aspect-video place-items-center overflow-hidden rounded-2xl bg-gradient-to-br from-ink-700 to-ink-900 ring-1 ring-white/6 transition group-hover:-translate-y-1 group-hover:ring-white/20">
              {c.logo ? <img src={c.logo} alt="" loading="lazy" className="max-h-[55%] max-w-[65%] object-contain" /> : <span className="font-display text-lg">{c.name}</span>}
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

function BecauseRail() {
  const { data: cont } = useContinue();
  const seed = cont?.[0];
  const { data } = useQuery({ queryKey: ['because', seed?.mediaId], queryFn: () => api.catalog.because(seed!.mediaId), enabled: Boolean(seed) });
  if (!data?.items.length) return null;
  return (
    <Rail title={<>Because you watched <span className="text-gradient">{data.title}</span></>}>
      {data.items.map((i) => (
        <PosterCard key={i.id} item={i} />
      ))}
    </Rail>
  );
}

function NewEpisodesRail() {
  const { data } = useQuery({ queryKey: ['anime-recent'], queryFn: api.catalog.animeRecent, staleTime: 15 * 60_000 });
  if (!data?.length) return null;
  return (
    <Rail title="Fresh episodes" action={<Link to="/anime" className="text-sm text-muted hover:text-fg">Anime</Link>}>
      {data.map((i) => (
        <PosterCard key={i.id} item={i} />
      ))}
    </Rail>
  );
}

function AiringRail() {
  const now = Math.floor(Date.now() / 1000);
  const { data } = useQuery({ queryKey: ['calendar-week'], queryFn: () => api.me.calendar(now - 6 * 3600, now + 7 * 86400, 'followed'), staleTime: 10 * 60_000 });
  const upcoming = data?.filter((e) => e.airsAt > now - 6 * 3600).slice(0, 20);
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

export function Home() {
  const { data: rows, isLoading, isError } = useQuery({ queryKey: ['home'], queryFn: api.catalog.home, staleTime: 10 * 60_000 });
  const { data: prefs } = usePrefs();
  const { data: contrib } = useContributions();
  const profile = useProfile();
  const featured = useMemo(() => (rows ? pickFeatured(rows) : null), [rows]);
  const order = prefs?.home.sections ?? ['hero', 'continue', 'upnext', 'collections', 'live', 'reading', 'mylist', 'trending', 'because', 'new', 'airing'];
  const hidden = new Set(prefs?.home.hidden ?? []);

  const sections: Record<string, ReactNode> = {
    continue: <ContinueRail key="continue" />,
    upnext: <UpNextRail key="upnext" />,
    collections: <CollectionRails key="collections" />,
    live: <LiveRail key="live" />,
    reading: <ReadingRail key="reading" />,
    mylist: <MyListRail key="mylist" />,
    because: <BecauseRail key="because" />,
    new: <NewEpisodesRail key="new" />,
    airing: <AiringRail key="airing" />,
    trending: (
      <div key="trending" className="space-y-10">
        {isLoading && [0, 1, 2].map((i) => <RailSkeleton key={i} />)}
        {rows?.map((r, idx) => (
          <Rail key={r.id} title={r.title}>
            {r.items.map((it, i) => (
              <PosterCard key={it.id} item={it} rank={idx === 0 && i < 10 ? i + 1 : undefined} />
            ))}
          </Rail>
        ))}
      </div>
    ),
  };

  return (
    <div>
      {!hidden.has('hero') && order.includes('hero') ? (
        featured ? (
          <Hero item={featured} eyebrow={`${greeting()}, ${profile?.name ?? ''}`} />
        ) : (
          <div className="h-[78svh] min-h-[520px] skeleton" />
        )
      ) : (
        <div className="h-24" />
      )}
      <div className="relative z-10 -mt-[6svh] space-y-10">
        {order.filter((s) => s !== 'hero' && !hidden.has(s)).map((s) => sections[s])}
        {contrib?.catalogs.slice(0, 6).map((c) => <PluginRail key={`${c.pluginId}:${c.type}:${c.id}`} catalog={c} />)}
        {isError && !rows?.length && (
          <Empty title="The catalogue is warming up">
            Nova couldn't reach its metadata sources. Check your internet connection and try again in a moment.
          </Empty>
        )}
      </div>
    </div>
  );
}
