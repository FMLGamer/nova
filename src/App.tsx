import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { PageFallback, Shell } from './components/Shell';
import { Toaster } from './components/ui';
import { useSession } from './lib/queries';
import { useApp } from './lib/store';
import { Login, Register } from './pages/Auth';
import { Profiles } from './pages/Profiles';
import { Home } from './pages/Home';
import { Browse } from './pages/Browse';
import { Title } from './pages/Title';
import PluginMeta from './pages/PluginMeta';

const Anime = lazy(() => import('./pages/Anime'));
const Search = lazy(() => import('./pages/Search'));
const Watch = lazy(() => import('./pages/Watch'));
const LibraryPage = lazy(() => import('./pages/Library'));
const CollectionPage = lazy(() => import('./pages/Collection'));
const Live = lazy(() => import('./pages/Live'));
const Read = lazy(() => import('./pages/Read'));
const ReadTitle = lazy(() => import('./pages/ReadTitle'));
const Reader = lazy(() => import('./pages/Reader'));
const Music = lazy(() => import('./pages/Music'));
const Settings = lazy(() => import('./pages/Settings'));
const Admin = lazy(() => import('./pages/Admin'));
const RoomJoin = lazy(() => import('./pages/RoomJoin'));
const ShareGuest = lazy(() => import('./pages/ShareGuest'));
const PluginPage = lazy(() => import('./pages/PluginPage'));

function RequireSession() {
  const { data, isLoading } = useSession();
  const location = useLocation();
  if (isLoading) return <Splash />;
  if (!data) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <Outlet />;
}

function RequireProfile() {
  const { data } = useSession();
  const profileId = useApp((s) => s.profileId);
  const setProfile = useApp((s) => s.setProfile);
  const valid = data?.profiles.some((p) => p.id === profileId);
  const only = data && data.profiles.length === 1 ? data.profiles[0]!.id : null;
  // A single-profile account never sees the picker.
  useEffect(() => {
    if (!valid && only) setProfile(only);
  }, [valid, only, setProfile]);
  if (!valid) return only ? <Splash /> : <Navigate to="/profiles" replace />;
  return <Outlet />;
}

function Splash() {
  return (
    <div className="grid min-h-dvh place-items-center">
      <div className="bg-gradient-accent size-10 animate-[spin_1.6s_linear_infinite] rounded-xl [mask:conic-gradient(#000_0_75%,transparent_0)]" />
    </div>
  );
}

function Bare() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Outlet />
      <Toaster />
    </Suspense>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<Bare />}>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/share/:token" element={<ShareGuest />} />
      </Route>
      <Route element={<RequireSession />}>
        <Route element={<Bare />}>
          <Route path="/profiles" element={<Profiles />} />
        </Route>
        <Route element={<RequireProfile />}>
          <Route element={<Bare />}>
            <Route path="/watch/:type/:id" element={<Watch />} />
            <Route path="/room/:code" element={<RoomJoin />} />
            <Route path="/reader" element={<Reader />} />
          </Route>
          <Route element={<Shell />}>
            <Route index element={<Home />} />
            <Route path="/movies" element={<Browse kind="movies" />} />
            <Route path="/shows" element={<Browse kind="shows" />} />
            <Route path="/anime" element={<Anime />} />
            <Route path="/title/:type/:id" element={<Title />} />
            <Route path="/search" element={<Search />} />
            <Route path="/library/:tab?" element={<LibraryPage />} />
            <Route path="/collection/:id" element={<CollectionPage />} />
            <Route path="/live" element={<Live />} />
            <Route path="/read" element={<Read />} />
            <Route path="/read/:kind/:id" element={<ReadTitle />} />
            <Route path="/music/*" element={<Music />} />
            <Route path="/settings/:section?" element={<Settings />} />
            <Route path="/admin/:section?" element={<Admin />} />
            <Route path="/p/:plugin/:page" element={<PluginPage />} />
            <Route path="/x/:plugin/:type/:id" element={<PluginMeta />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Route>
      </Route>
    </Routes>
  );
}
