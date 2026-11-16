import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Music2, Play, Search, Shuffle } from 'lucide-react';
import { api } from '../lib/api';
import { resolveAudio, useAudio } from '../lib/audio';
import { cls, fmtClock } from '../lib/format';
import { usePrefs, useSession } from '../lib/queries';
import { errorText, toast, useApp } from '../lib/store';
import type { Album } from '../lib/types';
import { Rail, RailSkeleton } from '../components/media';
import { Button, Empty, Spinner } from '../components/ui';
import { Kicker } from './Browse';

function AlbumCard({ a }: { a: Album }) {
  const [broken, setBroken] = useState(false);
  return (
    <Link to={`/music/album/${a.id}`} className="group block">
      <div className="relative aspect-square overflow-hidden rounded-2xl bg-gradient-to-br from-ink-700 to-ink-900 shadow-lg ring-1 ring-white/6 transition-[translate,box-shadow] duration-200 group-hover:-translate-y-1 group-hover:ring-white/20">
        {a.cover && !broken ? (
          <img src={a.cover} alt="" loading="lazy" onError={() => setBroken(true)} className="size-full object-cover" />
        ) : (
          <Music2 className="absolute inset-0 m-auto size-10 text-faint" />
        )}
        <span className="bg-gradient-accent absolute right-2 bottom-2 grid size-11 translate-y-2 place-items-center rounded-full text-on-accent opacity-0 shadow-xl transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100">
          <Play className="size-5 translate-x-px fill-current" />
        </span>
      </div>
      <div className="mt-2.5 truncate text-[13.5px] font-semibold">{a.title}</div>
      <div className="truncate text-xs text-faint">
        {a.artist}
        {a.year ? ` · ${a.year}` : ''}
      </div>
    </Link>
  );
}

function MusicHome() {
  const [q, setQ] = useState('');
  const home = useQuery({ queryKey: ['music-home'], queryFn: api.media.musicHome, staleTime: 60 * 60_000 });
  const search = useQuery({ queryKey: ['music-search', q], queryFn: () => api.media.musicSearch(q), enabled: q.length >= 2, staleTime: 10 * 60_000 });
  return (
    <div className="space-y-10 pb-10">
      <div className="px-5 pt-24 sm:px-10 sm:pt-28">
        <Kicker tone="#b48cff">Albums · Artists</Kicker>
        <h1 className="font-display text-4xl font-bold tracking-tight sm:text-6xl">Music</h1>
        <label className="glass mt-6 flex h-12 max-w-xl items-center gap-3 rounded-2xl px-4">
          <Search className="size-5 text-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Albums or artists" className="flex-1 bg-transparent focus:outline-none" />
          {search.isFetching && <Spinner className="size-4" />}
        </label>
      </div>
      {q.length >= 2 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-x-4 gap-y-6 px-5 sm:grid-cols-[repeat(auto-fill,minmax(170px,1fr))] sm:px-10">
          {search.data?.map((a) => <AlbumCard key={a.id} a={a} />)}
        </div>
      ) : home.isLoading ? (
        <RailSkeleton />
      ) : (
        home.data?.map((r) => (
          <Rail key={r.id} title={r.title}>
            {r.items.map((a) => (
              <AlbumCard key={a.id} a={a} />
            ))}
          </Rail>
        ))
      )}
    </div>
  );
}

function AlbumPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data: a, isLoading } = useQuery({ queryKey: ['album', id], queryFn: () => api.media.album(id) });
  const more = useQuery({ queryKey: ['artist', a?.artistId], queryFn: () => api.media.artist(a!.artistId!), enabled: Boolean(a?.artistId) });
  const audio = useAudio();
  const setAmbient = useApp((s) => s.setAmbient);
  const [busy, setBusy] = useState(false);
  useEffect(() => setAmbient(a?.cover ?? null), [a?.cover, setAmbient]);

  const playing = audio.context?.href === `/music/album/${id}`;
  const play = async (start = 0, shuffle = false) => {
    if (!a) return;
    if (playing && audio.queue.length) {
      audio.jumpTo(start);
      return;
    }
    setBusy(true);
    try {
      const tracks = await resolveAudio({ mediaId: `music:${a.id}`, title: a.title, creator: a.artist, cover: a.cover, itemKey: `music:${a.id}` });
      if (!tracks.length) throw new Error('No source found for this album');
      // Name tracks from the official tracklist when the counts line up.
      const named = tracks.length === a.tracks.length ? tracks.map((t, i) => ({ ...t, title: a.tracks[i]!.title })) : tracks;
      audio.setShuffle(shuffle);
      audio.playQueue(named, Math.min(start, named.length - 1), { title: a.title, href: `/music/album/${a.id}` });
    } catch (e) {
      toast(errorText(e), 'bad');
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) return <div className="grid min-h-[60vh] place-items-center"><Spinner className="size-7" /></div>;
  if (!a) return <Empty title="Album not found" />;
  return (
    <div className="px-5 pt-24 pb-16 sm:px-10 sm:pt-28">
      <div className="flex flex-col gap-8 sm:flex-row sm:items-end">
        <motion.div initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} className="bg-gradient-accent w-56 shrink-0 self-center overflow-hidden rounded-3xl shadow-[0_30px_80px_-20px_rgb(0_0_0/0.9)] ring-1 ring-white/10 sm:w-64 sm:self-auto">
          {a.cover ? (
            <img src={a.cover} alt="" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} className="aspect-square w-full object-cover" />
          ) : (
            <div className="bg-gradient-accent aspect-square" />
          )}
        </motion.div>
        <div className="min-w-0">
          <div className="text-xs font-semibold tracking-widest text-faint uppercase">{a.primaryType ?? 'Album'}</div>
          <h1 className="mt-2 font-display text-4xl leading-tight font-bold sm:text-6xl">{a.title}</h1>
          <div className="mt-3 text-muted">
            <button onClick={() => more.data && window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })} className="font-semibold text-fg hover:underline">
              {a.artist}
            </button>
            {a.year ? ` · ${a.year}` : ''} · {a.tracks.length} songs{a.totalMs ? ` · ${Math.round(a.totalMs / 60000)} min` : ''}
          </div>
          <div className="mt-6 flex gap-3">
            <Button variant="primary" size="lg" loading={busy} icon={<Play className="size-5 fill-current" />} onClick={() => play(0)}>
              Play
            </Button>
            <Button variant="glass" size="lg" icon={<Shuffle className="size-5" />} onClick={() => play(0, true)}>
              Shuffle
            </Button>
          </div>
        </div>
      </div>
      <div className="mt-10 max-w-3xl">
        {a.tracks.map((t, i) => {
          const current = playing && audio.index === i;
          return (
            <button key={t.id} onClick={() => play(i)} className={cls('group flex w-full items-center gap-4 rounded-xl px-3 py-2.5 text-left transition-colors', current ? 'bg-white/10' : 'hover:bg-white/5')}>
              <span className={cls('w-6 text-right text-sm tabular-nums', current ? 'text-accent' : 'text-faint')}>{current && audio.playing ? '♪' : t.position}</span>
              <span className={cls('flex-1 truncate text-sm', current && 'text-accent')}>{t.title}</span>
              <span className="text-xs text-faint tabular-nums">{t.lengthMs ? fmtClock(t.lengthMs / 1000) : ''}</span>
            </button>
          );
        })}
      </div>
      {more.data && more.data.length > 1 && (
        <div className="-mx-5 mt-12 sm:-mx-10">
          <Rail title={`More by ${a.artist}`}>
            {more.data.filter((x) => x.id !== a.id).map((x) => (
              <AlbumCard key={x.id} a={x} />
            ))}
          </Rail>
        </div>
      )}
      <button onClick={() => navigate('/music')} className="mt-8 text-sm text-muted hover:text-fg">
        ← All music
      </button>
    </div>
  );
}

export default function Music() {
  const { data: session } = useSession();
  const { data: prefs } = usePrefs();
  if (session && (!session.settings.musicBooksEnabled || prefs?.ui.musicAndBooks === false)) {
    return <Empty icon={<Music2 />} title="Music is off">Turn on “Music & books” in Settings (an admin has to enable it for your account first).</Empty>;
  }
  return (
    <Routes>
      <Route index element={<MusicHome />} />
      <Route path="album/:id" element={<AlbumPage />} />
    </Routes>
  );
}
