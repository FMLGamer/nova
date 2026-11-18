import DOMPurify from 'dompurify';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, Heart } from 'lucide-react';
import { api } from '../lib/api';
import { cls, relTime } from '../lib/format';
import { errorText } from '../lib/store';
import type { ThreadPost } from '../lib/types';
import { Avatar, Button, Spinner } from './ui';

// Forum posts are someone else's HTML: keep the formatting, drop scripts, styles and our own class names.
DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName === 'class') data.attrValue = data.attrValue.split(/\s+/).filter((c) => c === 'markdown_spoiler').join(' ');
});
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
  if (node.tagName === 'IMG') {
    node.setAttribute('loading', 'lazy');
    node.setAttribute('referrerpolicy', 'no-referrer');
  }
});

const clean = (html: string) =>
  DOMPurify.sanitize(html, {
    FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button', 'textarea', 'select', 'object', 'embed', 'video', 'audio', 'link', 'meta'],
    FORBID_ATTR: ['style', 'id', 'name'],
  });

function Post({ p, depth = 0 }: { p: ThreadPost; depth?: number }) {
  return (
    <div className={cls('flex gap-3', depth > 0 && 'mt-3 border-l border-line pl-3')}>
      {p.avatar ? <img src={p.avatar} alt="" referrerPolicy="no-referrer" className="size-8 shrink-0 rounded-full object-cover" /> : <Avatar avatar="slate" name={p.user} className="size-8 text-xs" />}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className="font-semibold text-fg">{p.user}</span>
          <span className="text-faint">{relTime(p.createdAt)}</span>
          {p.likes ? (
            <span className="flex items-center gap-1 text-faint">
              <Heart className="size-3" /> {p.likes}
            </span>
          ) : null}
        </div>
        <div className="thread-html mt-1 text-sm leading-relaxed text-fg/90" dangerouslySetInnerHTML={{ __html: clean(p.html) }} />
        {p.replies.map((r) => (
          <Post key={r.id} p={r} depth={depth + 1} />
        ))}
      </div>
    </div>
  );
}

/** An AniList thread or MyAnimeList topic, read inside Nova. Spoilers stay hidden until tapped. */
export function ThreadView({ site, id, onBack }: { site: 'anilist' | 'mal'; id: number; onBack?: () => void }) {
  const q = useInfiniteQuery({
    queryKey: ['thread', site, id],
    queryFn: ({ pageParam }) => api.trackers.thread(site, id, pageParam),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
    staleTime: 5 * 60_000,
  });
  const first = q.data?.pages[0];
  return (
    <div
      onClick={(e) => {
        const spoiler = (e.target as HTMLElement).closest('.markdown_spoiler');
        if (spoiler) spoiler.classList.toggle('revealed');
      }}
    >
      <div className="mb-4 flex items-center gap-2">
        {onBack && (
          <button onClick={onBack} aria-label="Back to the threads" className="grid size-8 shrink-0 place-items-center rounded-full text-muted hover:bg-white/8 hover:text-fg">
            <ArrowLeft className="size-4" />
          </button>
        )}
        <div className="min-w-0 flex-1 truncate font-semibold">{first?.title ?? 'Discussion'}</div>
        {first && (
          <a href={first.url} target="_blank" rel="noreferrer" className="flex shrink-0 items-center gap-1 text-xs text-muted hover:text-fg">
            {site === 'anilist' ? 'AniList' : 'MyAnimeList'} <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
      {q.isLoading && (
        <div className="grid h-32 place-items-center">
          <Spinner />
        </div>
      )}
      {q.error && <p className="text-sm text-bad">{errorText(q.error)}</p>}
      {first?.post && (
        <div className="mb-5 rounded-2xl bg-white/[0.04] p-3">
          <Post p={first.post} />
        </div>
      )}
      <div className="space-y-5">
        {q.data?.pages.flatMap((pg) => pg.comments).map((c) => (
          <Post key={c.id} p={c} />
        ))}
      </div>
      {q.data && !q.data.pages.some((pg) => pg.comments.length) && !first?.post && <p className="text-sm text-muted">No comments yet.</p>}
      {q.hasNextPage && (
        <div className="mt-5 flex justify-center">
          <Button size="sm" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            More comments
          </Button>
        </div>
      )}
    </div>
  );
}
