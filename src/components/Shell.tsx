import { AnimatePresence, motion } from 'motion/react';
import { Component, Suspense, lazy, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import {
  Bell,
  BookOpen,
  Clapperboard,
  Film,
  House,
  Library,
  LogOut,
  Music2,
  Radio,
  Search,
  Settings,
  Shield,
  Sparkles,
  Swords,
  Tv,
  UserRound,
  Users,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { cls, relTime } from '../lib/format';
import { useAppConfig, useContributions, useNotifications, usePrefs, useProfile, useSession } from '../lib/queries';
import { useApp } from '../lib/store';
import { Avatar, Menu, MenuItem, Spinner, Toaster } from './ui';
import { CommandPalette } from './CommandPalette';
import { AudioDock } from './AudioDock';
import { Logo } from './Logo';

const AssistantPanel = lazy(() => import('./AssistantPanel'));

interface NavEntry {
  to: string;
  label: string;
  icon: typeof House;
  end?: boolean;
}

function useNav(): NavEntry[] {
  const { data: session } = useSession();
  const { data: prefs } = usePrefs();
  const s = session?.settings;
  const nav: NavEntry[] = [
    { to: '/', label: 'Home', icon: House, end: true },
    { to: '/movies', label: 'Movies', icon: Film },
    { to: '/shows', label: 'Shows', icon: Tv },
    { to: '/anime', label: 'Anime', icon: Swords },
  ];
  if (s?.liveTvEnabled) nav.push({ to: '/live', label: 'Live', icon: Radio });
  nav.push({ to: '/read', label: 'Read', icon: BookOpen });
  if (s?.musicBooksEnabled && prefs?.ui.musicAndBooks) nav.push({ to: '/music', label: 'Music', icon: Music2 });
  return nav;
}

/** Keeps the <html> attributes (accent, motion) and plugin themes in sync with the profile. */
function useAppearance() {
  const { data: prefs } = usePrefs();
  const { data: contrib } = useContributions();
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.accent = prefs?.ui.accent ?? 'nova';
    root.dataset.reduceMotion = String(Boolean(prefs?.ui.reduceMotion));
  }, [prefs?.ui.accent, prefs?.ui.reduceMotion]);
  useEffect(() => {
    const links = (contrib?.themes ?? []).map((t) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = t.url;
      l.dataset.plugin = t.pluginId;
      document.head.appendChild(l);
      return l;
    });
    return () => links.forEach((l) => l.remove());
  }, [contrib?.themes]);
}

function Ambient() {
  const ambient = useApp((s) => s.ambient);
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <AnimatePresence>
        {ambient && (
          <motion.img
            key={ambient}
            src={ambient}
            alt=""
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.32 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5 }}
            className="absolute -inset-[10%] size-[120%] scale-110 object-cover blur-[90px] saturate-150"
          />
        )}
      </AnimatePresence>
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,transparent_0%,var(--color-bg)_70%)]" />
    </div>
  );
}

