import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Volume2, VolumeX } from 'lucide-react';

const MUTE_KEY = 'nova.trailerMuted';
const START_OVERLAY_S = 3.5;

/**
 * A background YouTube trailer with all YouTube UI hidden. Fades in only once it is
 * actually playing (so the title overlay never shows), remembers mute, and reports
 * failure (blocked / unavailable) so the caller keeps the still image.
 */
export function Trailer({ videoKey, onFail, controls = true, className }: { videoKey: string; onFail?: () => void; controls?: boolean; className?: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(() => localStorage.getItem(MUTE_KEY) !== 'false');
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  // YouTube shows its own title bar and play overlay for the first seconds of playback (again after each loop
  // and resume), so the video is only revealed once its own clock has passed this point.
  const revealAt = useRef(START_OVERLAY_S);
  const lastTime = useRef(0);

  const cmd = (func: string, args: unknown[] = []) => ref.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), '*');

  useEffect(() => {
    let started = false;
    let playing = false;
    revealAt.current = START_OVERLAY_S;
    lastTime.current = 0;
    const onMsg = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow || typeof e.data !== 'string') return;
      let data: { event?: string; info?: unknown };
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      if (data.event === 'onError') onFail?.();
      const state = data.event === 'onStateChange' ? data.info : data.event === 'infoDelivery' ? (data.info as { playerState?: number } | null)?.playerState : undefined;
      if (state === 1 && !started) {
        started = true;
        if (!mutedRef.current) cmd('unMute');
      }
      if (typeof state === 'number') {
        playing = state === 1;
        // Ended, paused or buffering: YouTube draws over the picture.
        if (!playing) setVisible(false);
      }
      const info = data.info as { currentTime?: number; duration?: number } | null;
      if (data.event === 'infoDelivery' && typeof info?.currentTime === 'number') {
        const t = info.currentTime;
        if (t + 0.5 < lastTime.current) revealAt.current = t + START_OVERLAY_S;
        lastTime.current = t;
        const nearEnd = Boolean(info.duration && info.duration - t < 1.2);
        const show = playing && t >= revealAt.current && !nearEnd;
        setVisible(show);
        if (show) setReady(true);
      }
    };
    window.addEventListener('message', onMsg);
    const t = window.setTimeout(() => !started && onFail?.(), 9000);
    return () => {
      window.removeEventListener('message', onMsg);
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoKey]);

  // The YouTube player can take focus (e.g. on its error screen) and the browser then scrolls the
  // page up to it. Keep the reader where they were.
  useEffect(() => {
    const onBlur = () => {
      if (document.activeElement !== ref.current) return;
      const y = window.scrollY;
      const restore = () => Math.abs(window.scrollY - y) > 1 && window.scrollTo({ top: y, behavior: 'instant' });
      requestAnimationFrame(restore);
      window.setTimeout(restore, 120);
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);

  const origin = window.location.origin;
  const src =
    `https://www.youtube-nocookie.com/embed/${videoKey}?autoplay=1&mute=1&controls=0&loop=1&playlist=${videoKey}` +
    `&modestbranding=1&rel=0&playsinline=1&disablekb=1&fs=0&iv_load_policy=3&cc_load_policy=0&enablejsapi=1&origin=${encodeURIComponent(origin)}`;

  return (
    <>
      <div className={className ?? 'absolute inset-0 overflow-hidden [container-type:size]'}>
        <iframe
          ref={ref}
          title="Trailer"
          src={src}
          allow="autoplay; encrypted-media"
          // YouTube refuses embeds without a referrer (error 153); the page itself sends none.
          referrerPolicy="strict-origin-when-cross-origin"
          onLoad={() => ref.current?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), '*')}
          className="pointer-events-none absolute top-1/2 left-1/2 h-[max(100%,56.25cqw)] w-[max(100%,177.78cqh)] -translate-x-1/2 -translate-y-1/2 scale-[1.18] transition-opacity duration-500"
          style={{ opacity: visible && !paused ? 1 : 0 }}
        />
      </div>
      {controls && (
        <AnimatePresence>
          {ready && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute right-5 bottom-[22%] z-20 flex gap-2 sm:right-10">
              <button
                onClick={() => {
                  if (paused) revealAt.current = lastTime.current + 1.5;
                  cmd(paused ? 'playVideo' : 'pauseVideo');
                  setPaused((p) => !p);
                }}
                aria-label={paused ? 'Play trailer' : 'Pause trailer'}
                className="grid size-10 place-items-center rounded-full border border-white/25 bg-black/30 backdrop-blur transition hover:bg-black/50"
              >
                {paused ? <Play className="size-4 fill-current" /> : <Pause className="size-4 fill-current" />}
              </button>
              <button
                onClick={() => {
                  cmd(muted ? 'unMute' : 'mute');
                  setMuted(!muted);
                  localStorage.setItem(MUTE_KEY, String(!muted));
                }}
                aria-label={muted ? 'Unmute trailer' : 'Mute trailer'}
                className="grid size-10 place-items-center rounded-full border border-white/25 bg-black/30 backdrop-blur transition hover:bg-black/50"
              >
                {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </>
  );
}
