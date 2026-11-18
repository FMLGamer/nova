// Settings → Customize (what each page shows), Settings → Beta, and importing a viewing history.
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, RotateCcw, Upload, X } from 'lucide-react';
import { api } from '../lib/api';
import { PAGES, layoutPatch, pageLayout, type PageId } from '../lib/layout';
import { useSession } from '../lib/queries';
import { errorText, toast } from '../lib/store';
import type { HeroSize, Preferences } from '../lib/types';
import { Button, Card, Chip, Row, Segmented, Switch } from '../components/ui';

function Group({ title, children, hint }: { title: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <Card className="mb-5">
      <h3 className="font-display text-lg font-semibold">{title}</h3>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
      <div className="mt-2 divide-y divide-line">{children}</div>
    </Card>
  );
}

const SIZES: { value: HeroSize; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
  { value: 'full', label: 'Full' },
];

const NAV_TABS = [
  { id: 'movies', label: 'Movies' },
  { id: 'shows', label: 'Shows' },
  { id: 'anime', label: 'Anime' },
  { id: 'live', label: 'Live' },
  { id: 'read', label: 'Read' },
  { id: 'music', label: 'Music' },
];

export function CustomizeSection({ p, set }: { p: Preferences; set: (x: object) => void }) {
  const { data: session } = useSession();
  const live = Boolean(session?.settings.liveTvEnabled);
  const music = Boolean(session?.settings.musicBooksEnabled && p.ui.musicAndBooks);
  const pages = (Object.keys(PAGES) as PageId[]).filter((id) => id !== 'live' || live);
  const [page, setPage] = useState<PageId>('home');
  const def = PAGES[page];
  const saved = p.layout?.[page];
  const layout = pageLayout(page, p);
  const change = (c: Parameters<typeof layoutPatch>[3]) => set(layoutPatch(page, layout, saved, c));
  const available = def.sections.filter((d) => !layout.sections.includes(d.id));
  const label = (id: string) => def.sections.find((d) => d.id === id);
  const navHidden = new Set(p.ui.navHidden ?? []);

  return (
    <>
      <Group title="Pages" hint="Choose what every page shows, in which order, and how big its banner is.">
        <div className="py-3">
          <Segmented value={page} onChange={setPage} options={pages.map((id) => ({ value: id, label: PAGES[id].label }))} />
        </div>
        <Row label="Banner" hint={def.heroLabel}>
          <Switch checked={layout.hero} onChange={(v) => change({ hero: v })} label="Show the banner" />
        </Row>
        {layout.hero && (
          <Row label="Banner size">
            <Segmented size="sm" value={layout.heroSize} onChange={(v) => change({ heroSize: v })} options={SIZES} />
          </Row>
        )}
        {def.sections.length > 0 && (
          <div className="py-3">
            <div className="mb-1 text-xs font-semibold tracking-wider text-faint uppercase">On this page</div>
            {!layout.sections.length && <p className="py-3 text-sm text-muted">Nothing yet: add a section below.</p>}
            {layout.sections.map((id, i) => (
              <motion.div layout key={id} className="flex items-center gap-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{label(id)?.label ?? id}</span>
                  <span className="block truncate text-xs text-faint">{label(id)?.hint}</span>
                </span>
                <button disabled={i === 0} onClick={() => change({ move: [i, -1] })} aria-label="Move up" className="rounded-lg p-1.5 text-muted hover:bg-white/8 disabled:opacity-30">
                  <ArrowUp className="size-4" />
                </button>
                <button disabled={i === layout.sections.length - 1} onClick={() => change({ move: [i, 1] })} aria-label="Move down" className="rounded-lg p-1.5 text-muted hover:bg-white/8 disabled:opacity-30">
                  <ArrowDown className="size-4" />
                </button>
                <button onClick={() => change({ remove: id })} aria-label={`Remove ${label(id)?.label ?? id}`} title="Remove" className="rounded-lg p-1.5 text-muted hover:bg-white/8 hover:text-bad">
                  <X className="size-4" />
                </button>
              </motion.div>
            ))}
          </div>
        )}
        {available.length > 0 && (
          <div className="py-3">
            <div className="mb-2 text-xs font-semibold tracking-wider text-faint uppercase">Add a section</div>
            <div className="flex flex-wrap gap-1.5">
              {available.map((d) => (
                <button key={d.id} onClick={() => change({ add: d.id })} title={d.hint} className="flex items-center gap-1.5 rounded-full border border-dashed border-line-strong px-3 py-1.5 text-sm text-muted transition hover:border-white/40 hover:text-fg">
                  <Plus className="size-3.5" /> {d.label}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex justify-end py-3">
          <Button size="sm" variant="ghost" icon={<RotateCcw className="size-4" />} onClick={() => change({ reset: true })} disabled={!saved}>
            Restore {def.label}'s defaults
          </Button>
        </div>
      </Group>
      <Group title="Top bar" hint="Tabs you never use can go. Everything stays reachable from search.">
        <div className="flex flex-wrap gap-1.5 py-3">
          {NAV_TABS.filter((t) => (t.id !== 'live' || live) && (t.id !== 'music' || music)).map((t) => (
            <Chip key={t.id} active={!navHidden.has(t.id)} onClick={() => set({ ui: { navHidden: navHidden.has(t.id) ? [...navHidden].filter((x) => x !== t.id) : [...navHidden, t.id] } })}>
              {t.label}
            </Chip>
          ))}
        </div>
      </Group>
    </>
  );
}

export function BetaSection({ p, set }: { p: Preferences; set: (x: object) => void }) {
  return (
    <Group title="Beta" hint="Features that are still being shaped. They're all off until you switch them on, and may change or go away.">
      <Row label="Month view in the anime schedule" hint="“This week” above the schedule becomes a menu with a month view.">
        <Switch checked={p.beta.monthSchedule} onChange={(v) => set({ beta: { monthSchedule: v } })} />
      </Row>
      <Row label="Episode counts on cards" hint="Series and anime cards show how many episodes you've watched.">
        <Switch checked={p.beta.episodeCounts} onChange={(v) => set({ beta: { episodeCounts: v } })} />
      </Row>
    </Group>
  );
}

/** Settings → Profile: bring a viewing history over from Netflix, Letterboxd or a CSV of titles. */
export function ImportHistory() {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const job = useQuery({
    queryKey: ['import-job', jobId],
    queryFn: () => api.me.importJob(jobId!),
    enabled: Boolean(jobId),
    refetchInterval: (q) => (q.state.data?.state === 'running' ? 1500 : false),
  });
  const j = job.data;
  useEffect(() => {
    if (j?.state !== 'done') return;
    for (const key of ['summary', 'continue', 'upnext', 'recommendations', 'profile-stats']) qc.invalidateQueries({ queryKey: [key] });
  }, [j?.state, qc]);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      setJobId((await api.me.importHistory(await file.text())).id);
    } catch (e) {
      toast(errorText(e), 'bad');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <Group
      title="Bring your history"
      hint={
        <>
          Import what you watched elsewhere so Nova knows what you've seen. On Netflix: Account → Profile → Viewing activity → Download all. Letterboxd's
          watched.csv works too, as does any CSV with a Title column.
        </>
      }
    >
      <div className="py-3">
        <input ref={input} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
        {!j || j.state !== 'running' ? (
          <Button icon={<Upload className="size-4" />} loading={busy} onClick={() => input.current?.click()}>
            Choose a CSV file
          </Button>
        ) : (
          <div>
            <div className="flex items-center justify-between text-sm">
              <span>Matching titles… {j.done} of {j.total}</span>
              <span className="text-faint">{j.episodes + j.movies} added so far</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
              <div className="bg-gradient-accent h-full transition-[width]" style={{ width: `${j.total ? (j.done / j.total) * 100 : 0}%` }} />
            </div>
          </div>
        )}
        {j && j.state !== 'running' && (
          <div className="mt-4 text-sm">
            {j.state === 'failed' ? (
              <p className="text-bad">The import stopped: {j.error}</p>
            ) : (
              <p>
                <span className="font-semibold">Done.</span> {j.episodes} episode{j.episodes === 1 ? '' : 's'} of {j.shows} show{j.shows === 1 ? '' : 's'} and {j.movies} film{j.movies === 1 ? '' : 's'} added to your history
                {j.source === 'netflix' ? ' from Netflix' : j.source === 'letterboxd' ? ' from Letterboxd' : ''}.
              </p>
            )}
            {j.unmatched.length > 0 && (
              <details className="mt-2 text-muted">
                <summary className="cursor-pointer">{j.unmatched.length} not recognised</summary>
                <ul className="mt-2 max-h-48 list-disc overflow-y-auto pl-5 text-xs">
                  {j.unmatched.map((u, i) => (
                    <li key={i}>{u}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
    </Group>
  );
}
