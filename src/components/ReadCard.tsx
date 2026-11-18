import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Star } from 'lucide-react';
import { cls } from '../lib/format';
import type { ReadFormat, ReadItem } from '../lib/types';

export const FORMAT_LABEL: Record<ReadFormat, string> = { manga: 'Manga', manhwa: 'Manhwa', manhua: 'Manhua', novel: 'Light novel', oneshot: 'One-shot', book: 'Book' };

/** "manga:30013" -> "/read/manga/30013". */
export const readTitlePath = (id: string) => {
  const i = id.indexOf(':');
  return `/read/${id.slice(0, i)}/${encodeURIComponent(id.slice(i + 1))}`;
};

/** The Read catalogue's poster card: same look as the watch catalogue's. */
export function ReadCard({ item, hint, className }: { item: Pick<ReadItem, 'id' | 'title' | 'poster' | 'format'> & Partial<ReadItem>; hint?: ReactNode; className?: string }) {
  const meta = [FORMAT_LABEL[item.format], item.author ?? item.year].filter(Boolean).join(' · ');
  return (
    <Link to={readTitlePath(item.id)} className={cls('group/card block w-full shrink-0 outline-none', className)} draggable={false}>
      <div className="relative aspect-[2/3] overflow-hidden rounded-2xl bg-ink-800 ring-1 ring-white/6 transition-[translate,box-shadow] duration-200 ease-snap group-hover/card:-translate-y-1.5 group-hover/card:shadow-[0_24px_48px_-16px_rgb(0_0_0/0.9)] group-hover/card:ring-white/20 group-focus-visible/card:ring-2 group-focus-visible/card:ring-accent">
        {item.poster ? (
          <img src={item.poster} alt="" loading="lazy" draggable={false} className="size-full object-cover transition-transform duration-300 ease-snap group-hover/card:scale-105" />
        ) : (
          <div className="grid size-full place-items-center bg-gradient-to-br from-ink-700 to-ink-900 p-3 text-center font-display text-sm text-muted">{item.title}</div>
        )}
        {item.rating ? (
          <span className="nova-score absolute top-2 right-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold backdrop-blur">
            <Star className="size-3 fill-amber-300 text-amber-300" /> {item.rating.toFixed(1)}
          </span>
        ) : null}
      </div>
      <div className="mt-2.5 px-0.5">
        <div className="truncate text-[13.5px] font-semibold text-fg/95">{item.title}</div>
        <div className="mt-0.5 truncate text-xs text-faint">{hint ?? (meta || '\u00a0')}</div>
      </div>
    </Link>
  );
}

/** Grid that asks for more as its end comes into view (same layout as the watch catalogue). */
export function ReadGrid({ items, loading, done, onEnd }: { items: ReadItem[]; loading?: boolean; done?: boolean; onEnd?: () => void }) {
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
          <ReadCard key={`${it.id}-${i}`} item={it} />
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
