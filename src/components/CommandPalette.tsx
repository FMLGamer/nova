import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, BookOpen, CalendarDays, Clapperboard, CornerDownLeft, Film, House, Library, Radio, Search, Settings, Shield, Sparkles, Swords, Tv } from 'lucide-react';
import { api } from '../lib/api';
import { cls, kindLabel, titlePath } from '../lib/format';
import { useContributions, useSession } from '../lib/queries';
import { toast, useApp } from '../lib/store';

interface Entry {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
  image?: string | null;
  run: () => void;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function CommandPalette() {
  const open = useApp((s) => s.palette);
  const setOpen = useApp((s) => s.setPalette);
  return createPortal(
    <AnimatePresence>{open && <Palette onClose={() => setOpen(false)} />}</AnimatePresence>,
    document.body,
  );
}

function Palette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const query = useDebounced(q.trim(), 220);
  const listRef = useRef<HTMLDivElement>(null);
  const { data: session } = useSession();
  const { data: contrib } = useContributions();
  const openAssistant = useApp((s) => s.openAssistant);

  const search = useQuery({ queryKey: ['palette-search', query], queryFn: () => api.catalog.search(query), enabled: query.length >= 2, staleTime: 60_000 });
  const pluginSearch = useQuery({
    queryKey: ['palette-plugin-search', query, contrib?.searchCatalogs.length],
    enabled: query.length >= 2 && Boolean(contrib?.searchCatalogs.length),
    staleTime: 60_000,
    queryFn: async () => {
      const results = await Promise.all(
        (contrib?.searchCatalogs ?? []).slice(0, 4).map((c) =>
          api.plugins
            .catalog(c.pluginId, c.type, c.id, { search: query })
            .then((metas) => metas.slice(0, 4).map((m) => ({ meta: m, catalog: c })))
            .catch(() => []),
        ),
      );
      return results.flat();
    },
  });

