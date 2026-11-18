import '../../lib/reading-fonts';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  AudioLines,
  Camera,
  Captions,
  Cast,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Gauge,
  Languages,
  ListVideo,
  Maximize,
  MessageCircle,
  Minimize,
  Moon,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  Settings2,
  SkipForward,
  Sparkles,
  Users,
  Volume1,
  Volume2,
  VolumeX,
  WandSparkles,
  X,
} from 'lucide-react';
import { api } from '../../lib/api';
import { desktop, publicImage, setPresence } from '../../lib/desktop';
import { cls, episodeLabel, fmtBytes, fmtClock, fmtSpeed, langName, matchesLanguage } from '../../lib/format';
import { useOffline } from '../../lib/offline';
import { useContributions, useEpisodes, usePrefs, useSavePrefs, useSession } from '../../lib/queries';
import { errorText, toast } from '../../lib/store';
import type { CatalogDetail, Episode, MediaTracks, RoomState, RoomTarget, SubtitleOption } from '../../lib/types';
import { Segmented, Slider, Spinner, Switch } from '../ui';
import { useEnhancer, type EnhanceMode } from './enhance';
import { useAssRenderer } from './ass';
import { useRoom } from './room';
import { cueStyle, cuesAt, useSubtitleTrack, type SubtitleSource } from './subtitles';
import { CastDevices, CastRemote, type ActiveCast, type CastPick } from './Cast';
import { eventKey, shortcutMap } from './shortcuts';
import { browserCast, castApi, type CastSubtitle } from '../../lib/cast';

export interface Playable {
  /** "t/<hash>/<idx>" | "l/<id>" | "u/<token>" — empty for offline copies. */
  src: string;
  path: string;
  name: string;
  mime: string;
  size: number;
  blobUrl?: string;
  label?: string | null;
  /** Set when the Nova app on this computer streams it: base for /api/play calls. */
  api?: string;
}

export interface PlayerProps {
  playable: Playable;
  title: string;
  mediaId: string;
  mediaType: string;
  season: number | null;
  episode: number | null;
  episodeTitle?: string | null;
  itemKey: string;
  detail?: CatalogDetail;
  episodes: Episode[];
  next: { season: number | null; episode: number; title: string; still: string | null; label?: string } | null;
  startAt: number;
  roomCode: string | null;
  wantRoom: boolean;
  onRoomCreated: (code: string) => void;
  onStartRoom: () => void;
  onRoomTarget: (t: RoomTarget) => void;
  onBack: () => void;
  onNext: () => void;
  onEpisode: (season: number | null, episode: number) => void;
  onSources: () => void;
  onProgress: (position: number, duration: number, finished: boolean) => void;
}

type Mode = 'direct' | 'remux' | 'transcode';
type Panel = 'episodes' | 'subtitles' | 'audio' | 'settings' | 'room' | 'cast' | null;

const BROWSER_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'mp2']);
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'stl']);
const SLEEP = [0, 15, 30, 45, 60, 90, -1];

export function videoCodecPlayable(codec: string): boolean {
  const c = codec.toLowerCase();
  if (c === 'h264' || c === 'vp9' || c === 'vp8' || c === 'av1') return true;
  if (c === 'hevc' || c === 'h265') {
    return typeof MediaSource !== 'undefined' && (MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"') || MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L93.B0"'));
  }
  return false;
}

function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <motion.div
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 900, damping: 60 }}
      onClick={(e) => e.stopPropagation()}
      className="glass-strong wco-top absolute right-3 bottom-24 z-40 flex w-[min(400px,calc(100%-1.5rem))] flex-col overflow-hidden rounded-3xl shadow-2xl max-sm:top-auto max-sm:right-0 max-sm:bottom-0 max-sm:max-h-[70%] max-sm:w-full max-sm:rounded-b-none"
    >
      <div className="flex items-center justify-between px-5 pt-4 pb-2">
        <h3 className="font-display text-lg font-semibold">{title}</h3>
        <button onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-full text-muted hover:bg-white/10 hover:text-fg">
          <X className="size-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-4">{children}</div>
    </motion.div>
  );
}

