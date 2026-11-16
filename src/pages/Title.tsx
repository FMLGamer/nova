import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  CheckCircle2,
  Download,
  ExternalLink,
  FolderPlus,
  HardDrive,
  Lock,
  MoreHorizontal,
  Play,
  Plus,
  Radio,
  Share2,
  Smartphone,
  Sparkles,
  Star,
  Users,
  Zap,
} from 'lucide-react';
import { api } from '../lib/api';
import { cls, episodeLabel, fmtAirTime, fmtRuntime, itemKeyFor, kindLabel, relTime, watchPath } from '../lib/format';
import { playIntent } from '../lib/intent';
import { offlineSupported, useOffline } from '../lib/offline';
import { useCollections, useContributions, useDetail, useEpisodes, useListToggle, useMediaProgress, usePrefs, useSession } from '../lib/queries';
import { errorText, toast, useApp } from '../lib/store';
import type { CatalogDetail, Episode, Progress } from '../lib/types';
import { PosterCard, Rail } from '../components/media';
import { Trailer } from '../components/Trailer';
import { Avatar, Badge, Button, Chip, Empty, Input, Menu, MenuItem, Modal, Segmented, Spinner } from '../components/ui';

function IconAction({ label, onClick, children, active }: { label: string; onClick?: () => void; children: React.ReactNode; active?: boolean }) {
  return (
    <button onClick={onClick} className="group flex w-16 flex-col items-center gap-1.5 text-[11px] text-muted transition-colors hover:text-fg">
      <span className={cls('grid size-11 place-items-center rounded-full border transition-all group-active:scale-90', active ? 'border-transparent bg-white text-black' : 'border-white/20 bg-black/20 backdrop-blur group-hover:border-white/50')}>
        {children}
      </span>
      {label}
    </button>
  );
}

function CollectionsMenu({ detail }: { detail: CatalogDetail }) {
  const qc = useQueryClient();
  const { data: collections } = useCollections();
  const containing = useQuery({ queryKey: ['containing', detail.id], queryFn: () => api.me.containing(detail.id) });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const toggle = async (id: string, on: boolean) => {
    try {
      if (on) await api.me.removeFromCollection(id, detail.id);
      else await api.me.addToCollection(id, { mediaId: detail.id, mediaType: detail.mediaType, title: detail.title, poster: detail.poster, year: detail.year });
      qc.invalidateQueries({ queryKey: ['containing', detail.id] });
      qc.invalidateQueries({ queryKey: ['collections'] });
    } catch (e) {
      toast(errorText(e), 'bad');
    }
  };
  return (
    <>
      <Menu
        align="left"
        up
        width="w-64"
        trigger={(_o, t) => (
          <IconAction label="Collect" onClick={t} active={Boolean(containing.data?.length)}>
            <FolderPlus className="size-5" />
          </IconAction>
        )}
      >
        {(close) => (
          <>
            {collections?.map((c) => {
              const on = containing.data?.includes(c.id) ?? false;
              return (
                <MenuItem key={c.id} active={on} onClick={() => toggle(c.id, on)}>
                  {c.name}
                </MenuItem>
              );
            })}
            <MenuItem
              icon={<Plus />}
              onClick={() => {
                close();
                setCreating(true);
              }}
            >
              New collection…
            </MenuItem>
          </>
        )}
      </Menu>
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New collection"
        footer={
          <Button
            variant="primary"
            disabled={!name.trim()}
            onClick={async () => {
              const c = await api.me.createCollection({ name: name.trim() });
              await toggle(c.id, false);
              setCreating(false);
              setName('');
              toast(`Added to ${c.name}`, 'ok');
            }}
          >
            Create & add
          </Button>
        }
      >
        <Input autoFocus placeholder="e.g. Rainy Sunday" value={name} onChange={(e) => setName(e.target.value)} />
      </Modal>
    </>
  );
}

