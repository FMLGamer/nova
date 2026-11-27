import { motion } from 'motion/react';
import { Children, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { Check, ChevronLeft, ChevronRight, Film, Info, Play, Plus, Swords, Tv, X } from 'lucide-react';
import { cls, episodeLabel, fmtLeft, fmtRuntime, kindLabel, titlePath, watchPath } from '../lib/format';
import { useDragScroll } from '../lib/dragScroll';
import { useListToggle, usePrefs, useSummary } from '../lib/queries';
import type { CatalogItem } from '../lib/types';
import { useTrackedAnime } from './Tracking';
import { SectionTitle } from './ui';

export type CardItem = Pick<CatalogItem, 'id' | 'mediaType' | 'title' | 'year' | 'poster'> & Partial<CatalogItem>;

/** Stand-in artwork for titles without a (working) poster. */
export function PosterPlaceholder({ title, mediaType }: { title: string; mediaType?: string }) {
  const Icon = mediaType === 'movie' ? Film : mediaType === 'anime' ? Swords : Tv;
  return (
    <div className="flex size-full flex-col items-center justify-center gap-3 bg-gradient-to-br from-ink-600 via-ink-800 to-ink-900 p-3 text-center">
      <Icon className="size-8 text-white/25" strokeWidth={1.5} />
      <span className="line-clamp-4 font-display text-sm leading-snug text-white/60">{title}</span>
    </div>
  );
}

/** The one poster card used everywhere: title, year and length always visible, watched state as a badge. */
export function PosterCard({ item, className, rank, hint }: { item: CardItem; className?: string; rank?: number; hint?: ReactNode }) {
  const navigate = useNavigate();
  const [broken, setBroken] = useState(false);
  const summary = useSummary().data?.get(item.id);
  const tracked = useTrackedAnime().get(item.id);
  const { data: prefs } = usePrefs();
  const list = useListToggle();
  const inList = list.has(item.id);
  const isSeries = item.mediaType !== 'movie';
  // A series only gets the check once it's done; until then the badge says how far you are.
  const episodesSeen = Math.max(summary?.finished ?? 0, tracked?.progress ?? 0);
  const total = tracked?.episodes ?? null;
  const watched = isSeries ? tracked?.status === 'completed' || (total != null && episodesSeen >= total) : Boolean(summary && (summary.lastPercent > 0.9 || summary.finished > 0));
  const progressBadge =
    isSeries && !watched && (summary?.started || tracked?.progress)
      ? prefs?.beta?.episodeCounts
        ? `${episodesSeen}${total ? `/${total}` : ''} watched`
        : summary?.lastEpisode != null
          ? episodeLabel(item.mediaType, summary.lastSeason, summary.lastEpisode)
          : tracked?.progress
            ? `E${tracked.progress}`
            : null
      : null;
  const meta = [item.year, fmtRuntime(item.runtime ?? null), isSeries ? kindLabel(item.mediaType) : null].filter(Boolean).join(' · ');

  const quickPlay = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isSeries && summary?.lastEpisode != null) navigate(watchPath({ mediaId: item.id, season: summary.lastSeason, episode: summary.lastEpisode }));
    else if (isSeries) navigate(titlePath(item.id));
    else navigate(watchPath({ mediaId: item.id }));
  };

  return (
    <Link to={titlePath(item.id)} className={cls('group/card block w-full shrink-0 outline-none', className)} draggable={false}>
      <div className="relative">
        {rank != null && (
          <span className="pointer-events-none absolute bottom-1 left-2 z-10 font-display text-[52px] leading-none font-black text-white [text-shadow:0_2px_0_rgb(0_0_0/0.35),0_6px_28px_rgb(0_0_0/0.85)] sm:text-[68px]">
            {rank}
          </span>
        )}
        <div className="relative aspect-[2/3] overflow-hidden rounded-2xl bg-ink-800 ring-1 ring-white/6 transition-[translate,box-shadow] duration-200 ease-snap group-hover/card:-translate-y-1.5 group-hover/card:shadow-[0_24px_48px_-16px_rgb(0_0_0/0.9)] group-hover/card:ring-white/20 group-focus-visible/card:ring-2 group-focus-visible/card:ring-accent">
          {item.poster && !broken ? (
            <img src={item.poster} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} className="size-full object-cover transition-transform duration-300 ease-snap group-hover/card:scale-105" />
          ) : (
            <PosterPlaceholder title={item.title} mediaType={item.mediaType} />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 transition-opacity duration-150 group-hover/card:opacity-100" />
          <div className="absolute inset-x-2 bottom-2 flex translate-y-1 items-center gap-1.5 opacity-0 transition-all duration-150 group-hover/card:translate-y-0 group-hover/card:opacity-100 max-sm:hidden">
            <button onClick={quickPlay} aria-label="Play" className="grid size-9 place-items-center rounded-full bg-white text-black transition-transform hover:scale-110">
              <Play className="size-4 fill-current" />
            </button>
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                list.toggle({ id: item.id, mediaType: item.mediaType, title: item.title, poster: item.poster, year: item.year });
              }}
              aria-label={inList ? 'Remove from My List' : 'Add to My List'}
              className="glass grid size-9 place-items-center rounded-full transition-transform hover:scale-110"
            >
              {inList ? <Check className="size-4" /> : <Plus className="size-4" />}
            </button>
          </div>
          {watched && (
            <span className="absolute top-2 right-2 grid size-6 place-items-center rounded-full bg-black/60 text-ok backdrop-blur" title="Watched">
              <Check className="size-3.5" strokeWidth={3} />
            </span>
          )}
          {progressBadge && (
            <span className="absolute top-2 right-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold backdrop-blur">
              {progressBadge}
            </span>
          )}
          {summary && summary.lastPercent > 0 && summary.lastPercent < 0.95 && (
            <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
              <div className="h-full bg-progress" style={{ width: `${summary.lastPercent * 100}%` }} />
            </div>
          )}
        </div>
      </div>
      <div className="mt-2.5 px-0.5">
        <div className="truncate text-[13.5px] font-semibold text-fg/95">{item.title}</div>
        <div className="mt-0.5 truncate text-xs text-faint">{hint ?? (meta || '\u00a0')}</div>
      </div>
    </Link>
  );
}