function Option({ active, onClick, children, hint }: { active?: boolean; onClick: () => void; children: ReactNode; hint?: ReactNode }) {
  return (
    <button onClick={onClick} className={cls('flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors', active ? 'bg-white/12 text-fg' : 'text-fg/85 hover:bg-white/6')}>
      <span className={cls('size-2 shrink-0 rounded-full', active ? 'bg-gradient-accent' : 'bg-white/15')} />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-xs text-faint">{hint}</span>}
    </button>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <div className="px-3 pt-4 pb-1.5 text-[11px] font-semibold tracking-wider text-faint uppercase">{children}</div>;
}

export function Player(p: PlayerProps) {
  const { playable } = p;
  const { data: prefs } = usePrefs();
  const savePrefs = useSavePrefs();
  const { data: session } = useSession();
  const { data: contrib } = useContributions();
  const offline = useOffline();
  const transcodeAllowed = Boolean(session?.settings.transcodingEnabled);
  const isOffline = Boolean(playable.blobUrl);

  const box = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  // Must stay the same function: a new ref callback each render detaches and reattaches the
  // element, which tore down everything keyed on it (the subtitle renderer) several times a second.
  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    setVideoEl(el);
  }, []);
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);

  const [mode, setMode] = useState<Mode>(() => (transcodeAllowed && prefs?.ui.transcode && !isOffline ? 'transcode' : 'direct'));
  const [offset, setOffset] = useState(() => (mode !== 'direct' ? p.startAt : 0));
  const [audioTrack, setAudioTrack] = useState<number | null>(null);
  const [height, setHeight] = useState(prefs?.ui.transcodeHeight ?? 720);
  const [tracks, setTracks] = useState<MediaTracks | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [t, setT] = useState(p.startAt);
  const [videoDuration, setVideoDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(() => Number(localStorage.getItem('nova.volume') ?? 1));
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(prefs?.ui.playbackSpeed ?? 1);
  const [fullscreen, setFullscreen] = useState(false);
  const [chrome, setChrome] = useState(true);
  // HDR screens (where HDR video, or RTX Video HDR, outshines plain white) get high-contrast controls.
  const [hdrScreen, setHdrScreen] = useState(() => typeof matchMedia === 'function' && matchMedia('(dynamic-range: high)').matches);
  useEffect(() => {
    const mq = matchMedia('(dynamic-range: high)');
    const on = () => setHdrScreen(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const [panel, setPanel] = useState<Panel>(null);
  const seasons = (p.detail?.seasons ?? []).filter((s) => s.episodeCount > 0 || s.season === p.season);
  const [epSeason, setEpSeason] = useState(p.season ?? 1);
  const otherSeason = useEpisodes(p.mediaType === 'tv' && epSeason !== (p.season ?? 1) ? p.mediaId : null, epSeason);
  const panelEpisodes = epSeason === (p.season ?? 1) ? p.episodes : (otherSeason.data ?? []).filter((e) => e.season === epSeason);
  const episodeScrolled = useRef(false);
  useEffect(() => {
    if (panel === 'episodes') return;
    episodeScrolled.current = false;
    setEpSeason(p.season ?? 1);
  }, [panel, p.season]);
  const [flash, setFlash] = useState<{ id: number; icon: ReactNode } | null>(null);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const [enhance, setEnhance] = useState<EnhanceMode>((prefs?.ui.enhance as EnhanceMode) ?? 'none');
  const [sleepAt, setSleepAt] = useState<number | null>(null);
  const [sleepEnd, setSleepEnd] = useState(false);
  const [stillThere, setStillThere] = useState(false);
  const [nextDismissed, setNextDismissed] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [subDelay, setSubDelay] = useState(0);
  const [subChoice, setSubChoice] = useState<SubtitleSource | null>(null);
  const [subSecondary, setSubSecondary] = useState<SubtitleSource | null>(null);
  const [osResults, setOsResults] = useState<SubtitleOption[] | null>(null);
  const [osLoading, setOsLoading] = useState(false);
  const [chatText, setChatText] = useState('');
  const [cast, setCast] = useState<ActiveCast | null>(null);
  const [castBusy, setCastBusy] = useState<string | null>(null);
  const subPicked = useRef(false);
  const hoverChrome = useRef(false);
  const hideTimer = useRef<number>(0);
  const suppress = useRef(0);
  const resumeApplied = useRef(false);
  const lastSaved = useRef(0);

  const piped = mode !== 'direct' && !isOffline;
  const knownDuration = tracks?.duration ?? (p.detail?.runtime ? p.detail.runtime * 60 : 0);
  const duration = piped ? knownDuration || videoDuration + offset : videoDuration || knownDuration;
  const time = piped ? offset + t : t;
  const timeRef = useRef(time);
  timeRef.current = time;
  const durRef = useRef(duration);
  durRef.current = duration;

  const videoSrc = useMemo(() => {
    if (playable.blobUrl) return playable.blobUrl;
    const track = audioTrack ?? 0;
    if (mode === 'remux') return `${playable.path}/audio?track=${track}&start=${offset.toFixed(1)}`;
    if (mode === 'transcode') return `${playable.path}/transcode?height=${height}&track=${track}&start=${offset.toFixed(1)}`;
    return playable.path;
  }, [playable, mode, audioTrack, offset, height]);

  // -------------------------------------------------------------- probe
  useEffect(() => {
    if (isOffline || !playable.src) return;
    let cancelled = false;
    let tries = 0;
    let timer = 0;
    const probe = () =>
      api.play
        .tracks(playable.src, playable.api)
        .then((tr) => {
          if (cancelled) return;
          if (tr.audio.length || tr.video || tries >= 4) setTracks(tr);
          else timer = window.setTimeout(probe, 6000 * ++tries);
        })
        .catch(() => {
          if (!cancelled && tries++ < 4) timer = window.setTimeout(probe, 6000 * tries);
          else if (!cancelled) setTracks({ video: null, audio: [], subtitles: [], duration: null });
        });
    probe();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [playable.src, isOffline]);

  // Proactive compatibility: unplayable audio would play silently, unplayable video would show black.
  const compatChecked = useRef(false);
  useEffect(() => {
    if (!tracks || compatChecked.current || isOffline) return;
    compatChecked.current = true;
    const audio = tracks.audio.find((a) => a.default) ?? tracks.audio[0];
    const videoOk = !tracks.video || videoCodecPlayable(tracks.video.codec);
    // Dual-audio files: switch to the first language you asked for that the file has.
    const wanted = (p.mediaType === 'anime' ? prefs?.anime.audioLanguages : prefs?.torrent.preferredLanguages) ?? [];
    const preferred = tracks.audio.length > 1 ? wanted.map((l) => tracks.audio.find((a) => matchesLanguage(l, a.language, a.title))).find(Boolean) : undefined;
    if (preferred && preferred !== audio && videoOk) {
      switchMode(mode === 'transcode' ? 'transcode' : 'remux', { track: preferred.index });
      return;
    }
    const audioOk = !audio || BROWSER_AUDIO.has(audio.codec.toLowerCase());
    if (!videoOk && mode !== 'transcode' && transcodeAllowed) switchMode('transcode');
    // E-AC-3, AC-3, DTS, TrueHD...: browsers play the picture in silence, so convert the audio.
    else if (!audioOk && mode === 'direct') switchMode('remux');
    else if (!videoOk && mode !== 'transcode') toast(`This release is ${tracks.video!.codec.toUpperCase()}, which your browser may not play. Pick another source if it stays black.`, 'bad');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks]);

  // Safety net for files whose audio the probe couldn't read: if a few seconds of
  // playback decoded no audio at all, the browser can't play this codec.
  useEffect(() => {
    if (mode !== 'direct' || isOffline || !playing || (tracks && !tracks.audio.length)) return;
    const id = window.setTimeout(() => {
      const v = videoRef.current as (HTMLVideoElement & { webkitAudioDecodedByteCount?: number }) | null;
      if (v && !v.paused && v.webkitAudioDecodedByteCount === 0 && v.currentTime > 2) switchMode('remux');
    }, 4000);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, playing, tracks, isOffline]);

  const switchMode = useCallback(
    (m: Mode, opts?: { track?: number | null; height?: number }) => {
      const at = timeRef.current;
      setMode(m);
      if (opts && 'track' in opts) setAudioTrack(opts.track ?? null);
      if (opts?.height) setHeight(opts.height);
      setOffset(m === 'direct' ? 0 : at);
      if (m === 'direct') resumeApplied.current = false;
      setT(m === 'direct' ? at : 0);
      setStarted(false);
      setWaiting(true);
    },
    [],
  );

  // -------------------------------------------------------------- transport
  const poke = useCallback(() => {
    setChrome(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!videoRef.current?.paused && !hoverChrome.current) setChrome(false);
    }, 2800);
  }, []);

  const showFlash = (icon: ReactNode) => setFlash({ id: Date.now(), icon });

  const room = useRoom(
    p.roomCode,
    (s: RoomState, by, reason) => {
      const v = videoRef.current;
      if (!v) return;
      suppress.current = Date.now();
      if (Math.abs(s.position - timeRef.current) > 1.5) seekTo(s.position, false);
      if (s.rate !== v.playbackRate) v.playbackRate = s.rate;
      if (s.playing && v.paused) v.play().catch(() => undefined);
      if (!s.playing && !v.paused) v.pause();
      if (by && reason && reason !== 'join' && reason !== 'tick') toast(`${by} ${reason === 'seek' ? 'skipped' : s.playing ? 'pressed play' : 'paused'}`);
    },
    p.onRoomTarget,
  );

  const broadcast = (reason: string) => {
    if (!p.roomCode || Date.now() - suppress.current < 600) return;
    const v = videoRef.current;
    if (v) room.sendState({ playing: !v.paused, position: timeRef.current, rate: v.playbackRate }, reason);
  };

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch(() => undefined);
      showFlash(<Play className="size-9 translate-x-0.5 fill-current" />);
    } else {
      v.pause();
      showFlash(<Pause className="size-9 fill-current" />);
    }
    setStillThere(false);
  }, []);

  const seekTo = useCallback(
    (target: number, announce = true) => {
      const v = videoRef.current;
      const d = durRef.current;
      const to = Math.max(0, d ? Math.min(d - 1, target) : target);
      if (piped) {
        setOffset(to);
        setT(0);
        setWaiting(true);
      } else if (v) {
        v.currentTime = to;
        setT(to);
      }
      if (announce && p.roomCode) window.setTimeout(() => broadcast('seek'), 50);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [piped, p.roomCode],
  );

  const setVol = (val: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = Math.max(0, Math.min(1, val));
    v.muted = val <= 0;
    localStorage.setItem('nova.volume', String(v.volume));
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    else box.current?.requestFullscreen().catch(() => undefined);
  };

  // Mouse: click toggles play, double-click toggles fullscreen (the first click of a double is
  // held back so it doesn't pause). Touch: a tap shows or hides the controls.
  const clickTimer = useRef(0);
  const lastPointer = useRef<string>('mouse');
  const chromeAtDown = useRef(false);
  const onSurfaceClick = (e: React.MouseEvent) => {
    if (e.detail >= 2) {
      window.clearTimeout(clickTimer.current);
      clickTimer.current = 0;
      if (e.detail === 2) toggleFullscreen();
      return;
    }
    if (lastPointer.current === 'touch') {
      if (chromeAtDown.current && !panel) setChrome(false);
      return;
    }
    window.clearTimeout(clickTimer.current);
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = 0;
      if (panel) return setPanel(null);
      togglePlay();
      broadcast(videoRef.current?.paused ? 'pause' : 'play');
    }, 220);
  };

  const togglePip = async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch {
      toast('Picture-in-picture is not available here', 'bad');
    }
  };

  /** Saves the current frame as a PNG (the picture only, without subtitles or controls). */
  const screenshot = async () => {
    const v = videoRef.current;
    if (!v?.videoWidth) return;
    try {
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext('2d')!.drawImage(v, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('empty');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${[p.title, episodeLabel(p.mediaType, p.season, p.episode), fmtClock(timeRef.current).replace(/:/g, '.')].filter(Boolean).join(' - ')}.png`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      showFlash(<Camera className="size-8" />);
    } catch {
      // Streams from another origin (a paired desktop engine) can't be read back into a canvas.
      toast("Screenshots aren't possible for this stream", 'bad');
    }
  };

  useEffect(() => {
    const on = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  // -------------------------------------------------------------- progress
  const persist = useCallback(
    (finished = false) => {
      const d = durRef.current;
      const pos = timeRef.current;
      if (!d || d <= 0 || (!finished && pos < 3)) return;
      lastSaved.current = Date.now();
      p.onProgress(Math.floor(pos), Math.floor(d), finished || pos / d > 0.92);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => {
    const id = window.setInterval(() => videoRef.current && !videoRef.current.paused && persist(), 15_000);
    const onHide = () => document.visibilityState === 'hidden' && persist();
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onHide);
      persist();
    };
  }, [persist]);

  // -------------------------------------------------------------- torrent stats while loading
  const stats = useQuery({
    queryKey: ['play-status', playable.src],
    queryFn: () => api.play.status(playable.src, playable.api),
    enabled: Boolean(playable.src.startsWith('t/')) && (waiting || !started),
    refetchInterval: 1500,
  });

  // -------------------------------------------------------------- skip intro / credits
  const chapterSkip = useMemo(() => {
    const out: { op?: { start: number; end: number }; ed?: { start: number; end: number } } = {};
    for (const c of tracks?.chapters ?? []) {
      if (c.end == null || c.end - c.start > 240) continue;
      if (!out.op && /^(op|opening|intro|opening credits|op\s*\d*)$/i.test(c.title.trim())) out.op = { start: c.start, end: c.end };
      else if (!out.ed && /^(ed|ending|outro|credits|end credits|ed\s*\d*)$/i.test(c.title.trim())) out.ed = { start: c.start, end: c.end };
    }
    return out;
  }, [tracks]);
  const malId = p.detail?.malId;
  const skip = useQuery({
    queryKey: ['aniskip', malId, p.episode],
    queryFn: () => api.catalog.aniskip(malId!, p.episode!),
    enabled: p.mediaType === 'anime' && Boolean(malId) && p.episode != null,
    staleTime: Infinity,
  });
  const op = skip.data?.op ?? chapterSkip.op;
  const ed = skip.data?.ed ?? chapterSkip.ed;
  const inOp = op && time >= op.start && time < op.end - 1;
  const inEd = ed && time >= ed.start && time < ed.end - 1;
  const skipVisible = (inOp && (time < op!.start + 5 || chrome)) || (inEd && !p.next && (time < ed!.start + 5 || chrome));
  const autoSkipped = useRef<string | null>(null);
  useEffect(() => {
    if (inOp && prefs?.ui.skipIntroAutomatically && autoSkipped.current !== `op:${p.itemKey}`) {
      autoSkipped.current = `op:${p.itemKey}`;
      seekTo(op!.end);
      toast('Skipped the intro');
    }
    if (inEd && prefs?.ui.skipCreditsAutomatically && autoSkipped.current !== `ed:${p.itemKey}`) {
      autoSkipped.current = `ed:${p.itemKey}`;
      if (p.next) p.onNext();
      else seekTo(ed!.end);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inOp, inEd]);

  // -------------------------------------------------------------- next episode card
  const nearEnd = duration > 0 && (ed ? time >= ed.start : duration - time < 35);
  const showNext = Boolean(p.next) && nearEnd && !nextDismissed && started;
  useEffect(() => {
    if (!showNext || !prefs?.ui.autoplayNext || p.roomCode) {
      setCountdown(null);
      return;
    }
    setCountdown(10);
    const id = window.setInterval(() => setCountdown((c) => (c == null ? null : c - 1)), 1000);
    return () => window.clearInterval(id);
  }, [showNext, prefs?.ui.autoplayNext, p.roomCode]);
  useEffect(() => {
    if (countdown === 0) {
      persist(true);
      p.onNext();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown]);

  // -------------------------------------------------------------- sleep timer
  useEffect(() => {
    if (!sleepAt) return;
    const id = window.setInterval(() => {
      if (Date.now() >= sleepAt) {
        videoRef.current?.pause();
        setSleepAt(null);
        setStillThere(true);
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [sleepAt]);

  // -------------------------------------------------------------- subtitles
  const subLang = prefs?.ui.subtitleLanguage ?? 'en';
  const secondLang = prefs?.ui.secondarySubtitleLanguage ?? '';
  const embedded: SubtitleSource[] = useMemo(
    () =>
      isOffline
        ? []
        : (tracks?.subtitles ?? [])
            .filter((s) => TEXT_SUBS.has(s.codec.toLowerCase()))
            .map((s, i): SubtitleSource => {
              const label = [s.language && s.language !== 'und' ? langName(s.language) : null, s.title, s.forced ? 'Forced' : null].filter(Boolean).join(' · ') || `Track ${i + 1}`;
              if (tracks?.container === 'matroska' && s.number != null) {
                return {
                  id: `e${s.index}`,
                  label,
                  lang: s.language,
                  url: `${playable.path}/subs/${s.number}/vtt`,
                  embedded: true,
                  mkv: { path: playable.path, track: s.number, codec: s.codec.toLowerCase(), fonts: (tracks.fonts ?? []).map((f) => `${playable.path}/font/${f}`) },
                };
              }
              return { id: `e${s.index}`, label, lang: s.language, url: `${playable.path}/subtitle/${s.index}`, embedded: true };
            }),
    [tracks, playable.path, isOffline],
  );
  const imageOnlySubs = (tracks?.subtitles ?? []).filter((s) => !TEXT_SUBS.has(s.codec.toLowerCase())).length;

  const searchOs = useCallback(
    async (languages: string) => {
      setOsLoading(true);
      try {
        const wanted = languages.split(',').filter(Boolean);
        const [configured, fromPlugins] = await Promise.all([
          api.catalog.subtitlesStatus().catch(() => false),
          api.catalog.pluginSubtitles({ mediaId: p.mediaId, season: p.mediaType === 'anime' ? null : p.season, episode: p.episode }).catch(() => []),
        ]);
        const builtin = configured
          ? await api.catalog
              .subtitles({
                imdbId: p.detail?.imdbId ?? undefined,
                query: p.title,
                season: p.mediaType === 'anime' ? undefined : (p.season ?? undefined),
                episode: p.episode ?? undefined,
                languages,
                kind: p.episode != null ? 'episode' : 'movie',
              })
              .catch(() => [] as SubtitleOption[])
          : [];
        // Plugins answer for every language at once: keep yours, in the order you listed them.
        const extra: SubtitleOption[] = fromPlugins
          .filter((s) => !wanted.length || wanted.some((l) => matchesLanguage(l, s.language)))
          .sort((a, b) => wanted.findIndex((l) => matchesLanguage(l, a.language)) - wanted.findIndex((l) => matchesLanguage(l, b.language)))
          .slice(0, 30)
          .map((s) => ({ fileId: 0, language: s.language, release: s.release, match: 'exact', url: api.catalog.pluginSubtitleUrl(s.token), provider: s.plugin }));
        const list = [...builtin, ...extra];
        setOsResults(list);
        return list;
      } catch {
        setOsResults([]);
        return [];
      } finally {
        setOsLoading(false);
      }
    },
    [p.detail?.imdbId, p.title, p.mediaType, p.mediaId, p.season, p.episode],
  );
  const osSource = (o: SubtitleOption): SubtitleSource => ({
    id: o.url ? `pl${o.url.slice(o.url.lastIndexOf('/') + 1)}` : `os${o.fileId}`,
    label: `${langName(o.language)} · ${o.release}`,
    lang: o.language,
    url: o.url ?? api.catalog.subtitleUrl(o.fileId),
  });
  const translated = (base: SubtitleSource, target: string): SubtitleSource => ({
    ...base,
    id: `${base.id}>${target}`,
    label: `${base.label} → ${langName(target)}`,
    lang: target,
    embedded: false,
    mkv: undefined,
    transform: (vtt) => api.subtitles.translate(vtt, target, prefs?.ui.translateProvider ?? 'google'),
  });

  // Auto-pick once per source: embedded in your language → OpenSubtitles → translated.
  useEffect(() => {
    if (subPicked.current || !prefs || (!tracks && !isOffline)) return;
    if (!prefs.ui.autoSelectSubtitles) return;
    subPicked.current = true;
    const audio = tracks?.audio.find((a) => a.default) ?? tracks?.audio[0];
    if (audio && matchesLanguage(subLang, audio.language, audio.title) && p.mediaType !== 'anime') return;
    // "Signs & Songs" and forced tracks only translate on-screen text: never the automatic choice.
    const ignore = (prefs.ui.subtitleIgnore ?? []).map((x) => x.toLowerCase()).filter(Boolean);
    const pickable = embedded.filter((s) => !ignore.some((x) => s.label.toLowerCase().includes(x)));
    const pick = async () => {
      const own = pickable.find((s) => matchesLanguage(subLang, s.lang, s.label));
      if (own) return own;
      const os = await searchOs([subLang, secondLang, 'en'].filter(Boolean).join(','));
      const exact = os.find((o) => o.match === 'exact' && matchesLanguage(subLang, o.language)) ?? os.find((o) => matchesLanguage(subLang, o.language));
      if (exact) return osSource(exact);
      if (prefs.ui.translateSubtitles) {
        const base = pickable[0] ?? (os[0] ? osSource(os[0]) : null);
        if (base) return translated(base, subLang);
      }
      return null;
    };
    void pick().then((s) => s && setSubChoice(s));
    if (secondLang) {
      const second = pickable.find((s) => matchesLanguage(secondLang, s.lang, s.label));
      if (second) setSubSecondary(second);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, prefs, embedded]);

  const primarySubs = useSubtitleTrack(subChoice, timeRef);
  const secondarySubs = useSubtitleTrack(subSecondary, timeRef);
  const [assHost, setAssHost] = useState<HTMLDivElement | null>(null);
  const assHeader = primarySubs.header?.current ?? null;
  const styled = Boolean(subChoice?.mkv && assHeader && prefs?.ui.styledSubtitles !== false);
  const [assFailed, setAssFailed] = useState(false);
  useEffect(() => setAssFailed(false), [subChoice?.id]);
  const onAssError = useCallback((m: string) => {
    setAssFailed(true);
    toast(`Styled subtitles unavailable: ${m.slice(0, 100)}`, 'bad');
  }, []);
  useAssRenderer({
    enabled: styled && !assFailed,
    video: videoEl,
    host: assHost,
    header: assHeader,
    blocks: primarySubs.blocks,
    version: primarySubs.version,
    fonts: subChoice?.mkv?.fonts ?? [],
    timeOffset: (piped ? offset : 0) - subDelay,
    onError: onAssError,
  });
  const cueTime = time - subDelay;
  const cue = subChoice && !(styled && !assFailed) ? cuesAt(primarySubs.cues, cueTime) : '';
  const cue2 = subSecondary ? cuesAt(secondarySubs.cues, cueTime) : '';
  const lastCueEnd = primarySubs.cues.at(-1)?.end ?? 0;
  const subsBehind = subChoice?.mkv
    ? !primarySubs.covered
    : Boolean(subChoice?.embedded) && !primarySubs.complete && primarySubs.cues.length > 0 && cueTime > lastCueEnd + 5;
  const subPct = useQuery({
    queryKey: ['sub-progress', playable.src, subChoice?.id],
    queryFn: () => api.play.subtitleProgress(playable.src, Number(subChoice!.id.slice(1)), playable.api),
    enabled: subsBehind && Boolean(subChoice?.embedded) && !subChoice?.mkv,
    refetchInterval: 3000,
  });
  const style = prefs?.ui.subtitleStyle;

  // -------------------------------------------------------------- enhancement
  const onEnhanceError = useCallback((msg: string) => {
    toast(`Enhancement off: ${msg.slice(0, 120)}`, 'bad');
    setEnhance('none');
  }, []);
  useEnhancer(enhance !== 'none' ? videoEl : null, canvasEl, enhance, prefs?.ui.customShader ?? '', onEnhanceError);

  // -------------------------------------------------------------- room creation
  const roomRequested = useRef(false);
  useEffect(() => {
    if (!p.wantRoom || p.roomCode || roomRequested.current || !started || isOffline) return;
    roomRequested.current = true;
    if (playable.api) {
      toast("Watch together needs a source the server streams; this one plays from your computer", 'bad');
      return;
    }
    api.rooms
      .create({
        mediaId: p.mediaId,
        mediaType: p.mediaType,
        itemKey: p.itemKey,
        title: p.title,
        poster: p.detail?.poster ?? null,
        backdrop: p.detail?.backdrop ?? null,
        season: p.season,
        episode: p.episode,
        path: playable.path,
        src: playable.src,
      })
      .then((code) => {
        p.onRoomCreated(code);
        setPanel('room');
      })
      .catch((e) => toast(errorText(e), 'bad'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.wantRoom, started]);

  // -------------------------------------------------------------- keyboard
  const keys = useMemo(() => shortcutMap(prefs?.ui.shortcuts), [prefs?.ui.shortcuts]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey) return;
      if (cast) return;
      const v = videoRef.current;
      if (!v) return;
      const k = eventKey(e);
      if (k === 'escape') {
        if (panel) setPanel(null);
        else if (!document.fullscreenElement) p.onBack();
        return poke();
      }
      const action = keys.get(k);
      if (!action) return;
      if (action === 'playPause' || action.startsWith('volume')) e.preventDefault();
      switch (action) {
        case 'playPause':
          togglePlay();
          broadcast(v.paused ? 'play' : 'pause');
          break;
        case 'fullscreen':
          toggleFullscreen();
          break;
        case 'mute':
          v.muted = !v.muted;
          break;
        case 'back5':
        case 'back10':
          seekTo(timeRef.current - (action === 'back10' ? 10 : 5));
          break;
        case 'forward5':
        case 'forward10':
          seekTo(timeRef.current + (action === 'forward10' ? 10 : 5));
          break;
        case 'volumeUp':
          setVol(v.volume + 0.1);
          break;
        case 'volumeDown':
          setVol(v.volume - 0.1);
          break;
        case 'next':
          if (p.next) p.onNext();
          break;
        case 'skip':
          if (inOp || inEd) seekTo((inOp ? op!.end : ed!.end) + 0.2);
          break;
        case 'pip':
          void togglePip();
          break;
        case 'subtitles':
          setSubChoice((s) => (s ? null : (embedded[0] ?? null)));
          break;
        case 'faster':
        case 'slower':
          v.playbackRate = Math.max(0.25, Math.min(3, Math.round((v.playbackRate + (action === 'faster' ? 0.25 : -0.25)) * 100) / 100));
          showFlash(<span className="font-display text-xl font-bold">{v.playbackRate}×</span>);
          break;
        case 'screenshot':
          void screenshot();
          break;
      }
      poke();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // -------------------------------------------------------------- video events
  const onLoaded = () => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = volume;
    v.playbackRate = rate;
    setVideoDuration(Number.isFinite(v.duration) ? v.duration : 0);
    if (!piped && !resumeApplied.current && p.startAt > 5) {
      const d = Number.isFinite(v.duration) ? v.duration : 0;
      if (!d || p.startAt < d - 20) v.currentTime = p.startAt;
    }
    resumeApplied.current = true;
    v.play().catch(() => setPlaying(false));
  };

  const onVideoError = () => {
    if (isOffline) return setError('This offline copy could not be played.');
    if (mode === 'direct') return switchMode('remux');
    if (mode === 'remux' && transcodeAllowed) return switchMode('transcode');
    setError(mode === 'transcode' ? 'The server could not convert this release. Try another source.' : "Your browser can't play this release. Try another source" + (transcodeAllowed ? '.' : ', or ask an admin to enable transcoding.'));
  };

  const playedPct = duration ? (time / duration) * 100 : 0;
  const bufferedPct = duration ? Math.min(100, ((piped ? offset + buffered : buffered) / duration) * 100) : 0;
  const chromeOn = chrome || !playing || Boolean(panel);
  const playerActions = (contrib?.actions ?? []).filter((a) => a.placement === 'player');
  const subtitleLine = [episodeLabel(p.mediaType, p.season, p.episode), p.episodeTitle].filter(Boolean).join(' · ');
  const saveJob = offline.jobs[p.itemKey];
  const savedOffline = offline.entries.some((e) => e.itemKey === p.itemKey);

  // Discord status (desktop app): re-sent on play/pause and seeks, not every tick.
  const [seeks, setSeeks] = useState(0);
  useEffect(() => {
    if (!videoEl || !desktop) return;
    const on = () => setSeeks((n) => n + 1);
    videoEl.addEventListener('seeked', on);
    return () => videoEl.removeEventListener('seeked', on);
  }, [videoEl]);
  useEffect(() => {
    if (!desktop || !started) return;
    const now = Date.now() / 1000;
    setPresence({ kind: 'watching', title: p.title, subtitle: subtitleLine || null, image: publicImage(p.detail?.poster), paused: !playing, start: now - time, end: duration ? now - time + duration : undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, playing, p.title, subtitleLine, Math.floor(duration), seeks]);
  useEffect(() => () => setPresence(null), []);

  const external = async (kind: 'vlc' | 'mpv' | 'iina' | 'copy' | 'm3u') => {
    try {
      const links = playable.api
        ? { url: playable.path, vlc: `vlc://${playable.path}`, mpv: `mpv://${playable.path}`, iina: `iina://weblink?url=${encodeURIComponent(playable.path)}`, playlist: `#EXTM3U\n#EXTINF:-1,${p.title}\n${playable.path}\n` }
        : await api.play.external({
        src: playable.src,
        filename: playable.name,
        itemKey: p.itemKey,
        mediaId: p.mediaId,
        mediaType: p.mediaType,
        season: p.season,
        episode: p.episode,
        title: p.title,
        duration: duration || null,
      });
      videoRef.current?.pause();
      if (kind === 'copy') {
        await navigator.clipboard.writeText(links.url);
        toast('Stream link copied — valid for 24 hours', 'ok');
      } else if (kind === 'm3u') {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([links.playlist], { type: 'audio/x-mpegurl' }));
        a.download = `${p.title}.m3u`;
        a.click();
      } else window.location.href = links[kind];
    } catch (e) {
      toast(errorText(e), 'bad');
    }
  };

  // -------------------------------------------------------------- casting
  const castBase = playable.api ?? '';
  const castSubtitle = async (): Promise<CastSubtitle> => {
    const s = subChoice;
    if (!s) return null;
    if (s.mkv && !s.transform) return { kind: 'embedded', track: s.mkv.track };
    // Anything else goes to the TV as finished WebVTT text.
    const res = await fetch(s.url, { credentials: /^https?:/.test(s.url) ? 'omit' : 'include' });
    if (!res.ok) throw new Error('Could not load the subtitles for casting');
    const text = s.transform ? await s.transform(await res.text()) : await res.text();
    return { kind: 'text', vtt: text, language: s.lang, label: s.label };
  };
  const startCast = async (pick: CastPick) => {
    if (!playable.src) return;
    setCastBusy(pick.kind === 'browser' ? 'browser' : pick.device.id);
    try {
      // The browser's device picker must open straight from the click.
      const handle = pick.kind === 'browser' ? await browserCast() : undefined;
      const image = p.detail?.backdrop ?? p.detail?.poster ?? null;
      const started = await castApi(castBase).start({
        device: pick.kind === 'browser' ? 'browser' : pick.device.id,
        source: playable.src,
        audioTrack: audioTrack ?? (tracks?.audio.find((a) => a.default) ?? tracks?.audio[0])?.index ?? 0,
        start: Math.max(0, timeRef.current - 2),
        subtitle: await castSubtitle(),
        title: p.title,
        subtitleLine: subtitleLine || null,
        image: image && /^https?:/.test(image) ? image : null,
      });
      if (handle && started.url) {
        await handle.load(started.url, {
          duration: started.duration ? started.duration - started.offset : null,
          title: p.title,
          subtitle: subtitleLine || null,
          image,
          subtitles: Boolean(started.subtitles),
        });
      }
      videoRef.current?.pause();
      setPanel(null);
      setCast({
        id: started.id,
        base: castBase,
        deviceName: handle?.deviceName ?? (pick.kind === 'device' ? pick.device.name : 'TV'),
        offset: started.offset,
        duration: started.duration,
        browser: handle,
      });
    } catch (e) {
      toast(errorText(e), 'bad');
    } finally {
      setCastBusy(null);
    }
  };
  const stopCast = async (position: number) => {
    const c = cast;
    setCast(null);
    if (!c) return;
    c.browser?.stop();
    await castApi(c.base).stop(c.id).catch(() => undefined);
    seekTo(position);
  };
  const onCastProgress = useCallback(
    (position: number, d: number, ended: boolean) => {
      if (d > 0) p.onProgress(Math.floor(position), Math.floor(d), ended || position / d > 0.92);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <div
      ref={box}
      onPointerMove={poke}
      onPointerDown={poke}
      className={cls('fixed inset-0 z-[60] overflow-hidden bg-black select-none', !chromeOn && 'cursor-hidden', hdrScreen && 'hdr-ui')}
    >
      <video
        ref={attachVideo}
        key={videoSrc}
        src={videoSrc}
        autoPlay
        playsInline
        crossOrigin={playable.blobUrl ? undefined : 'use-credentials'}
        onPointerDown={(e) => {
          lastPointer.current = e.pointerType;
          chromeAtDown.current = chromeOn;
        }}
        onClick={onSurfaceClick}
        onLoadedMetadata={onLoaded}
        onDurationChange={(e) => setVideoDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
        onProgress={(e) => {
          const b = e.currentTarget.buffered;
          if (b.length) setBuffered(b.end(b.length - 1));
        }}
        onPlay={() => {
          setPlaying(true);
          poke();
        }}
        onPause={() => {
          setPlaying(false);
          setChrome(true);
          persist();
        }}
        onWaiting={() => {
          setWaiting(true);
          if (p.roomCode) room.setBuffering(true);
        }}
        onPlaying={() => {
          setWaiting(false);
          setStarted(true);
          if (p.roomCode) room.setBuffering(false);
        }}
        onVolumeChange={(e) => {
          setVolume(e.currentTarget.volume);
          setMuted(e.currentTarget.muted);
        }}
        onRateChange={(e) => setRate(e.currentTarget.playbackRate)}
        onEnded={() => {
          persist(true);
          if (p.next && prefs?.ui.autoplayNext && !p.roomCode) p.onNext();
          if (sleepEnd) {
            setSleepEnd(false);
            setStillThere(true);
          }
        }}
        onError={onVideoError}
        className={cls('hdr-video absolute inset-0 size-full object-contain transition-opacity', enhance !== 'none' && 'opacity-0')}
      />
      {enhance !== 'none' && <canvas ref={setCanvasEl} className="pointer-events-none absolute inset-0 size-full object-contain" />}
      <div ref={setAssHost} className="pointer-events-none absolute inset-0 z-[5]" />

      {/* subtitles */}
      {(cue || cue2 || subsBehind) && style && (
        <div
          className="pointer-events-none absolute inset-x-0 z-10 flex flex-col items-center gap-1 px-6 text-center transition-[bottom] duration-300"
          style={{ bottom: chromeOn ? `calc(${style.position}% + 5.5rem)` : `${style.position}%` }}
        >
          {cue2 && (
            <span className="max-w-5xl whitespace-pre-line opacity-80" style={cueStyle(style, 0.78)}>
              {cue2}
            </span>
          )}
          {cue && (
            <span className="max-w-5xl whitespace-pre-line" style={cueStyle(style)}>
              {cue}
            </span>
          )}
          {!cue && subsBehind && (
            <span className="flex items-center gap-2 rounded-full bg-black/70 px-3 py-1 text-xs text-white/75">
              <Spinner className="size-3" /> {subChoice?.mkv ? 'Loading subtitles…' : `Reading subtitles from the file${subPct.data ? ` — ${Math.round(subPct.data.progress * 100)}%` : '…'}`}
            </span>
          )}
        </div>
      )}

      {/* loading */}
      <AnimatePresence>
        {(!started || waiting) && !error && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="pointer-events-none absolute inset-0 z-10 grid place-items-center">
            {!started && p.detail?.backdrop && <img src={p.detail.backdrop} alt="" className="absolute inset-0 size-full object-cover opacity-25 blur-sm" />}
            <div className="relative flex flex-col items-center gap-3">
              <div className="relative size-16">
                <div className="absolute inset-0 animate-spin rounded-full border-2 border-white/10 border-t-white" />
              </div>
              {stats.data && stats.data.progress < 1 && (
                <div className="text-center text-xs text-white/70 tabular-nums">
                  {stats.data.numPeers} peers · {fmtSpeed(stats.data.downloadSpeed)}
                </div>
              )}
              {!started && <div className="text-sm text-white/70">{mode === 'transcode' ? 'Converting for your browser…' : mode === 'remux' ? 'Preparing audio…' : 'Starting…'}</div>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* center flash */}
      <AnimatePresence>
        {flash && (
          <motion.div
            key={flash.id}
            initial={{ opacity: 0.9, scale: 0.7 }}
            animate={{ opacity: 0, scale: 1.35 }}
            transition={{ duration: 0.55 }}
            onAnimationComplete={() => setFlash(null)}
            className="pointer-events-none absolute top-1/2 left-1/2 z-20 grid size-24 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/45 backdrop-blur"
          >
            {flash.icon}
          </motion.div>
        )}
      </AnimatePresence>

      {/* reactions */}
      <div className="pointer-events-none absolute right-8 bottom-28 z-30 flex flex-col items-end">
        <AnimatePresence>
          {room.reactions.map((r) => (
            <motion.div key={r.id} initial={{ opacity: 0, y: 20, scale: 0.5 }} animate={{ opacity: 1, y: -80, scale: 1.2 }} exit={{ opacity: 0 }} transition={{ duration: 2.4 }} className="text-4xl">
              {r.emoji}
              <span className="ml-1 align-middle text-xs text-white/70">{r.name}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* error */}
      {error && (
        <div className="absolute inset-0 z-30 grid place-items-center bg-black/70 p-6">
          <div className="max-w-md text-center">
            <h2 className="font-display text-2xl font-semibold">Playback stopped</h2>
            <p className="mt-2 text-muted">{error}</p>
            <div className="mt-6 flex justify-center gap-2">
              <button onClick={p.onSources} className="rounded-xl bg-white px-5 py-2.5 font-semibold text-black">
                Choose another source
              </button>
              <button onClick={p.onBack} className="glass rounded-xl px-5 py-2.5 font-semibold">
                Back
              </button>
            </div>
          </div>
        </div>
      )}

      {/* still watching */}
      {stillThere && (
        <div className="absolute inset-0 z-30 grid place-items-center bg-black/60 backdrop-blur-sm">
          <div className="text-center">
            <Moon className="mx-auto size-10 text-accent" />
            <h2 className="mt-3 font-display text-2xl font-semibold">Still watching?</h2>
            <div className="mt-5 flex justify-center gap-2">
              <button onClick={togglePlay} className="rounded-xl bg-white px-5 py-2.5 font-semibold text-black">
                Keep watching
              </button>
              <button onClick={p.onBack} className="glass rounded-xl px-5 py-2.5 font-semibold">
                I'm done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* skip intro */}
      <AnimatePresence>
        {skipVisible && !error && (
          <motion.button
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            onClick={() => seekTo((inOp ? op!.end : ed!.end) + 0.2)}
            className="absolute right-6 bottom-28 z-30 flex items-center gap-2 rounded-xl bg-white px-5 py-3 font-semibold text-black shadow-2xl transition-transform hover:scale-105 sm:right-10"
          >
            <SkipForward className="size-5 fill-current" /> {inOp ? 'Skip intro' : 'Skip credits'}
          </motion.button>
        )}
      </AnimatePresence>

      {/* next episode */}
      <AnimatePresence>
        {showNext && p.next && !error && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="glass-strong absolute right-6 bottom-28 z-30 w-80 overflow-hidden rounded-2xl shadow-2xl sm:right-10"
          >
            <button
              onClick={() => {
                persist(true);
                p.onNext();
              }}
              className="group relative block w-full text-left"
            >
              {p.next.still && <img src={p.next.still} alt="" className="aspect-video w-full object-cover" />}
              <div className="p-3.5">
                <div className="text-xs text-faint">{p.next.label ?? `Next · ${episodeLabel(p.mediaType, p.next.season, p.next.episode)}`}</div>
                <div className="mt-0.5 truncate font-semibold">{p.next.title}</div>
              </div>
              {countdown != null && (
                <div className="absolute inset-x-0 bottom-0 h-1 bg-white/10">
                  <motion.div className="h-full bg-progress" initial={{ width: '0%' }} animate={{ width: '100%' }} transition={{ duration: 10, ease: 'linear' }} />
                </div>
              )}
            </button>
            <div className="flex gap-2 px-3.5 pb-3.5">
              <button
                onClick={() => {
                  persist(true);
                  p.onNext();
                }}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-white py-2 text-sm font-semibold text-black"
              >
                <Play className="size-4 fill-current" /> {countdown != null ? `Play in ${countdown}` : 'Play next'}
              </button>
              <button onClick={() => setNextDismissed(true)} className="rounded-xl px-3 text-sm text-muted hover:text-fg">
                Not now
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* chrome */}
      {/* Only the bars take pointer events, so clicks in the middle reach the video. */}
      <motion.div animate={{ opacity: chromeOn ? 1 : 0 }} transition={{ duration: 0.25 }} className="pointer-events-none absolute inset-0 z-20">
        <div className="player-scrim absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-black/80 to-transparent" />
        <div className="player-scrim absolute inset-x-0 bottom-0 h-56 bg-gradient-to-t from-black/90 via-black/50 to-transparent" />

        <div
          className={cls('wco-pad absolute inset-x-0 top-0', chromeOn && 'app-drag pointer-events-auto')}
          onPointerEnter={() => (hoverChrome.current = true)}
          onPointerLeave={() => (hoverChrome.current = false)}
        >
          <div className="flex items-center gap-3 px-4 pt-safe-5 sm:px-8 sm:pt-safe-7">
            <button onClick={p.onBack} aria-label="Back" className="grid size-11 place-items-center rounded-full hover:bg-white/10">
              <ArrowLeft className="size-6" />
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate font-display text-lg font-semibold">{p.title}</div>
              {subtitleLine && <div className="truncate text-sm text-white/65">{subtitleLine}</div>}
            </div>
            {p.roomCode && (
              <button onClick={() => setPanel('room')} className="glass flex items-center gap-2 rounded-full py-1.5 pr-3 pl-2 text-sm">
                <span className={cls('size-2 rounded-full', room.connected ? 'bg-ok' : 'bg-warn')} />
                <Users className="size-4" /> {room.members.length}
              </button>
            )}
            {!isOffline && (
              <button onClick={p.onSources} className="glass hidden items-center gap-2 rounded-full px-3.5 py-1.5 text-xs text-white/80 hover:text-white sm:flex">
                <ListVideo className="size-4" /> {playable.label ?? 'Sources'}
              </button>
            )}
          </div>
        </div>

        <div
          className={cls('absolute inset-x-0 bottom-0 px-4 pb-safe-4 sm:px-8 sm:pb-safe-6', chromeOn && 'pointer-events-auto')}
          onPointerEnter={() => (hoverChrome.current = true)}
          onPointerLeave={() => (hoverChrome.current = false)}
        >
          {/* seek bar */}
          <div
            className="group/seek relative flex h-6 cursor-pointer items-center"
            onPointerMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
              setHover({ x: x * 100, t: x * duration });
            }}
            onPointerLeave={() => setHover(null)}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              seekTo(((e.clientX - r.left) / r.width) * duration);
            }}
          >
            <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/20 transition-[height] duration-200 group-hover/seek:h-1.5">
              <div className="absolute inset-y-0 left-0 bg-white/30" style={{ width: `${bufferedPct}%` }} />
              <div className="absolute inset-y-0 left-0 bg-progress" style={{ width: `${playedPct}%` }} />
              {duration > 0 &&
                [op, ed].filter(Boolean).map((s, i) => (
                  <div key={i} className="absolute inset-y-0 bg-white/35" style={{ left: `${(s!.start / duration) * 100}%`, width: `${((s!.end - s!.start) / duration) * 100}%` }} />
                ))}
              {duration > 0 &&
                (tracks?.chapters ?? []).slice(1).map((c, i) => (
                  <div key={`ch${i}`} className="absolute inset-y-0 w-[3px] -translate-x-1/2 bg-black/70" style={{ left: `${(c.start / duration) * 100}%` }} />
                ))}
            </div>
            <div className="pointer-events-none absolute size-3.5 -translate-x-1/2 rounded-full bg-white shadow-lg transition-transform group-hover/seek:scale-110" style={{ left: `${playedPct}%` }} />
            {hover && (
              <div className="pointer-events-none absolute -top-8 -translate-x-1/2 rounded-md bg-black/85 px-2 py-0.5 text-xs tabular-nums" style={{ left: `${hover.x}%` }}>
                {fmtClock(hover.t)}
              </div>
            )}
          </div>

          <div className="mt-2 flex items-center gap-1 sm:gap-2">
            <button
              onClick={() => {
                togglePlay();
                broadcast(videoRef.current?.paused ? 'pause' : 'play');
              }}
              aria-label={playing ? 'Pause' : 'Play'}
              className="grid size-11 place-items-center rounded-full hover:bg-white/10"
            >
              {playing ? <Pause className="size-6 fill-current" /> : <Play className="size-6 translate-x-px fill-current" />}
            </button>
            <button onClick={() => seekTo(time - 10)} aria-label="Back 10 seconds" className="grid size-10 place-items-center rounded-full hover:bg-white/10 max-sm:hidden">
              <RotateCcw className="size-5" />
            </button>
            <button onClick={() => seekTo(time + 10)} aria-label="Forward 10 seconds" className="grid size-10 place-items-center rounded-full hover:bg-white/10 max-sm:hidden">
              <RotateCw className="size-5" />
            </button>
            <div className="group/vol flex items-center max-sm:hidden">
              <button onClick={() => videoRef.current && (videoRef.current.muted = !muted)} aria-label={muted ? 'Unmute' : 'Mute'} className="grid size-10 place-items-center rounded-full hover:bg-white/10">
                {muted || volume === 0 ? <VolumeX className="size-5" /> : volume < 0.5 ? <Volume1 className="size-5" /> : <Volume2 className="size-5" />}
              </button>
              <div className="w-0 overflow-hidden transition-all duration-300 group-hover/vol:w-24">
                <input aria-label="Volume" type="range" min={0} max={1} step={0.02} value={muted ? 0 : volume} onChange={(e) => setVol(Number(e.target.value))} className="w-22 accent-white" />
              </div>
            </div>
            <div className="ml-1 text-sm text-white/80 tabular-nums">
              {fmtClock(time)} <span className="text-white/45">/ {fmtClock(duration)}</span>
            </div>
            {mode !== 'direct' && !isOffline && <span className="ml-2 rounded bg-white/12 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white/70 uppercase max-sm:hidden">{mode === 'transcode' ? `Transcoding ${height}p` : 'Compat audio'}</span>}
            <div className="flex-1" />
            {p.next && (
              <button onClick={p.onNext} aria-label="Next episode" className="grid size-10 place-items-center rounded-full hover:bg-white/10">
                <SkipForward className="size-5" />
              </button>
            )}
            {(p.episodes.length > 1 || (p.mediaType === 'tv' && seasons.length > 1)) && (
              <button onClick={() => setPanel(panel === 'episodes' ? null : 'episodes')} aria-label="Episodes" className={cls('grid size-10 place-items-center rounded-full hover:bg-white/10', panel === 'episodes' && 'bg-white/15')}>
                <ListVideo className="size-5" />
              </button>
            )}
            <button
              onClick={() => {
                setPanel(panel === 'subtitles' ? null : 'subtitles');
                if (!osResults && !osLoading) void searchOs([subLang, secondLang, 'en'].filter(Boolean).join(','));
              }}
              aria-label="Subtitles"
              className={cls('grid size-10 place-items-center rounded-full hover:bg-white/10', (panel === 'subtitles' || subChoice) && 'text-accent')}
            >
              <Captions className="size-5" />
            </button>
            {!isOffline && (tracks?.audio.length ?? 0) > 1 && (
              <button onClick={() => setPanel(panel === 'audio' ? null : 'audio')} aria-label="Audio" className={cls('grid size-10 place-items-center rounded-full hover:bg-white/10', panel === 'audio' && 'bg-white/15')}>
                <AudioLines className="size-5" />
              </button>
            )}
            {p.roomCode && (
              <button onClick={() => setPanel(panel === 'room' ? null : 'room')} aria-label="Chat" className={cls('grid size-10 place-items-center rounded-full hover:bg-white/10', panel === 'room' && 'bg-white/15')}>
                <MessageCircle className="size-5" />
              </button>
            )}
            <button onClick={() => setPanel(panel === 'settings' ? null : 'settings')} aria-label="Settings" className={cls('grid size-10 place-items-center rounded-full hover:bg-white/10', panel === 'settings' && 'bg-white/15')}>
              <Settings2 className="size-5" />
            </button>
            {!isOffline && !p.roomCode && (
              <button onClick={() => setPanel(panel === 'cast' ? null : 'cast')} aria-label="Cast to a TV" className={cls('grid size-10 place-items-center rounded-full hover:bg-white/10', panel === 'cast' && 'bg-white/15')}>
                <Cast className="size-5" />
              </button>
            )}
            <button onClick={() => void screenshot()} aria-label="Screenshot" title="Screenshot" className="grid size-10 place-items-center rounded-full hover:bg-white/10 max-sm:hidden">
              <Camera className="size-5" />
            </button>
            <button onClick={togglePip} aria-label="Picture in picture" className="grid size-10 place-items-center rounded-full hover:bg-white/10 max-sm:hidden">
              <PictureInPicture2 className="size-5" />
            </button>
            <button onClick={toggleFullscreen} aria-label="Fullscreen" className="grid size-10 place-items-center rounded-full hover:bg-white/10">
              {fullscreen ? <Minimize className="size-5" /> : <Maximize className="size-5" />}
            </button>
          </div>
        </div>
      </motion.div>

      {/* panels */}
      <AnimatePresence>
        {panel === 'cast' && (
          <Panel title="Cast to a TV" onClose={() => setPanel(null)}>
            <CastDevices base={playable.api ?? ''} allowBrowser={!playable.api} busy={castBusy} onPick={(pick) => void startCast(pick)} />
          </Panel>
        )}
        {panel === 'episodes' && (
          <Panel title="Episodes" onClose={() => setPanel(null)}>
            {p.mediaType === 'tv' && seasons.length > 1 && (
              <div className="scrollbar-none -mx-3 mb-2 flex gap-1.5 overflow-x-auto px-3 pb-1">
                {seasons.map((s) => (
                  <button
                    key={s.season}
                    onClick={() => setEpSeason(s.season)}
                    className={cls(
                      'shrink-0 rounded-full px-3 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors',
                      s.season === epSeason ? 'bg-white text-black' : 'bg-white/8 text-muted hover:bg-white/14 hover:text-fg',
                    )}
                  >
                    {s.season === 0 ? 'Specials' : `Season ${s.season}`}
                  </button>
                ))}
              </div>
            )}
            {otherSeason.isFetching && !panelEpisodes.length && (
              <div className="grid h-32 place-items-center">
                <Spinner className="size-5" />
              </div>
            )}
            <div className="space-y-1">
              {panelEpisodes.map((e) => {
                const current = e.episode === p.episode && e.season === (p.season ?? e.season);
                const ahead = e.season > (p.season ?? e.season) || (e.season === (p.season ?? e.season) && e.episode > (p.episode ?? 0));
                const veiled = Boolean(prefs?.ui.hideSpoilers) && ahead;
                return (
                  <button
                    key={e.id}
                    ref={(el) => {
                      // Inline refs re-run on every render (several per second while playing).
                      if (current && el && !episodeScrolled.current) {
                        episodeScrolled.current = true;
                        // Scroll the panel only: scrollIntoView also scrolls the page and the player box, which made everything jump.
                        const list = el.closest<HTMLElement>('.overflow-y-auto');
                        if (list) list.scrollTop += el.getBoundingClientRect().top - list.getBoundingClientRect().top - (list.clientHeight - el.offsetHeight) / 2;
                      }
                    }}
                    onClick={() => p.onEpisode(e.season, e.episode)}
                    className={cls('flex w-full gap-3 rounded-2xl p-2 text-left transition-colors', current ? 'bg-white/12' : 'hover:bg-white/6')}
                  >
                    <div className="aspect-video w-28 shrink-0 overflow-hidden rounded-lg bg-white/5">{e.still && <img src={e.still} alt="" loading="lazy" className={cls('size-full object-cover', veiled && 'scale-110 blur-lg')} />}</div>
                    <div className="min-w-0 py-0.5">
                      <div className="text-xs text-faint">{episodeLabel(p.mediaType, e.season, e.episode)}</div>
                      <div className="truncate text-sm font-medium">{veiled ? `Episode ${e.episode}` : e.title}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </Panel>
        )}

        {panel === 'subtitles' && (
          <Panel title="Subtitles" onClose={() => setPanel(null)}>
            <Option active={!subChoice} onClick={() => setSubChoice(null)}>
              Off
            </Option>
            {embedded.length > 0 && <Heading>In the file</Heading>}
            {embedded.map((s) => (
              <Option key={s.id} active={subChoice?.id === s.id} onClick={() => setSubChoice(s)} hint={subChoice?.id === s.id && primarySubs.loading ? <Spinner className="size-3.5" /> : undefined}>
                {s.label}
              </Option>
            ))}
            {imageOnlySubs > 0 && <p className="px-3 pt-1 text-xs text-faint">{imageOnlySubs} picture-based track{imageOnlySubs > 1 ? 's' : ''} can't be shown in a browser.</p>}
            <Heading>Online</Heading>
            {osLoading && (
              <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted">
                <Spinner className="size-4" /> Searching…
              </div>
            )}
            {osResults?.slice(0, 16).map((o) => {
              const s = osSource(o);
              return (
                <Option key={s.id} active={subChoice?.id === s.id} onClick={() => setSubChoice(s)} hint={o.provider ?? (o.match === 'exact' ? 'Exact' : undefined)}>
                  {s.label}
                </Option>
              );
            })}
            {osResults && !osResults.length && !osLoading && (
              <p className="px-3 py-1 text-xs text-faint">No online subtitles found. Install a subtitles plugin (such as OpenSubtitles v3) under Server → Plugins, or add an OpenSubtitles key.</p>
            )}
            {subChoice && !matchesLanguage(subLang, subChoice.lang) && !subChoice.transform && (
              <>
                <Heading>Translate</Heading>
                <Option onClick={() => setSubChoice(translated(subChoice, subLang))}>
                  <span className="inline-flex items-center gap-2">
                    <Languages className="size-4" /> Translate this track to {langName(subLang)}
                  </span>
                </Option>
              </>
            )}
            {subChoice && (
              <>
                <Heading>Timing</Heading>
                <div className="flex items-center gap-2 px-3">
                  <button onClick={() => setSubDelay((d) => +(d - 0.25).toFixed(2))} className="glass rounded-lg px-3 py-1.5 text-sm">
                    −0.25s
                  </button>
                  <span className="flex-1 text-center text-sm tabular-nums">{subDelay > 0 ? '+' : ''}{subDelay.toFixed(2)}s</span>
                  <button onClick={() => setSubDelay((d) => +(d + 0.25).toFixed(2))} className="glass rounded-lg px-3 py-1.5 text-sm">
                    +0.25s
                  </button>
                </div>
              </>
            )}
            {style && (
              <>
                <Heading>Look</Heading>
                <div className="space-y-3 px-3">
                  <div>
                    <div className="mb-1 text-xs text-muted">Size</div>
                    <Slider value={style.fontSize} min={60} max={200} step={5} onChange={(v) => savePrefs.mutate({ ui: { subtitleStyle: { fontSize: v } } })} format={(v) => `${v}%`} />
                  </div>
                  <div>
                    <div className="mb-1 text-xs text-muted">Background</div>
                    <Slider value={style.background} min={0} max={100} step={5} onChange={(v) => savePrefs.mutate({ ui: { subtitleStyle: { background: v } } })} format={(v) => `${v}%`} />
                  </div>
                  <div>
                    <div className="mb-1 text-xs text-muted">Height</div>
                    <Slider value={style.position} min={2} max={40} onChange={(v) => savePrefs.mutate({ ui: { subtitleStyle: { position: v } } })} format={(v) => `${v}%`} />
                  </div>
                </div>
              </>
            )}
          </Panel>
        )}

        {panel === 'audio' && tracks && (
          <Panel title="Audio" onClose={() => setPanel(null)}>
            {tracks.audio.map((a, i) => {
              const def = Math.max(0, tracks.audio.findIndex((x) => x.default));
              const active = audioTrack == null ? i === def : audioTrack === a.index;
              return (
                <Option
                  key={a.index}
                  active={active}
                  onClick={() => {
                    if (i === def && mode !== 'transcode' && BROWSER_AUDIO.has(a.codec.toLowerCase())) return switchMode('direct', { track: null });
                    switchMode(mode === 'transcode' ? 'transcode' : 'remux', { track: a.index });
                  }}
                  hint={`${a.codec.toUpperCase()}${a.channels ? ` ${a.channels > 2 ? `${a.channels - 1}.1` : a.channels === 2 ? 'stereo' : 'mono'}` : ''}`}
                >
                  {[langName(a.language), a.title].filter((x) => x && x !== 'Unknown').join(' · ') || `Track ${i + 1}`}
                </Option>
              );
            })}
          </Panel>
        )}

        {panel === 'settings' && (
          <Panel title="Playback" onClose={() => setPanel(null)}>
            <Heading>
              <span className="inline-flex items-center gap-1.5">
                <Gauge className="size-3.5" /> Speed
              </span>
            </Heading>
            <div className="flex items-center gap-2 px-3">
              <div className="flex-1">
                <Slider
                  label="Playback speed"
                  value={rate}
                  min={0.25}
                  max={3}
                  step={0.05}
                  onChange={(s) => {
                    if (videoRef.current) videoRef.current.playbackRate = s;
                    broadcast('rate');
                  }}
                  format={(s) => `${s.toFixed(2)}×`}
                />
              </div>
              <button
                onClick={() => {
                  if (videoRef.current) videoRef.current.playbackRate = 1;
                  broadcast('rate');
                }}
                disabled={rate === 1}
                className="rounded-lg bg-white/8 px-2.5 py-1 text-xs hover:bg-white/12 disabled:opacity-40"
              >
                Reset
              </button>
            </div>

            <Heading>
              <span className="inline-flex items-center gap-1.5">
                <WandSparkles className="size-3.5" /> Picture
              </span>
            </Heading>
            <div className="px-3">
              <Segmented
                size="sm"
                value={enhance}
                onChange={(v) => {
                  setEnhance(v);
                  savePrefs.mutate({ ui: { enhance: v } });
                }}
                options={[
                  { value: 'none', label: 'Off' },
                  { value: 'sharpen', label: 'Sharpen' },
                  { value: 'anime4k', label: 'Anime4K' },
                  { value: 'deband', label: 'Deband' },
                  ...(prefs?.ui.customShader ? [{ value: 'custom' as const, label: 'Custom' }] : []),
                ]}
              />
            </div>

            {!isOffline && (
              <>
                <Heading>Stream</Heading>
                <Option active={mode === 'direct'} onClick={() => switchMode('direct')} hint="Best quality">
                  Original
                </Option>
                <Option active={mode === 'remux'} onClick={() => switchMode('remux')} hint="Fixes silent audio">
                  Compatible audio
                </Option>
                {transcodeAllowed &&
                  [480, 720, 1080].map((h) => (
                    <Option key={h} active={mode === 'transcode' && height === h} onClick={() => switchMode('transcode', { height: h })} hint="Converted live">
                      Transcode {h}p
                    </Option>
                  ))}
                {tracks?.video && (
                  <p className="px-3 pt-1 text-xs text-faint">
                    {tracks.video.codec.toUpperCase()} {tracks.video.width}×{tracks.video.height}
                    {tracks.video.hdr ? ' HDR' : ''} · {fmtBytes(playable.size)}
                  </p>
                )}
              </>
            )}

            <Heading>
              <span className="inline-flex items-center gap-1.5">
                <Moon className="size-3.5" /> Sleep timer
              </span>
            </Heading>
            <div className="flex flex-wrap gap-1.5 px-3">
              {SLEEP.map((m) => {
                const active = m === 0 ? !sleepAt && !sleepEnd : m === -1 ? sleepEnd : sleepAt != null && Math.abs(sleepAt - Date.now() - m * 60000) < 60000;
                return (
                  <button
                    key={m}
                    onClick={() => {
                      setSleepEnd(m === -1);
                      setSleepAt(m > 0 ? Date.now() + m * 60_000 : null);
                      if (m) toast(m === -1 ? 'Pausing at the end of this one' : `Pausing in ${m} minutes`);
                    }}
                    className={cls('rounded-lg px-3 py-1.5 text-sm', active ? 'bg-white text-black' : 'bg-white/8 hover:bg-white/12')}
                  >
                    {m === 0 ? 'Off' : m === -1 ? 'End of episode' : `${m}m`}
                  </button>
                );
              })}
            </div>

            <Heading>More</Heading>
            {!isOffline && !p.roomCode && (
              <Option
                onClick={() => {
                  roomRequested.current = false;
                  p.onStartRoom();
                }}
                hint={<Users className="size-4" />}
              >
                <span className="block">Watch together</span>
                <span className="block whitespace-normal text-xs text-faint">Everyone has to be signed in on this same Nova server.</span>
              </Option>
            )}
            {!isOffline && (
              <Option
                onClick={() => {
                  if (saveJob) return offline.cancel(p.itemKey);
                  if (savedOffline) return toast('Already saved on this device');
                  void offline.save(
                    {
                      itemKey: p.itemKey,
                      kind: 'video',
                      mediaId: p.mediaId,
                      mediaType: p.mediaType,
                      title: p.title,
                      subtitle: subtitleLine || null,
                      poster: p.detail?.poster ?? null,
                      season: p.season,
                      episode: p.episode,
                    },
                    playable.path,
                    playable.name,
                    playable.mime,
                  );
                  toast('Saving to this device in the background');
                }}
                hint={saveJob ? `${Math.round(saveJob.progress * 100)}%` : savedOffline ? 'Saved' : <Download className="size-4" />}
              >
                {saveJob ? 'Cancel saving' : 'Save on this device'}
              </Option>
            )}
            {!isOffline && (
              <>
                <Heading>
                  <span className="inline-flex items-center gap-1.5">
                    <ExternalLink className="size-3.5" /> Open in
                  </span>
                </Heading>
                <div className="grid grid-cols-3 gap-1.5 px-3">
                  {(['vlc', 'mpv', 'iina'] as const).map((k) => (
                    <button key={k} onClick={() => external(k)} className={cls('rounded-lg py-2 text-sm font-medium uppercase', prefs?.ui.externalPlayer === k ? 'bg-white text-black' : 'bg-white/8 hover:bg-white/12')}>
                      {k}
                    </button>
                  ))}
                </div>
                <div className="mt-1.5 grid grid-cols-2 gap-1.5 px-3">
                  <button onClick={() => external('copy')} className="flex items-center justify-center gap-1.5 rounded-lg bg-white/8 py-2 text-sm hover:bg-white/12">
                    <Copy className="size-3.5" /> Copy link
                  </button>
                  <button onClick={() => external('m3u')} className="flex items-center justify-center gap-1.5 rounded-lg bg-white/8 py-2 text-sm hover:bg-white/12">
                    <Download className="size-3.5" /> .m3u
                  </button>
                </div>
              </>
            )}
            {playerActions.length > 0 && <Heading>Plugins</Heading>}
            {playerActions.map((a) => (
              <Option
                key={`${a.pluginId}:${a.id}`}
                onClick={async () => {
                  try {
                    const r = await api.plugins.action(a.pluginId, a.id, { mediaId: p.mediaId, itemKey: p.itemKey, position: Math.floor(time), season: p.season, episode: p.episode });
                    if (r.toast) toast(r.toast);
                    if (r.openUrl) window.open(r.openUrl, '_blank', 'noopener');
                  } catch (e) {
                    toast(errorText(e), 'bad');
                  }
                }}
                hint={<Sparkles className="size-4" />}
              >
                {a.label}
              </Option>
            ))}
            <div className="mt-4 flex items-center justify-between px-3 text-sm">
              <span>Autoplay next episode</span>
              <Switch checked={prefs?.ui.autoplayNext ?? true} onChange={(v) => savePrefs.mutate({ ui: { autoplayNext: v } })} />
            </div>
          </Panel>
        )}

        {panel === 'room' && p.roomCode && (
          <Panel title="Watching together" onClose={() => setPanel(null)}>
            <div className="mx-2 rounded-2xl bg-white/6 p-4 text-center">
              <div className="text-xs text-faint">Room code</div>
              <div className="mt-1 font-mono text-3xl font-bold tracking-[0.3em]">{p.roomCode}</div>
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(`${location.origin}/room/${p.roomCode}`);
                  toast('Invite link copied', 'ok');
                }}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-sm font-semibold text-black"
              >
                <Copy className="size-3.5" /> Copy invite link
              </button>
              <p className="mt-3 text-xs text-faint">Only works for people with an account on this server ({location.host}). Nova apps on other servers can't join.</p>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 px-2">
              {room.members.map((m) => (
                <span key={m.id} className="glass inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs">
                  <span className={cls('size-1.5 rounded-full', m.buffering ? 'bg-warn' : 'bg-ok')} />
                  {m.name}
                  {m.host && <span className="text-faint">host</span>}
                </span>
              ))}
            </div>
            <div className="mt-3 space-y-1.5 px-2">
              {room.chat.map((c) => (
                <div key={c.id} className={cls('text-sm', c.kind === 'system' && 'text-xs text-faint italic')}>
                  {c.kind !== 'system' && <span className="mr-1.5 font-semibold">{c.name}</span>}
                  {c.text}
                </div>
              ))}
            </div>
            <div className="sticky bottom-0 mt-3 space-y-2 bg-transparent px-2 pt-2">
              <div className="flex justify-between">
                {['😂', '😮', '😍', '😭', '🔥', '👏'].map((e) => (
                  <button key={e} onClick={() => room.react(e)} className="rounded-lg p-1.5 text-2xl transition-transform hover:scale-125">
                    {e}
                  </button>
                ))}
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (chatText.trim()) room.sendChat(chatText.trim());
                  setChatText('');
                }}
                className="flex gap-2"
              >
                <input value={chatText} onChange={(e) => setChatText(e.target.value)} placeholder="Say something…" className="h-10 flex-1 rounded-xl border border-line bg-white/5 px-3 text-sm focus:outline-none" />
                <button type="submit" aria-label="Send" className="grid size-10 place-items-center rounded-xl bg-white text-black">
                  <ChevronRight className="size-4" />
                </button>
              </form>
            </div>
          </Panel>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {cast && (
          <CastRemote
            cast={cast}
            title={p.title}
            subtitle={subtitleLine || null}
            backdrop={p.detail?.backdrop ?? p.detail?.poster ?? null}
            onStop={(pos) => void stopCast(pos)}
            onProgress={onCastProgress}
            onRestarted={(offset) => setCast((c) => (c ? { ...c, offset } : c))}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
