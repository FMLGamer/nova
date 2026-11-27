import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, BookOpen, CalendarDays, Clapperboard, CornerDownLeft, Film, House, Library, Radio, Search, Settings, Shield, Sparkles, Swords, Tv, X } from 'lucide-react';
import { api } from '../lib/api';
import { cls, kindLabel, titlePath } from '../lib/format';
import { useContributions, useSession } from '../lib/queries';
import { toast, useApp } from '../lib/store';
import { FORMAT_LABEL, readTitlePath } from './ReadCard';

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

export type ScopeId = 'movies' | 'shows' | 'anime' | 'read';
export interface SearchScope {
  id: ScopeId;
  label: string;
}
const SCOPE_LABEL: Record<ScopeId, string> = { movies: 'Movies', shows: 'Shows', anime: 'Anime', read: 'Manga & books' };

/** Searching from a tab searches that tab's kind of media first. */
export function searchScope(pathname: string): SearchScope | null {
  const m = /^\/(movies|shows|anime|read)(\/|$)/.exec(pathname);
  return m ? { id: m[1] as ScopeId, label: SCOPE_LABEL[m[1] as ScopeId] } : null;
}

/** Plugin catalogue types that belong to a scope. */
function scopeHasType(scope: SearchScope | null, type: string, reader: string | undefined): boolean {
  if (!scope) return true;
  if (scope.id === 'read') return reader === 'comic' || reader === 'book' || type === 'manga' || type === 'comic' || type === 'book';
  return scope.id === 'movies' ? type === 'movie' : scope.id === 'shows' ? type === 'series' || type === 'tv' : type === 'anime';
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
  const location = useLocation();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [scope, setScope] = useState(() => searchScope(location.pathname));
  const query = useDebounced(q.trim(), 220);
  const listRef = useRef<HTMLDivElement>(null);
  const { data: session } = useSession();
  const { data: contrib } = useContributions();
  const openAssistant = useApp((s) => s.openAssistant);
  const readerOf = (type: string) => contrib?.mediaTypes.find((m) => m.id === type)?.reader;
  const catalogs = (contrib?.searchCatalogs ?? []).filter((c) => scopeHasType(scope, c.type, readerOf(c.type)));

  const search = useQuery({ queryKey: ['palette-search', query], queryFn: () => api.catalog.search(query), enabled: query.length >= 2 && scope?.id !== 'read', staleTime: 60_000 });
  const readSearch = useQuery({ queryKey: ['palette-read-search', query], queryFn: () => api.catalog.readSearch(query), enabled: query.length >= 2 && scope?.id === 'read', staleTime: 60_000 });
  const pluginSearch = useQuery({
    queryKey: ['palette-plugin-search', query, scope?.id ?? 'all', catalogs.length],
    enabled: query.length >= 2 && Boolean(catalogs.length),
    staleTime: 60_000,
    queryFn: async () => {
      const results = await Promise.all(
        catalogs.slice(0, 4).map((c) =>
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
      // Everywhere: the best matches of every kind, best first. In a tab: that kind's own list.
      const all = !scope ? (s.top ?? []).slice(0, 10) : (scope.id === 'movies' ? s.movies : scope.id === 'shows' ? s.shows : scope.id === 'anime' ? s.anime : []).slice(0, 10);
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
    for (const it of readSearch.data?.slice(0, 12) ?? []) {
      out.push({
        id: it.id,
        group: 'Titles',
        label: it.title,
        hint: [FORMAT_LABEL[it.format], it.author ?? it.year].filter(Boolean).join(' · '),
        image: it.poster,
        run: go(readTitlePath(it.id)),
      });
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
      out.push({ id: 'all', group: 'Titles', label: `See all results for “${q.trim()}”`, icon: <ArrowRight className="size-4" />, run: go(`/search?${new URLSearchParams({ q: q.trim(), ...(scope ? { type: scope.id } : {}) })}`) });
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
  }, [search.data, readSearch.data, pluginSearch.data, q, session, contrib, scope]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'Backspace' && !q && scope) setScope(null);
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
          <Search className="size-5 shrink-0 text-muted" />
          {scope && (
            <button
              onClick={() => setScope(null)}
              title="Only searching here. Click (or Backspace) to search everything."
              className="flex shrink-0 items-center gap-1.5 rounded-full bg-accent/15 py-1 pr-2 pl-3 text-xs font-semibold text-fg ring-1 ring-accent/35 transition hover:bg-accent/25"
            >
              In {scope.label}
              <X className="size-3.5 opacity-70" />
            </button>
          )}
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder={scope ? `Search ${scope.label.toLowerCase()}…` : 'Search titles, jump anywhere, run an action…'}
            className="h-16 min-w-0 flex-1 bg-transparent text-[17px] placeholder:text-faint focus:outline-none"
          />
          {(search.isFetching || readSearch.isFetching || pluginSearch.isFetching) && <span className="size-4 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />}
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
                      <span className="h-12 w-8 shrink-0 overflow-hidden rounded-md bg-white/8">
                        <img src={e.image} alt="" className="size-full object-cover" />
                      </span>
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
          {query.length >= 2 && (search.isSuccess || readSearch.isSuccess) && !entries.some((e) => e.group === 'Titles' && e.id !== 'all') && (
            <div className="px-3 py-6 text-center text-sm text-muted">
              No titles match “{query}”{scope ? ` in ${scope.label}` : ''}.
              {scope && (
                <button onClick={() => setScope(null)} className="ml-1 font-semibold text-fg underline">
                  Search everything
                </button>
              )}
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