/** Landscape card for continue watching / up next. */
export function WideCard({
  to,
  image,
  title,
  subtitle,
  progress,
  onRemove,
  removeLabel = 'Remove from Continue Watching',
  detailsTo,
  badge,
}: {
  to: string;
  image: string | null;
  title: string;
  subtitle?: ReactNode;
  progress?: number;
  onRemove?: () => void;
  removeLabel?: string;
  /** The title page, opened on this episode. */
  detailsTo?: string;
  badge?: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <Link to={to} className="group/card block w-full shrink-0 outline-none" draggable={false}>
      <div className="relative aspect-video overflow-hidden rounded-2xl bg-ink-800 ring-1 ring-white/6 transition-[translate,box-shadow] duration-200 ease-snap group-hover/card:-translate-y-1 group-hover/card:ring-white/20 group-focus-visible/card:ring-2 group-focus-visible/card:ring-accent">
        {image && <img src={image} alt="" loading="lazy" draggable={false} className="size-full object-cover transition-transform duration-300 ease-snap group-hover/card:scale-105" />}
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-transparent" />
        <div className="absolute inset-0 grid place-items-center opacity-0 transition-opacity duration-150 group-hover/card:opacity-100">
          <span className="grid size-12 place-items-center rounded-full bg-white/95 text-black shadow-xl">
            <Play className="size-5 translate-x-px fill-current" />
          </span>
        </div>
        {badge && <div className="absolute top-2.5 left-2.5">{badge}</div>}
        <div className="absolute top-2 right-2 flex gap-1.5 opacity-0 transition-opacity group-hover/card:opacity-100 max-sm:opacity-100">
          {detailsTo && (
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                navigate(detailsTo);
              }}
              aria-label="Details"
              title="Details"
              className="grid size-7 place-items-center rounded-full bg-black/60 text-white/80 backdrop-blur hover:text-white"
            >
              <Info className="size-4" />
            </button>
          )}
          {onRemove && (
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onRemove();
              }}
              aria-label={removeLabel}
              title={removeLabel}
              className="grid size-7 place-items-center rounded-full bg-black/60 text-white/80 backdrop-blur hover:text-white"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        <div className="absolute inset-x-3 bottom-2.5">
          <div className="truncate text-sm font-semibold">{title}</div>
          {subtitle && <div className="truncate text-xs text-white/70">{subtitle}</div>}
          {progress != null && progress > 0 && (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/20">
              <div className="h-full rounded-full bg-progress" style={{ width: `${Math.min(100, progress * 100)}%` }} />
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}

export function leftLabel(position: number, duration: number | null) {
  return fmtLeft(position, duration);
}

/** A horizontally scrolling row with snap, edge fades and hover arrows. */
export function Rail({
  title,
  action,
  children,
  wide,
  dense,
  onEnd,
  loadingMore,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  dense?: boolean;
  /** Called when the row is scrolled close to its end (load the next page). */
  onEnd?: () => void;
  /** Placeholder cards at the end while the next page loads. */
  loadingMore?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: true });
  useDragScroll(ref);
  const update = () => {
    const el = ref.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 8, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 8 });
    if (onEnd && el.scrollLeft + el.clientWidth > el.scrollWidth - el.clientWidth * 0.6) onEnd();
  };
  useEffect(update, [children]);
  const scroll = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.85, behavior: 'smooth' });
  const item = wide ? 'w-[78vw] sm:w-[340px] lg:w-[380px]' : dense ? 'w-[30vw] sm:w-[148px]' : 'w-[38vw] sm:w-[172px] lg:w-[188px]';
  return (
    <section className="group/rail relative animate-rise">
      {title && <SectionTitle action={action}>{title}</SectionTitle>}
      <div className="relative">
        <div
          ref={ref}
          onScroll={update}
          className="scrollbar-none flex snap-x snap-mandatory scroll-px-5 gap-3 overflow-x-auto overscroll-x-contain px-5 pt-2 pb-4 sm:scroll-px-10 sm:gap-4 sm:px-10"
        >
          {Children.toArray(children).map((c, i) => (
            <div key={(c as { key?: string }).key ?? i} className={cls('shrink-0 snap-start', item)}>
              {c}
            </div>
          ))}
          {loadingMore &&
            [0, 1, 2].map((i) => (
              <div key={`more${i}`} className={cls('shrink-0', item)}>
                <div className={cls('skeleton rounded-2xl', wide ? 'aspect-video' : 'aspect-[2/3]')} />
              </div>
            ))}
        </div>
        {edges.left && (
          <button
            onClick={() => scroll(-1)}
            aria-label="Scroll left"
            className="glass absolute top-[38%] left-2 z-10 hidden size-11 -translate-y-1/2 place-items-center rounded-full opacity-0 transition-opacity group-hover/rail:opacity-100 sm:grid"
          >
            <ChevronLeft className="size-5" />
          </button>
        )}
        {edges.right && (
          <button
            onClick={() => scroll(1)}
            aria-label="Scroll right"
            className="glass absolute top-[38%] right-2 z-10 hidden size-11 -translate-y-1/2 place-items-center rounded-full opacity-0 transition-opacity group-hover/rail:opacity-100 sm:grid"
          >
            <ChevronRight className="size-5" />
          </button>
        )}
      </div>
    </section>
  );
}

