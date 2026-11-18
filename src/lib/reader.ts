export type ReaderSource =
  | { type: 'library'; fileId: string; title: string; cover: string | null; author?: string | null; name?: string; manga?: boolean }
  | { type: 'url'; url: string; format: 'epub' | 'pdf' | 'cbz'; title: string; cover: string | null; author?: string | null }
  | { type: 'plugin'; pluginId: string; metaType: string; videoId: string; title: string; cover: string | null; metaId?: string; series?: string; anilist?: number; chapter?: number }
  | { type: 'offline'; itemKey: string; format: 'epub' | 'pdf' | 'cbz'; title: string; cover: string | null };

/** The chapter number of a plugin chapter, from its episode field or its name ("Ch. 12", "Chapter 12.5"). */
export function chapterOf(v: { episode?: number | null; title?: string | null }): number | undefined {
  if (v.episode) return v.episode;
  const m = v.title?.match(/(?:\bch(?:apter)?\.?|#)\s*(\d+(?:\.\d+)?)/i);
  return m ? Number(m[1]) : undefined;
}

type Ordered = { season?: number; episode?: number };
/** Chapters run by chapter number (volumes are often missing for the newest ones); episodes by season first. */
export const byChapter = (a: Ordered, b: Ordered) => (a.episode ?? 0) - (b.episode ?? 0) || (a.season ?? 0) - (b.season ?? 0);
export const byEpisode = (a: Ordered, b: Ordered) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0);

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