function ShareModal({ detail, onClose }: { detail: CatalogDetail; onClose: () => void }) {
  const [days, setDays] = useState('7');
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} title={`Share ${detail.title}`}>
      <p className="text-sm text-muted">Guests get a link that only opens this title — no account needed. It stops working when it expires.</p>
      <div className="mt-4">
        <Segmented
          value={days}
          onChange={setDays}
          options={[
            { value: '1', label: '1 day' },
            { value: '7', label: '1 week' },
            { value: '30', label: '1 month' },
            { value: '0', label: 'Never' },
          ]}
        />
      </div>
      {url ? (
        <div className="mt-5 flex gap-2">
          <Input readOnly value={url} onFocus={(e) => e.target.select()} />
          <Button
            variant="white"
            onClick={() => {
              navigator.clipboard?.writeText(url);
              toast('Link copied', 'ok');
            }}
          >
            Copy
          </Button>
        </div>
      ) : (
        <Button
          className="mt-5 w-full"
          variant="primary"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api.shares.create({ scope: 'title', target: detail.id, label: detail.title, expiresInDays: days === '0' ? null : Number(days) });
              setUrl(r.url);
            } catch (e) {
              toast(errorText(e), 'bad');
            } finally {
              setBusy(false);
            }
          }}
        >
          Create link
        </Button>
      )}
    </Modal>
  );
}

function DownloadMenu({ detail, intentSeason, intentEpisode }: { detail: CatalogDetail; intentSeason: number | null; intentEpisode: number | null }) {
  const { data: session } = useSession();
  const offline = useOffline();
  const qc = useQueryClient();
  const isSeries = detail.mediaType !== 'movie';
  const itemKey = itemKeyFor(detail.id, intentSeason, intentEpisode);
  const job = offline.jobs[itemKey];
  const serverDownloads = session?.settings.downloadsEnabled;

  const toServer = async () => {
    try {
      const s = await api.play.sourcesSync({ mediaId: detail.id, season: intentSeason ?? undefined, episode: intentEpisode ?? undefined });
      const best = s.releases[0];
      if (!best) throw new Error('No source found');
      const d = await api.server.requestDownload(best.id, itemKey, detail.poster);
      toast(d.status === 'pending' ? 'Requested — waiting for an admin to approve' : 'Downloading to the server', 'ok');
      qc.invalidateQueries({ queryKey: ['server-downloads'] });
    } catch (e) {
      toast(errorText(e), 'bad');
    }
  };
  const rule = async (mode: 'new' | 'missing') => {
    try {
      const r = await api.server.saveRule({ mediaId: detail.id, title: detail.title, poster: detail.poster, mode, runNow: true });
      toast(r.queued ? `Auto-download on — ${r.queued} episode${r.queued > 1 ? 's' : ''} queued` : 'Auto-download on for new episodes', 'ok');
    } catch (e) {
      toast(errorText(e), 'bad');
    }
  };

  return (
    <Menu
      align="left"
      up
      width="w-72"
      trigger={(_o, t) => (
        <IconAction label={job ? `${Math.round(job.progress * 100)}%` : 'Save'} onClick={t} active={Boolean(offline.entries.find((e) => e.itemKey === itemKey))}>
          {job ? <Spinner className="size-5 text-current" /> : <Download className="size-5" />}
        </IconAction>
      )}
    >
      {(close) => (
        <>
          {offlineSupported() && (
            <MenuItem
              icon={<Smartphone />}
              hint={isSeries ? episodeLabel(detail.mediaType, intentSeason, intentEpisode) : undefined}
              onClick={() => {
                close();
                if (job) return offline.cancel(itemKey);
                toast('Finding the best copy to save…');
                void offline.saveBest({
                  itemKey,
                  mediaId: detail.id,
                  mediaType: detail.mediaType,
                  title: detail.title,
                  subtitle: episodeLabel(detail.mediaType, intentSeason, intentEpisode, true),
                  poster: detail.poster,
                  season: intentSeason,
                  episode: intentEpisode,
                });
              }}
            >
              {job ? 'Cancel saving' : 'Save on this device'}
            </MenuItem>
          )}
          {serverDownloads && (
            <MenuItem
              icon={<HardDrive />}
              onClick={() => {
                close();
                void toServer();
              }}
            >
              Download to server
            </MenuItem>
          )}
          {serverDownloads && isSeries && (
            <>
              <MenuItem
                icon={<Zap />}
                onClick={() => {
                  close();
                  void rule('new');
                }}
              >
                Auto-download new episodes
              </MenuItem>
              <MenuItem
                icon={<Zap />}
                onClick={() => {
                  close();
                  void rule('missing');
                }}
              >
                Get every missing episode
              </MenuItem>
            </>
          )}
        </>
      )}
    </Menu>
  );
}

