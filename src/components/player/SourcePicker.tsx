import { motion } from 'motion/react';
import { useState } from 'react';
import { AlertCircle, Check, ChevronDown, HardDrive, Loader2, Play, Sparkles, Users, Zap } from 'lucide-react';
import { cls, fmtBytes } from '../../lib/format';
import type { MediaFile, PluginRun, Release } from '../../lib/types';

function Tag({ children, tone }: { children: React.ReactNode; tone?: 'accent' | 'ok' | 'warn' }) {
  return (
    <span
      className={cls(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold',
        tone === 'accent' ? 'bg-gradient-accent text-on-accent' : tone === 'ok' ? 'bg-ok/15 text-ok' : tone === 'warn' ? 'bg-warn/15 text-warn' : 'bg-white/10 text-fg/90',
      )}
    >
      {children}
    </span>
  );
}

const LANG_FLAGS: Record<string, string> = { en: 'EN', ja: 'JA', nl: 'NL', de: 'DE', fr: 'FR', es: 'ES', it: 'IT', pt: 'PT', ru: 'RU', ko: 'KO', zh: 'ZH', multi: 'MULTI' };

export function ReleaseTags({ r }: { r: Release }) {
  return (
    <div className="flex flex-wrap gap-1">
      {r.cached && (
        <Tag tone="accent">
          <Zap className="size-3" /> Instant
        </Tag>
      )}
      {r.quality && <Tag>{r.quality === '2160p' ? '4K' : r.quality}</Tag>}
      {r.hdr && <Tag tone="warn">HDR</Tag>}
      {r.source && <Tag>{r.source === 'webdl' ? 'WEB-DL' : r.source.toUpperCase()}</Tag>}
      {r.codec && <Tag>{r.codec.toUpperCase()}</Tag>}
      {r.audio && <Tag>{r.audio.toUpperCase()}</Tag>}
      {r.audioKind === 'dub' && <Tag tone="ok">Dub</Tag>}
      {r.audioKind === 'dual' && <Tag tone="ok">Dual audio</Tag>}
      {r.hasSubs && <Tag>Subs</Tag>}
      {r.languages.slice(0, 3).map((l) => (
        <Tag key={l}>{LANG_FLAGS[l] ?? l.toUpperCase()}</Tag>
      ))}
    </div>
  );
}

function Meta({ r }: { r: Release }) {
  return (
    <span className="flex items-center gap-2 text-xs text-muted">
      {r.sizeBytes > 0 && <span>{fmtBytes(r.sizeBytes)}</span>}
      {(r.infoHash || !r.url || r.seeders > 0) && (
        <span className="flex items-center gap-1" title={`${r.seeders} seeders${r.leechers ? ` · ${r.leechers} leechers` : ''}`}>
          <Users className="size-3" /> {r.seeders}
        </span>
      )}
      <span className="truncate">
        {r.pluginName}
        {r.alsoFrom.length ? ` +${r.alsoFrom.length}` : ''}
        {r.group ? ` · ${r.group}` : ''}
      </span>
    </span>
  );
}

