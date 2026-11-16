import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume2, X } from 'lucide-react';
import { useAudio } from '../lib/audio';
import { cls, fmtClock } from '../lib/format';

/** The persistent mini player for music and audiobooks; survives navigation. */
export function AudioDock() {
  const s = useAudio();
  const ref = useRef<HTMLAudioElement>(null);
  const [t, setT] = useState(0);
  const [d, setD] = useState(0);
  const track = s.queue[s.index];

  useEffect(() => {
    const a = ref.current;
    if (!a || !track) return;
    if (s.playing) a.play().catch(() => s.setPlaying(false));
    else a.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.playing, track?.url, s.nonce]);

  useEffect(() => {
    if (ref.current) ref.current.volume = s.volume;
  }, [s.volume]);

  useEffect(() => {
    if (s.nonce && ref.current) ref.current.currentTime = 0;
  }, [s.nonce]);

  useEffect(() => {
    if (!track || !('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.subtitle,
      album: s.context?.title,
      artwork: track.cover ? [{ src: track.cover, sizes: '512x512' }] : [],
    });
    navigator.mediaSession.setActionHandler('play', () => s.setPlaying(true));
    navigator.mediaSession.setActionHandler('pause', () => s.setPlaying(false));
    navigator.mediaSession.setActionHandler('nexttrack', () => s.next());
    navigator.mediaSession.setActionHandler('previoustrack', () => s.previous());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id]);

  return (
    <AnimatePresence>
      {track && (
        <motion.div
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 100, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 900, damping: 60 }}
          className="fixed inset-x-2 bottom-[4.6rem] z-40 lg:inset-x-auto lg:right-6 lg:bottom-6 lg:w-[440px]"
        >
          <div className="glass-strong relative overflow-hidden rounded-2xl shadow-2xl">
            <div className="absolute inset-x-0 top-0 h-0.5 bg-white/10">
              <div className="bg-gradient-accent h-full transition-[width] duration-300" style={{ width: d ? `${(t / d) * 100}%` : '0%' }} />
            </div>
            <div className="flex items-center gap-3 p-2.5">
              {track.cover ? (
                <img src={track.cover} alt="" className={cls('size-12 shrink-0 rounded-lg object-cover', s.playing && 'animate-[pulse_3s_ease-in-out_infinite]')} />
              ) : (
                <div className="bg-gradient-accent size-12 shrink-0 rounded-lg" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{track.title}</div>
                <div className="truncate text-xs text-muted">
                  {s.context ? (
                    <Link to={s.context.href} className="hover:text-fg">
                      {track.subtitle} · {s.context.title}
                    </Link>
                  ) : (
                    track.subtitle
                  )}
                </div>
                <input
                  aria-label="Seek"
                  type="range"
                  min={0}
                  max={d || 1}
                  step={0.5}
                  value={t}
                  onChange={(e) => ref.current && (ref.current.currentTime = Number(e.target.value))}
                  className="mt-1 hidden h-1 w-full sm:block"
                />
              </div>
              <span className="hidden text-[11px] text-faint tabular-nums sm:block">
                {fmtClock(t)} / {fmtClock(d)}
              </span>
              <div className="flex items-center">
                <button aria-label="Shuffle" onClick={() => s.setShuffle(!s.shuffle)} className={cls('hidden size-8 place-items-center rounded-full sm:grid', s.shuffle ? 'text-accent' : 'text-muted')}>
                  <Shuffle className="size-4" />
                </button>
                <button aria-label="Previous" onClick={s.previous} className="grid size-9 place-items-center rounded-full text-fg hover:bg-white/8">
                  <SkipBack className="size-4 fill-current" />
                </button>
                <button aria-label={s.playing ? 'Pause' : 'Play'} onClick={s.toggle} className="grid size-10 place-items-center rounded-full bg-white text-black transition-transform active:scale-90">
                  {s.playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 translate-x-px fill-current" />}
                </button>
                <button aria-label="Next" onClick={() => s.next()} className="grid size-9 place-items-center rounded-full text-fg hover:bg-white/8">
                  <SkipForward className="size-4 fill-current" />
                </button>
                <button aria-label="Repeat" onClick={s.cycleRepeat} className={cls('hidden size-8 place-items-center rounded-full sm:grid', s.repeat !== 'off' ? 'text-accent' : 'text-muted')}>
                  {s.repeat === 'one' ? <Repeat1 className="size-4" /> : <Repeat className="size-4" />}
                </button>
                <label className="group/vol relative hidden size-8 place-items-center text-muted sm:grid">
                  <Volume2 className="size-4" />
                  <input
                    aria-label="Volume"
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={s.volume}
                    onChange={(e) => s.setVolume(Number(e.target.value))}
                    className="absolute bottom-full mb-6 hidden w-24 -rotate-90 group-hover/vol:block"
                  />
                </label>
                <button aria-label="Close player" onClick={s.close} className="grid size-8 place-items-center rounded-full text-faint hover:text-fg">
                  <X className="size-4" />
                </button>
              </div>
            </div>
          </div>
          <audio
            ref={ref}
            src={track.url}
            preload="auto"
            onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
            onDurationChange={(e) => setD(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)}
            onEnded={() => s.next(true)}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