function EpisodeRow({ ep, detail, progress, onServer, focused }: { ep: Episode; detail: CatalogDetail; progress?: Progress; onServer: boolean; focused?: boolean }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) rowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focused]);
  const pct = progress?.durationSeconds ? progress.positionSeconds / progress.durationSeconds : 0;
  const watched = progress?.finished || pct > 0.92;
  const upcoming = ep.airDate ? Date.parse(ep.airDate) > Date.now() : false;
  const markWatched = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (watched) await api.progress.remove(ep.id);
    else
      await api.progress.save({
        itemKey: ep.id,
        mediaType: detail.mediaType,
        mediaId: detail.id,
        season: ep.season,
        episode: ep.episode,
        positionSeconds: (ep.runtime ?? 24) * 60,
        durationSeconds: (ep.runtime ?? 24) * 60,
        finished: true,
        title: detail.title,
        poster: detail.poster,
        backdrop: detail.backdrop,
        year: detail.year,
      });
    qc.invalidateQueries({ queryKey: ['media-progress'] });
    qc.invalidateQueries({ queryKey: ['summary'] });
    qc.invalidateQueries({ queryKey: ['continue'] });
  };
  return (
    <motion.div
      ref={rowRef}
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      onClick={() => !upcoming && navigate(watchPath({ mediaId: detail.id, season: ep.season, episode: ep.episode }))}
      className={cls('group flex cursor-pointer gap-4 rounded-2xl p-2.5 transition-colors hover:bg-white/5', upcoming && 'cursor-default opacity-50', focused && 'bg-white/6 ring-1 ring-accent/60')}
    >
      <div className="relative aspect-video w-36 shrink-0 overflow-hidden rounded-xl bg-ink-800 sm:w-52">
        {ep.still ? <img src={ep.still} alt="" loading="lazy" className="size-full object-cover transition-transform duration-300 group-hover:scale-105" /> : <div className="grid size-full place-items-center font-display text-2xl text-faint">{ep.episode}</div>}
        {!upcoming && (
          <div className="absolute inset-0 grid place-items-center bg-black/30 opacity-0 transition-opacity group-hover:opacity-100">
            <span className="grid size-10 place-items-center rounded-full bg-white/95 text-black">
              <Play className="size-4 translate-x-px fill-current" />
            </span>
          </div>
        )}
        {pct > 0 && !watched && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
            <div className="h-full bg-progress" style={{ width: `${pct * 100}%` }} />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 py-1">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-faint">
              {episodeLabel(detail.mediaType, ep.season, ep.episode)}
              {ep.runtime ? ` · ${fmtRuntime(ep.runtime)}` : ''}
              {ep.airDate ? ` · ${upcoming ? 'Airs ' : ''}${new Date(ep.airDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: upcoming ? undefined : 'numeric' })}` : ''}
            </div>
            <div className="mt-0.5 truncate font-semibold">{ep.title}</div>
          </div>
          {onServer && (
            <span title="On your server" className="mt-0.5 text-accent">
              <HardDrive className="size-4" />
            </span>
          )}
          {!upcoming && (
            <button onClick={markWatched} aria-label={watched ? 'Mark unwatched' : 'Mark watched'} className={cls('rounded-full p-1 transition', watched ? 'text-ok' : 'text-faint opacity-0 group-hover:opacity-100 hover:text-fg max-sm:opacity-100')}>
              <CheckCircle2 className="size-5" />
            </button>
          )}
        </div>
        {ep.overview && <p className="mt-1 line-clamp-2 text-sm text-muted max-sm:hidden">{ep.overview}</p>}
      </div>
    </motion.div>
  );
}