export function RailSkeleton({ wide, title = true }: { wide?: boolean; title?: boolean }) {
  return (
    <div className="space-y-3">
      {title && <div className="skeleton mx-5 h-6 w-44 rounded-lg sm:mx-10" />}
      <div className="flex gap-4 overflow-hidden px-5 sm:px-10">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className={cls('shrink-0', wide ? 'w-[78vw] sm:w-[340px]' : 'w-[38vw] sm:w-[172px]')}>
            <div className={cls('skeleton rounded-2xl', wide ? 'aspect-video' : 'aspect-[2/3]')} />
            {!wide && <div className="skeleton mt-2.5 h-3.5 w-3/4 rounded" />}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Responsive poster grid that asks for more as the end comes into view. */
export function PosterGrid({
  items,
  onEnd,
  loading,
  done,
}: {
  items: CardItem[];
  onEnd?: () => void;
  loading?: boolean;
  done?: boolean;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!onEnd || done) return;
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && onEnd(), { rootMargin: '900px' });
    io.observe(el);
    return () => io.disconnect();
  }, [onEnd, done, items.length]);
  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-x-4 gap-y-6 px-5 sm:grid-cols-[repeat(auto-fill,minmax(168px,1fr))] sm:px-10">
        {items.map((it, i) => (
          <motion.div key={`${it.id}-${i}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: [0.2, 0, 0, 1], delay: Math.min(i % 20, 12) * 0.012 }}>
            <PosterCard item={it} />
          </motion.div>
        ))}
        {loading &&
          Array.from({ length: 12 }).map((_, i) => (
            <div key={`sk${i}`}>
              <div className="skeleton aspect-[2/3] rounded-2xl" />
              <div className="skeleton mt-2.5 h-3.5 w-3/4 rounded" />
            </div>
          ))}
      </div>
      <div ref={sentinel} className="h-px" />
    </>
  );
}
