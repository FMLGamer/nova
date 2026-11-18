// Library tabs: your AniList / MyAnimeList lists, and what you've watched and read in numbers.
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, ListChecks } from 'lucide-react';
import { api, retryUpstream } from '../lib/api';
import { cls, kindLabel, titlePath } from '../lib/format';
import { errorText } from '../lib/store';
import type { TrackStatus } from '../lib/types';
import { PosterCard } from '../components/media';
import { ReadCard } from '../components/ReadCard';
import { trackStatusLabel } from '../components/Tracking';
import { Card, Chip, Empty, Segmented, Spinner } from '../components/ui';

const STATUS: TrackStatus[] = ['watching', 'rewatching', 'planning', 'completed', 'paused', 'dropped'];

export function TrackerLists() {
  const status = useQuery({ queryKey: ['trackers'], queryFn: api.trackers.status, staleTime: 5 * 60_000 });
  const connected = Boolean(status.data?.anilist.connected || status.data?.mal.connected);
  const [kind, setKind] = useState<'anime' | 'manga'>('anime');
  const lists = useQuery({ queryKey: ['tracker-lists', kind], queryFn: () => api.trackers.lists(kind), enabled: connected, staleTime: 60_000, retry: retryUpstream });
  const [tab, setTab] = useState<TrackStatus>('watching');
  const counts = useMemo(() => new Map(STATUS.map((s) => [s, (lists.data ?? []).filter((i) => i.status === s).length])), [lists.data]);
  if (status.isLoading) return <Spinner />;
  if (!connected)
    return (
      <Empty icon={<ListChecks />} title="Connect AniList or MyAnimeList" action={<Link to="/settings/tracking" className="text-sm font-semibold underline">Open Settings → Anime & manga tracking</Link>}>
        Your anime and manga lists show up here, and Nova keeps them up to date as you watch and read.
      </Empty>
    );
  const shown = (lists.data ?? []).filter((i) => i.status === tab);
  const unit = kind === 'anime' ? 'episodes' : 'chapters';
  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: 'anime', label: 'Anime' },
            { value: 'manga', label: 'Manga' },
          ]}
        />
        <div className="scrollbar-none -mx-5 flex min-w-0 flex-1 gap-2 overflow-x-auto px-5 sm:mx-0 sm:px-0">
          {STATUS.map((s) => (
            <Chip key={s} active={tab === s} onClick={() => setTab(s)}>
              {trackStatusLabel(s, kind)}
              <span className="text-[11px] opacity-60">{counts.get(s)}</span>
            </Chip>
          ))}
        </div>
      </div>
      {lists.isLoading ? (
        <Spinner />
      ) : lists.error ? (
        <p className="text-sm text-bad">{errorText(lists.error)}</p>
      ) : !shown.length ? (
        <p className="py-10 text-center text-sm text-muted">Nothing here.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-x-4 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(168px,1fr))]">
          {shown.map((s) => {
            const hint = (
              <>
                {s.progress}
                {s.episodes ? ` / ${s.episodes}` : ''} {unit}
                {s.score ? <span className="nova-score"> · ★ {s.score}</span> : null}
              </>
            );
            return kind === 'anime' ? (
              <PosterCard key={s.mediaId} item={{ id: s.mediaId, mediaType: 'anime', title: s.title, year: null, poster: s.poster }} hint={hint} />
            ) : (
              <ReadCard key={s.mediaId} item={{ id: s.mediaId, format: 'manga', title: s.title, poster: s.poster }} hint={hint} />
            );
          })}
        </div>
      )}
    </>
  );
}

const hours = (s: number) => (s >= 36_000 ? `${Math.round(s / 3600)}` : (s / 3600).toFixed(1));

function Big({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <Card className="!p-5">
      <div className="font-display text-3xl font-bold tabular-nums sm:text-4xl">{value}</div>
      <div className="mt-1 text-sm text-muted">{label}</div>
    </Card>
  );
}

function Bars({ rows, label }: { rows: { key: string; label: string; value: number }[]; label: (v: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-3 text-sm">
          <span className="w-28 shrink-0 truncate text-muted">{r.label}</span>
          <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-white/6">
            <span className="bg-gradient-accent block h-full rounded-full" style={{ width: `${(r.value / max) * 100}%` }} />
          </span>
          <span className="w-16 shrink-0 text-right text-xs text-faint tabular-nums">{label(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

export function Stats() {
  const { data, isLoading, error } = useQuery({ queryKey: ['profile-stats'], queryFn: api.me.stats, staleTime: 5 * 60_000 });
  if (isLoading) return <Spinner />;
  if (error || !data) return <p className="text-sm text-bad">{errorText(error)}</p>;
  if (!data.totals.titles && !data.reading.length)
    return (
      <Empty icon={<BarChart3 />} title="Nothing to count yet">
        Watch or read something and your numbers show up here.
      </Empty>
    );
  const maxMonth = Math.max(1, ...data.months.map((m) => m.seconds));
  const read = data.reading.reduce((n, r) => n + r.finished, 0);
  return (
    <div className="space-y-6 pb-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Big value={hours(data.totals.seconds)} label="hours watched" />
        <Big value={data.totals.episodes} label="episodes finished" />
        <Big value={data.totals.movies} label="films finished" />
        <Big value={read} label="books & volumes finished" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h3 className="mb-4 font-display text-lg font-semibold">The last twelve months</h3>
          <div className="flex h-40 items-end gap-1.5">
            {data.months.map((m) => (
              <div key={m.month} className="flex h-full flex-1 flex-col justify-end" title={`${hours(m.seconds)} h`}>
                <div className={cls('rounded-t-md', m.seconds ? 'bg-gradient-accent' : 'bg-white/6')} style={{ height: `${Math.max(3, (m.seconds / maxMonth) * 100)}%` }} />
                <div className="mt-1.5 text-center text-[10px] text-faint">{new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'narrow', timeZone: 'UTC' })}</div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-sm text-muted">
            Active on {data.totals.activeDays} of the last 30 days{data.totals.streak > 1 ? ` · ${data.totals.streak}-day streak` : ''}.
          </p>
        </Card>
        <Card>
          <h3 className="mb-4 font-display text-lg font-semibold">What you watch</h3>
          <Bars rows={data.byType.map((t) => ({ key: t.type, label: t.type === 'movie' ? 'Films' : kindLabel(t.type), value: t.seconds }))} label={(v) => `${hours(v)} h`} />
          {data.genres.length > 0 && (
            <>
              <h4 className="mt-6 mb-3 text-xs font-semibold tracking-wider text-faint uppercase">Favourite genres</h4>
              <Bars rows={data.genres.map((g) => ({ key: g.name, label: g.name, value: g.seconds }))} label={(v) => `${hours(v)} h`} />
            </>
          )}
        </Card>
      </div>
      {data.top.length > 0 && (
        <Card>
          <h3 className="mb-4 font-display text-lg font-semibold">Most watched</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {data.top.map((t, i) => (
              <Link key={t.mediaId} to={titlePath(t.mediaId)} className="flex items-center gap-3 rounded-2xl p-2 hover:bg-white/5">
                <span className="w-5 text-right font-display text-lg text-faint tabular-nums">{i + 1}</span>
                <div className="h-14 w-10 shrink-0 overflow-hidden rounded-lg bg-ink-800">{t.poster && <img src={t.poster} alt="" loading="lazy" className="size-full object-cover" />}</div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{t.title}</div>
                  <div className="text-xs text-faint">
                    {hours(t.seconds)} h{t.episodes ? ` · ${t.episodes} episodes` : ''}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
