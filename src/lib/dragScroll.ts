import { useEffect, type RefObject } from 'react';

/**
 * Hold and drag a horizontal scroller with the mouse, with momentum after letting go (touch and
 * trackpads already scroll natively). A drag never counts as a click on the card under it.
 */
export function useDragScroll(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let startX = 0;
    let startLeft = 0;
    let lastX = 0;
    let lastT = 0;
    let velocity = 0;
    let dragging = false;
    let pressed = false;
    let moved = false;
    let raf = 0;

    const stopMomentum = () => cancelAnimationFrame(raf);
    const restoreSnap = () => {
      el.style.scrollSnapType = '';
      el.style.removeProperty('scroll-behavior');
    };
    // Where a glide stops is where the row stays (snapping to a card would jerk it), unless that's just short of an end.
    const settle = () => {
      const max = el.scrollWidth - el.clientWidth;
      const edge = Math.min(80, el.clientWidth * 0.15);
      if (el.scrollLeft > 0 && el.scrollLeft < edge) el.scrollTo({ left: 0, behavior: 'smooth' });
      else if (el.scrollLeft < max && el.scrollLeft > max - edge) el.scrollTo({ left: max, behavior: 'smooth' });
    };

    const onMove = (e: PointerEvent) => {
      if (!pressed) return;
      const dx = e.clientX - startX;
      if (!dragging) {
        if (Math.abs(dx) < 6) return;
        dragging = true;
        moved = true;
        el.style.scrollSnapType = 'none';
        el.style.scrollBehavior = 'auto';
        document.body.style.userSelect = 'none';
        el.style.cursor = 'grabbing';
      }
      const now = performance.now();
      const dt = Math.max(1, now - lastT);
      velocity = 0.8 * ((lastX - e.clientX) / dt) + 0.2 * velocity;
      lastX = e.clientX;
      lastT = now;
      el.scrollLeft = startLeft - dx;
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      pressed = false;
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      el.style.cursor = '';
      // Glide on with the release speed (px/ms), slowing down every frame.
      let v = performance.now() - lastT > 80 ? 0 : velocity;
      let prev = performance.now();
      const glide = (t: number) => {
        const dt = t - prev;
        prev = t;
        el.scrollLeft += v * dt;
        v *= Math.pow(0.94, dt / 16);
        if (Math.abs(v) > 0.05) raf = requestAnimationFrame(glide);
        else {
          el.style.removeProperty('scroll-behavior');
          settle();
        }
      };
      raf = requestAnimationFrame(glide);
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      if ((e.target as HTMLElement).closest('input, textarea, select, [data-no-drag]')) return;
      stopMomentum();
      pressed = true;
      moved = false;
      startX = lastX = e.clientX;
      startLeft = el.scrollLeft;
      lastT = performance.now();
      velocity = 0;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };

    const onClick = (e: MouseEvent) => {
      if (!moved) return;
      moved = false;
      e.preventDefault();
      e.stopPropagation();
    };
    // Links and images would otherwise start the browser's own drag.
    const onDragStart = (e: DragEvent) => e.preventDefault();
    // Fingers scroll natively and like the cards snapping into place.
    const onTouch = () => restoreSnap();

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('click', onClick, true);
    el.addEventListener('dragstart', onDragStart);
    el.addEventListener('touchstart', onTouch, { passive: true });
    return () => {
      stopMomentum();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('click', onClick, true);
      el.removeEventListener('dragstart', onDragStart);
      el.removeEventListener('touchstart', onTouch);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [ref]);
}
