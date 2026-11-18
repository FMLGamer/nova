import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { History, Maximize, PictureInPicture2, Play, Radio, Search, Star, Volume2, VolumeX } from 'lucide-react';
import { api } from '../lib/api';
import { cls, fmtAirTime } from '../lib/format';
import { pageLayout } from '../lib/layout';
import { usePrefs, useSession } from '../lib/queries';
import { errorText, toast } from '../lib/store';
import type { Channel, LivePlay, Programme } from '../lib/types';
import { Spotlight } from '../components/Hero';
import { Button, Chip, Empty, Spinner } from '../components/ui';

type Destroyable = { destroy: () => void };

/** Plays a live URL: HLS via hls.js, MPEG-TS via mpegts.js, falling back to the server remux then transcode. */
export function LiveVideo({ play, className, muted, onError }: { play: LivePlay; className?: string; muted?: boolean; onError?: (msg: string) => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [stage, setStage] = useState<'native' | 'remux' | 'transcode'>('native');
  const [loading, setLoading] = useState(true);
  useEffect(() => setStage('native'), [play.url]);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    let inst: Destroyable | null = null;
    let cancelled = false;
    setLoading(true);
    const fail = () => {
      if (cancelled) return;
      if (stage === 'native') setStage('remux');
      else if (stage === 'remux') setStage('transcode');
      else onError?.('This channel will not play right now.');
    };
    v.onerror = fail;
    v.onplaying = () => setLoading(false);
    (async () => {
      if (stage === 'remux') v.src = play.remux;
      else if (stage === 'transcode') v.src = play.transcode;
      else if (play.type === 'hls') {
        if (v.canPlayType('application/vnd.apple.mpegurl')) v.src = play.url;
        else {
          const { default: Hls } = await import('hls.js');
          if (cancelled) return;
          if (!Hls.isSupported()) return fail();
          const hls = new Hls({
            lowLatencyMode: true,
            xhrSetup: (xhr) => {
              xhr.withCredentials = true;
            },
          });
          hls.on(Hls.Events.ERROR, (_e, d) => d.fatal && fail());
          hls.loadSource(play.url);
          hls.attachMedia(v);
          inst = hls;
        }
      } else {
        const mpegts = (await import('mpegts.js')).default;
        if (cancelled) return;
        if (!mpegts.isSupported()) return fail();
        const p = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: play.url, withCredentials: true }, { enableStashBuffer: false, liveBufferLatencyChasing: true });
        p.on(mpegts.Events.ERROR, fail);
        p.attachMediaElement(v);
        p.load();
        inst = p;
      }
      v.play().catch(() => undefined);
    })();
    return () => {
      cancelled = true;
      inst?.destroy();
      v.removeAttribute('src');
      v.load();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play.url, stage]);

  return (
    <div className="relative size-full">
      <video ref={ref} autoPlay playsInline muted={muted} className={cls('size-full bg-black object-contain', className)} />
      {loading && (
        <div className="absolute inset-0 grid place-items-center">
          <Spinner className="size-8 text-white" />
        </div>
      )}
    </div>
  );
}

const HOUR_PX = 260;

