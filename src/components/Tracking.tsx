// AniList / MyAnimeList list entries for one anime or manga: status, progress and score (both sites at once).
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { api } from '../lib/api';
import { errorText, toast } from '../lib/store';
import type { TrackedShow, TrackEntry, TrackStatus } from '../lib/types';
import { Button, Chip, Input, Modal, Slider, Spinner } from './ui';

type Kind = 'anime' | 'manga';

const STATUSES: TrackStatus[] = ['watching', 'rewatching', 'completed', 'planning', 'paused', 'dropped'];
const LABELS: Record<Kind, Record<TrackStatus, string>> = {
  anime: { watching: 'Watching', rewatching: 'Rewatching', completed: 'Completed', planning: 'Plan to watch', paused: 'On hold', dropped: 'Dropped' },
  manga: { watching: 'Reading', rewatching: 'Rereading', completed: 'Completed', planning: 'Plan to read', paused: 'On hold', dropped: 'Dropped' },
};

export const trackStatusLabel = (s: TrackStatus, kind: Kind = 'anime') => LABELS[kind][s];

export function useTrackersConnected() {
  const trackers = useQuery({ queryKey: ['trackers'], queryFn: api.trackers.status, staleTime: 5 * 60_000 });
  return Boolean(trackers.data?.anilist.connected || trackers.data?.mal.connected);
}

export function useTrackEntry(mediaId: string | null, enabled: boolean) {
  return useQuery({ queryKey: ['track-entry', mediaId], queryFn: () => api.trackers.entry(mediaId!), enabled: Boolean(enabled && mediaId), staleTime: 60_000 });
}

const NO_TRACKED = new Map<string, TrackedShow>();

/** The connected lists' anime by Nova id (empty without a tracker), for watched marks on cards and in the schedule. */
export function useTrackedAnime(): Map<string, TrackedShow> {
  const connected = useTrackersConnected();
  const { data } = useQuery({
    queryKey: ['tracker-lists', 'anime'],
    queryFn: () => api.trackers.lists('anime'),
    enabled: connected,
    staleTime: 5 * 60_000,
    select: (items) => new Map(items.map((i) => [i.mediaId, i])),
  });
  return data ?? NO_TRACKED;
}

export function TrackingModal({ mediaId, total: knownTotal, kind, onClose }: { mediaId: string; total: number | null; kind: Kind; onClose: () => void }) {
  const qc = useQueryClient();
  const entry = useTrackEntry(mediaId, true);
  const current = entry.data?.anilist ?? entry.data?.mal ?? null;
  const [status, setStatus] = useState<TrackStatus | ''>('');
  const [progress, setProgress] = useState(0);
  const [score, setScore] = useState(0);
  const [saving, setSaving] = useState(false);
  const unit = kind === 'anime' ? 'Episodes watched' : 'Chapters read';
  useEffect(() => {
    if (!current) return;
    setStatus(current.status ?? '');
    setProgress(current.progress);
    setScore(current.score ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.data]);
  const total = entry.data?.episodes ?? knownTotal ?? null;
  const save = async () => {
    setSaving(true);
    try {
      qc.setQueryData(['track-entry', mediaId], await api.trackers.setEntry(mediaId, { status: status || undefined, progress, score: score || null }));
      qc.invalidateQueries({ queryKey: ['tracker-lists'] });
      qc.invalidateQueries({ queryKey: ['tracker-watching'] });
      toast('Your lists are updated', 'ok');
      onClose();
    } catch (e) {
      toast(errorText(e), 'bad');
    } finally {
      setSaving(false);
    }
  };
  const line = (site: string, e: TrackEntry | null | undefined) =>
    e !== undefined && (
      <div className="flex items-center justify-between gap-3 py-2 text-sm">
        <span className="font-medium">{site}</span>
        {e ? (
          <a href={e.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-muted hover:text-fg">
            {e.status ? trackStatusLabel(e.status, kind) : 'Not on your list'}
            {e.progress ? ` · ${e.progress}${total ? ` / ${total}` : ''}` : ''}
            {e.score ? ` · ★ ${e.score}` : ''}
            <ExternalLink className="size-3.5" />
          </a>
        ) : (
          <span className="text-faint">Not on MyAnimeList</span>
        )}
      </div>
    );
  return (
    <Modal open onClose={onClose} title="Tracking">
      {entry.isLoading ? (
        <div className="grid h-24 place-items-center">
          <Spinner />
        </div>
      ) : entry.error ? (
        <p className="text-sm text-bad">{errorText(entry.error)}</p>
      ) : (
        <>
          <div className="divide-y divide-line">
            {line('AniList', entry.data?.anilist)}
            {line('MyAnimeList', entry.data?.mal)}
          </div>
          <div className="mt-4 text-xs font-semibold tracking-wider text-faint uppercase">Status</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {STATUSES.map((s) => (
              <Chip key={s} active={status === s} onClick={() => setStatus(s)}>
                {trackStatusLabel(s, kind)}
              </Chip>
            ))}
          </div>
          <div className="mt-5 text-xs font-semibold tracking-wider text-faint uppercase">{unit}</div>
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" onClick={() => setProgress((p) => Math.max(0, p - 1))} aria-label="One fewer">
              −
            </Button>
            <Input
              type="number"
              min={0}
              max={total ?? undefined}
              value={progress}
              onChange={(e) => setProgress(Math.max(0, Math.min(total ?? 100000, Number(e.target.value) || 0)))}
              className="w-24 text-center"
              aria-label={unit}
            />
            <Button size="sm" onClick={() => setProgress((p) => (total ? Math.min(total, p + 1) : p + 1))} aria-label="One more">
              +
            </Button>
            {total && <span className="text-sm text-muted">of {total}</span>}
            {total && progress < total && (
              <button onClick={() => setProgress(total)} className="ml-auto text-xs text-muted hover:text-fg">
                All {kind === 'anime' ? 'watched' : 'read'}
              </button>
            )}
          </div>
          <div className="mt-5 text-xs font-semibold tracking-wider text-faint uppercase">Your score</div>
          <div className="mt-1">
            <Slider value={score} min={0} max={10} step={0.5} onChange={setScore} format={(v) => (v ? `★ ${v.toFixed(1)}` : 'No score')} />
            {entry.data?.mal !== undefined && score % 1 !== 0 && <p className="mt-1 text-xs text-faint">MyAnimeList only keeps whole numbers: it gets {Math.round(score)}.</p>}
          </div>
          <div className="mt-6 flex justify-end">
            <Button variant="white" loading={saving} onClick={save}>
              Save to your lists
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
