import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import ePub, { type Book, type Rendition } from 'epubjs';
import { fontFaceCss, READING_FONTS } from '../../lib/reading-fonts';
import type { Annotation } from '../../lib/types';
import { themeColors, type ReaderHandle, type ReaderViewProps } from './common';

/** EPUB in paginated columns, styled from the profile's reading preferences. */
export const EpubView = forwardRef<ReaderHandle, ReaderViewProps & { buffer: ArrayBuffer }>(function EpubView(
  { buffer, prefs, initialLocator, annotations, onLocation, onSelect, onToc, onTap },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const book = useRef<Book | null>(null);
  const rendition = useRef<Rendition | null>(null);
  const drawn = useRef(new Set<string>());
  const displayed = useRef(false);
  const cb = useRef({ onLocation, onSelect, onTap });
  cb.current = { onLocation, onSelect, onTap };

  useImperativeHandle(ref, () => ({
    next: () => void rendition.current?.next(),
    prev: () => void rendition.current?.prev(),
    goTo: (loc: string) => void rendition.current?.display(loc),
    goToPercent: (p: number) => {
      const b = book.current;
      if (b?.locations.length()) void rendition.current?.display(b.locations.cfiFromPercentage(p));
    },
    removeHighlight: (locator: string) => {
      rendition.current?.annotations.remove(locator, 'highlight');
      drawn.current.delete(locator);
    },
  }));

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const b = ePub(buffer);
    book.current = b;
    const r = b.renderTo(el, { width: '100%', height: '100%', flow: 'paginated', spread: 'auto', allowScriptedContent: false } as Parameters<Book['renderTo']>[1]);
    rendition.current = r;
    r.hooks.content.register((contents: { document: Document }) => {
      const s = contents.document.createElement('style');
      s.textContent = fontFaceCss();
      contents.document.head.appendChild(s);
    });
    r.on('relocated', (loc: { start: { cfi: string; displayed?: { page: number; total: number } }; atEnd?: boolean }) => {
      const pct = b.locations.length() ? b.locations.percentageFromCfi(loc.start.cfi) : 0;
      const label = loc.start.displayed ? `Page ${loc.start.displayed.page} of ${loc.start.displayed.total} in chapter` : undefined;
      cb.current.onLocation(loc.start.cfi, loc.atEnd ? 1 : pct, label);
    });
    r.on('selected', (cfiRange: string, contents: { window: Window }) => {
      const sel = contents.window.getSelection();
      const text = sel?.toString().trim() ?? '';
      if (!text) return;
      const range = sel!.getRangeAt(0).getBoundingClientRect();
      const frame = (contents.window.frameElement as HTMLElement).getBoundingClientRect();
      cb.current.onSelect?.({ locator: cfiRange, text, x: frame.left + range.left + range.width / 2, y: frame.top + range.top });
    });
    r.on('click', () => cb.current.onTap());
    r.on('keyup', (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') void r.next();
      if (e.key === 'ArrowLeft') void r.prev();
    });
    b.loaded.navigation.then((nav) => onToc?.(nav.toc.map((t) => ({ label: t.label.trim(), href: t.href }))));
    displayed.current = false;
    void r.display(initialLocator || undefined).then(() => (displayed.current = true));
    // Locations power the percentage and the scrubber; generate once in the background.
    void b.ready
      .then(() => b.locations.generate(1600))
      .then(() => {
        const cur = displayed.current ? (r.currentLocation() as unknown as { start?: { cfi: string } }) : null;
        if (cur?.start) cb.current.onLocation(cur.start.cfi, b.locations.percentageFromCfi(cur.start.cfi));
      })
      .catch(() => undefined);
    return () => {
      displayed.current = false;
      r.destroy();
      b.destroy();
      drawn.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buffer]);

  // Typography changes apply live without reloading the book.
  useEffect(() => {
    const r = rendition.current;
    if (!r) return;
    const { bg, fg } = themeColors(prefs);
    r.themes.default({
      body: {
        'font-family': `${READING_FONTS[prefs.typeface]?.css ?? READING_FONTS.literata.css} !important`,
        'font-size': `${prefs.fontSize}% !important`,
        'line-height': `${prefs.lineHeight} !important`,
        color: `${fg} !important`,
        background: `${bg} !important`,
        'text-align': prefs.justify ? 'justify' : 'start',
        hyphens: prefs.justify ? 'auto' : 'manual',
      },
      'p, li, span, div': { 'font-family': 'inherit !important', 'line-height': 'inherit !important', color: 'inherit !important' },
      a: { color: `${fg} !important` },
      '::selection': { background: 'rgba(167,139,250,.4)' },
    });
    // Re-render the current page so new metrics take effect.
    if (!displayed.current) return;
    try {
      const cur = r.currentLocation() as unknown as { start?: { cfi: string } };
      if (cur?.start) void r.display(cur.start.cfi);
    } catch {
      /* not laid out yet */
    }
  }, [prefs]);

  useEffect(() => {
    const r = rendition.current;
    if (!r) return;
    for (const a of annotations as Annotation[]) {
      if (a.kind !== 'highlight' || drawn.current.has(a.locator)) continue;
      drawn.current.add(a.locator);
      r.annotations.highlight(a.locator, { id: a.id }, () => undefined, 'nova-hl', { fill: a.color ?? '#fde047', 'fill-opacity': '0.35', 'mix-blend-mode': 'multiply' });
    }
  }, [annotations]);

  return <div ref={host} className="size-full" />;
});
