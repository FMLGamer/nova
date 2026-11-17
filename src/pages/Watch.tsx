import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, X } from 'lucide-react';
import { api } from '../lib/api';
import { connectEngine, enginePrepare } from '../lib/engine';
import { browserTorrent } from '../lib/webtorrent';
import { episodeLabel, itemKeyFor, titlePath, watchPath } from '../lib/format';
import { offlineUrl } from '../lib/offline';
import { useDetail, useEpisodes, usePrefs, useSession } from '../lib/queries';
import { errorText, toast } from '../lib/store';
import type { MediaFile, PlaySource, Release, RoomTarget, SourceSearch } from '../lib/types';
import { Player, videoCodecPlayable, type Playable } from '../components/player/Player';
import { SourcePicker } from '../components/player/SourcePicker';
import { Spinner } from '../components/ui';

function toPlayable(s: PlaySource, label: string | null): Playable {
  return { src: [s.kind, s.a, s.b].filter((x) => x != null && x !== '').join('/'), path: s.path, name: s.name, mime: s.mime, size: s.size, label };
}

/** TORRENT_MODE=client: this device streams the torrent (the Nova app if it's running, else the browser). */
async function clientPlayable(s: PlaySource, label: string | null, port: number, itemKey: string, title: string | null): Promise<Playable> {
  const engine = await connectEngine(port, { pair: true, onAsk: () => toast('Allow streaming in the Nova app on this computer') });
  if (engine) {
    const local = await enginePrepare(engine, s.torrent!, 'video', itemKey, title);
    return { ...toPlayable(local, [label, 'this computer'].filter(Boolean).join(' · ')), api: engine.root };
  }
  toast('Nova app not found on this computer: trying to stream in the browser (works for fewer torrents)');
  const b = await browserTorrent(s.torrent!);
  return { src: '', path: b.url, blobUrl: b.url, name: b.name, mime: s.mime, size: b.size, label: 'In your browser' };
}

function releaseLabel(r: Release): string {
  return [r.quality, r.source === 'webdl' ? 'WEB-DL' : r.source?.toUpperCase(), r.pluginName].filter(Boolean).join(' · ');
}

/** Runs the plugin source search as Server-Sent Events. */
function useSourceSearch(url: string | null) {
  const [state, setState] = useState<SourceSearch | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setState(null);
    setError(null);
    if (!url) return;
    const es = new EventSource(url, { withCredentials: true });
    es.addEventListener('update', (e) => setState(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('done', (e) => {
      setState(JSON.parse((e as MessageEvent).data));
      es.close();
    });
    es.addEventListener('error', (e) => {
      const data = (e as MessageEvent).data;
      if (data) setError(JSON.parse(data).error);
      setState((s) => (s ? { ...s, done: true } : { id: '', done: true, noDub: false, runs: [], releases: [], context: { title: '', year: null, kind: '', ids: {} } }));
      es.close();
    });
    return () => es.close();
  }, [url]);
  return { state, error };
}

