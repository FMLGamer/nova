import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Play, Star } from 'lucide-react';
import { api } from '../lib/api';
import { episodeLabel, metaLine } from '../lib/format';
import { errorText } from '../lib/store';
import type { CatalogDetail, Episode, MediaFile, PlaySource, Release } from '../lib/types';
import { LogoMark } from '../components/Logo';
import { Button, Chip, Empty, Spinner } from '../components/ui';

/** A deliberately small player for guests: native controls, compatibility fallback, nothing account-bound. */
function GuestPlayer({ source, title, onClose }: { source: PlaySource; title: string; onClose: () => void }) {
  const [compat, setCompat] = useState(false);
  return (
    <div className="fixed inset-0 z-50 bg-black">
      <button onClick={onClose} aria-label="Back" className="absolute top-4 left-4 z-10 grid size-11 place-items-center rounded-full bg-black/50 backdrop-blur hover:bg-black/70">
        <ArrowLeft className="size-6" />
      </button>
      <div className="absolute top-5 left-18 z-10 font-display text-lg font-semibold">{title}</div>
      <video key={String(compat)} src={compat ? `${source.path}/audio` : source.path} controls autoPlay playsInline onError={() => !compat && setCompat(true)} className="size-full object-contain" />
    </div>
  );
}

function GuestTitle({ detail, onBack }: { detail: CatalogDetail; onBack: () => void }) {
  const [season, setSeason] = useState(detail.mediaType === 'anime' ? 1 : (detail.seasons.find((s) => s.season >= 1)?.season ?? 1));
  const episodes = useQuery({ queryKey: ['guest-eps', detail.id, season], queryFn: () => api.shares.episodes(detail.id, season), enabled: detail.mediaType !== 'movie' });
  const [busy, setBusy] = useState<string | null>(null);
  const [playing, setPlaying] = useState<{ source: PlaySource; title: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const start = (ep?: Episode) => {
    const key = ep?.id ?? detail.id;
    setBusy(key);
    setErr(null);
    const es = new EventSource(api.shares.sourcesUrl({ mediaId: detail.id, season: ep?.season, episode: ep?.episode }), { withCredentials: true });
    let picked = false;
    const pick = async (files: MediaFile[], releases: Release[]) => {
      if (picked) return;
      picked = true;
      es.close();
      try {
        const source = files[0] ? await api.shares.prepare({ fileId: files[0].id }) : releases[0] ? await api.shares.prepare({ releaseId: releases[0].id }) : null;
        if (!source) throw new Error('Nothing playable was found for this one');
        setPlaying({ source, title: ep ? `${detail.title} · ${episodeLabel(detail.mediaType, ep.season, ep.episode)}` : detail.title });
      } catch (e) {
        setErr(errorText(e));
      } finally {
        setBusy(null);
      }
    };
    es.addEventListener('update', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { files: MediaFile[]; releases: Release[] };
      if (d.files.length || d.releases.some((r) => r.cached)) void pick(d.files, d.releases);
    });
    es.addEventListener('done', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { files: MediaFile[]; releases: Release[] };
      void pick(d.files, d.releases);
    });
    es.addEventListener('error', () => {
      if (!picked) {
        es.close();
        setBusy(null);
        setErr('Could not find a source');
      }
    });
  };

  if (playing) return <GuestPlayer source={playing.source} title={playing.title} onClose={() => setPlaying(null)} />;
  return (
    <div>
      <div className="relative h-[60svh] min-h-[420px] overflow-hidden">
        {detail.backdrop && <img src={detail.backdrop} alt="" className="absolute inset-0 size-full object-cover" />}
        <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/40 to-transparent" />
        <button onClick={onBack} aria-label="Back" className="absolute top-5 left-5 grid size-11 place-items-center rounded-full bg-black/40 backdrop-blur">
          <ArrowLeft className="size-5" />
        </button>
        <div className="absolute inset-x-0 bottom-0 px-5 pb-8 sm:px-10">
          <h1 className="font-display text-4xl font-bold sm:text-6xl">{detail.title}</h1>
          <div className="mt-2 flex items-center gap-3 text-sm text-white/75">
            {detail.rating ? (
              <span className="flex items-center gap-1">
                <Star className="size-3.5 fill-amber-300 text-amber-300" /> {detail.rating.toFixed(1)}
              </span>
            ) : null}
            {metaLine(detail)}
          </div>
          <p className="mt-3 line-clamp-3 max-w-2xl text-white/75">{detail.overview}</p>
          {detail.mediaType === 'movie' && (
            <Button className="mt-6" size="lg" variant="white" loading={busy === detail.id} icon={<Play className="size-5 fill-current" />} onClick={() => start()}>
              Play
            </Button>
          )}
          {err && <p className="mt-3 text-sm text-bad">{err}</p>}
        </div>
      </div>
      {detail.mediaType !== 'movie' && (
        <div className="px-5 py-6 sm:px-10">
          {detail.mediaType === 'tv' && detail.seasons.length > 1 && (
            <div className="scrollbar-none mb-4 flex gap-2 overflow-x-auto">
              {detail.seasons
                .filter((s) => s.episodeCount > 0)
                .map((s) => (
                  <Chip key={s.season} active={season === s.season} onClick={() => setSeason(s.season)}>
                    {s.name}
                  </Chip>
                ))}
            </div>
          )}
          <div className="grid gap-2 lg:grid-cols-2">
            {episodes.data?.map((ep) => (
              <button key={ep.id} onClick={() => start(ep)} className="flex gap-4 rounded-2xl p-2 text-left hover:bg-white/5">
                <div className="relative aspect-video w-40 shrink-0 overflow-hidden rounded-xl bg-ink-800">
                  {ep.still && <img src={ep.still} alt="" className="size-full object-cover" />}
                  {busy === ep.id && (
                    <div className="absolute inset-0 grid place-items-center bg-black/50">
                      <Spinner className="size-6 text-white" />
                    </div>
                  )}
                </div>
                <div className="min-w-0 py-1">
                  <div className="text-xs text-faint">{episodeLabel(detail.mediaType, ep.season, ep.episode)}</div>
                  <div className="truncate font-semibold">{ep.title}</div>
                  <p className="mt-1 line-clamp-2 text-sm text-muted">{ep.overview}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ShareGuest() {
  const { token = '' } = useParams();
  const [redeemed, setRedeemed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<CatalogDetail | null>(null);
  useEffect(() => {
    api.shares
      .redeem(token)
      .then(() => setRedeemed(token))
      .catch((e) => setError(errorText(e)));
  }, [token]);
  const guest = useQuery({ queryKey: ['guest', redeemed], queryFn: api.shares.guest, enabled: Boolean(redeemed) });

  if (error) return <Empty title="This link doesn't work anymore">{error}</Empty>;
  if (!guest.data) return <div className="grid min-h-dvh place-items-center"><Spinner className="size-8" /></div>;
  if (open) return <GuestTitle detail={open} onBack={() => setOpen(null)} />;
  const { share, owner, items } = guest.data;
  if (items.length === 1 && share.scope === 'title') return <GuestTitle detail={items[0]!} onBack={() => undefined} />;
  return (
    <div className="px-5 py-10 sm:px-10">
      <div className="flex items-center gap-3">
        <LogoMark className="size-9" />
        <div>
          <div className="text-xs text-faint">{owner} shared with you</div>
          <h1 className="font-display text-3xl font-bold">{share.label ?? 'A collection'}</h1>
        </div>
      </div>
      {share.expiresAt && <p className="mt-2 text-sm text-muted">Available until {new Date(share.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}.</p>}
      <div className="mt-8 grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-x-4 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(170px,1fr))]">
        {items.map((d, i) => (
          <motion.button key={d.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }} onClick={() => setOpen(d)} className="group text-left">
            <div className="aspect-[2/3] overflow-hidden rounded-2xl bg-ink-800 ring-1 ring-white/6 transition group-hover:-translate-y-1 group-hover:ring-white/20">
              {d.poster && <img src={d.poster} alt="" loading="lazy" className="size-full object-cover" />}
            </div>
            <div className="mt-2 truncate text-sm font-semibold">{d.title}</div>
            <div className="text-xs text-faint">{d.year}</div>
          </motion.button>
        ))}
      </div>
    </div>
  );
}
