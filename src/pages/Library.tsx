import { motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart3,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  FileDown,
  FolderHeart,
  HardDrive,
  Heart,
  ListChecks,
  Pin,
  Play,
  Plus,
  RotateCw,
  Smartphone,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { api } from '../lib/api';
import { cls, episodeLabel, fmtAirTime, fmtBytes, fmtSpeed, relTime, titlePath, watchPath } from '../lib/format';
import { useOffline } from '../lib/offline';
import { useCollections, useMyList, useSession } from '../lib/queries';
import { errorText, toast } from '../lib/store';
import type { CalendarEntry, Collection } from '../lib/types';
import { PosterCard } from '../components/media';
import { Badge, Button, Empty, Input, Modal, Progress, Segmented, Spinner } from '../components/ui';
import { Stats, TrackerLists } from './LibraryExtras';

const TABS = [
  { id: '', label: 'My List', icon: Heart },
  { id: 'collections', label: 'Collections', icon: FolderHeart },
  { id: 'anime-lists', label: 'Anime & manga', icon: ListChecks },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'downloads', label: 'Downloads', icon: Download },
  { id: 'history', label: 'History', icon: Clock },
  { id: 'stats', label: 'Stats', icon: BarChart3 },
];

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-x-4 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(168px,1fr))]">{children}</div>;
}

function MyList() {
  const { data, isLoading } = useMyList();
  if (isLoading) return <Spinner />;
  if (!data?.length) return <Empty icon={<Heart />} title="Nothing saved yet">Tap + on anything you want to come back to. It'll wait for you here.</Empty>;
  return (
    <Grid>
      {data.map((e) => (
        <PosterCard key={e.mediaId} item={{ id: e.mediaId, mediaType: e.mediaType, title: e.title ?? 'Untitled', year: e.year, poster: e.poster }} />
      ))}
    </Grid>
  );
}

export function CollectionTile({ c }: { c: Collection }) {
  const qc = useQueryClient();
  const covers = c.items.slice(0, 4);
  return (
    <Link to={`/collection/${c.id}`} className="group block">
      <div className="relative grid aspect-square grid-cols-2 grid-rows-2 gap-0.5 overflow-hidden rounded-3xl bg-ink-800 ring-1 ring-white/8 transition-[translate,box-shadow] duration-200 group-hover:-translate-y-1 group-hover:ring-white/20">
        {covers.map((i) => (i.poster ? <img key={i.mediaId} src={i.poster} alt="" loading="lazy" className="size-full object-cover" /> : <div key={i.mediaId} className="bg-ink-700" />))}
        {covers.length < 4 && Array.from({ length: 4 - covers.length }).map((_, i) => <div key={i} className="bg-gradient-to-br from-ink-700 to-ink-800" />)}
        <button
          onClick={async (e) => {
            e.preventDefault();
            await api.me.updateCollection(c.id, { pinned: !c.pinned });
            qc.invalidateQueries({ queryKey: ['collections'] });
            toast(c.pinned ? 'Unpinned from Home' : 'Pinned to Home', 'ok');
          }}
          aria-label={c.pinned ? 'Unpin from Home' : 'Pin to Home'}
          className={cls('absolute top-2.5 right-2.5 grid size-8 place-items-center rounded-full backdrop-blur transition', c.pinned ? 'bg-white text-black' : 'bg-black/50 text-white opacity-0 group-hover:opacity-100')}
        >
          <Pin className="size-4" />
        </button>
      </div>
      <div className="mt-2.5 px-0.5">
        <div className="truncate font-semibold">{c.name}</div>
        <div className="text-xs text-faint">{c.count} titles</div>
      </div>
    </Link>
  );
}