export function SourcePicker({
  runs,
  releases,
  done,
  noDub,
  files,
  current,
  onPick,
  onPickFile,
  onServerDownload,
}: {
  runs: PluginRun[];
  releases: Release[];
  done: boolean;
  noDub: boolean;
  files: MediaFile[];
  current?: string | null;
  onPick: (r: Release) => void;
  onPickFile: (f: MediaFile) => void;
  onServerDownload?: (r: Release) => void;
}) {
  const [more, setMore] = useState(false);
  const best = releases[0];
  const preferred = releases.slice(1).filter((r) => r.tier === 0);
  const primary = preferred.slice(0, 10);
  const others = [...preferred.slice(10), ...releases.slice(1).filter((r) => r.tier === 1)];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {runs.map((r) => (
          <span key={r.pluginId} title={r.error} className="glass inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs">
            {r.status === 'running' ? (
              <Loader2 className="size-3 animate-spin" />
            ) : r.status === 'error' ? (
              <AlertCircle className="size-3 text-bad" />
            ) : r.status === 'skipped' ? (
              <span className="size-1.5 rounded-full bg-white/30" />
            ) : (
              <Check className="size-3 text-ok" />
            )}
            {r.name}
            {r.status === 'done' && <span className="text-faint">{r.count}</span>}
          </span>
        ))}
        {!runs.length && !done && (
          <span className="glass inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs">
            <Loader2 className="size-3 animate-spin" /> Asking your sources…
          </span>
        )}
      </div>

      {noDub && (
        <div className="flex items-center gap-2 rounded-xl bg-warn/10 px-3 py-2 text-sm text-warn">
          <AlertCircle className="size-4 shrink-0" /> No dubbed release found — these are subbed.
        </div>
      )}

      {files.map((f) => (
        <motion.button
          key={f.id}
          layout
          onClick={() => onPickFile(f)}
          className="flex w-full items-center gap-4 rounded-2xl border border-accent/40 bg-accent/10 p-4 text-left transition hover:bg-accent/15"
        >
          <span className="bg-gradient-accent grid size-11 shrink-0 place-items-center rounded-xl text-on-accent">
            <HardDrive className="size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">On your server</span>
            <span className="block truncate text-xs text-muted">
              {f.path.split('/').pop()} · {fmtBytes(f.size)}
            </span>
          </span>
          <Play className="size-5 fill-current" />
        </motion.button>
      ))}

      {best && (
        <motion.button
          layout
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          onClick={() => onPick(best)}
          className={cls('group relative w-full overflow-hidden rounded-2xl border p-4 text-left transition', current === best.id ? 'border-white/40 bg-white/10' : 'border-line-strong bg-white/[0.05] hover:bg-white/[0.08]')}
        >
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wider text-accent uppercase">
            <Sparkles className="size-3.5" /> Best match
          </div>
          <div className="flex items-center gap-4">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-semibold">{best.title}</div>
              <div className="mt-2">
                <ReleaseTags r={best} />
              </div>
              <div className="mt-2">
                <Meta r={best} />
              </div>
            </div>
            <span className="grid size-12 shrink-0 place-items-center rounded-full bg-white text-black shadow-xl transition-transform group-hover:scale-110">
              <Play className="size-5 translate-x-px fill-current" />
            </span>
          </div>
        </motion.button>
      )}

      <div className="space-y-1">
        {primary.map((r) => (
          <ReleaseRow key={r.id} r={r} current={current === r.id} onPick={onPick} onServerDownload={onServerDownload} />
        ))}
      </div>

      {others.length > 0 && (
        <div>
          <button onClick={() => setMore((m) => !m)} className="flex items-center gap-1.5 px-1 py-2 text-sm text-muted hover:text-fg">
            <ChevronDown className={cls('size-4 transition-transform', more && 'rotate-180')} /> {more ? 'Fewer sources' : `More sources (${others.length})`}
          </button>
          {more && (
            <div className="space-y-1">
              {others.slice(0, 150).map((r) => (
                <ReleaseRow key={r.id} r={r} current={current === r.id} onPick={onPick} onServerDownload={onServerDownload} />
              ))}
            </div>
          )}
        </div>
      )}

      {done && !releases.length && !files.length && (
        <div className="rounded-2xl border border-line p-6 text-center">
          <div className="font-semibold">Nothing found</div>
          <p className="mt-1 text-sm text-muted">None of your sources had this one. Try again later, or add a source plugin in Server → Plugins.</p>
        </div>
      )}
    </div>
  );
}

function ReleaseRow({ r, current, onPick, onServerDownload }: { r: Release; current: boolean; onPick: (r: Release) => void; onServerDownload?: (r: Release) => void }) {
  return (
    <div className={cls('group flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors', current ? 'bg-white/10' : 'hover:bg-white/5')}>
      <button onClick={() => onPick(r)} className="min-w-0 flex-1 text-left">
        <div className="truncate text-sm">{r.title}</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          <ReleaseTags r={r} />
          <Meta r={r} />
        </div>
      </button>
      {onServerDownload && (
        <button onClick={() => onServerDownload(r)} title="Download to server" aria-label="Download to server" className="rounded-full p-2 text-faint opacity-0 transition group-hover:opacity-100 hover:bg-white/8 hover:text-fg">
          <HardDrive className="size-4" />
        </button>
      )}
      <button onClick={() => onPick(r)} aria-label="Play" className="rounded-full p-2 text-muted hover:bg-white/8 hover:text-fg">
        <Play className="size-4 fill-current" />
      </button>
    </div>
  );
}