function Episodes({ detail, progress, serverEpisodes, initialSeason, focusEpisode }: { detail: CatalogDetail; progress: Progress[]; serverEpisodes: Set<string>; initialSeason: number; focusEpisode: number | null }) {
  const seasons = detail.mediaType === 'anime' ? [] : detail.seasons.filter((s) => s.episodeCount > 0);
  const [season, setSeason] = useState(initialSeason);
  useEffect(() => setSeason(initialSeason), [initialSeason]);
  const { data: episodes, isLoading } = useEpisodes(detail.id, season);
  const [page, setPage] = useState(0);
  const PAGE = 50;
  const list = episodes ?? [];
  const pages = Math.ceil(list.length / PAGE);
  const focus = season === initialSeason ? focusEpisode : null;
  useEffect(() => {
    // Jump to the chunk holding the episode you asked for, or the one you're on.
    const at = focus ?? progress.find((x) => x.season === season || detail.mediaType === 'anime')?.episode;
    const idx = at ? list.findIndex((e) => e.episode === at) : -1;
    if (idx >= 0 && list.length > PAGE) setPage(Math.floor(idx / PAGE));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.length, season, focus]);
  const byKey = useMemo(() => new Map(progress.map((p) => [p.itemKey, p])), [progress]);

  return (
    <section className="px-5 sm:px-10">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="font-display text-2xl font-semibold">Episodes</h2>
        {seasons.length > 1 && (
          <div className="scrollbar-none -mx-1 flex max-w-full gap-1.5 overflow-x-auto px-1">
            {seasons.map((s) => (
              <Chip key={s.season} active={season === s.season} onClick={() => setSeason(s.season)}>
                {s.season === 0 ? 'Specials' : s.name || `Season ${s.season}`}
              </Chip>
            ))}
          </div>
        )}
      </div>
      {pages > 1 && (
        <div className="scrollbar-none mb-3 flex gap-1.5 overflow-x-auto">
          {Array.from({ length: pages }).map((_, i) => (
            <Chip key={i} active={page === i} onClick={() => setPage(i)}>
              {i * PAGE + 1}–{Math.min(list.length, (i + 1) * PAGE)}
            </Chip>
          ))}
        </div>
      )}
      {isLoading && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-4 p-2.5">
              <div className="skeleton aspect-video w-36 rounded-xl sm:w-52" />
              <div className="flex-1 space-y-2 py-2">
                <div className="skeleton h-3 w-24 rounded" />
                <div className="skeleton h-4 w-1/2 rounded" />
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="grid gap-1 lg:grid-cols-2">
        {list.slice(page * PAGE, (page + 1) * PAGE).map((ep) => (
          <EpisodeRow key={ep.id} ep={ep} detail={detail} progress={byKey.get(ep.id)} onServer={serverEpisodes.has(`${ep.season}:${ep.episode}`)} focused={focus === ep.episode} />
        ))}
      </div>
      {!isLoading && !list.length && <p className="text-sm text-muted">No episode list yet.</p>}
    </section>
  );
}

function People({ detail }: { detail: CatalogDetail }) {
  if (detail.characters.length) {
    return (
      <Rail title="Characters & voice actors" wide>
        {detail.characters.map((c) => (
          <div key={c.name} className="flex items-center gap-3 rounded-2xl border border-line bg-white/[0.02] p-2.5">
            {c.image ? <img src={c.image} alt="" loading="lazy" className="size-14 shrink-0 rounded-xl object-cover" /> : <Avatar avatar="slate" name={c.name} className="size-14 rounded-xl" />}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{c.name}</div>
              <div className="truncate text-xs text-faint capitalize">{c.role.toLowerCase()}</div>
              {c.voiceActor && <div className="mt-1 truncate text-xs text-muted">{c.voiceActor}</div>}
            </div>
            {c.voiceActorImage && <img src={c.voiceActorImage} alt="" loading="lazy" className="size-12 shrink-0 rounded-full object-cover" />}
          </div>
        ))}
      </Rail>
    );
  }
  if (!detail.cast.length) return null;
  return (
    <Rail title="Cast" dense>
      {detail.cast.map((c) => (
        <div key={c.name + c.character} className="text-center">
          {c.photo ? <img src={c.photo} alt="" loading="lazy" className="mx-auto aspect-square w-full rounded-full object-cover ring-1 ring-white/10" /> : <Avatar avatar="slate" name={c.name} className="mx-auto aspect-square w-full text-2xl" />}
          <div className="mt-2 truncate text-[13px] font-semibold">{c.name}</div>
          <div className="truncate text-xs text-faint">{c.character}</div>
        </div>
      ))}
    </Rail>
  );
}

const REL_ORDER = ['PREQUEL', 'SEQUEL', 'PARENT', 'SIDE_STORY', 'SPIN_OFF', 'ALTERNATIVE', 'RELATED', 'RECOMMENDATION'];

export function Title() {
  const { type = '', id = '' } = useParams();
  const [search] = useSearchParams();
  const focusEpisode = Number(search.get('e')) || null;
  const focusSeason = focusEpisode ? (type === 'anime' ? 1 : Number(search.get('s')) || 1) : null;
  const mediaId = `${type}:${id}`;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: detail, isLoading, error } = useDetail(mediaId);
  const { data: progress } = useMediaProgress(mediaId);
  const { data: prefs } = usePrefs();
  const { data: session } = useSession();
  const { data: contrib } = useContributions();
  const list = useListToggle();
  const setAmbient = useApp((s) => s.setAmbient);
  const openAssistant = useApp((s) => s.openAssistant);
  const [trailerOn, setTrailerOn] = useState(false);
  const [trailerFailed, setTrailerFailed] = useState(false);
  const [sharing, setSharing] = useState(false);
  const serverFiles = useQuery({ queryKey: ['server-files', mediaId], queryFn: () => api.server.mediaFiles(mediaId), retry: false });
  const airings = useQuery({ queryKey: ['airings', detail?.title], queryFn: () => api.live.airings(detail!.title), enabled: Boolean(detail && session?.settings.liveTvEnabled), retry: false });
  const intent = detail ? playIntent(detail, progress) : null;

  useEffect(() => setAmbient(detail?.backdrop ?? detail?.poster ?? null), [detail?.backdrop, detail?.poster, setAmbient]);
  useEffect(() => {
    setTrailerOn(false);
    setTrailerFailed(false);
    if (!detail?.trailer || prefs?.ui.autoplayPreviews === false) return;
    const t = window.setTimeout(() => setTrailerOn(true), 1600);
    return () => window.clearTimeout(t);
  }, [detail?.trailer, prefs?.ui.autoplayPreviews, mediaId]);

  const serverEpisodes = useMemo(() => new Set((serverFiles.data ?? []).filter((f) => f.episode != null).map((f) => `${f.season ?? 1}:${f.episode}`)), [serverFiles.data]);
  const serverItem = serverFiles.data?.[0]?.itemId;
  const relations = useMemo(
    () => [...(detail?.relations ?? [])].sort((a, b) => REL_ORDER.indexOf(a.relationType) - REL_ORDER.indexOf(b.relationType)),
    [detail?.relations],
  );

  if (isLoading) {
    return (
      <div>
        <div className="skeleton h-[72svh] w-full" />
      </div>
    );
  }
  if (error || !detail) return <Empty title="Couldn't load this title">{errorText(error)}</Empty>;

  const isSeries = detail.mediaType !== 'movie';
  const titleActions = (contrib?.actions ?? []).filter((a) => a.placement === 'title' && (!a.types?.length || a.types.includes(detail.mediaType)));
  const play = (season?: number | null, episode?: number | null, extra?: Record<string, string>) =>
    navigate(watchPath({ mediaId, season: season ?? intent?.season, episode: episode ?? intent?.episode }, extra));

  return (
    <div>
      <section className="relative h-[72svh] min-h-[520px] w-full overflow-hidden">
        <motion.img
          key={detail.backdrop}
          src={detail.backdrop ?? detail.poster ?? undefined}
          alt=""
          initial={{ scale: 1.08, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.7, ease: [0.2, 0, 0, 1] }}
          className="absolute inset-0 size-full object-cover"
        />
        {trailerOn && detail.trailer && !trailerFailed && <Trailer videoKey={detail.trailer.key} onFail={() => setTrailerFailed(true)} />}
        <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/40 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-r from-bg/95 via-bg/40 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 px-5 pb-8 sm:px-10">
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: [0.2, 0, 0, 1] }} className="max-w-3xl">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge>{kindLabel(detail.mediaType)}</Badge>
              {serverFiles.data?.length ? (
                <Badge tone="accent">
                  <HardDrive className="size-3" /> On your server
                </Badge>
              ) : null}
              {detail.status && <span className="text-xs text-white/60">{detail.status.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</span>}
            </div>
            <h1 className="font-display text-[clamp(2.2rem,5.5vw,4.6rem)] leading-[0.98] font-bold text-balance">{detail.title}</h1>
            {detail.tagline && <p className="mt-2 text-lg text-white/70 italic">{detail.tagline}</p>}
            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-white/80">
              {detail.rating != null && detail.rating > 0 && (
                <span className="flex items-center gap-1 font-semibold text-white">
                  <Star className="size-3.5 fill-amber-300 text-amber-300" /> {detail.rating.toFixed(1)}
                </span>
              )}
              {detail.year && <span>{detail.year}</span>}
              {fmtRuntime(detail.runtime) && <span>{fmtRuntime(detail.runtime)}</span>}
              {isSeries && detail.mediaType === 'tv' && detail.seasons.length > 0 && <span>{detail.seasons.filter((s) => s.season > 0).length} seasons</span>}
              {detail.mediaType === 'anime' && detail.totalEpisodes && <span>{detail.totalEpisodes} episodes</span>}
              {detail.genres.slice(0, 4).map((g) => (
                <span key={g} className="rounded-full border border-white/20 px-2.5 py-0.5 text-xs">
                  {g}
                </span>
              ))}
            </div>
            {detail.nextAiring && (
              <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs backdrop-blur">
                <span className="size-1.5 animate-pulse rounded-full bg-ok" /> Episode {detail.nextAiring.episode} airs {relTime(detail.nextAiring.airingAt * 1000)}
              </div>
            )}
            <p className="mt-4 line-clamp-4 max-w-2xl text-[15px] leading-relaxed text-white/80">{detail.overview}</p>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.06 }} className="mt-7 flex flex-wrap items-end gap-x-3 gap-y-4">
            <div className="mr-3">
              <Button size="lg" variant="white" icon={<Play className="size-5 fill-current" />} onClick={() => play()} className="min-w-44">
                {intent?.label ?? 'Play'}
                {intent?.sub && <span className="font-normal text-black/55">· {intent.sub}</span>}
              </Button>
              {intent && intent.progress > 0 && (
                <div className="mx-2 mt-2 h-1 overflow-hidden rounded-full bg-white/20">
                  <div className="h-full rounded-full bg-white" style={{ width: `${intent.progress * 100}%` }} />
                </div>
              )}
            </div>
            <IconAction label="My List" onClick={() => list.toggle(detail)} active={list.has(detail.id)}>
              {list.has(detail.id) ? <Check className="size-5" /> : <Plus className="size-5" />}
            </IconAction>
            <CollectionsMenu detail={detail} />
            <DownloadMenu detail={detail} intentSeason={intent?.season ?? null} intentEpisode={intent?.episode ?? null} />
            <IconAction label="Together" onClick={() => play(undefined, undefined, { room: 'new' })}>
              <Users className="size-5" />
            </IconAction>
            <Menu
              align="left"
              up
              width="w-64"
              trigger={(_o, t) => (
                <IconAction label="More" onClick={t}>
                  <MoreHorizontal className="size-5" />
                </IconAction>
              )}
            >
              {(close) => (
                <>
                  <MenuItem
                    icon={<Share2 />}
                    onClick={() => {
                      close();
                      setSharing(true);
                    }}
                  >
                    Share with a guest
                  </MenuItem>
                  {session?.settings.assistantEnabled && (
                    <MenuItem
                      icon={<Sparkles />}
                      onClick={() => {
                        close();
                        openAssistant({ kind: 'title', id: detail.id, label: detail.title, data: { mediaType: detail.mediaType, year: detail.year } });
                      }}
                    >
                      Ask the assistant
                    </MenuItem>
                  )}
                  {serverItem && (
                    <MenuItem
                      icon={<Lock />}
                      onClick={async () => {
                        close();
                        const items = await api.server.items({ q: detail.title });
                        const it = items.find((x) => x.id === serverItem);
                        const updated = await api.server.setPrivate(serverItem, !(it?.privateMine ?? false)).catch((e) => toast(errorText(e), 'bad'));
                        if (updated) toast(updated.private ? 'Only you can see this on the server now' : 'Visible to everyone again', 'ok');
                        qc.invalidateQueries({ queryKey: ['server-files', mediaId] });
                      }}
                    >
                      Private on the server
                    </MenuItem>
                  )}
                  {detail.malId && (
                    <MenuItem icon={<ExternalLink />} onClick={() => window.open(`https://myanimelist.net/anime/${detail.malId}`, '_blank', 'noopener')}>
                      Open on MyAnimeList
                    </MenuItem>
                  )}
                  {detail.imdbId && (
                    <MenuItem icon={<ExternalLink />} onClick={() => window.open(`https://www.imdb.com/title/${detail.imdbId}/`, '_blank', 'noopener')}>
                      Open on IMDb
                    </MenuItem>
                  )}
                  {titleActions.map((a) => (
                    <MenuItem
                      key={`${a.pluginId}:${a.id}`}
                      icon={<Sparkles />}
                      hint={a.pluginName}
                      onClick={async () => {
                        close();
                        try {
                          const r = await api.plugins.action(a.pluginId, a.id, { mediaId: detail.id, title: detail.title, mediaType: detail.mediaType, ids: { imdb: detail.imdbId, mal: detail.malId } });
                          if (r.toast) toast(r.toast);
                          if (r.navigate) navigate(r.navigate);
                          if (r.openUrl) window.open(r.openUrl, '_blank', 'noopener');
                        } catch (e) {
                          toast(errorText(e), 'bad');
                        }
                      }}
                    >
                      {a.label}
                    </MenuItem>
                  ))}
                </>
              )}
            </Menu>
          </motion.div>
        </div>
      </section>

      <div className="relative z-10 space-y-12 pt-6">
        {isSeries && (
          <Episodes
            detail={detail}
            progress={progress ?? []}
            serverEpisodes={serverEpisodes}
            initialSeason={focusSeason ?? intent?.season ?? (detail.mediaType === 'anime' ? 1 : (detail.seasons.find((s) => s.season >= 1)?.season ?? 1))}
            focusEpisode={focusEpisode}
          />
        )}

        {relations.length > 0 && (
          <Rail title={detail.mediaType === 'anime' ? 'Related' : 'More like this'}>
            {relations.map((r) => (
              <PosterCard
                key={r.id}
                item={{ id: r.id, mediaType: r.id.split(':')[0] as CatalogDetail['mediaType'], title: r.title, year: null, poster: r.poster }}
                hint={r.relationType !== 'RECOMMENDATION' ? r.relationType.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : undefined}
              />
            ))}
          </Rail>
        )}

        <People detail={detail} />

        <section className="grid gap-6 px-5 sm:grid-cols-2 sm:px-10 lg:grid-cols-3">
          {detail.studios.length > 0 && (
            <div>
              <div className="text-xs font-semibold tracking-wider text-faint uppercase">Studio</div>
              <div className="mt-1 text-sm">{detail.studios.join(', ')}</div>
            </div>
          )}
          {airings.data && airings.data.length > 0 && (
            <div className="sm:col-span-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold tracking-wider text-faint uppercase">
                <Radio className="size-3.5" /> On TV soon
              </div>
              <div className="mt-2 space-y-1.5">
                {airings.data.slice(0, 4).map((a) => (
                  <Link key={`${a.channelId}:${a.start}`} to={`/live?c=${encodeURIComponent(a.channelId)}`} className="flex items-center gap-3 rounded-xl p-1.5 text-sm hover:bg-white/5">
                    {a.channelLogo ? <img src={a.channelLogo} alt="" className="h-6 w-10 object-contain" /> : <Radio className="size-4 text-faint" />}
                    <span className="flex-1 truncate">{a.subtitle ?? a.title}</span>
                    <span className="text-xs text-muted">
                      {new Date(a.start * 1000).toLocaleDateString(undefined, { weekday: 'short' })} {fmtAirTime(a.start)} · {a.channelName}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
      <AnimatePresence>{sharing && <ShareModal detail={detail} onClose={() => setSharing(false)} />}</AnimatePresence>
    </div>
  );
}