function Collections() {
  const { data, isLoading } = useCollections();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  return (
    <>
      <div className="mb-6 flex justify-end">
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
          New collection
        </Button>
      </div>
      {isLoading && <Spinner />}
      {!isLoading && !data?.length && <Empty icon={<FolderHeart />} title="Make your first collection">Group anything — a director's films, comfort shows, a reading list — and pin it to Home.</Empty>}
      <div className="grid grid-cols-2 gap-5 sm:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
        {data?.map((c) => <CollectionTile key={c.id} c={c} />)}
      </div>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New collection"
        footer={
          <Button
            variant="primary"
            disabled={!name.trim()}
            onClick={async () => {
              await api.me.createCollection({ name: name.trim(), pinned: true });
              qc.invalidateQueries({ queryKey: ['collections'] });
              setOpen(false);
              setName('');
            }}
          >
            Create
          </Button>
        }
      >
        <Input autoFocus placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <p className="mt-2 text-xs text-faint">New collections are pinned to your Home screen. Add titles from any title page.</p>
      </Modal>
    </>
  );
}

function startOfWeek(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

function CalendarView() {
  const [view, setView] = useState<'week' | 'month'>('week');
  const [scope, setScope] = useState<'followed' | 'list' | 'watching'>('followed');
  const [anchor, setAnchor] = useState(() => new Date());
  const range = useMemo(() => {
    if (view === 'week') {
      const s = startOfWeek(anchor);
      const e = new Date(s);
      e.setDate(e.getDate() + 7);
      return [s, e] as const;
    }
    const s = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
    const e = new Date(s);
    e.setDate(e.getDate() + 42);
    return [s, e] as const;
  }, [view, anchor]);
  const { data, isLoading } = useQuery({
    queryKey: ['calendar', scope, range[0].getTime(), range[1].getTime()],
    queryFn: () => api.me.calendar(Math.floor(range[0].getTime() / 1000), Math.floor(range[1].getTime() / 1000), scope),
  });
  const days = Array.from({ length: view === 'week' ? 7 : 42 }, (_, i) => {
    const d = new Date(range[0]);
    d.setDate(d.getDate() + i);
    return d;
  });
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const entriesOn = (d: Date) => (data ?? []).filter((e) => sameDay(new Date(e.airsAt * 1000), d));
  const shift = (n: number) => {
    const d = new Date(anchor);
    if (view === 'week') d.setDate(d.getDate() + n * 7);
    else d.setMonth(d.getMonth() + n);
    setAnchor(d);
  };
  const today = new Date();

  const Entry = ({ e, compact }: { e: CalendarEntry; compact?: boolean }) => (
    <Link to={titlePath(e.mediaId)} className={cls('flex items-center gap-2 rounded-xl transition-colors hover:bg-white/8', compact ? 'p-1' : 'p-1.5')}>
      {e.poster && <img src={e.poster} alt="" className={cls('shrink-0 rounded-md object-cover', compact ? 'h-8 w-6' : 'h-14 w-10')} />}
      <div className="min-w-0">
        <div className={cls('truncate font-semibold', compact ? 'text-[11px]' : 'text-[13px]')}>{e.title}</div>
        <div className="truncate text-[11px] text-faint">
          {episodeLabel(e.mediaType, e.season, e.episode)}
          {!e.allDay && ` · ${fmtAirTime(e.airsAt)}`}
        </div>
      </div>
    </Link>
  );

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="mr-auto flex items-center gap-1">
          <button onClick={() => shift(-1)} aria-label="Previous" className="grid size-9 place-items-center rounded-full hover:bg-white/8">
            <ChevronLeft className="size-5" />
          </button>
          <button onClick={() => setAnchor(new Date())} className="min-w-40 font-display text-lg font-semibold">
            {view === 'week'
              ? `${range[0].toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${new Date(range[1].getTime() - 86400000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
              : anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
          </button>
          <button onClick={() => shift(1)} aria-label="Next" className="grid size-9 place-items-center rounded-full hover:bg-white/8">
            <ChevronRight className="size-5" />
          </button>
        </div>
        <Segmented size="sm" value={scope} onChange={setScope} options={[{ value: 'followed', label: 'Following' }, { value: 'list', label: 'My List' }, { value: 'watching', label: 'Watching' }]} />
        <Segmented size="sm" value={view} onChange={setView} options={[{ value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} />
      </div>
      {isLoading && <Spinner />}
      {view === 'week' ? (
        <div className="grid gap-2 sm:grid-cols-7">
          {days.map((d) => {
            const list = entriesOn(d);
            const isToday = sameDay(d, today);
            return (
              <div key={d.toISOString()} className={cls('min-h-32 rounded-2xl border p-2', isToday ? 'border-accent/40 bg-accent/[0.06]' : 'border-line bg-white/[0.02]')}>
                <div className="mb-1 flex items-baseline justify-between px-1">
                  <span className={cls('text-sm font-semibold', isToday && 'text-gradient')}>{d.toLocaleDateString(undefined, { weekday: 'short' })}</span>
                  <span className="text-xs text-faint">{d.getDate()}</span>
                </div>
                {list.map((e) => (
                  <Entry key={`${e.mediaId}:${e.season}:${e.episode}`} e={e} />
                ))}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="grid grid-cols-7 gap-1">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
            <div key={d} className="px-2 pb-1 text-xs font-semibold text-faint">
              {d}
            </div>
          ))}
          {days.map((d) => {
            const list = entriesOn(d);
            const other = d.getMonth() !== anchor.getMonth();
            return (
              <div key={d.toISOString()} className={cls('min-h-24 rounded-xl border p-1', sameDay(d, today) ? 'border-accent/50' : 'border-line', other && 'opacity-40')}>
                <div className="px-1 text-xs text-muted">{d.getDate()}</div>
                {list.slice(0, 3).map((e) => (
                  <Entry key={`${e.mediaId}:${e.season}:${e.episode}`} e={e} compact />
                ))}
                {list.length > 3 && <div className="px-1 text-[10px] text-faint">+{list.length - 3} more</div>}
              </div>
            );
          })}
        </div>
      )}
      {!isLoading && !data?.length && <p className="mt-6 text-center text-sm text-muted">Nothing airing in this range. Follow a show by adding it to My List or watching an episode.</p>}
    </div>
  );
}

function Downloads() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: session } = useSession();
  const offline = useOffline();
  const server = useQuery({ queryKey: ['server-downloads'], queryFn: () => api.server.downloads(), refetchInterval: 4000, enabled: Boolean(session?.settings.downloadsEnabled) });
  const missing = useQuery({ queryKey: ['missing'], queryFn: api.server.missing, enabled: Boolean(session?.settings.downloadsEnabled), staleTime: 10 * 60_000 });
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => api.server.rules() });
  const jobs = Object.values(offline.jobs);
  const act = async (fn: () => Promise<unknown>, msg?: string) => {
    try {
      await fn();
      if (msg) toast(msg, 'ok');
      qc.invalidateQueries({ queryKey: ['server-downloads'] });
      qc.invalidateQueries({ queryKey: ['rules'] });
      qc.invalidateQueries({ queryKey: ['missing'] });
    } catch (e) {
      toast(errorText(e), 'bad');
    }
  };

  return (
    <div className="space-y-12">
      <section>
        <h2 className="mb-4 flex items-center gap-2 font-display text-xl font-semibold">
          <Smartphone className="size-5 text-accent" /> On this device
        </h2>
        {jobs.map((j) => (
          <div key={j.itemKey} className="mb-2 flex items-center gap-4 rounded-2xl border border-line p-3">
            <Spinner className="size-5" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{j.title}</div>
              <Progress value={j.progress} className="mt-2" />
            </div>
            <span className="text-xs text-muted tabular-nums">{j.phase === 'finding' ? 'Finding…' : `${Math.round(j.progress * 100)}%`}</span>
            <button onClick={() => offline.cancel(j.itemKey)} aria-label="Cancel" className="rounded-full p-2 text-muted hover:bg-white/8 hover:text-fg">
              <X className="size-4" />
            </button>
          </div>
        ))}
        {!offline.entries.length && !jobs.length && <p className="text-sm text-muted">Save episodes and movies from their page or the player to watch them without a connection.</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          {offline.entries.map((e) => (
            <div key={e.itemKey} className="group flex items-center gap-3 rounded-2xl border border-line p-2.5">
              {e.poster ? <img src={e.poster} alt="" className="h-16 w-11 shrink-0 rounded-lg object-cover" /> : <div className="h-16 w-11 rounded-lg bg-white/5" />}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{e.title}</div>
                <div className="truncate text-xs text-faint">{[e.subtitle, fmtBytes(e.size)].filter(Boolean).join(' · ')}</div>
              </div>
              <button
                onClick={() => (e.kind === 'video' ? navigate(watchPath({ mediaId: e.mediaId, season: e.season, episode: e.episode })) : navigate(`/reader?key=${encodeURIComponent(e.itemKey)}`))}
                aria-label="Play"
                className="grid size-9 place-items-center rounded-full bg-white text-black"
              >
                <Play className="size-4 fill-current" />
              </button>
              <button onClick={() => offline.remove(e.itemKey)} aria-label="Delete" className="grid size-9 place-items-center rounded-full text-muted hover:bg-white/8 hover:text-bad">
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
        </div>
      </section>

      {session?.settings.downloadsEnabled && (
        <section>
          <h2 className="mb-4 flex items-center gap-2 font-display text-xl font-semibold">
            <HardDrive className="size-5 text-accent" /> On the server
          </h2>
          {!server.data?.length && <p className="text-sm text-muted">Nothing queued. Download any release to the server from the player's source list.</p>}
          <div className="space-y-2">
            {server.data?.map((d) => (
              <div key={d.id} className="flex items-center gap-4 rounded-2xl border border-line p-3">
                {d.poster ? <img src={d.poster} alt="" className="h-14 w-10 shrink-0 rounded-lg object-cover" /> : <div className="h-14 w-10 rounded-lg bg-white/5" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold">{d.title}</span>
                    {d.episode != null && <span className="text-xs text-faint">{episodeLabel(d.kind, d.season, d.episode)}</span>}
                    {d.ruleId && <Zap className="size-3.5 text-accent" />}
                  </div>
                  <div className="truncate text-xs text-faint">{d.release.title}</div>
                  {d.status === 'downloading' && <Progress value={d.progress} className="mt-2" />}
                </div>
                <div className="hidden text-right text-xs text-muted sm:block">
                  <Badge tone={d.status === 'completed' ? 'ok' : d.status === 'failed' ? 'bad' : d.status === 'pending' ? 'warn' : 'default'}>{d.status}</Badge>
                  <div className="mt-1 tabular-nums">{d.status === 'downloading' ? `${Math.round(d.progress * 100)}% · ${fmtSpeed(d.speed)}` : fmtBytes(d.release.sizeBytes)}</div>
                </div>
                {d.status === 'failed' && (
                  <button onClick={() => act(() => api.server.retry(d.id))} aria-label="Retry" className="rounded-full p-2 text-muted hover:bg-white/8 hover:text-fg">
                    <RotateCw className="size-4" />
                  </button>
                )}
                {d.status !== 'completed' && (
                  <button onClick={() => act(() => api.server.cancel(d.id))} aria-label="Cancel" className="rounded-full p-2 text-muted hover:bg-white/8 hover:text-bad">
                    <X className="size-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {missing.data && missing.data.length > 0 && (
        <section>
          <h2 className="mb-1 font-display text-xl font-semibold">Missing episodes</h2>
          <p className="mb-4 text-sm text-muted">Aired episodes of shows you follow that aren't on the server yet.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {missing.data.map((m) => (
              <div key={m.mediaId} className="flex items-center gap-3 rounded-2xl border border-line p-2.5">
                {m.poster && <img src={m.poster} alt="" className="h-16 w-11 shrink-0 rounded-lg object-cover" />}
                <div className="min-w-0 flex-1">
                  <Link to={titlePath(m.mediaId)} className="block truncate text-sm font-semibold hover:underline">
                    {m.title}
                  </Link>
                  <div className="text-xs text-faint">
                    {m.missing.length} missing · {m.have}/{m.aired} on server
                  </div>
                  <div className="mt-1 truncate text-[11px] text-muted">
                    {m.missing
                      .slice(0, 6)
                      .map((e) => episodeLabel(m.mediaId.split(':')[0]!, e.season, e.episode))
                      .join(', ')}
                    {m.missing.length > 6 ? '…' : ''}
                  </div>
                </div>
                <Button size="sm" variant="white" icon={<Zap className="size-3.5" />} onClick={() => act(() => api.server.saveRule({ mediaId: m.mediaId, title: m.title, poster: m.poster, mode: 'missing', runNow: true }), 'Fetching every missing episode')}>
                  Get all
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      {rules.data && rules.data.length > 0 && (
        <section>
          <h2 className="mb-4 flex items-center gap-2 font-display text-xl font-semibold">
            <Zap className="size-5 text-accent" /> Auto-download
          </h2>
          <div className="space-y-2">
            {rules.data.map((r) => (
              <div key={r.id} className="flex items-center gap-3 rounded-2xl border border-line p-2.5">
                {r.poster && <img src={r.poster} alt="" className="h-12 w-8 shrink-0 rounded-md object-cover" />}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{r.title}</div>
                  <div className="text-xs text-faint">
                    {r.mode === 'new' ? 'New episodes as they air' : 'Everything missing'}
                    {r.lastCheckedAt ? ` · checked ${relTime(r.lastCheckedAt)}` : ''}
                  </div>
                </div>
                <button onClick={() => act(() => api.server.deleteRule(r.id), 'Rule removed')} aria-label="Remove rule" className="rounded-full p-2 text-muted hover:bg-white/8 hover:text-bad">
                  <Trash2 className="size-4" />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function History() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['history'], queryFn: () => api.me.history(0, 200) });
  const groups = useMemo(() => {
    const m = new Map<string, NonNullable<typeof data>>();
    for (const h of data ?? []) {
      const d = new Date(h.updatedAt.includes('T') ? h.updatedAt : `${h.updatedAt.replace(' ', 'T')}Z`);
      const key = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
      m.set(key, [...(m.get(key) ?? []), h]);
    }
    return [...m.entries()];
  }, [data]);
  return (
    <div>
      <div className="mb-6 flex flex-wrap justify-end gap-2">
        <a href={api.me.exportUrl()} download>
          <Button variant="glass" icon={<FileDown className="size-4" />}>
            Export my data
          </Button>
        </a>
        <Button
          variant="danger"
          icon={<Trash2 className="size-4" />}
          onClick={async () => {
            if (!confirm('Clear your whole watch history?')) return;
            await api.me.clearHistory();
            qc.invalidateQueries();
          }}
        >
          Clear history
        </Button>
      </div>
      {isLoading && <Spinner />}
      {!isLoading && !data?.length && <Empty icon={<Clock />} title="No history yet">What you watch shows up here, newest first.</Empty>}
      <div className="space-y-8">
        {groups.map(([day, items]) => (
          <section key={day}>
            <h3 className="mb-2 text-sm font-semibold text-muted">{day}</h3>
            <div className="space-y-1">
              {items.map((h) => (
                <Link key={h.itemKey} to={watchPath({ mediaId: h.mediaId, season: h.season, episode: h.episode })} className="flex items-center gap-3 rounded-2xl p-2 transition-colors hover:bg-white/5">
                  <div className="relative h-14 w-24 shrink-0 overflow-hidden rounded-lg bg-ink-800">
                    {(h.backdrop ?? h.poster) && <img src={h.backdrop ?? h.poster ?? ''} alt="" loading="lazy" className="size-full object-cover" />}
                    <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
                      <div className="h-full bg-progress" style={{ width: `${h.finished ? 100 : h.durationSeconds ? (h.positionSeconds / h.durationSeconds) * 100 : 0}%` }} />
                    </div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{h.title}</div>
                    <div className="text-xs text-faint">{[episodeLabel(h.mediaType, h.season, h.episode), h.finished ? 'Finished' : null].filter(Boolean).join(' · ')}</div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export default function Library() {
  const { tab = '' } = useParams();
  return (
    <div className="px-5 pt-24 sm:px-10 sm:pt-28">
      <h1 className="font-display text-4xl font-bold tracking-tight sm:text-6xl">Your library</h1>
      <nav className="scrollbar-none -mx-5 mt-6 mb-8 flex gap-1 overflow-x-auto px-5 sm:mx-0 sm:px-0">
        {TABS.map((t) => (
          <NavLink key={t.id} to={`/library${t.id ? `/${t.id}` : ''}`} end className="relative shrink-0 rounded-full px-4 py-2 text-sm font-medium">
            {({ isActive }) => (
              <>
                {isActive && <motion.span layoutId="lib-tab" className="absolute inset-0 rounded-full bg-white" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
                <span className={cls('relative flex items-center gap-2', isActive ? 'text-black' : 'text-muted hover:text-fg')}>
                  <t.icon className="size-4" /> {t.label}
                </span>
              </>
            )}
          </NavLink>
        ))}
      </nav>
      <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        {tab === '' && <MyList />}
        {tab === 'collections' && <Collections />}
        {tab === 'anime-lists' && <TrackerLists />}
        {tab === 'calendar' && <CalendarView />}
        {tab === 'downloads' && <Downloads />}
        {tab === 'history' && <History />}
        {tab === 'stats' && <Stats />}
      </motion.div>
    </div>
  );
}