export default function Live() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const { data: session } = useSession();
  const channels = useQuery({ queryKey: ['live-channels'], queryFn: () => api.live.channels() });
  const { data: prefs } = usePrefs();
  const [windowStart] = useState(() => {
    const d = new Date();
    d.setMinutes(d.getMinutes() < 30 ? 0 : 30, 0, 0);
    return Math.floor(d.getTime() / 1000) - 3600;
  });
  const windowEnd = windowStart + 9 * 3600;
  const guide = useQuery({ queryKey: ['live-guide', windowStart], queryFn: () => api.live.guide(windowStart, windowEnd), staleTime: 10 * 60_000 });
  const [group, setGroup] = useState<string>('favorites');
  const [q, setQ] = useState('');
  const [now, setNow] = useState(() => Date.now() / 1000);
  const [muted, setMuted] = useState(false);
  const [play, setPlay] = useState<(LivePlay & { channel: Channel; catchup?: Programme }) | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const selectedId = params.get('c');

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now() / 1000), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const byEpg = useMemo(() => {
    const m = new Map<string, Programme[]>();
    for (const p of guide.data?.programmes ?? []) m.set(p.epgId, [...(m.get(p.epgId) ?? []), p]);
    for (const list of m.values()) list.sort((a, b) => a.start - b.start);
    return m;
  }, [guide.data]);
  const groupOf = (c: Channel) => {
    const g = c.group?.split(';')[0]?.trim();
    return g && g.toLowerCase() !== 'undefined' ? g : null;
  };
  const groups = useMemo(() => [...new Set((channels.data ?? []).map(groupOf).filter(Boolean) as string[])].sort(), [channels.data]);
  const hasFavs = (channels.data ?? []).some((c) => c.favorite);
  const activeGroup = group === 'favorites' && !hasFavs ? 'all' : group;
  const visible = (channels.data ?? []).filter(
    (c) => (activeGroup === 'all' || (activeGroup === 'favorites' ? c.favorite : groupOf(c) === activeGroup)) && (!q || c.name.toLowerCase().includes(q.toLowerCase())),
  );
  const onNow = (c: Channel) => (c.epgId ? byEpg.get(c.epgId)?.find((p) => p.start <= now && p.stop > now) : undefined);
  // Something airing right now on a favourite (or any) channel, preferring programmes with artwork.
  const spotlight = useMemo(() => {
    const list = channels.data ?? [];
    const t = Date.now() / 1000;
    const favs = list.filter((c) => c.favorite);
    const airing = (favs.length ? favs : list)
      .slice(0, 300)
      .map((c) => ({ c, p: c.epgId ? byEpg.get(c.epgId)?.find((x) => x.start <= t && x.stop > t) : undefined }))
      .filter((x) => x.p);
    const withArt = airing.filter((x) => x.p!.image);
    const pool = withArt.length ? withArt : airing;
    if (pool.length) return pool[Math.floor(Math.random() * pool.length)]!;
    const first = favs[0] ?? list[0];
    return first ? { c: first, p: undefined } : null;
  }, [channels.data, byEpg]);

  const tune = async (c: Channel, catchup?: Programme) => {
    try {
      const p = catchup ? await api.live.catchup(c.id, catchup.start, catchup.stop) : await api.live.play(c.id);
      setPlay({ ...p, channel: c, catchup });
      setParams({ c: c.id }, { replace: true });
      stage.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
      toast(errorText(e), 'bad');
    }
  };

  useEffect(() => {
    if (play || !channels.data?.length) return;
    const c = channels.data.find((x) => x.id === selectedId) ?? (selectedId ? undefined : visible[0]);
    if (c) void tune(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels.data, selectedId]);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = ((now - windowStart) / 3600) * HOUR_PX - 120;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guide.isSuccess]);

  if (channels.isLoading) return <div className="grid min-h-[70vh] place-items-center"><Spinner className="size-7" /></div>;
  if (!channels.data?.length) {
    return (
      <div className="pt-28">
        <Empty icon={<Radio />} title="No channels yet" action={session?.account.isAdmin ? <Link to="/admin/live" className="rounded-xl bg-white px-4 py-2 font-semibold text-black">Add a TV source</Link> : undefined}>
          Connect an M3U playlist, Xtream login, HDHomeRun tuner, or pick free channels from the public directory.
        </Empty>
      </div>
    );
  }

  const current = play ? onNow(play.channel) : undefined;
  const nextUp = play?.channel.epgId ? byEpg.get(play.channel.epgId)?.find((p) => p.start >= now) : undefined;
  const hours = Array.from({ length: 9 }, (_, i) => windowStart + i * 3600);

  const banner = pageLayout('live', prefs);
  const showSpotlight = spotlight && banner.hero;

  return (
    <div className={showSpotlight ? '' : 'pt-24 sm:pt-28'}>
      {showSpotlight && (
        <Spotlight
          size={banner.heroSize}
          backdrop={spotlight.p?.image}
          art={spotlight.c.logo}
          eyebrow={
            <span className="flex items-center gap-2">
              <span className="size-1.5 animate-pulse rounded-full bg-red-500" /> {spotlight.p ? 'On now' : 'Live'} · {spotlight.c.name}
            </span>
          }
          title={spotlight.p?.title ?? spotlight.c.name}
          meta={
            spotlight.p ? (
              <span>
                {fmtAirTime(spotlight.p.start)} – {fmtAirTime(spotlight.p.stop)}
                {spotlight.p.category ? ` · ${spotlight.p.category}` : ''}
              </span>
            ) : (
              spotlight.c.group && <span>{spotlight.c.group}</span>
            )
          }
          description={spotlight.p?.description ?? spotlight.p?.subtitle}
          actions={
            <Button variant="white" icon={<Play className="size-5 fill-current" />} onClick={() => tune(spotlight.c)}>
              Watch now
            </Button>
          }
        />
      )}
      <div ref={stage} className="relative z-10 grid scroll-mt-24 gap-6 px-5 sm:px-10 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="group relative aspect-video overflow-hidden rounded-3xl bg-black shadow-2xl ring-1 ring-white/10">
          {play ? <LiveVideo key={play.url} play={play} muted={muted} onError={(m) => toast(m, 'bad')} /> : <div className="grid size-full place-items-center"><Spinner /></div>}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end gap-3 bg-gradient-to-t from-black/80 to-transparent p-4 opacity-0 transition-opacity group-hover:opacity-100">
            <div className="flex-1" />
            <button onClick={() => setMuted((m) => !m)} aria-label={muted ? 'Unmute' : 'Mute'} className="pointer-events-auto grid size-10 place-items-center rounded-full bg-black/40 backdrop-blur hover:bg-black/60">
              {muted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
            </button>
            <button onClick={() => stage.current?.querySelector('video')?.requestPictureInPicture().catch(() => undefined)} aria-label="Picture in picture" className="pointer-events-auto grid size-10 place-items-center rounded-full bg-black/40 backdrop-blur hover:bg-black/60">
              <PictureInPicture2 className="size-5" />
            </button>
            <button onClick={() => stage.current?.querySelector('.aspect-video')?.requestFullscreen().catch(() => undefined)} aria-label="Fullscreen" className="pointer-events-auto grid size-10 place-items-center rounded-full bg-black/40 backdrop-blur hover:bg-black/60">
              <Maximize className="size-5" />
            </button>
          </div>
          {play?.catchup && <span className="absolute top-4 left-4 rounded-full bg-black/60 px-3 py-1 text-xs backdrop-blur">Catch-up · {fmtAirTime(play.catchup.start)}</span>}
          {!play?.catchup && play && (
            <span className="absolute top-4 left-4 flex items-center gap-1.5 rounded-full bg-red-600 px-2.5 py-0.5 text-[11px] font-bold tracking-wider uppercase">
              <span className="size-1.5 animate-pulse rounded-full bg-white" /> Live
            </span>
          )}
        </div>
        <AnimatePresence mode="wait">
          {play && (
            <motion.div key={play.channel.id} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="flex flex-col lg:h-0 lg:min-h-full">
              <div className="flex items-center gap-3">
                {play.channel.logo ? <img src={play.channel.logo} alt="" className="h-12 w-16 object-contain" /> : <Radio className="size-8 text-muted" />}
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-faint">{play.channel.number ? `${play.channel.number} · ` : ''}{play.channel.group}</div>
                  <div className="truncate font-display text-xl font-semibold">{play.channel.name}</div>
                </div>
                <button
                  onClick={async () => {
                    await api.live.favorite(play.channel.id, !play.channel.favorite);
                    setPlay({ ...play, channel: { ...play.channel, favorite: !play.channel.favorite } });
                    qc.invalidateQueries({ queryKey: ['live-channels'] });
                  }}
                  aria-label="Favourite"
                  className="grid size-10 place-items-center rounded-full hover:bg-white/8"
                >
                  <Star className={cls('size-5', play.channel.favorite && 'fill-amber-300 text-amber-300')} />
                </button>
              </div>
              {(play.catchup ?? current) && (
                <div className="mt-5">
                  <div className="text-xs font-semibold tracking-wider text-accent uppercase">{play.catchup ? 'Catch-up' : 'On now'}</div>
                  <div className="mt-1 text-lg font-semibold">{(play.catchup ?? current)!.title}</div>
                  {(play.catchup ?? current)!.subtitle && <div className="text-sm text-muted">{(play.catchup ?? current)!.subtitle}</div>}
                  {!play.catchup && current && (
                    <div className="mt-2 flex items-center gap-2 text-xs text-faint tabular-nums">
                      {fmtAirTime(current.start)}
                      <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
                        <div className="h-full bg-red-500" style={{ width: `${((now - current.start) / (current.stop - current.start)) * 100}%` }} />
                      </div>
                      {fmtAirTime(current.stop)}
                    </div>
                  )}
                  {(play.catchup ?? current)!.description && <p className="mt-3 line-clamp-5 text-sm leading-relaxed text-muted">{(play.catchup ?? current)!.description}</p>}
                </div>
              )}
              {nextUp && !play.catchup && (
                <div className="mt-5 rounded-2xl border border-line p-3">
                  <div className="text-xs text-faint">Next · {fmtAirTime(nextUp.start)}</div>
                  <div className="truncate text-sm font-semibold">{nextUp.title}</div>
                </div>
              )}
              {!current && !play.catchup && (
                <div className="mt-5 min-h-0 flex-1 overflow-y-auto">
                  <div className="mb-2 text-xs font-semibold tracking-wider text-faint uppercase">Zap to</div>
                  {visible
                    .filter((c) => c.id !== play.channel.id)
                    .slice(0, 8)
                    .map((c) => (
                      <button key={c.id} onClick={() => tune(c)} className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left text-sm hover:bg-white/6">
                        {c.logo ? <img src={c.logo} alt="" loading="lazy" className="h-6 w-9 object-contain" /> : <Radio className="size-4 text-faint" />}
                        <span className="truncate">{c.name}</span>
                      </button>
                    ))}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="mt-10 px-5 sm:px-10">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h2 className="mr-auto font-display text-2xl font-semibold">Guide</h2>
          <label className="glass flex h-9 items-center gap-2 rounded-full px-3">
            <Search className="size-4 text-faint" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a channel" className="w-36 bg-transparent text-sm focus:outline-none" />
          </label>
        </div>
        <div className="scrollbar-none -mx-5 mb-4 flex gap-2 overflow-x-auto px-5 sm:-mx-10 sm:px-10">
          {hasFavs && (
            <Chip active={activeGroup === 'favorites'} onClick={() => setGroup('favorites')}>
              <Star className="size-3.5" /> Favourites
            </Chip>
          )}
          <Chip active={activeGroup === 'all'} onClick={() => setGroup('all')}>
            All channels
          </Chip>
          {groups.map((g) => (
            <Chip key={g} active={activeGroup === g} onClick={() => setGroup(g)}>
              {g}
            </Chip>
          ))}
        </div>

        <div className="overflow-hidden rounded-3xl border border-line">
          <div ref={scroller} className="max-h-[70vh] overflow-auto">
            <div className="relative" style={{ width: 200 + hours.length * HOUR_PX }}>
              <div className="sticky top-0 z-20 flex border-b border-line bg-bg/90 backdrop-blur">
                <div className="sticky left-0 z-10 w-[200px] shrink-0 bg-bg/95" />
                {hours.map((h) => (
                  <div key={h} className="shrink-0 border-l border-line px-2 py-2 text-xs text-faint tabular-nums" style={{ width: HOUR_PX }}>
                    {fmtAirTime(h)}
                  </div>
                ))}
              </div>
              <div className="pointer-events-none absolute top-0 bottom-0 z-10 w-0.5 bg-red-500" style={{ left: 200 + ((now - windowStart) / 3600) * HOUR_PX }} />
              {visible.map((c) => {
                const progs = c.epgId ? (byEpg.get(c.epgId) ?? []) : [];
                const active = play?.channel.id === c.id;
                return (
                  <div key={c.id} className={cls('flex h-16 border-b border-line', active && 'bg-white/[0.04]')}>
                    <button onClick={() => tune(c)} className={cls('sticky left-0 z-10 flex w-[200px] shrink-0 items-center gap-3 border-r border-line px-3 text-left backdrop-blur', active ? 'bg-ink-700/95' : 'bg-bg/95 hover:bg-ink-800/95')}>
                      {c.logo ? <img src={c.logo} alt="" loading="lazy" className="h-8 w-11 shrink-0 object-contain" /> : <Radio className="size-5 shrink-0 text-faint" />}
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{c.name}</span>
                        {c.catchup && (
                          <span className="flex items-center gap-1 text-[10px] text-faint">
                            <History className="size-3" /> Catch-up
                          </span>
                        )}
                      </span>
                    </button>
                    <div className="relative flex-1">
                      {progs.map((p) => {
                        const left = Math.max(0, ((p.start - windowStart) / 3600) * HOUR_PX);
                        const right = Math.min(hours.length * HOUR_PX, ((p.stop - windowStart) / 3600) * HOUR_PX);
                        if (right <= 0 || left >= hours.length * HOUR_PX) return null;
                        const live = p.start <= now && p.stop > now;
                        const past = p.stop <= now;
                        const canCatch = past && c.catchup;
                        return (
                          <button
                            key={`${p.start}`}
                            onClick={() => (live ? tune(c) : canCatch ? tune(c, p) : toast(`${p.title} — ${new Date(p.start * 1000).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`))}
                            title={p.description ?? p.title}
                            className={cls(
                              'absolute top-1 bottom-1 overflow-hidden rounded-xl border px-2.5 py-1.5 text-left transition-colors',
                              live ? 'border-accent/40 bg-accent/15 hover:bg-accent/25' : past ? 'border-transparent bg-white/[0.03] text-faint hover:bg-white/[0.06]' : 'border-line bg-white/[0.05] hover:bg-white/10',
                            )}
                            style={{ left: left + 2, width: Math.max(8, right - left - 4) }}
                          >
                            <div className="truncate text-[13px] font-medium">{p.title}</div>
                            <div className="truncate text-[11px] text-faint">
                              {fmtAirTime(p.start)}
                              {canCatch ? ' · Watch' : ''}
                            </div>
                          </button>
                        );
                      })}
                      {!progs.length && (
                        <div className="absolute inset-y-1 left-0.5 right-0.5 rounded-xl border border-line bg-white/[0.03]">
                          <span className="sticky left-[208px] inline-block px-3 py-2.5 text-[13px] text-muted">{c.name} · no guide information</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
