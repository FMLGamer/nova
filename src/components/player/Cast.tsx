import { motion } from 'motion/react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Cast, Loader2, Pause, Play, Plus, RefreshCw, Square, Tv, Volume2, X } from 'lucide-react';
import { castApi, loadCastSdk, type BrowserCast, type CastDeviceInfo } from '../../lib/cast';
import { cls, fmtClock } from '../../lib/format';
import { useAppConfig, useSession } from '../../lib/queries';
import { errorText } from '../../lib/store';
import { Slider, Spinner } from '../ui';

export type CastPick = { kind: 'device'; device: CastDeviceInfo } | { kind: 'browser' };

/** The list of TVs in the player's Cast panel. */
export function CastDevices({ base, allowBrowser, busy, onPick }: { base: string; allowBrowser: boolean; busy: string | null; onPick: (p: CastPick) => void }) {
  const [devices, setDevices] = useState<CastDeviceInfo[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sdk, setSdk] = useState(false);
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const desktop = useAppConfig().data?.mode === 'desktop' || Boolean(base);
  const { data: session } = useSession();
  // Added TVs are shared by everyone on the server; on the Nova app the viewer owns it.
  const canAdd = Boolean(base) || Boolean(session?.account.isAdmin);

  const scan = async (refresh: boolean) => {
    setScanning(true);
    setError(null);
    try {
      setDevices(await castApi(base).devices(refresh));
    } catch (e) {
      setError(errorText(e));
      setDevices([]);
    } finally {
      setScanning(false);
    }
  };
  useEffect(() => {
    void scan(false);
    if (allowBrowser) void loadCastSdk().then(setSdk);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, allowBrowser]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setAddBusy(true);
    setError(null);
    try {
      const d = await castApi(base).addDevice(address.trim());
      setDevices((list) => [...(list ?? []).filter((x) => x.id !== d.id), d]);
      setAddress('');
      setAdding(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setAddBusy(false);
    }
  };
  const remove = async (d: CastDeviceInfo) => {
    try {
      await castApi(base).removeDevice(d.id);
      setDevices((list) => list?.filter((x) => x.id !== d.id) ?? null);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="space-y-1">
      {devices?.map((d) => (
        <div key={d.id} className="group flex items-center rounded-xl transition-colors hover:bg-white/6">
          <button
            disabled={Boolean(busy)}
            onClick={() => onPick({ kind: 'device', device: d })}
            className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left text-sm disabled:opacity-50"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/8">{d.kind === 'chromecast' ? <Cast className="size-4" /> : <Tv className="size-4" />}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{d.name}</span>
              <span className="block truncate text-xs text-faint">{[d.kind === 'chromecast' ? 'Chromecast' : 'DLNA TV', d.model, d.saved && 'added by address'].filter(Boolean).join(' · ')}</span>
            </span>
            {busy === d.id && <Spinner className="size-4" />}
          </button>
          {d.saved && canAdd && (
            <button onClick={() => void remove(d)} aria-label={`Forget ${d.name}`} className="mr-2 grid size-8 place-items-center rounded-full text-faint opacity-0 group-hover:opacity-100 hover:bg-white/10 hover:text-fg focus:opacity-100 max-sm:opacity-100">
              <X className="size-4" />
            </button>
          )}
        </div>
      ))}
      {sdk && (
        <button
          disabled={Boolean(busy)}
          onClick={() => onPick({ kind: 'browser' })}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-white/6 disabled:opacity-50"
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/8">
            <Cast className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">Chromecast near this browser…</span>
            <span className="block truncate text-xs text-faint">Uses your browser's Cast menu</span>
          </span>
          {busy === 'browser' && <Spinner className="size-4" />}
        </button>
      )}
      {devices && !devices.length && !scanning && !sdk && (
        <p className="px-3 py-2 text-sm text-muted">
          No TVs found on this network. Make sure the TV is on and on the same network{desktop ? ' as this computer' : ' as the Nova server'}.
          {desktop && ' If Windows asked whether Nova may use the network, allow it on private networks.'}
          {!desktop && ' A server in a container only sees TVs with host networking; Chrome and Edge can also cast with their own Cast menu.'}
        </p>
      )}
      {error && <p className="px-3 py-1 text-xs text-bad">{error}</p>}
      <div className="flex flex-wrap items-center gap-1">
        <button onClick={() => void scan(true)} disabled={scanning} className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted hover:text-fg disabled:opacity-60">
          {scanning ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} {scanning ? 'Looking for TVs…' : 'Search again'}
        </button>
        {canAdd && !adding && (
          <button onClick={() => setAdding(true)} className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted hover:text-fg">
            <Plus className="size-3.5" /> Add a TV by IP address
          </button>
        )}
      </div>
      {adding && (
        <form onSubmit={add} className="mx-1 space-y-2 rounded-2xl border border-line p-3">
          <label className="block text-xs font-medium text-muted" htmlFor="cast-address">
            TV or Chromecast address
          </label>
          <div className="flex gap-2">
            <input
              id="cast-address"
              autoFocus
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="192.168.1.40"
              className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-white/5 px-3 text-sm focus:border-accent focus:outline-none"
            />
            <button type="submit" disabled={addBusy || address.trim().length < 2} className="h-9 rounded-lg bg-white px-3 text-sm font-semibold text-black disabled:opacity-50">
              {addBusy ? <Loader2 className="size-4 animate-spin" /> : 'Add'}
            </button>
          </div>
          <p className="text-xs leading-relaxed text-faint">
            Find the IP address in the TV's network settings (or the Google Home app for a Chromecast). Nova checks what answers there: a Chromecast or a DLNA
            TV. You can also paste a DLNA description URL.
          </p>
          <button type="button" onClick={() => setAdding(false)} className="text-xs text-muted hover:text-fg">
            Cancel
          </button>
        </form>
      )}
      {!canAdd && <p className="px-3 text-xs text-faint">TV missing? A server admin can add it here by its IP address.</p>}
      <p className="px-3 pt-2 text-xs leading-relaxed text-faint">
        Text subtitles are sent to the TV as subtitles. Styled (ASS) subtitles are drawn into the picture while casting, which needs a little more of this machine's power.
      </p>
    </div>
  );
}

export interface ActiveCast {
  id: string;
  base: string;
  deviceName: string;
  offset: number;
  duration: number | null;
  browser?: BrowserCast;
}

/** Full-screen remote while something plays on a TV. */
export function CastRemote({
  cast,
  title,
  subtitle,
  backdrop,
  onStop,
  onProgress,
  onRestarted,
}: {
  cast: ActiveCast;
  title: string;
  subtitle?: string | null;
  backdrop: string | null;
  onStop: (position: number) => void;
  onProgress: (position: number, duration: number, ended: boolean) => void;
  onRestarted: (offset: number) => void;
}) {
  const api = castApi(cast.base);
  const [pos, setPos] = useState(cast.offset);
  const [dur, setDur] = useState(cast.duration ?? 0);
  const [state, setState] = useState('BUFFERING');
  const [volume, setVolume] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [seeking, setSeeking] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const posRef = useRef(pos);
  posRef.current = pos;

  // Follow the TV.
  useEffect(() => {
    if (cast.browser) {
      const b = cast.browser;
      const read = () => {
        const s = b.state();
        if (!s.connected) return;
        setPos(cast.offset + s.time);
        if (cast.duration) setDur(cast.duration);
        else if (s.duration) setDur(cast.offset + s.duration);
        setVolume(s.volume);
        setState(s.playerState ?? (s.paused ? 'PAUSED' : 'PLAYING'));
      };
      read();
      return b.onChange(read);
    }
    let alive = true;
    const tick = async () => {
      try {
        const s = await api.status(cast.id);
        if (!alive) return;
        setPos(s.position);
        if (s.duration) setDur(s.duration);
        setVolume(s.volume);
        setState(s.state);
        setError(s.error);
      } catch (e) {
        if (alive) setError(errorText(e));
      }
    };
    void tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cast.id, cast.offset, cast.browser]);

  // Keep watch progress while the TV plays; a finished episode counts as watched.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (state === 'PLAYING' && dur > 0) onProgress(posRef.current, dur, false);
    }, 15_000);
    return () => window.clearInterval(id);
  }, [state, dur, onProgress]);
  const endedOnce = useRef(false);
  useEffect(() => {
    if (state === 'IDLE' && dur > 0 && posRef.current > dur - 60 && !endedOnce.current) {
      endedOnce.current = true;
      onProgress(dur, dur, true);
    }
  }, [state, dur, onProgress]);

  const playing = state === 'PLAYING';
  const act = async (fn: () => Promise<unknown> | void) => {
    try {
      setBusy(true);
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const seek = (to: number) =>
    act(async () => {
      if (cast.browser) {
        const s = cast.browser.state();
        const available = cast.offset + (s.duration || 0);
        if (to >= cast.offset && to <= available - 2) cast.browser.seek(to - cast.offset);
        else {
          const r = await api.restart(cast.id, to);
          await cast.browser.load(r.url, { duration: dur ? dur - r.offset : null, title, subtitle, image: backdrop, subtitles: true });
          onRestarted(r.offset);
        }
      } else await api.control(cast.id, 'seek', to);
      setPos(to);
    });

  const shown = seeking ?? pos;
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 z-[45] grid place-items-center bg-black">
      {backdrop && <img src={backdrop} alt="" className="absolute inset-0 size-full object-cover opacity-30 blur-md" />}
      <div className="relative w-[min(560px,92vw)] text-center">
        <div className="mx-auto mb-5 grid size-16 place-items-center rounded-full bg-white/10">
          <Cast className="size-7" />
        </div>
        <div className="text-xs font-semibold tracking-[0.2em] text-white/60 uppercase">Playing on {cast.deviceName}</div>
        <h2 className="mt-2 truncate font-display text-2xl font-semibold">{title}</h2>
        {subtitle && <div className="mt-1 truncate text-sm text-white/65">{subtitle}</div>}

        <div className="mt-8">
          <input
            aria-label="Position"
            type="range"
            min={0}
            max={Math.max(1, dur)}
            step={1}
            value={Math.min(shown, Math.max(1, dur))}
            onChange={(e) => setSeeking(Number(e.target.value))}
            onPointerUp={() => {
              if (seeking != null) void seek(seeking);
              setSeeking(null);
            }}
            onKeyUp={() => {
              if (seeking != null) void seek(seeking);
              setSeeking(null);
            }}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/15 [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
            style={{ background: `linear-gradient(90deg, var(--color-progress) ${dur ? (shown / dur) * 100 : 0}%, rgb(255 255 255 / 0.15) 0)` }}
          />
          <div className="mt-2 flex justify-between text-xs text-white/60 tabular-nums">
            <span>{fmtClock(shown)}</span>
            <span>{dur ? fmtClock(dur) : '--:--'}</span>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-center gap-3">
          <button onClick={() => void seek(Math.max(0, pos - 10))} className="glass rounded-full px-4 py-2 text-sm">
            −10s
          </button>
          <button
            onClick={() => void act(() => (cast.browser ? cast.browser.playOrPause() : api.control(cast.id, playing ? 'pause' : 'play')))}
            disabled={busy}
            aria-label={playing ? 'Pause' : 'Play'}
            className="grid size-16 place-items-center rounded-full bg-white text-black transition-transform active:scale-95"
          >
            {state === 'BUFFERING' ? <Loader2 className="size-7 animate-spin" /> : playing ? <Pause className="size-7 fill-current" /> : <Play className="size-7 translate-x-0.5 fill-current" />}
          </button>
          <button onClick={() => void seek(pos + 30)} className="glass rounded-full px-4 py-2 text-sm">
            +30s
          </button>
        </div>

        <div className="mx-auto mt-6 flex max-w-xs items-center gap-3">
          <Volume2 className="size-4 shrink-0 text-white/70" />
          <div className="flex-1">
            <Slider
              label="TV volume"
              value={Math.round(volume * 100)}
              min={0}
              max={100}
              step={2}
              onChange={(v) => {
                setVolume(v / 100);
                void act(() => (cast.browser ? cast.browser.setVolume(v / 100) : api.control(cast.id, 'volume', v / 100)));
              }}
            />
          </div>
        </div>

        {error && <p className="mt-4 text-sm text-bad">{error}</p>}

        <button onClick={() => onStop(pos)} className={cls('mt-8 inline-flex items-center gap-2 rounded-xl bg-white/10 px-5 py-2.5 font-semibold hover:bg-white/15')}>
          <Square className="size-4 fill-current" /> Stop casting
        </button>
      </div>
    </motion.div>
  );
}