export default function Watch() {
  const { type = '', id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const mediaId = `${type}:${id}`;
  const isAnime = type === 'anime';
  const isMovie = type === 'movie';
  const season = isMovie ? null : isAnime ? 1 : Number(params.get('s') ?? 1);
  const episode = isMovie ? null : Number(params.get('e') ?? 1);
  const itemKey = itemKeyFor(mediaId, season, episode);
  const roomParam = params.get('room');
  const roomCode = roomParam && roomParam !== 'new' ? roomParam : null;
  const [wantRoom, setWantRoom] = useState(roomParam === 'new');

  const { data: detail } = useDetail(mediaId);
  const { data: prefs } = usePrefs();
  const { data: session } = useSession();
  const { data: episodes } = useEpisodes(isMovie ? null : mediaId, season ?? 1);
  const nextSeasonEps = useEpisodes(!isMovie && !isAnime && detail?.seasons.some((s) => s.season === (season ?? 1) + 1) ? mediaId : null, (season ?? 1) + 1);

  const [playable, setPlayable] = useState<Playable | null>(null);
  const [phase, setPhase] = useState<'init' | 'pick' | 'preparing' | 'play'>('init');
  const [picker, setPicker] = useState(false);
  const [currentRelease, setCurrentRelease] = useState<string | null>(null);
  const [startAt, setStartAt] = useState(0);
  const [prepError, setPrepError] = useState<string | null>(null);
  const autoPicked = useRef(false);
  const searchStarted = useRef(Date.now());
  const sourceLinkRef = useRef<string | null>(null);
  const itemKeyRef = useRef(itemKey);
  itemKeyRef.current = itemKey;
  const titleRef = useRef<string | null>(null);
  titleRef.current = detail?.title ?? null;
  const [tick, setTick] = useState(0);

  const progressQ = useQuery({ queryKey: ['progress-item', itemKey], queryFn: () => api.progress.get(itemKey), staleTime: 0 });
  const filesQ = useQuery({ queryKey: ['server-files', mediaId], queryFn: () => api.server.mediaFiles(mediaId), retry: false });
  const files: MediaFile[] = useMemo(
    () =>
      (filesQ.data ?? []).filter((f) => (isMovie ? true : f.episode === episode && (isAnime || f.season == null || f.season === season)) && (f.kind === 'video' || /video/.test(f.mime ?? ''))),
    [filesQ.data, isMovie, isAnime, episode, season],
  );

  const roomQ = useQuery({ queryKey: ['room', roomCode], queryFn: () => api.rooms.get(roomCode!), enabled: Boolean(roomCode), retry: false });

  // HEVC only fits when this browser can decode it (or the server converts video for this account).
  const unplayable = !session?.settings.transcodingEnabled && !videoCodecPlayable('hevc') ? 'h265' : undefined;
  const sourcesUrl = roomCode ? null : api.play.sourcesUrl({ mediaId, season: season ?? undefined, episode: episode ?? undefined, unplayable });
  const search = useSourceSearch(phase === 'init' || playable?.blobUrl ? null : sourcesUrl);

  // Reset when the episode changes.
  useEffect(() => {
    setPlayable(null);
    setPhase('init');
    setPicker(false);
    setCurrentRelease(null);
    setPrepError(null);
    autoPicked.current = false;
    searchStarted.current = Date.now();
  }, [itemKey]);

  const prepare = useCallback(
    async (fn: () => Promise<{ source: PlaySource; label: string | null; releaseId?: string }>) => {
      setPhase('preparing');
      setPicker(false);
      setPrepError(null);
      try {
        const { source, label, releaseId } = await fn();
        setCurrentRelease(releaseId ?? null);
        if (source.kind === 'c' && source.torrent) {
          const cfg = await qc.fetchQuery({ queryKey: ['app-config'], queryFn: api.system.config, staleTime: Infinity });
          setPlayable(await clientPlayable(source, label, cfg.enginePort, itemKeyRef.current, titleRef.current));
        } else setPlayable(toPlayable(source, label));
        setPhase('play');
        sourceLinkRef.current = source.link || null;
      } catch (e) {
        setPrepError(errorText(e));
        setPhase('pick');
        setPicker(true);
      }
    },
    [],
  );

  const pickRelease = useCallback(
    (r: Release) =>
      prepare(async () => {
        const res = await api.play.prepare({ releaseId: r.id, itemKey, title: detail?.title ?? null });
        return { source: res.source, label: releaseLabel(r), releaseId: r.id };
      }),
    [prepare, itemKey, detail?.title],
  );
  const pickFile = useCallback(
    (f: MediaFile) =>
      prepare(async () => ({ source: await api.server.fileSource(f.id), label: 'On your server' })),
    [prepare],
  );

  // Decide how to start: room → offline copy → last source → server file → picker / auto.
  useEffect(() => {
    if (phase !== 'init' || !progressQ.isFetched) return;
    let cancelled = false;
    (async () => {
      const prog = progressQ.data;
      const resume = prog && !prog.finished && prog.positionSeconds > 5 ? prog.positionSeconds : 0;
      setStartAt(resume);
      if (roomCode) return;
      const blob = await offlineUrl(itemKey);
      if (cancelled) return;
      if (blob) {
        setPlayable({ src: '', path: blob, blobUrl: blob, name: 'Offline copy', mime: 'video/mp4', size: 0, label: 'Offline copy' });
        setPhase('play');
        return;
      }
      if (prog?.sourceLink?.startsWith('magnet:') && resume > 0) {
        void prepare(async () => {
          const res = await api.play.prepare({ link: prog.sourceLink!, itemKey, title: detail?.title ?? null });
          return { source: res.source, label: 'Last source' };
        });
        return;
      }
      setPhase('pick');
      setPicker(true);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, progressQ.isFetched, itemKey, roomCode]);

  // Rooms play exactly what the host prepared.
  useEffect(() => {
    const room = roomQ.data;
    if (!room) return;
    if (room.target.mediaId !== mediaId || room.target.itemKey !== itemKey) {
      navigate(watchPath({ mediaId: room.target.mediaId, season: room.target.season, episode: room.target.episode }, { room: room.code }), { replace: true });
      return;
    }
    setPlayable({ src: room.target.src, path: room.target.path, name: room.target.title, mime: 'video/mp4', size: 0, label: 'Room' });
    setPhase('play');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomQ.data]);
  useEffect(() => {
    if (roomQ.error) toast('That room has closed', 'bad');
  }, [roomQ.error]);

  // Auto-select: server copy instantly, otherwise the top release once the search settles.
  useEffect(() => {
    if (phase !== 'pick' || autoPicked.current || !prefs?.ui.autoSelectSource || prepError) return;
    if (files[0]) {
      autoPicked.current = true;
      void pickFile(files[0]);
      return;
    }
    const s = search.state;
    const best = s?.releases[0];
    if (!best) return;
    const waited = Date.now() - searchStarted.current;
    if (s.done || (best.tier === 0 && waited > 6000) || best.cached) {
      autoPicked.current = true;
      void pickRelease(best);
    } else {
      const t = window.setTimeout(() => setTick((x) => x + 1), Math.max(200, 6500 - waited));
      return () => window.clearTimeout(t);
    }
  }, [phase, search.state, files, prefs?.ui.autoSelectSource, prepError, pickFile, pickRelease, tick]);

  const nextEp = useMemo(() => {
    if (isMovie || !episodes) return null;
    const idx = episodes.findIndex((e) => e.episode === episode);
    const n = idx >= 0 ? episodes[idx + 1] : undefined;
    const now = Date.now();
    if (n && (!n.airDate || Date.parse(n.airDate) <= now)) return { season: n.season, episode: n.episode, title: n.title, still: n.still };
    if (isAnime) return null;
    const first = nextSeasonEps.data?.[0];
    if (first && (!first.airDate || Date.parse(first.airDate) <= now)) return { season: first.season, episode: first.episode, title: first.title, still: first.still };
    return null;
  }, [episodes, episode, isMovie, isAnime, nextSeasonEps.data]);
  const currentEp = episodes?.find((e) => e.episode === episode);

  const go = (s: number | null, e: number) => navigate(watchPath({ mediaId, season: s, episode: e }, roomCode ? { room: roomCode } : undefined), { replace: true });
  const back = () => (window.history.length > 1 ? navigate(-1) : navigate(titlePath(mediaId)));

  const saveProgress = useCallback(
    (position: number, duration: number, finished: boolean) => {
      void api.progress
        .save({
          itemKey,
          mediaType: type,
          mediaId,
          season,
          episode,
          positionSeconds: position,
          durationSeconds: duration,
          finished,
          title: detail?.title ?? null,
          poster: detail?.poster ?? null,
          backdrop: detail?.backdrop ?? null,
          year: detail?.year ?? null,
          sourceLink: sourceLinkRef.current,
        })
        .then(() => {
          qc.invalidateQueries({ queryKey: ['continue'] });
          qc.invalidateQueries({ queryKey: ['media-progress'] });
          qc.invalidateQueries({ queryKey: ['summary'] });
          if (finished) qc.invalidateQueries({ queryKey: ['upnext'] });
        })
        .catch(() => undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [itemKey, detail],
  );

  const onServerDownload = session?.settings.downloadsEnabled
    ? async (r: Release) => {
        try {
          const d = await api.server.requestDownload(r.id, itemKey, detail?.poster ?? null);
          toast(d.status === 'pending' ? 'Requested — an admin will approve it' : 'Downloading to the server', 'ok');
        } catch (e) {
          toast(errorText(e), 'bad');
        }
      }
    : undefined;

  const title = detail?.title ?? '';
  const epLabel = episodeLabel(type, season, episode, true);

  return (
    <div className="fixed inset-0 bg-black">
      {playable && phase === 'play' && (
        <Player
          key={`${itemKey}:${playable.path}`}
          playable={playable}
          title={title}
          mediaId={mediaId}
          mediaType={type}
          season={season}
          episode={episode}
          episodeTitle={currentEp?.title}
          itemKey={itemKey}
          detail={detail}
          episodes={episodes ?? []}
          next={nextEp}
          startAt={startAt}
          roomCode={roomCode}
          wantRoom={wantRoom}
          onStartRoom={() => setWantRoom(true)}
          onRoomCreated={(code) => {
            const p = new URLSearchParams(params);
            p.set('room', code);
            setParams(p, { replace: true });
            setWantRoom(false);
          }}
          onRoomTarget={(t: RoomTarget) => navigate(watchPath({ mediaId: t.mediaId, season: t.season, episode: t.episode }, { room: roomCode ?? '' }), { replace: true })}
          onBack={back}
          onNext={() => nextEp && go(nextEp.season, nextEp.episode)}
          onEpisode={(s, e) => go(s, e)}
          onSources={() => setPicker(true)}
          onProgress={saveProgress}
        />
      )}

      {/* backdrop while choosing / preparing */}
      {(phase !== 'play' || !playable) && (
        <div className="absolute inset-0">
          {detail?.backdrop && <img src={detail.backdrop} alt="" className="absolute inset-0 size-full scale-110 object-cover opacity-50 blur-2xl" />}
          <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-black/30" />
        </div>
      )}

      {phase === 'preparing' && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex flex-col items-center gap-4 text-center">
            <Spinner className="size-10 text-white" />
            <div className="font-display text-xl font-semibold">{title}</div>
            <div className="text-sm text-muted">{epLabel ? `${epLabel} · ` : ''}Getting it ready…</div>
          </div>
        </div>
      )}

      {phase === 'init' && (
        <div className="absolute inset-0 grid place-items-center">
          <Spinner className="size-10 text-white" />
        </div>
      )}

      <AnimatePresence>
        {picker && (phase === 'pick' || phase === 'play') && !roomCode && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 z-[70] overflow-y-auto bg-black/70 backdrop-blur-xl">
            <div className="mx-auto max-w-3xl px-5 pt-6 pb-16 sm:pt-12">
              <div className="mb-6 flex items-start gap-3">
                <button
                  onClick={() => (playable && phase === 'play' ? setPicker(false) : back())}
                  aria-label={playable ? 'Close' : 'Back'}
                  className="grid size-11 shrink-0 place-items-center rounded-full hover:bg-white/10"
                >
                  {playable ? <X className="size-6" /> : <ArrowLeft className="size-6" />}
                </button>
                <div className="min-w-0 flex-1 pt-1">
                  <h1 className="font-display text-3xl font-bold">{title}</h1>
                  <div className="mt-1 text-muted">{[epLabel, currentEp?.title].filter(Boolean).join(' · ') || (detail?.year ?? '')}</div>
                </div>
              </div>
              {prepError && <div className="mb-4 rounded-xl bg-bad/10 px-4 py-3 text-sm text-bad">{prepError}</div>}
              {search.error && <div className="mb-4 rounded-xl bg-bad/10 px-4 py-3 text-sm text-bad">{search.error}</div>}
              <SourcePicker
                runs={search.state?.runs ?? []}
                releases={search.state?.releases ?? []}
                done={search.state?.done ?? false}
                noDub={search.state?.noDub ?? false}
                files={files}
                current={currentRelease}
                onPick={pickRelease}
                onPickFile={pickFile}
                onServerDownload={onServerDownload}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
