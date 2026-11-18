import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { cls } from '../lib/format';
import { Chip, Menu, MenuItem, Segmented } from './ui';

export interface FilterOption<T extends string = string> {
  value: T;
  label: string;
}

const FADE = 40;

/** One line of chips: arrows and the mouse wheel scroll it, edges fade, the active chip stays in view. */
export function ChipStrip({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const update = () => {
    const el = ref.current;
    if (el) setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    const active = el.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (active && active.offsetLeft + active.offsetWidth > el.clientWidth) el.scrollLeft = active.offsetLeft - el.clientWidth / 3;
    // Mice only have a vertical wheel: turn it sideways while the strip can still move that way.
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const canMove = e.deltaY > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollLeft > 0;
      if (!canMove) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', update);
    return () => {
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', update);
    };
  }, []);
  useEffect(update, [children]);
  const by = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.7, behavior: 'smooth' });
  const mask =
    edges.left || edges.right
      ? `linear-gradient(90deg, ${edges.left ? 'transparent' : '#000'}, #000 ${FADE}px, #000 calc(100% - ${FADE}px), ${edges.right ? 'transparent' : '#000'})`
      : undefined;
  const arrow = 'absolute top-1/2 z-10 grid size-8 -translate-y-1/2 place-items-center rounded-full bg-bg/85 text-muted ring-1 ring-line backdrop-blur transition hover:text-fg max-sm:hidden';
  return (
    <div className={cls('relative min-w-0', className)}>
      <div ref={ref} onScroll={update} className="scrollbar-none flex gap-2 overflow-x-auto py-0.5" style={{ maskImage: mask, WebkitMaskImage: mask }}>
        {children}
      </div>
      {edges.left && (
        <button onClick={() => by(-1)} aria-label="Scroll left" className={cls(arrow, 'left-0')}>
          <ChevronLeft className="size-4" />
        </button>
      )}
      {edges.right && (
        <button onClick={() => by(1)} aria-label="Scroll right" className={cls(arrow, 'right-0')}>
          <ChevronRight className="size-4" />
        </button>
      )}
    </div>
  );
}

/** A chip that opens a list of choices (format, type…). */
export function FilterMenu<T extends string>({ value, options, onChange }: { value: T; options: FilterOption<T>[]; onChange: (v: T) => void }) {
  const current = options.find((o) => o.value === value) ?? options[0];
  return (
    <Menu
      align="left"
      width="w-48"
      trigger={(open, toggle) => (
        <Chip active={value !== options[0]?.value} onClick={toggle}>
          {current?.label}
          <ChevronDown className={cls('size-3.5 transition-transform', open && 'rotate-180')} />
        </Chip>
      )}
    >
      {(close) =>
        options.map((o) => (
          <MenuItem
            key={o.value}
            active={o.value === value}
            onClick={() => {
              close();
              onChange(o.value);
            }}
          >
            {o.label}
          </MenuItem>
        ))
      }
    </Menu>
  );
}

/** Sort, extra filters and genres on one row (genres drop to their own line on narrow screens). */
export function BrowseFilters<S extends string>({
  sort,
  sorts,
  onSort,
  genre,
  genres,
  onGenre,
  extra,
}: {
  sort: S;
  sorts: readonly FilterOption<S>[];
  onSort: (v: S) => void;
  genre: string;
  genres: FilterOption[];
  onGenre: (v: string) => void;
  extra?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-3 md:flex-nowrap">
      <Segmented size="sm" value={sort} onChange={onSort} options={[...sorts]} className="shrink-0" />
      {extra}
      <span className="mx-1 hidden h-6 w-px shrink-0 bg-line md:block" />
      <ChipStrip className="w-full md:w-auto md:flex-1">
        <Chip active={!genre} onClick={() => onGenre('')}>
          All genres
        </Chip>
        {genres.map((g) => (
          <Chip key={g.value} active={genre === g.value} onClick={() => onGenre(g.value)}>
            {g.label}
          </Chip>
        ))}
      </ChipStrip>
    </div>
  );
}

/** The browse block every catalogue tab shares: heading, filters, results. */
export function BrowseSection({
  id = 'browse',
  title,
  filters,
  children,
  top,
  className,
}: {
  id?: string;
  title: string;
  filters: ReactNode;
  children: ReactNode;
  /** Nothing above it: clear the top bar. */
  top?: boolean;
  className?: string;
}) {
  return (
    <section id={id} className={cls('scroll-mt-24', top && 'pt-24 sm:pt-28', className)}>
      <div className="mb-6 space-y-4 px-5 sm:px-10">
        <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h2>
        {filters}
      </div>
      {children}
    </section>
  );
}
