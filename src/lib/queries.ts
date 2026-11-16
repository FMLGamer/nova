import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from './api';
import { useApp, toast, errorText } from './store';
import type { CatalogItem, DeepPartial, Preferences } from './types';

export function useAppConfig() {
  return useQuery({ queryKey: ['app-config'], queryFn: api.system.config, staleTime: Infinity });
}

export function useSession() {
  return useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      try {
        return await api.auth.me();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: (n, e) => !(e instanceof ApiError && e.status === 401) && n < 2,
  });
}

export function useProfile() {
  const { data } = useSession();
  const profileId = useApp((s) => s.profileId);
  return data?.profiles.find((p) => p.id === profileId) ?? null;
}

export function usePrefs() {
  const profileId = useApp((s) => s.profileId);
  return useQuery({
    queryKey: ['prefs', profileId],
    queryFn: () => api.profiles.prefs(profileId!),
    enabled: Boolean(profileId),
    staleTime: 5 * 60_000,
  });
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !base || typeof base !== 'object') return (patch ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge((base as Record<string, unknown>)[k], v);
  return out as T;
}

/** Optimistic preference updates — the UI never waits on the network to reflect a toggle. */
export function useSavePrefs() {
  const qc = useQueryClient();
  const profileId = useApp((s) => s.profileId);
  return useMutation({
    mutationFn: (patch: DeepPartial<Preferences>) => api.profiles.savePrefs(profileId!, patch),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: ['prefs', profileId] });
      const prev = qc.getQueryData<Preferences>(['prefs', profileId]);
      if (prev) qc.setQueryData(['prefs', profileId], deepMerge(prev, patch));
      return { prev };
    },
    onError: (e, _p, ctx) => {
      if (ctx?.prev) qc.setQueryData(['prefs', profileId], ctx.prev);
      toast(errorText(e), 'bad');
    },
    onSuccess: (p) => qc.setQueryData(['prefs', profileId], p),
  });
}

export const useDetail = (mediaId: string | null | undefined) =>
  useQuery({
    queryKey: ['detail', mediaId],
    queryFn: () => api.catalog.detail(mediaId!),
    enabled: Boolean(mediaId),
    staleTime: 30 * 60_000,
  });

export const useEpisodes = (mediaId: string | null | undefined, season: number) =>
  useQuery({
    queryKey: ['episodes', mediaId, season],
    queryFn: () => api.catalog.episodes(mediaId!, season),
    enabled: Boolean(mediaId) && !mediaId?.startsWith('movie:'),
    staleTime: 30 * 60_000,
    placeholderData: keepPreviousData,
  });

export const useContinue = () => {
  const profileId = useApp((s) => s.profileId);
  return useQuery({ queryKey: ['continue', profileId], queryFn: api.progress.continue, enabled: Boolean(profileId) });
};

export const useUpNext = () => {
  const profileId = useApp((s) => s.profileId);
  return useQuery({ queryKey: ['upnext', profileId], queryFn: api.me.upnext, enabled: Boolean(profileId), staleTime: 60_000 });
};

export const useMediaProgress = (mediaId: string | null | undefined) => {
  const profileId = useApp((s) => s.profileId);
  return useQuery({
    queryKey: ['media-progress', profileId, mediaId],
    queryFn: () => api.progress.media(mediaId!),
    enabled: Boolean(profileId && mediaId),
  });
};

export const useSummary = () => {
  const profileId = useApp((s) => s.profileId);
  return useQuery({
    queryKey: ['summary', profileId],
    queryFn: api.progress.summary,
    enabled: Boolean(profileId),
    staleTime: 60_000,
    select: (items) => new Map(items.map((i) => [i.mediaId, i])),
  });
};

export const useMyList = () => {
  const profileId = useApp((s) => s.profileId);
  return useQuery({ queryKey: ['list', profileId], queryFn: api.list.all, enabled: Boolean(profileId) });
};

export function useListToggle() {
  const qc = useQueryClient();
  const profileId = useApp((s) => s.profileId);
  const list = useMyList();
  const has = (mediaId: string) => Boolean(list.data?.some((e) => e.mediaId === mediaId));
  const m = useMutation({
    mutationFn: async (item: Pick<CatalogItem, 'id' | 'mediaType' | 'title' | 'poster' | 'year'>) => {
      if (has(item.id)) await api.list.remove(item.id);
      else await api.list.add({ mediaType: item.mediaType, mediaId: item.id, title: item.title, poster: item.poster, year: item.year });
      return !has(item.id);
    },
    onSuccess: (added, item) => {
      qc.invalidateQueries({ queryKey: ['list', profileId] });
      toast(added ? `Added ${item.title} to My List` : `Removed from My List`, 'ok');
    },
    onError: (e) => toast(errorText(e), 'bad'),
  });
  return { has, toggle: m.mutate, pending: m.isPending };
}

export const useCollections = () => {
  const profileId = useApp((s) => s.profileId);
  return useQuery({ queryKey: ['collections', profileId], queryFn: api.me.collections, enabled: Boolean(profileId) });
};

export const useContributions = () =>
  useQuery({ queryKey: ['contributions'], queryFn: api.plugins.contributions, staleTime: 5 * 60_000, retry: false });

export const useNotifications = () =>
  useQuery({ queryKey: ['notifications'], queryFn: api.me.notifications, refetchInterval: 60_000, staleTime: 30_000 });

export const useServerStatus = () => useQuery({ queryKey: ['server-status'], queryFn: api.server.status, staleTime: 5 * 60_000, retry: false });
