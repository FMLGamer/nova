export type ReaderSource =
  | { type: 'library'; fileId: string; title: string; cover: string | null; author?: string | null; name?: string }
  | { type: 'url'; url: string; format: 'epub' | 'pdf' | 'cbz'; title: string; cover: string | null; author?: string | null }
  | { type: 'plugin'; pluginId: string; metaType: string; videoId: string; title: string; cover: string | null; metaId?: string; series?: string }
  | { type: 'offline'; itemKey: string; format: 'epub' | 'pdf' | 'cbz'; title: string; cover: string | null };

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function readerKey(s: ReaderSource): string {
  if (s.type === 'library') return `lib:${s.fileId}`;
  if (s.type === 'url') return `url:${hash(s.url)}`;
  if (s.type === 'plugin') return `plugin:${s.pluginId}:${s.videoId}`.slice(0, 290);
  return s.itemKey;
}

export const readerPath = (s: ReaderSource) => `/reader?src=${encodeURIComponent(JSON.stringify(s))}`;
