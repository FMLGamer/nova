import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { themeColors, type ReaderHandle, type ReaderViewProps } from './common';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

function Page({ doc, n, width, dark }: { doc: pdfjs.PDFDocumentProxy; n: number; width: number; dark: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(1.414);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e && setVisible(e.isIntersecting), { rootMargin: '1200px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !ref.current || !width) return;
    let task: { cancel: () => void } | null = null;
    let cancelled = false;
    void doc.getPage(n).then((page) => {
      if (cancelled || !ref.current) return;
      const base = page.getViewport({ scale: 1 });
      setRatio(base.height / base.width);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: (width / base.width) * dpr });
      const canvas = ref.current;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const t = page.render({ canvas, viewport });
      task = t;
      t.promise.catch(() => undefined);
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [visible, doc, n, width]);

  return (
    <div ref={box} data-page={n} className="relative mx-auto bg-white shadow-xl" style={{ width, height: width * ratio }}>
      <canvas ref={ref} className="size-full" style={dark ? { filter: 'invert(0.9) hue-rotate(180deg)' } : undefined} />
    </div>
  );
}

/** PDF as a continuous scroll of pages, rendered lazily as they near the viewport. */
export const PdfView = forwardRef<ReaderHandle, ReaderViewProps & { buffer: ArrayBuffer }>(function PdfView({ buffer, prefs, initialLocator, onLocation, onTap }, ref) {
  const scroller = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [width, setWidth] = useState(0);
  const { dark } = themeColors(prefs);

  const goPage = (n: number) => scroller.current?.querySelector(`[data-page="${n}"]`)?.scrollIntoView({ block: 'start' });
  useImperativeHandle(ref, () => ({
    next: () => scroller.current?.scrollBy({ top: scroller.current.clientHeight * 0.9, behavior: 'smooth' }),
    prev: () => scroller.current?.scrollBy({ top: -scroller.current.clientHeight * 0.9, behavior: 'smooth' }),
    goTo: (loc: string) => goPage(Number(loc) || 1),
    goToPercent: (p: number) => doc && goPage(Math.max(1, Math.round(p * doc.numPages))),
  }));

  useEffect(() => {
    let cancelled = false;
    const task = pdfjs.getDocument({ data: new Uint8Array(buffer.slice(0)) });
    void task.promise.then((d) => !cancelled && setDoc(d));
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [buffer]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setWidth(Math.min(1100, el.clientWidth * (1 - (prefs.margins / 100) * 1.2)));
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [prefs.margins]);

  useEffect(() => {
    if (doc && initialLocator) window.setTimeout(() => goPage(Number(initialLocator) || 1), 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el || !doc) return;
    const pages = el.querySelectorAll<HTMLElement>('[data-page]');
    const mid = el.scrollTop + el.clientHeight / 3;
    let current = 1;
    pages.forEach((p) => {
      if (p.offsetTop <= mid) current = Number(p.dataset.page);
    });
    onLocation(String(current), doc.numPages > 1 ? (current - 1) / (doc.numPages - 1) : 1, `Page ${current} of ${doc.numPages}`);
  };

  return (
    <div ref={scroller} onScroll={onScroll} onClick={onTap} className="size-full overflow-y-auto py-20">
      <div className="space-y-4">{doc && width > 0 && Array.from({ length: doc.numPages }, (_, i) => <Page key={i} doc={doc} n={i + 1} width={width} dark={dark} />)}</div>
    </div>
  );
});