function Notifications() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data } = useNotifications();
  const unread = (data ?? []).filter((n) => !n.read).length;
  return (
    <Menu
      width="w-80"
      trigger={(open, toggle) => (
        <button
          onClick={() => {
            toggle();
            if (!open && unread) api.me.readNotifications().then(() => qc.invalidateQueries({ queryKey: ['notifications'] }));
          }}
          aria-label="Notifications"
          className="relative grid size-10 place-items-center rounded-full text-muted transition-colors hover:bg-white/8 hover:text-fg"
        >
          <Bell className="size-[19px]" />
          {unread > 0 && <span className="bg-gradient-accent absolute top-2 right-2 size-2.5 rounded-full ring-2 ring-bg" />}
        </button>
      )}
    >
      {(close) => (
        <div className="max-h-[60vh] overflow-y-auto">
          <div className="px-3 pt-2 pb-1 text-xs font-semibold tracking-wider text-faint uppercase">Notifications</div>
          {!data?.length && <div className="px-3 py-6 text-center text-sm text-muted">You're all caught up.</div>}
          {data?.map((n) => (
            <button
              key={n.id}
              onClick={() => {
                close();
                if (n.link) {
                  const m = /^nova:\/\/detail\/(\w+):(.+)$/.exec(n.link);
                  navigate(m ? `/title/${m[1]}/${m[2]}` : n.link.replace(/^nova:\/\//, '/'));
                }
              }}
              className="flex w-full gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-white/6"
            >
              <span className={cls('mt-1.5 size-2 shrink-0 rounded-full', n.read ? 'bg-white/15' : 'bg-gradient-accent')} />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{n.title}</span>
                {n.body && <span className="mt-0.5 block text-xs text-muted">{n.body}</span>}
                <span className="mt-1 block text-[11px] text-faint">{relTime(n.createdAt)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </Menu>
  );
}

function ProfileMenu() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: session } = useSession();
  const profile = useProfile();
  const { data: contrib } = useContributions();
  const { data: appConfig } = useAppConfig();
  const setProfile = useApp((s) => s.setProfile);
  if (!session || !profile) return null;
  return (
    <Menu
      width="w-64"
      trigger={(_o, toggle) => (
        <button onClick={toggle} aria-label="Account" className="rounded-full p-0.5 ring-2 ring-transparent transition hover:ring-white/20">
          <Avatar avatar={profile.avatar} name={profile.name} className="size-8 text-sm" />
        </button>
      )}
    >
      {(close) => {
        const go = (to: string) => () => {
          close();
          navigate(to);
        };
        return (
          <>
            <div className="flex items-center gap-3 px-3 pt-2 pb-3">
              <Avatar avatar={profile.avatar} name={profile.name} className="size-10 text-base" />
              <div className="min-w-0">
                <div className="truncate font-semibold">{profile.name}</div>
                <div className="truncate text-xs text-faint">@{session.account.username}</div>
              </div>
            </div>
            <MenuItem icon={<Library />} onClick={go('/library')}>
              My library
            </MenuItem>
            <MenuItem icon={<Settings />} onClick={go('/settings')}>
              Settings
            </MenuItem>
            {session.account.isAdmin && (
              <MenuItem icon={<Shield />} onClick={go('/admin')}>
                Server
              </MenuItem>
            )}
            {contrib?.pages.map((p) => (
              <MenuItem key={`${p.pluginId}:${p.id}`} icon={<Sparkles />} onClick={go(`/p/${encodeURIComponent(p.pluginId)}/${encodeURIComponent(p.id)}`)}>
                {p.title}
              </MenuItem>
            ))}
            <div className="my-1.5 h-px bg-line" />
            {session.profiles.length > 1 && (
              <MenuItem
                icon={<Users />}
                onClick={() => {
                  close();
                  setProfile(null);
                  navigate('/profiles');
                }}
              >
                Switch profile
              </MenuItem>
            )}
            {appConfig?.mode !== 'desktop' && (
              <MenuItem
                icon={<LogOut />}
                onClick={async () => {
                  close();
                  await api.auth.logout();
                  setProfile(null);
                  qc.clear();
                  navigate('/login');
                }}
              >
                Sign out
              </MenuItem>
            )}
          </>
        );
      }}
    </Menu>
  );
}

function TopBar() {
  const nav = useNav();
  const setPalette = useApp((s) => s.setPalette);
  const openAssistant = useApp((s) => s.openAssistant);
  const { data: session } = useSession();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 24);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <header className="pt-safe fixed inset-x-0 top-0 z-50">
      <div
        className={cls(
          'mx-auto flex h-16 items-center gap-2 px-4 transition-all duration-200 ease-snap sm:gap-4 sm:px-8',
          scrolled ? 'bg-bg/70 backdrop-blur-2xl [box-shadow:0_1px_0_var(--color-line)]' : 'bg-gradient-to-b from-black/60 to-transparent',
        )}
      >
        <Link to="/" aria-label="Nova home" className="mr-1 shrink-0">
          <Logo />
        </Link>

        <nav className="hidden items-center rounded-full p-1 lg:flex">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className="relative rounded-full px-4 py-1.5 text-sm font-medium transition-colors">
              {({ isActive }) => (
                <>
                  {isActive && (
                    <motion.span layoutId="nav-pill" className="absolute inset-0 rounded-full bg-white/12 ring-1 ring-white/10" transition={{ type: 'spring', stiffness: 1000, damping: 64 }} />
                  )}
                  <span className={cls('relative', isActive ? 'text-fg' : 'text-muted hover:text-fg')}>{n.label}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="flex-1" />

        <button
          onClick={() => setPalette(true)}
          className="glass flex h-10 items-center gap-2.5 rounded-full pr-2 pl-3.5 text-sm text-muted transition-colors hover:text-fg max-sm:size-10 max-sm:justify-center max-sm:p-0 sm:w-56"
        >
          <Search className="size-[18px] shrink-0" />
          <span className="flex-1 text-left max-sm:hidden">Search</span>
          <kbd className="rounded-md bg-white/8 px-1.5 py-0.5 font-sans text-[11px] text-faint max-sm:hidden">{isMac ? '⌘' : 'Ctrl'} K</kbd>
        </button>
        {session?.settings.liveTvEnabled && (
          <Link to="/read" aria-label="Read" className="grid size-10 place-items-center rounded-full text-muted hover:text-fg lg:hidden">
            <BookOpen className="size-[19px]" />
          </Link>
        )}
        {session?.settings.assistantEnabled && (
          <button
            onClick={() => openAssistant()}
            aria-label="Assistant"
            className="grid size-10 place-items-center rounded-full text-muted transition-colors hover:bg-white/8 hover:text-fg"
          >
            <Sparkles className="size-[19px]" />
          </button>
        )}
        <Notifications />
        <ProfileMenu />
      </div>
    </header>
  );
}

function MobileNav() {
  const { data: session } = useSession();
  const items: NavEntry[] = [
    { to: '/', label: 'Home', icon: House, end: true },
    { to: '/movies', label: 'Movies', icon: Clapperboard },
    { to: '/shows', label: 'Shows', icon: Tv },
    { to: '/anime', label: 'Anime', icon: Swords },
    session?.settings.liveTvEnabled ? { to: '/live', label: 'Live', icon: Radio } : { to: '/read', label: 'Read', icon: BookOpen },
    { to: '/library', label: 'Library', icon: UserRound },
  ];
  return (
    <nav className="pb-safe glass-strong fixed inset-x-0 bottom-0 z-50 border-x-0 border-b-0 lg:hidden">
      <div className="flex h-16 items-stretch justify-around px-1">
        {items.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className="relative flex flex-1 flex-col items-center justify-center gap-1 text-[10.5px] font-medium">
            {({ isActive }) => (
              <>
                {isActive && <motion.span layoutId="mnav" className="bg-gradient-accent absolute top-0 h-0.5 w-8 rounded-full" />}
                <n.icon className={cls('size-[21px] transition-colors', isActive ? 'text-fg' : 'text-faint')} strokeWidth={isActive ? 2.2 : 1.8} />
                <span className={isActive ? 'text-fg' : 'text-faint'}>{n.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

export function PageFallback() {
  return (
    <div className="grid min-h-[60vh] place-items-center">
      <Spinner className="size-7" />
    </div>
  );
}

/** One broken page must never blank the whole app. */
class PageBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid min-h-[60vh] place-items-center px-6 text-center">
        <div>
          <h2 className="font-display text-2xl font-semibold">Something went wrong here</h2>
          <p className="mt-2 text-sm text-muted">{this.state.error.message}</p>
          <button onClick={() => location.reload()} className="mt-5 rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black">
            Reload
          </button>
        </div>
      </div>
    );
  }
}

export function Shell() {
  useAppearance();
  const location = useLocation();
  const assistantOpen = useApp((s) => s.assistant.open);
  const setPalette = useApp((s) => s.setPalette);
  const setAmbient = useApp((s) => s.setAmbient);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
      }
      if (e.key === '/' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        setPalette(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        const s = useApp.getState();
        if (s.assistant.open) s.closeAssistant();
        else s.openAssistant(s.assistant.context);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPalette]);

  // Every page starts at the top and without the previous page's glow (layout effect: runs before pages set theirs).
  useLayoutEffect(() => {
    window.scrollTo({ top: 0 });
    setAmbient(null);
  }, [location.pathname, setAmbient]);

  return (
    <div className="relative min-h-dvh pb-24 lg:pb-12">
      <Ambient />
      <TopBar />
      <motion.main key={location.pathname} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}>
        <Suspense fallback={<PageFallback />}>
          <PageBoundary key={location.pathname}>
            <Outlet />
          </PageBoundary>
        </Suspense>
      </motion.main>
      <MobileNav />
      <AudioDock />
      <CommandPalette />
      {assistantOpen && (
        <Suspense fallback={null}>
          <AssistantPanel />
        </Suspense>
      )}
      <Toaster />
    </div>
  );
}
