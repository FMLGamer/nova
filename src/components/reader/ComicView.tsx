import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { cls } from '../../lib/format';
import type { ReaderHandle, ReaderViewProps } from './common';

/** Image pages: single page, two-page spreads, or a continuous vertical strip, in either reading direction. */
export const ComicView = forwardRef<ReaderHandle, ReaderViewProps & { pages: string[] }>(function ComicView({ pages, prefs, initialLocator, onLocation, onTap }, ref) {
  const [index, setIndex] = useState(() => Math.max(0, Math.min(pages.length - 1, Number(initialLocator) || 0)));
  const strip = useRef<HTMLDivElement>(null);
  const rtl = prefs.comicDirection === 'rtl';
  const step = prefs.comicMode === 'double' ? 2 : 1;
  const scroll = prefs.comicMode === 'scroll';

  const go = (i: number) => {
    const n = Math.max(0, Math.min(pages.length - 1, i));
    if (scroll) strip.current?.querySelector(`[data-i="${n}"]`)?.scrollIntoView({ block: 'start' });
    setIndex(n);
  };
  useImperativeHandle(ref, () => ({
    next: () => go(index + (scroll ? 1 : step)),
    prev: () => go(index - (scroll ? 1 : step)),
    goTo: (loc: string) => go(Number(loc) || 0),
    goToPercent: (p: number) => go(Math.round(p * (pages.length - 1))),
  }));

  useEffect(() => {
    onLocation(String(index), pages.length > 1 ? index / (pages.length - 1) : 1, `Page ${index + 1} of ${pages.length}`);
    // Warm the next few pages.
    for (let i = index + 1; i < Math.min(pages.length, index + 4); i++) new Image().src = pages[i]!;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  useEffect(() => {
    if (scroll && index) window.setTimeout(() => strip.current?.querySelector(`[data-i="${index}"]`)?.scrollIntoView({ block: 'start' }), 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scroll]);

  const fit = prefs.comicFit === 'width' ? 'w-full h-auto' : prefs.comicFit === 'original' ? 'max-w-none' : 'h-full w-auto max-w-full object-contain';

  if (scroll) {
    return (
      <div
        ref={strip}
        onClick={onTap}
        onScroll={(e) => {
          const el = e.currentTarget;
          const imgs = el.querySelectorAll<HTMLElement>('[data-i]');
          let cur = 0;
          imgs.forEach((im) => {
            if (im.offsetTop <= el.scrollTop + el.clientHeight / 3) cur = Number(im.dataset.i);
          });
          if (cur !== index) setIndex(cur);
        }}
        className="size-full overflow-y-auto"
      >
        <div className="mx-auto flex max-w-3xl flex-col">
          {pages.map((p, i) => (
            <img key={i} data-i={i} src={p} alt="" loading="lazy" className="w-full" />
          ))}
        </div>
      </div>
    );
  }

  const shown = step === 2 && index + 1 < pages.length ? [index, index + 1] : [index];
  const ordered = rtl ? [...shown].reverse() : shown;
  return (
    <div
      className="relative flex size-full items-center justify-center overflow-auto"
      onClick={(e) => {
        const x = e.clientX / e.currentTarget.clientWidth;
        if (x < 0.3) go(index + (rtl ? step : -step));
        else if (x > 0.7) go(index + (rtl ? -step : step));
        else onTap();
      }}
    >
      <div className={cls('flex h-full items-center justify-center', prefs.comicFit === 'width' && 'h-auto w-full')}>
        {ordered.map((i) => (
          <img key={i} src={pages[i]} alt={`Page ${i + 1}`} draggable={false} className={cls(fit, step === 2 && prefs.comicFit !== 'original' && 'max-w-[50%]')} />
        ))}
      </div>
    </div>
  );
});
