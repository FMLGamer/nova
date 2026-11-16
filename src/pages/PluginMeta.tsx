import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, Play } from 'lucide-react';
import { useEffect } from 'react';
import { api } from '../lib/api';
import { readerPath } from '../lib/reader';
import { titlePath } from '../lib/format';
import { useContributions } from '../lib/queries';
import { errorText, toast, useApp } from '../lib/store';
import type { CatalogDef, MetaPreview } from '../lib/types';
import { Rail, RailSkeleton } from '../components/media';
import { Button, Empty, Spinner } from '../components/ui';

/** Opens a plugin catalogue item: Nova's own title page when the id maps, the plugin page otherwise. */
export function useOpenMeta() {
  const navigate = useNavigate();
  return async (pluginId: string, m: MetaPreview) => {
    try {
      const mediaId = await api.catalog.resolve(m.id, m.type);
      if (mediaId) return navigate(titlePath(mediaId));
    } catch {
      /* fall through to the plugin's own page */
    }
    navigate(`/x/${encodeURIComponent(pluginId)}/${encodeURIComponent(m.type)}/${encodeURIComponent(m.id)}`);
  };
}

export function MetaCard({ pluginId, meta }: { pluginId: string; meta: MetaPreview }) {
  const open = useOpenMeta();
  const landscape = meta.posterShape === 'landscape';
  return (
    <button onClick={() => open(pluginId, meta)} className="group/card block w-full text-left">
      <div className={`relative overflow-hidden rounded-2xl bg-ink-800 ring-1 ring-white/6 transition-[translate,box-shadow] duration-200 group-hover/card:-translate-y-1.5 group-hover/card:ring-white/20 ${landscape ? 'aspect-video' : meta.posterShape === 'square' ? 'aspect-square' : 'aspect-[2/3]'}`}>
        {meta.poster && <img src={meta.poster} alt="" loading="lazy" className="size-full object-cover transition-transform duration-300 group-hover/card:scale-105" />}
      </div>
      <div className="mt-2.5 truncate text-[13.5px] font-semibold">{meta.name}</div>
      <div className="mt-0.5 truncate text-xs text-faint">{meta.releaseInfo ?? meta.genres?.slice(0, 2).join(' · ') ?? '\u00a0'}</div>
    </button>
  );
}

export function PluginRail({ catalog }: { catalog: CatalogDef & { pluginId: string; pluginName: string } }) {
  const { data, isLoading } = useQuery({
    queryKey: ['plugin-catalog', catalog.pluginId, catalog.type, catalog.id],
    queryFn: () => api.plugins.catalog(catalog.pluginId, catalog.type, catalog.id),
    staleTime: 30 * 60_000,
    retry: false,
  });
  if (isLoading) return <RailSkeleton />;
  if (!data?.length) return null;
  return (
    <Rail title={<>{catalog.name} <span className="text-sm font-normal text-faint">· {catalog.pluginName}</span></>}>
      {data.slice(0, 30).map((m) => (
        <MetaCard key={m.id} pluginId={catalog.pluginId} meta={m} />
      ))}
    </Rail>
  );
}

export default function PluginMeta() {
  const { plugin = '', type = '', id = '' } = useParams();
  const navigate = useNavigate();
  const setAmbient = useApp((s) => s.setAmbient);
  const { data: contrib } = useContributions();
  const { data: meta, isLoading, error } = useQuery({ queryKey: ['plugin-meta', plugin, type, id], queryFn: () => api.plugins.meta(plugin, type, id) });
  const mediaType = contrib?.mediaTypes.find((m) => m.id === type);
  const readable = mediaType?.reader === 'comic' || mediaType?.reader === 'book' || type === 'manga' || type === 'comic';

  useEffect(() => setAmbient(meta?.background ?? meta?.poster ?? null), [meta, setAmbient]);

  if (isLoading) return <div className="grid min-h-[60vh] place-items-center"><Spinner className="size-7" /></div>;
  if (error || !meta) return <Empty title="Couldn't open this">{errorText(error)}</Empty>;

  const openChapter = (videoId: string, title: string) =>
    navigate(readerPath({ type: 'plugin', pluginId: plugin, metaType: type, videoId, metaId: id, series: meta.name, title: `${meta.name} — ${title}`, cover: meta.poster ?? null }));

  const videos = [...(meta.videos ?? [])].sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));

  return (
    <div className="px-5 pt-28 sm:px-10">
      <div className="flex flex-col gap-8 sm:flex-row">
        {meta.poster && <img src={meta.poster} alt="" className="w-44 shrink-0 self-start rounded-2xl shadow-2xl ring-1 ring-white/10 sm:w-56" />}
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-4xl font-bold sm:text-5xl">{meta.name}</h1>
          <div className="mt-2 text-sm text-muted">{[meta.releaseInfo, ...(meta.genres ?? []).slice(0, 4)].filter(Boolean).join(' · ')}</div>
          {meta.description && <p className="mt-4 max-w-3xl leading-relaxed text-white/80">{meta.description}</p>}
          {readable && videos[0] && (
            <Button className="mt-6" variant="white" size="lg" icon={<BookOpen className="size-5" />} onClick={() => openChapter(videos[0]!.id, videos[0]!.title)}>
              Start reading
            </Button>
          )}
          {!readable && (
            <p className="mt-6 text-sm text-faint">
              This title comes from a plugin catalogue and isn't matched to Nova's library, so it can't be streamed here directly.
            </p>
          )}
          {readable && !videos.length && <p className="mt-6 text-sm text-faint">No readable chapters in your language from this source — try changing the plugin's language in Server → Plugins.</p>}
        </div>
      </div>
      {videos.length > 0 && (
        <div className="mt-10">
          <h2 className="mb-3 font-display text-xl font-semibold">{readable ? 'Chapters' : 'Episodes'}</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {videos.map((v) => (
              <button
                key={v.id}
                onClick={() => (readable ? openChapter(v.id, v.title) : toast('Not playable from a plugin page'))}
                className="flex items-center gap-3 rounded-2xl border border-line p-3 text-left transition hover:border-line-strong hover:bg-white/4"
              >
                {v.thumbnail ? <img src={v.thumbnail} alt="" className="h-12 w-20 shrink-0 rounded-lg object-cover" /> : <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-white/6 text-muted">{readable ? <BookOpen className="size-4" /> : <Play className="size-4" />}</span>}
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{v.title}</span>
                  {v.released && <span className="block text-xs text-faint">{new Date(v.released).toLocaleDateString()}</span>}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