  const go = (to: string) => () => {
    onClose();
    navigate(to);
  };

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    const ql = q.trim().toLowerCase();
    const s = search.data;
    if (s) {
      const all = [...s.movies.slice(0, 4), ...s.shows.slice(0, 4), ...s.anime.slice(0, 4)];
      for (const it of all) {
        out.push({
          id: it.id,
          group: 'Titles',
          label: it.title,
          hint: [it.year, kindLabel(it.mediaType)].filter(Boolean).join(' · '),
          image: it.poster,
          run: go(titlePath(it.id)),
        });
      }
    }
    for (const r of pluginSearch.data ?? []) {
      out.push({
        id: `p:${r.catalog.pluginId}:${r.meta.id}`,
        group: `From ${r.catalog.pluginName}`,
        label: r.meta.name,
        hint: r.meta.releaseInfo,
        image: r.meta.poster,
        run: go(`/x/${encodeURIComponent(r.catalog.pluginId)}/${encodeURIComponent(r.meta.type)}/${encodeURIComponent(r.meta.id)}`),
      });
    }
    if (ql.length >= 2) {
      out.push({ id: 'all', group: 'Titles', label: `See all results for “${q.trim()}”`, icon: <ArrowRight className="size-4" />, run: go(`/search?q=${encodeURIComponent(q.trim())}`) });
    }
    const pages: Entry[] = [
      { id: 'home', group: 'Go to', label: 'Home', icon: <House className="size-4" />, run: go('/') },
      { id: 'movies', group: 'Go to', label: 'Movies', icon: <Film className="size-4" />, run: go('/movies') },
      { id: 'shows', group: 'Go to', label: 'Shows', icon: <Tv className="size-4" />, run: go('/shows') },
      { id: 'anime', group: 'Go to', label: 'Anime', icon: <Swords className="size-4" />, run: go('/anime') },
      { id: 'schedule', group: 'Go to', label: 'Anime schedule', icon: <CalendarDays className="size-4" />, run: go('/anime#schedule') },
      { id: 'read', group: 'Go to', label: 'Read', icon: <BookOpen className="size-4" />, run: go('/read') },
      { id: 'library', group: 'Go to', label: 'My library', icon: <Library className="size-4" />, run: go('/library') },
      { id: 'calendar', group: 'Go to', label: 'Airing calendar', icon: <CalendarDays className="size-4" />, run: go('/library/calendar') },
      { id: 'downloads', group: 'Go to', label: 'Downloads', icon: <Clapperboard className="size-4" />, run: go('/library/downloads') },
      { id: 'settings', group: 'Go to', label: 'Settings', icon: <Settings className="size-4" />, run: go('/settings') },
    ];
    if (session?.settings.liveTvEnabled) pages.splice(4, 0, { id: 'live', group: 'Go to', label: 'Live TV', icon: <Radio className="size-4" />, run: go('/live') });
    if (session?.account.isAdmin) {
      pages.push({ id: 'admin', group: 'Go to', label: 'Server', icon: <Shield className="size-4" />, run: go('/admin') });
      pages.push({ id: 'plugins', group: 'Go to', label: 'Plugins', icon: <Sparkles className="size-4" />, run: go('/admin/plugins') });
    }
    if (session?.settings.assistantEnabled) {
      pages.push({
        id: 'assistant',
        group: 'Actions',
        label: ql.length >= 2 ? `Ask the assistant: “${q.trim()}”` : 'Ask the assistant',
        icon: <Sparkles className="size-4" />,
        run: () => {
          onClose();
          openAssistant({ kind: 'prompt', label: q.trim() || null });
        },
      });
    }
    for (const a of contrib?.actions.filter((x) => x.placement === 'command') ?? []) {
      pages.push({
        id: `act:${a.pluginId}:${a.id}`,
        group: 'Actions',
        label: a.label,
        hint: a.pluginName,
        icon: <Sparkles className="size-4" />,
        run: async () => {
          onClose();
          const r = await api.plugins.action(a.pluginId, a.id, { query: q.trim() }).catch((e: Error) => ({ toast: e.message }) as { toast?: string; navigate?: string; openUrl?: string });
          if (r.toast) toast(r.toast);
          if (r.navigate) navigate(r.navigate);
          if (r.openUrl) window.open(r.openUrl, '_blank', 'noopener');
        },
      });
    }
    out.push(...pages.filter((p) => !ql || p.label.toLowerCase().includes(ql) || p.group === 'Actions'));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.data, pluginSearch.data, q, session, contrib]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(entries.length - 1, s + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (entries[sel]) entries[sel].run();
      else if (q.trim()) go(`/search?q=${encodeURIComponent(q.trim())}`)();
    }
  };

  let lastGroup = '';
  return (
    <motion.div className="fixed inset-0 z-[130] flex justify-center px-3 pt-[8vh] sm:pt-[14vh]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-md" onClick={onClose} />
      <motion.div
        initial={{ y: -16, scale: 0.97, opacity: 0 }}
        animate={{ y: 0, scale: 1, opacity: 1 }}
        exit={{ y: -10, scale: 0.98, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 520, damping: 38 }}
        className="glass-strong relative flex h-fit max-h-[72vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl shadow-[0_40px_120px_-20px_rgb(0_0_0/0.9)]"
      >
        <div className="flex items-center gap-3 border-b border-line px-5">
          <Search className="size-5 text-muted" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search titles, jump anywhere, run an action…"
            className="h-16 flex-1 bg-transparent text-[17px] placeholder:text-faint focus:outline-none"
          />
          {(search.isFetching || pluginSearch.isFetching) && <span className="size-4 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />}
          <kbd className="rounded-md bg-white/8 px-1.5 py-0.5 text-[11px] text-faint">Esc</kbd>
        </div>
        <div ref={listRef} className="overflow-y-auto p-2">
          {entries.map((e, i) => {
            const header = e.group !== lastGroup ? e.group : null;
            lastGroup = e.group;
            return (
              <div key={e.id}>
                {header && <div className="px-3 pt-3 pb-1.5 text-[11px] font-semibold tracking-wider text-faint uppercase">{header}</div>}
                <button
                  data-idx={i}
                  onMouseMove={() => setSel(i)}
                  onClick={e.run}
                  className={cls('flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors', sel === i ? 'bg-white/10' : '')}
                >
                  {e.image !== undefined ? (
                    e.image ? (
                      <img src={e.image} alt="" className="h-12 w-8 shrink-0 rounded-md object-cover" />
                    ) : (
                      <span className="h-12 w-8 shrink-0 rounded-md bg-white/8" />
                    )
                  ) : (
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/6 text-muted">{e.icon}</span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{e.label}</span>
                    {e.hint && <span className="block truncate text-xs text-faint">{e.hint}</span>}
                  </span>
                  {sel === i && <CornerDownLeft className="size-4 text-faint" />}
                </button>
              </div>
            );
          })}
          {query.length >= 2 && search.isSuccess && !entries.some((e) => e.group === 'Titles' && e.id !== 'all') && (
            <div className="px-3 py-6 text-center text-sm text-muted">No titles match “{query}”.</div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
