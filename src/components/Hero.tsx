import { motion, useScroll, useTransform } from 'motion/react';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Check, Info, Play, Plus, Star } from 'lucide-react';
import { cls, metaLine, titlePath, watchPath } from '../lib/format';
import { playIntent } from '../lib/intent';
import { useDetail, useListToggle, useMediaProgress, usePrefs } from '../lib/queries';
import { useApp } from '../lib/store';
import type { CatalogItem } from '../lib/types';
import { Trailer } from './Trailer';
import { Button } from './ui';

const rise = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.28, ease: [0.2, 0, 0, 1] as const } } };

/** Section pages use a hero about half the height of Home's. */
export const HERO_HEIGHT = { full: 'h-[78svh] min-h-[520px] sm:h-[86svh]', compact: 'h-[40svh] min-h-[300px] sm:h-[44svh]' };

function useScrollFade() {
  const { scrollY } = useScroll();
  const fadeEnd = typeof window !== 'undefined' ? window.innerHeight * 0.6 : 500;
  return useTransform(scrollY, [0, fadeEnd], [1, 0]);
}

function Shade() {
  return (
    <>
      <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/30 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-bg/90 via-bg/35 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-bg to-transparent" />
    </>
  );
}

export function Hero({ item, eyebrow, compact }: { item: CatalogItem; eyebrow?: ReactNode; compact?: boolean }) {
  const navigate = useNavigate();
  const { data: prefs } = usePrefs();
  const { data: detail } = useDetail(item.id);
  const { data: progress } = useMediaProgress(item.id);
  const list = useListToggle();
  const setAmbient = useApp((s) => s.setAmbient);
  const [trailerOn, setTrailerOn] = useState(false);
  const [trailerFailed, setTrailerFailed] = useState(false);
  const intent = detail ? playIntent(detail, progress) : null;
  const heroOpacity = useScrollFade();

  useEffect(() => setAmbient(item.backdrop), [item.backdrop, setAmbient]);
  useEffect(() => {
    if (compact || !detail?.trailer || prefs?.ui.autoplayPreviews === false) return;
    // Only start while the hero is on screen; scrolled down, wait until the user comes back up.
    const start = () => window.scrollY < window.innerHeight * 0.3 && setTrailerOn(true);
    const t = window.setTimeout(() => {
      start();
      window.addEventListener('scroll', start, { passive: true });
    }, 2200);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('scroll', start);
    };
  }, [compact, detail?.trailer, prefs?.ui.autoplayPreviews]);

  const long = item.title.length > 28;
  return (
    <section className={cls('relative w-full overflow-hidden', compact ? HERO_HEIGHT.compact : HERO_HEIGHT.full)}>
      <motion.div style={{ opacity: heroOpacity }} className="absolute inset-0">
        <motion.img
          key={item.id}
          src={item.backdrop ?? undefined}
          alt=""
          initial={{ scale: 1.04, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.9, ease: [0.2, 0, 0, 1] }}
          className="absolute inset-0 size-full object-cover"
        />
        {trailerOn && detail?.trailer && !trailerFailed && <Trailer videoKey={detail.trailer.key} onFail={() => setTrailerFailed(true)} />}
        <Shade />

        <div className={cls('absolute inset-x-0 px-5 sm:px-10', compact ? 'bottom-[10%]' : 'bottom-[12%]')}>
          <motion.div
            key={item.id}
            initial="hidden"
            animate="show"
            variants={{ hidden: {}, show: { transition: { staggerChildren: 0.04, delayChildren: 0.05 } } }}
            className="max-w-2xl"
          >
            {eyebrow && (
              <motion.div variants={rise} className={cls('text-xs font-semibold tracking-[0.2em] text-white/70 uppercase', compact ? 'mb-2' : 'mb-3')}>
                {eyebrow}
              </motion.div>
            )}
            <motion.h1
              variants={rise}
              className={cls(
                'font-display leading-[0.95] font-bold text-balance drop-shadow-[0_4px_30px_rgb(0_0_0/0.5)]',
                compact
                  ? long ? 'text-[clamp(1.6rem,3.2vw,2.6rem)]' : 'text-[clamp(1.9rem,4vw,3.4rem)]'
                  : long ? 'text-[clamp(2.1rem,4.4vw,3.8rem)]' : 'text-[clamp(2.4rem,6vw,5.2rem)]',
              )}
            >
              {item.title}
            </motion.h1>
            <motion.div variants={rise} className={cls('flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-white/80', compact ? 'mt-2.5' : 'mt-4')}>
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
            <motion.p
              variants={rise}
              className={cls('max-w-xl leading-relaxed text-white/75', compact ? 'mt-2.5 line-clamp-2 text-sm' : 'mt-4 line-clamp-3 text-[15px] sm:text-base')}
            >
              {item.overview}
            </motion.p>
            <motion.div variants={rise} className={cls('flex flex-wrap items-center gap-3', compact ? 'mt-4' : 'mt-7')}>
              <Button
                size={compact ? 'md' : 'lg'}
                variant="white"
                icon={<Play className="size-5 fill-current" />}
                onClick={() => navigate(watchPath({ mediaId: item.id, season: intent?.season, episode: intent?.episode }))}
              >
                {intent?.label ?? 'Play'}
                {intent?.sub && <span className="font-normal text-black/60">· {intent.sub}</span>}
              </Button>
              <Button size={compact ? 'md' : 'lg'} variant="glass" icon={<Info className="size-5" />} onClick={() => navigate(titlePath(item.id))}>
                Details
              </Button>
              <button
                onClick={() => list.toggle(item)}
                aria-label={list.has(item.id) ? 'Remove from My List' : 'Add to My List'}
                className={cls('glass grid place-items-center rounded-full transition hover:bg-white/15 active:scale-90', compact ? 'size-10' : 'size-12')}
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

/** A random title with artwork from the first results, re-picked whenever the results change. */
export function pickHero(items: CatalogItem[] | undefined, limit = 12): CatalogItem | null {
  const pool = (items ?? []).slice(0, limit).filter((i) => i.backdrop && i.overview);
  return pool.length ? pool[Math.floor(Math.random() * pool.length)]! : null;
}

/**
 * A compact hero for things that aren't catalogue titles (a channel, a book): wide artwork when
 * there is some, otherwise the cover blurred behind itself.
 */
export function Spotlight({
  backdrop,
  art,
  eyebrow,
  title,
  meta,
  description,
  actions,
}: {
  backdrop?: string | null;
  art?: string | null;
  eyebrow?: ReactNode;
  title: string;
  meta?: ReactNode;
  description?: string | null;
  actions?: ReactNode;
}) {
  const opacity = useScrollFade();
  const setAmbient = useApp((s) => s.setAmbient);
  useEffect(() => setAmbient(backdrop ?? art ?? null), [backdrop, art, setAmbient]);
  return (
    <section className={cls('relative w-full overflow-hidden', HERO_HEIGHT.compact)}>
      <motion.div style={{ opacity }} className="absolute inset-0">
        {backdrop ? (
          <motion.img key={backdrop} src={backdrop} alt="" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute inset-0 size-full object-cover" />
        ) : art ? (
          <img src={art} alt="" className="absolute inset-0 size-full scale-125 object-cover opacity-50 blur-2xl" />
        ) : (
          <div className="bg-gradient-accent absolute inset-0 opacity-25" />
        )}
        <Shade />
        <div className="absolute inset-x-0 bottom-[10%] flex items-end gap-6 px-5 sm:px-10">
          {art && !backdrop && (
            <img src={art} alt="" className="hidden h-[min(26svh,260px)] w-auto rounded-xl object-cover shadow-2xl ring-1 ring-white/15 sm:block" />
          )}
          <motion.div
            key={title}
            initial="hidden"
            animate="show"
            variants={{ hidden: {}, show: { transition: { staggerChildren: 0.04, delayChildren: 0.05 } } }}
            className="max-w-2xl min-w-0"
          >
            {eyebrow && (
              <motion.div variants={rise} className="mb-2 text-xs font-semibold tracking-[0.2em] text-white/70 uppercase">
                {eyebrow}
              </motion.div>
            )}
            <motion.h1
              variants={rise}
              className="font-display text-[clamp(1.7rem,3.6vw,3rem)] leading-[0.98] font-bold text-balance drop-shadow-[0_4px_30px_rgb(0_0_0/0.5)]"
            >
              {title}
            </motion.h1>
            {meta && (
              <motion.div variants={rise} className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-white/80">
                {meta}
              </motion.div>
            )}
            {description && (
              <motion.p variants={rise} className="mt-2.5 line-clamp-2 max-w-xl text-sm leading-relaxed text-white/75">
                {description}
              </motion.p>
            )}
            {actions && (
              <motion.div variants={rise} className="mt-4 flex flex-wrap items-center gap-3">
                {actions}
              </motion.div>
            )}
          </motion.div>
        </div>
      </motion.div>
    </section>
  );
}
