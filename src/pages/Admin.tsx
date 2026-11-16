import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState, type ReactNode } from 'react';
import { NavLink, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Archive,
  Check,
  Copy,
  Cpu,
  Database,
  Download,
  FlaskConical,
  Globe,
  HardDrive,
  Library,
  Lock,
  Plug,
  Plus,
  Radio,
  RefreshCw,
  ScrollText,
  Search,
  Shield,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import { cls, fmtBytes, relTime } from '../lib/format';
import { useSession } from '../lib/queries';
import { errorText, toast } from '../lib/store';
import type { AccountSettings, ConfigField, DirectoryChannel, InstallPreview, LibraryItem, PermissionSummary, PluginInfo } from '../lib/types';
import { Badge, Button, Card, Chip, Empty, Input, Modal, Row, Segmented, Select, Spinner, Switch, TextArea } from '../components/ui';
import { LiveVideo } from './Live';

const SECTIONS = [
  { id: '', label: 'Overview', icon: Activity },
  { id: 'people', label: 'People', icon: Users },
  { id: 'plugins', label: 'Plugins', icon: Plug },
  { id: 'library', label: 'Library', icon: Library },
  { id: 'downloads', label: 'Downloads', icon: Download },
  { id: 'live', label: 'Live TV', icon: Radio },
  { id: 'backups', label: 'Backups', icon: Archive },
];

function useAct() {
  const qc = useQueryClient();
  return async (fn: () => Promise<unknown>, ok?: string, keys: string[][] = []) => {
    try {
      await fn();
      if (ok) toast(ok, 'ok');
      for (const k of keys) await qc.invalidateQueries({ queryKey: k });
    } catch (e) {
      toast(errorText(e), 'bad');
    }
  };
}

function Stat({ icon, label, value, tone }: { icon: ReactNode; label: string; value: ReactNode; tone?: 'warn' }) {
  return (
    <Card className="p-5!">
      <div className={cls('mb-3 grid size-10 place-items-center rounded-xl', tone === 'warn' ? 'bg-warn/15 text-warn' : 'bg-white/8 text-accent')}>{icon}</div>
      <div className="font-display text-3xl font-bold">{value}</div>
      <div className="text-sm text-muted">{label}</div>
    </Card>
  );
}

// ---------------------------------------------------------------- overview
function Overview() {
  const { data, isLoading } = useQuery({ queryKey: ['admin-overview'], queryFn: api.admin.overview, refetchInterval: 30_000 });
  if (isLoading || !data) return <Spinner />;
  const s = data.server;
  const free = s.library.storage.freeBytes;
  const total = s.library.storage.totalBytes;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat icon={<Users className="size-5" />} label="Accounts" value={data.accounts.length} />
        <Stat icon={<Plug className="size-5" />} label={s.plugins.pending ? `${s.plugins.pending} need approval` : 'Plugins'} value={s.plugins.total} tone={s.plugins.pending ? 'warn' : undefined} />
        <Stat icon={<Download className="size-5" />} label="Downloads waiting" value={s.approvals} tone={s.approvals ? 'warn' : undefined} />
        <Stat icon={<Library className="size-5" />} label="Matches to review" value={s.review} tone={s.review ? 'warn' : undefined} />
      </div>
      <Card>
        <h3 className="font-display text-lg font-semibold">Server</h3>
        <div className="mt-2 divide-y divide-line">
          <Row label="Version">{s.version}</Row>
          <Row label="Plugin sandbox" hint="Plugins run in isolated worker processes with Node's permission model.">
            <Badge tone={s.sandbox ? 'ok' : 'warn'}>{s.sandbox ? 'Enforced' : 'Unavailable'}</Badge>
          </Row>
          <Row label="Hardware transcoding">
            <Badge tone={s.hwAccel ? 'ok' : 'default'}>{s.hwAccel ? s.hwAccel.toUpperCase() : 'Software'}</Badge>
          </Row>
          <Row label="Library storage" hint={s.library.lastScan ? `Last scan ${relTime(s.library.lastScan.at)} · ${fmtBytes(s.library.storage.usedByLibrary)} in the library` : 'Never scanned'}>
            {s.library.enabled ? `${fmtBytes(free)} free of ${fmtBytes(total)}` : <Badge>Not configured</Badge>}
          </Row>
          <Row label="Live channels">{s.liveChannels}</Row>
          <Row label="Last backup">{s.backups[0] ? relTime(s.backups[0].createdAt) : 'None yet'}</Row>
          <Row label="Transcode slots">{data.limits.maxTranscodes}</Row>
        </div>
      </Card>
      <Integrations />
    </div>
  );
}

// ---------------------------------------------------------------- integrations
const INTEGRATIONS: { key: string; label: string; hint: ReactNode; secret?: boolean }[] = [
  { key: 'tmdbApiKey', label: 'TMDB API key', hint: <>Movies and shows: posters, details, episodes. Free at <a className="underline" href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">themoviedb.org</a>.</>, secret: true },
  { key: 'openSubtitlesApiKey', label: 'OpenSubtitles API key', hint: 'Subtitle search in the player.', secret: true },
  { key: 'openSubtitlesUsername', label: 'OpenSubtitles username', hint: 'Needed to download subtitles.' },
  { key: 'openSubtitlesPassword', label: 'OpenSubtitles password', hint: 'Stored encrypted.', secret: true },
  { key: 'deeplApiKey', label: 'DeepL API key', hint: 'Optional: better subtitle translation.', secret: true },
];

function Integrations() {
  const act = useAct();
  const { data } = useQuery({ queryKey: ['admin-integrations'], queryFn: api.admin.integrations });
  const [draft, setDraft] = useState<Record<string, string>>({});
  if (!data) return null;
  const dirty = Object.keys(draft).length > 0;
  return (
    <Card>
      <h3 className="font-display text-lg font-semibold">Integrations</h3>
      <p className="mt-1 text-sm text-muted">Keys for outside services. Anything set through environment variables is shown as managed.</p>
      <div className="mt-2 divide-y divide-line">
        {INTEGRATIONS.map((f) => {
          const st = data[f.key];
          return (
            <Row key={f.key} label={f.label} hint={f.hint}>
              {st?.fromEnv ? (
                <Badge tone="ok">Set by environment</Badge>
              ) : (
                <Input
                  type={f.secret ? 'password' : 'text'}
                  autoComplete="off"
                  placeholder={st?.set ? '•••••••• (saved)' : 'Not set'}
                  value={draft[f.key] ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  className="w-64"
                />
              )}
            </Row>
          );
        })}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        {dirty && (
          <Button variant="ghost" onClick={() => setDraft({})}>
            Discard
          </Button>
        )}
        <Button
          variant="primary"
          disabled={!dirty}
          onClick={() =>
            act(
              async () => {
                await api.admin.saveIntegrations(draft);
                setDraft({});
              },
              'Saved',
              [['admin-integrations'], ['home']],
            )
          }
        >
          Save keys
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- people
const ENTITLEMENTS: { key: keyof AccountSettings; label: string }[] = [
  { key: 'multiProfile', label: 'Multiple profiles' },
  { key: 'downloadsEnabled', label: 'Server downloads' },
  { key: 'autoApproveDownloads', label: 'Skip download approval' },
  { key: 'transcodingEnabled', label: 'Transcoding' },
  { key: 'liveTvEnabled', label: 'Live TV' },
  { key: 'musicBooksEnabled', label: 'Music & free books' },
  { key: 'assistantEnabled', label: 'Assistant' },
];

function People() {
  const { data: session } = useSession();
  const { data } = useQuery({ queryKey: ['admin-overview'], queryFn: api.admin.overview });
  const invites = useQuery({ queryKey: ['invites'], queryFn: api.admin.invites });
  const act = useAct();
  const [note, setNote] = useState('');
  const link = (code: string) => `${location.origin}/register?code=${encodeURIComponent(code)}`;
  return (
    <div className="space-y-6">
      <Card>
        <h3 className="font-display text-lg font-semibold">Invite someone</h3>
        <p className="mt-1 text-sm text-muted">Each code works once. Share the link — the code is filled in for them.</p>
        <div className="mt-4 flex gap-2">
          <Input placeholder="Who is it for? (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <Button
            variant="primary"
            icon={<Plus className="size-4" />}
            onClick={() =>
              act(async () => {
                const inv = await api.admin.createInvite(note.trim() || undefined);
                await navigator.clipboard?.writeText(link(inv.code));
                setNote('');
              }, 'Invite link copied', [['invites']])
            }
          >
            Create
          </Button>
        </div>
        <div className="mt-4 divide-y divide-line">
          {invites.data
            ?.filter((i) => i.status === 'available')
            .map((i) => (
              <Row key={i.id} label={<span className="font-mono tracking-widest">{i.code}</span>} hint={[i.note, `created ${relTime(i.createdAt)}`].filter(Boolean).join(' · ')}>
                <div className="flex gap-1">
                  <Button size="sm" icon={<Copy className="size-3.5" />} onClick={() => navigator.clipboard?.writeText(link(i.code)).then(() => toast('Copied', 'ok'))}>
                    Link
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => act(() => api.admin.revokeInvite(i.id), 'Revoked', [['invites']])}>
                    Revoke
                  </Button>
                </div>
              </Row>
            ))}
        </div>
      </Card>
      {data?.accounts.map((a) => (
        <Card key={a.id}>
          <div className="flex flex-wrap items-center gap-3">
            <div className="mr-auto">
              <div className="flex items-center gap-2 font-display text-lg font-semibold">
                {a.username} {a.isAdmin && <Badge tone="accent">Admin</Badge>}
              </div>
              <div className="text-xs text-faint">
                {a.usage.profiles} profiles · {Math.round(a.usage.watchSeconds / 3600)}h watched · {a.usage.lastActivity ? `active ${relTime(a.usage.lastActivity)}` : 'never active'}
              </div>
            </div>
            <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={() => act(() => api.admin.flushAccount(a.id), 'Cache cleared', [['admin-overview']])}>
              Clear cache ({fmtBytes(a.usage.cacheBytes)})
            </Button>
            {a.id !== session?.account.id && (
              <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={() => confirm(`Delete ${a.username} and everything they own?`) && act(() => api.admin.deleteAccount(a.id), 'Account deleted', [['admin-overview']])}>
                Delete
              </Button>
            )}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {ENTITLEMENTS.map((e) => {
              const on = Boolean(a.settings[e.key]);
              return (
                <Chip key={e.key} active={on} onClick={() => act(() => api.admin.updateAccount(a.id, { [e.key]: !on }), undefined, [['admin-overview']])}>
                  {on && <Check className="size-3.5" />} {e.label}
                </Chip>
              );
            })}
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="text-sm">
              <span className="text-muted">Streaming cache</span>
              <Select value={a.settings.cacheMb} onChange={(e) => act(() => api.admin.updateAccount(a.id, { cacheMb: Number(e.target.value) }), undefined, [['admin-overview']])} className="mt-1">
                {[...new Set([0, 2048, 4096, 8192, 16384, 32768, 65536, a.settings.cacheMb])].sort((x, y) => x - y).map((v) => (
                  <option key={v} value={v}>
                    {v === 0 ? 'Server default' : fmtBytes(v * 1024 * 1024)}
                  </option>
                ))}
              </Select>
            </label>
            <label className="text-sm">
              <span className="text-muted">Profile limit</span>
              <Select value={a.settings.maxProfiles} onChange={(e) => act(() => api.admin.updateAccount(a.id, { maxProfiles: Number(e.target.value) }), undefined, [['admin-overview']])} className="mt-1">
                {[1, 2, 3, 4, 5, 6, 8, 10].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </Select>
            </label>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- plugins
function Permissions({ p }: { p: PermissionSummary }) {
  const rows: [ReactNode, string, string[]][] = [
    [<Globe key="g" className="size-4" />, 'Network', p.network],
    [<HardDrive key="h" className="size-4" />, 'Files', p.fs.map((f) => `${f.path} (${f.access})`)],
    [<Database key="d" className="size-4" />, 'Storage', p.storage ? ['Own key-value store'] : []],
    [<Shield key="s" className="size-4" />, 'Server API', p.api],
  ];
  const any = rows.some((r) => r[2].length);
  if (!any) return <p className="text-sm text-ok">Asks for no special access.</p>;
  return (
    <div className="space-y-2">
      {rows
        .filter((r) => r[2].length)
        .map(([icon, label, items]) => (
          <div key={label} className="flex gap-3 rounded-xl bg-white/4 p-3">
            <span className="mt-0.5 text-accent">{icon}</span>
            <div className="min-w-0">
              <div className="text-sm font-semibold">{label}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {items.map((i) => (
                  <code key={i} className="rounded-md bg-white/8 px-1.5 py-0.5 text-xs">
                    {i}
                  </code>
                ))}
              </div>
            </div>
          </div>
        ))}
    </div>
  );
}

function ConfigForm({ fields, values, onChange }: { fields: (ConfigField & { managed?: boolean })[]; values: Record<string, unknown>; onChange: (k: string, v: unknown) => void }) {
  return (
    <div className="space-y-3">
      {fields.map((f) => (
        <label key={f.key} className="block">
          <span className="text-sm font-medium">
            {f.title}
            {f.required && <span className="text-bad"> *</span>}
            {f.managed && <Badge className="ml-2">Set by server env</Badge>}
          </span>
          {f.description && <span className="block text-xs text-faint">{f.description}</span>}
          <div className="mt-1.5">
            {f.type === 'checkbox' ? (
              <Switch checked={Boolean(values[f.key] ?? f.default)} onChange={(v) => onChange(f.key, v)} disabled={f.managed} />
            ) : f.type === 'select' ? (
              <Select value={String(values[f.key] ?? f.default ?? '')} onChange={(e) => onChange(f.key, e.target.value)} disabled={f.managed}>
                {f.options?.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            ) : f.type === 'textarea' ? (
              <TextArea value={String(values[f.key] ?? '')} onChange={(e) => onChange(f.key, e.target.value)} disabled={f.managed} />
            ) : (
              <Input
                type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
                value={String(values[f.key] ?? '')}
                placeholder={f.default != null ? String(f.default) : undefined}
                onChange={(e) => onChange(f.key, f.type === 'number' ? Number(e.target.value) : e.target.value)}
                disabled={f.managed}
              />
            )}
          </div>
        </label>
      ))}
    </div>
  );
}

function InstallDialog({ url, onClose }: { url: string; onClose: () => void }) {
  const act = useAct();
  const preview = useQuery({ queryKey: ['plugin-preview', url], queryFn: () => api.admin.preview(url), retry: false });
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const p: InstallPreview | undefined = preview.data;
  const fields = [...(p?.manifest.nova?.config ?? []), ...(p?.manifest.config ?? [])];
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open
      onClose={onClose}
      title="Install plugin"
      wide
      footer={
        p && (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={p.installed}
              onClick={async () => {
                setBusy(true);
                await act(() => api.admin.install(url, config), `${p.manifest.name} installed`, [['admin-plugins'], ['contributions']]);
                setBusy(false);
                onClose();
              }}
            >
              {p.installed ? 'Already installed' : 'Allow & install'}
            </Button>
          </>
        )
      }
    >
      {preview.isLoading && <Spinner />}
      {preview.error && <p className="text-sm text-bad">{errorText(preview.error)}</p>}
      {p && (
        <div className="space-y-5">
          <div className="flex items-center gap-4">
            {p.manifest.logo ? <img src={p.manifest.logo} alt="" className="size-14 rounded-2xl bg-white/5 object-contain" /> : <div className="bg-gradient-accent grid size-14 place-items-center rounded-2xl text-on-accent"><Plug /></div>}
            <div className="min-w-0">
              <div className="flex items-center gap-2 font-display text-xl font-semibold">
                {p.manifest.name} <Badge>{p.kind === 'stremio' ? 'Stremio add-on' : 'Nova plugin'}</Badge>
              </div>
              <div className="text-sm text-muted">v{p.manifest.version} · {p.manifest.types.join(', ')}</div>
            </div>
          </div>
          {p.manifest.description && <p className="line-clamp-4 text-sm text-muted">{p.manifest.description}</p>}
          <div>
            <div className="mb-2 text-sm font-semibold">It will be able to</div>
            {p.kind === 'stremio' ? (
              <p className="text-sm text-muted">
                Stremio add-ons run on their own server. Nova only calls <code>{new URL(p.sourceUrl).host}</code> and never runs their code here.
              </p>
            ) : (
              <Permissions p={p.permissions} />
            )}
            {p.kind === 'local' && !p.sandbox && <p className="mt-2 text-sm text-warn">This server can't enforce the sandbox — only install plugins you trust.</p>}
          </div>
          {fields.length > 0 && (
            <div>
              <div className="mb-2 text-sm font-semibold">Settings</div>
              <ConfigForm fields={fields} values={config} onChange={(k, v) => setConfig((c) => ({ ...c, [k]: v }))} />
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function PluginCard({ p }: { p: PluginInfo }) {
  const act = useAct();
  const [open, setOpen] = useState<'config' | 'logs' | null>(null);
  const [config, setConfig] = useState<Record<string, unknown>>(() => Object.fromEntries(p.config.map((c) => [c.key, c.value])));
  const logs = useQuery({ queryKey: ['plugin-logs', p.id], queryFn: () => api.admin.logs(p.id), enabled: open === 'logs', refetchInterval: open === 'logs' ? 3000 : false });
  const keys = [['admin-plugins'], ['contributions']];
  const running = p.runtime.status === 'running' || p.runtime.status === 'remote';
  return (
    <Card className="p-5!">
      <div className="flex items-start gap-4">
        {p.logo ? <img src={p.logo} alt="" className="size-12 shrink-0 rounded-xl bg-white/5 object-contain" /> : <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-white/8 text-accent"><Plug className="size-5" /></div>}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-display text-lg font-semibold">{p.name}</span>
            <span className="text-xs text-faint">v{p.version}</span>
            <Badge>{p.kind === 'stremio' ? 'Stremio' : 'Nova'}</Badge>
            {p.status === 'pending' && <Badge tone="warn">Needs approval</Badge>}
            {p.enabled && p.status === 'approved' && <Badge tone={running ? 'ok' : 'bad'}>{running ? (p.runtime.status === 'remote' ? 'Remote' : 'Running') : p.runtime.status}</Badge>}
          </div>
          <div className="mt-0.5 text-sm text-muted">{p.description}</div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {p.resources.map((r) => (
              <span key={r} className="rounded-md bg-white/6 px-1.5 py-0.5 text-[11px] text-faint">
                {r}
              </span>
            ))}
          </div>
          {p.runtime.lastError && <p className="mt-2 rounded-lg bg-bad/10 px-2.5 py-1.5 text-xs text-bad">{p.runtime.lastError}</p>}
        </div>
        <Switch checked={p.enabled} onChange={(v) => act(() => api.admin.updatePlugin(p.id, { enabled: v }), undefined, keys)} />
      </div>

      {(p.status === 'pending' || p.pendingUpdate) && (
        <div className="mt-4 rounded-2xl border border-warn/30 bg-warn/5 p-4">
          <div className="mb-2 text-sm font-semibold">{p.pendingUpdate ? `Update to v${p.pendingUpdate.version} asks for:` : 'Asks for:'}</div>
          <Permissions p={p.pendingUpdate?.permissions ?? p.requested} />
          <Button className="mt-3" variant="primary" size="sm" onClick={() => act(() => api.admin.approve(p.id), 'Approved', keys)}>
            Approve
          </Button>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {p.config.length > 0 && (
          <Button size="sm" onClick={() => setOpen(open === 'config' ? null : 'config')}>
            Settings
          </Button>
        )}
        <Button size="sm" icon={<FlaskConical className="size-3.5" />} onClick={() => act(async () => {
          const r = await api.admin.test(p.id);
          toast(`${r.ok ? '✓' : '✗'} ${r.message} (${r.ms} ms)`, r.ok ? 'ok' : 'bad');
        })}>
          Test
        </Button>
        {p.kind === 'local' && (
          <Button size="sm" icon={<ScrollText className="size-3.5" />} onClick={() => setOpen(open === 'logs' ? null : 'logs')}>
            Logs
          </Button>
        )}
        <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={() => act(async () => {
          const r = await api.admin.checkUpdate(p.id);
          toast(r.result === 'none' ? 'Up to date' : r.result === 'updated' ? `Updated to v${r.plugin.version}` : 'Update needs your approval', 'ok');
        }, undefined, keys)}>
          Check for update
        </Button>
        <label className="ml-auto flex items-center gap-2 text-xs text-muted">
          Priority
          <input
            type="number"
            defaultValue={p.priority}
            onBlur={(e) => Number(e.target.value) !== p.priority && act(() => api.admin.updatePlugin(p.id, { priority: Number(e.target.value) }), undefined, keys)}
            className="h-8 w-16 rounded-lg border border-line bg-white/5 px-2 text-sm"
          />
        </label>
        <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={() => confirm(`Uninstall ${p.name}?`) && act(() => api.admin.uninstall(p.id), 'Uninstalled', keys)}>
          Remove
        </Button>
      </div>

      <AnimatePresence>
        {open === 'config' && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="mt-4 border-t border-line pt-4">
              <ConfigForm fields={p.config} values={config} onChange={(k, v) => setConfig((c) => ({ ...c, [k]: v }))} />
              <Button className="mt-4" variant="primary" size="sm" onClick={() => act(() => api.admin.updatePlugin(p.id, { config }), 'Saved', keys)}>
                Save settings
              </Button>
            </div>
          </motion.div>
        )}
        {open === 'logs' && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <pre className="mt-4 max-h-72 overflow-auto rounded-xl bg-black/40 p-3 font-mono text-[11px] leading-relaxed">
              {logs.data?.length
                ? logs.data.map((l) => `${l.timestamp.slice(11, 19)} ${l.level.toUpperCase().padEnd(5)} ${l.msg}`).join('\n')
                : 'No log lines yet.'}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}

function Plugins() {
  const installed = useQuery({ queryKey: ['admin-plugins'], queryFn: api.admin.plugins });
  const registry = useQuery({ queryKey: ['plugin-registry'], queryFn: api.admin.registry, staleTime: 10 * 60_000, retry: false });
  const [url, setUrl] = useState('');
  const [installing, setInstalling] = useState<string | null>(null);
  const [tab, setTab] = useState<'installed' | 'discover'>('installed');
  const list = installed.data?.plugins ?? [];
  return (
    <div className="space-y-6">
      <Card>
        <h3 className="font-display text-lg font-semibold">Add a plugin</h3>
        <p className="mt-1 text-sm text-muted">Paste a Nova plugin or Stremio add-on manifest URL (it ends in <code>manifest.json</code>). Configured Stremio add-ons like Torrentio work as-is.</p>
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) setInstalling(url.trim().replace(/^stremio:\/\//, 'https://'));
          }}
        >
          <Input placeholder="https://…/manifest.json" value={url} onChange={(e) => setUrl(e.target.value)} />
          <Button type="submit" variant="primary" disabled={!url.trim()}>
            Review
          </Button>
        </form>
      </Card>
      <Segmented value={tab} onChange={setTab} options={[{ value: 'installed', label: `Installed ${list.length}` }, { value: 'discover', label: 'Discover' }]} />
      {tab === 'installed' && (
        <div className="space-y-4">
          {installed.isLoading && <Spinner />}
          {!installed.isLoading && !list.length && <Empty icon={<Plug />} title="No plugins yet">Sources, catalogues, subtitles and live TV all come from plugins. Start in Discover.</Empty>}
          {list.map((p) => (
            <PluginCard key={p.id} p={p} />
          ))}
        </div>
      )}
      {tab === 'discover' && (
        <div className="grid gap-4 sm:grid-cols-2">
          {registry.isLoading && <Spinner />}
          {registry.error && <p className="text-sm text-bad">{errorText(registry.error)}</p>}
          {registry.data?.map((r) => (
            <Card key={`${r.registry}:${r.id}`} className="flex flex-col p-5!">
              <div className="flex items-start gap-3">
                {r.logo ? <img src={r.logo} alt="" className="size-11 rounded-xl bg-white/5 object-contain" /> : <div className="grid size-11 place-items-center rounded-xl bg-white/8 text-accent"><Plug className="size-5" /></div>}
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{r.name}</div>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    <Badge>{r.kind === 'stremio' ? 'Stremio' : 'Nova'}</Badge>
                    {r.tags?.slice(0, 3).map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                  </div>
                </div>
              </div>
              <p className="mt-3 flex-1 text-sm text-muted">{r.description}</p>
              <div className="mt-4 flex gap-2">
                {r.configure && (
                  <a href={r.configure} target="_blank" rel="noopener noreferrer">
                    <Button size="sm">Configure first</Button>
                  </a>
                )}
                <Button size="sm" variant={r.installed ? 'ghost' : 'white'} disabled={r.installed} onClick={() => setInstalling(r.manifest)}>
                  {r.installed ? 'Installed' : 'Install'}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      {installing && <InstallDialog url={installing} onClose={() => setInstalling(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- library
function ReviewItem({ item, pick, onPick }: { item: LibraryItem; pick: string | undefined; onPick: (mediaId: string) => void }) {
  const act = useAct();
  const [q, setQ] = useState('');
  const search = useQuery({ queryKey: ['candidates', item.kind, q], queryFn: () => api.server.candidates(item.kind, q, item.year), enabled: q.length >= 2 });
  const options = q.length >= 2 ? (search.data ?? []) : item.candidates;
  return (
    <Card className="p-4!">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{item.folder ?? item.title}</div>
          <div className="text-xs text-faint">
            {item.kind} · {item.fileCount} files · {fmtBytes(item.sizeBytes)}
            {item.matchConfidence != null && ` · best guess ${item.matchConfidence}%`}
          </div>
        </div>
        <label className="glass flex h-9 items-center gap-2 rounded-full px-3">
          <Search className="size-4 text-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search instead" className="w-32 bg-transparent text-sm focus:outline-none" />
        </label>
      </div>
      <div className="scrollbar-none mt-3 flex gap-3 overflow-x-auto">
        {options.map((c) => (
          <button key={c.mediaId} onClick={() => onPick(c.mediaId)} className={cls('w-28 shrink-0 rounded-xl p-1.5 text-left ring-2 transition', pick === c.mediaId ? 'bg-white/10 ring-accent' : 'ring-transparent hover:bg-white/5')}>
            {c.poster ? <img src={c.poster} alt="" className="aspect-[2/3] w-full rounded-lg object-cover" /> : <div className="aspect-[2/3] rounded-lg bg-white/5" />}
            <div className="mt-1.5 truncate text-xs font-semibold">{c.title}</div>
            <div className="text-[11px] text-faint">
              {c.year ?? '—'} · {c.confidence}%
            </div>
          </button>
        ))}
        {!options.length && <p className="py-6 text-sm text-muted">No candidates — search for the right title.</p>}
      </div>
      {pick && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" variant="white" onClick={() => act(() => api.server.match(item.id, pick, false), 'Matched', [['review'], ['admin-overview']])}>
            Match this item
          </Button>
          {(item.kind === 'tv' || item.kind === 'anime') && (
            <Button size="sm" onClick={() => act(() => api.server.match(item.id, pick, true), 'Matched the whole season', [['review'], ['admin-overview']])}>
              Match the whole season
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function LibraryAdmin() {
  const act = useAct();
  const status = useQuery({ queryKey: ['server-status'], queryFn: api.server.status });
  const review = useQuery({ queryKey: ['review'], queryFn: api.server.review });
  const profiles = useQuery({ queryKey: ['quality-profiles'], queryFn: api.server.qualityProfiles });
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [scanning, setScanning] = useState(false);
  const accepted = useMemo(() => Object.entries(picks).map(([itemId, mediaId]) => ({ itemId, mediaId })), [picks]);
  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <div className="mr-auto">
            <h3 className="font-display text-lg font-semibold">Server library</h3>
            <p className="text-sm text-muted">
              {status.data?.enabled ? `Scanned ${status.data.lastScan ? relTime(status.data.lastScan.at) : 'never'} · ${fmtBytes(status.data.storage.freeBytes)} free` : 'No library folder is configured on the server (LIBRARY_DIR).'}
            </p>
          </div>
          <Button
            variant="primary"
            loading={scanning}
            disabled={!status.data?.enabled}
            icon={<RefreshCw className="size-4" />}
            onClick={async () => {
              setScanning(true);
              await act(async () => {
                const r = await api.server.scan();
                toast(`Scan done — ${r.added} added, ${r.removed} removed${r.review ? `, ${r.review} to review` : ''}`, 'ok');
              }, undefined, [['review'], ['server-status']]);
              setScanning(false);
            }}
          >
            Scan now
          </Button>
        </div>
      </Card>

      <div>
        <div className="mb-3 flex items-center gap-3">
          <h3 className="mr-auto font-display text-xl font-semibold">Review matches {review.data?.length ? <span className="text-faint">· {review.data.length}</span> : null}</h3>
          {accepted.length > 1 && (
            <Button variant="white" onClick={() => act(() => api.server.bulkMatch(accepted).then(() => setPicks({})), `Matched ${accepted.length} items`, [['review'], ['admin-overview']])}>
              Apply {accepted.length} picks
            </Button>
          )}
        </div>
        {!review.data?.length && <p className="text-sm text-muted">Everything is matched. Uncertain matches land here after a scan.</p>}
        <div className="space-y-3">
          {review.data?.map((i) => (
            <ReviewItem key={i.id} item={i} pick={picks[i.id]} onPick={(m) => setPicks((p) => ({ ...p, [i.id]: m }))} />
          ))}
        </div>
      </div>

      <Card>
        <h3 className="font-display text-lg font-semibold">Quality profiles</h3>
        <p className="mt-1 text-sm text-muted">Used by auto-download rules. The default applies when a rule doesn't pick one.</p>
        <div className="mt-3 divide-y divide-line">
          {profiles.data?.map((q) => (
            <Row
              key={q.id}
              label={<span className="flex items-center gap-2">{q.name} {q.isDefault && <Badge tone="accent">Default</Badge>}</span>}
              hint={`${q.torrent.preferredQualities.join(' › ')} · up to ${q.torrent.maxQuality} · ≤ ${q.torrent.maxSizeGb} GB · ${q.torrent.preferredCodecs.join('/')}`}
            >
              <div className="flex gap-1">
                {!q.isDefault && (
                  <Button size="sm" onClick={() => act(() => api.server.saveQualityProfile({ id: q.id, name: q.name, isDefault: true }), 'Default changed', [['quality-profiles']])}>
                    Make default
                  </Button>
                )}
                {!q.isDefault && (
                  <button onClick={() => act(() => api.server.deleteQualityProfile(q.id), 'Removed', [['quality-profiles']])} aria-label="Delete profile" className="rounded-lg p-2 text-muted hover:text-bad">
                    <Trash2 className="size-4" />
                  </button>
                )}
              </div>
            </Row>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- downloads
function DownloadsAdmin() {
  const act = useAct();
  const { data } = useQuery({ queryKey: ['admin-downloads'], queryFn: () => api.server.downloads(true), refetchInterval: 5000 });
  const pending = data?.filter((d) => d.status === 'pending') ?? [];
  const rest = data?.filter((d) => d.status !== 'pending') ?? [];
  const keys = [['admin-downloads'], ['admin-overview']];
  return (
    <div className="space-y-6">
      <div>
        <h3 className="mb-3 font-display text-xl font-semibold">Waiting for approval</h3>
        {!pending.length && <p className="text-sm text-muted">Nothing to approve.</p>}
        <div className="space-y-2">
          {pending.map((d) => (
            <Card key={d.id} className="flex items-center gap-4 p-3!">
              {d.poster && <img src={d.poster} alt="" className="h-14 w-10 rounded-lg object-cover" />}
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{d.title}</div>
                <div className="truncate text-xs text-faint">
                  {d.username} · {d.release.title} · {fmtBytes(d.release.sizeBytes)}
                </div>
              </div>
              <Button size="sm" variant="white" icon={<Check className="size-3.5" />} onClick={() => act(() => api.server.approve(d.id, true), 'Approved', keys)}>
                Approve
              </Button>
              <Button size="sm" variant="danger" icon={<X className="size-3.5" />} onClick={() => act(() => api.server.approve(d.id, false), 'Declined', keys)}>
                Decline
              </Button>
            </Card>
          ))}
        </div>
      </div>
      <div>
        <h3 className="mb-3 font-display text-xl font-semibold">All downloads</h3>
        <div className="divide-y divide-line rounded-3xl border border-line">
          {rest.map((d) => (
            <div key={d.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <Badge tone={d.status === 'completed' ? 'ok' : d.status === 'failed' ? 'bad' : 'default'}>{d.status}</Badge>
              <span className="min-w-0 flex-1 truncate">{d.title}</span>
              <span className="text-xs text-faint">{d.username}</span>
              <span className="w-16 text-right text-xs text-muted tabular-nums">{d.status === 'downloading' ? `${Math.round(d.progress * 100)}%` : fmtBytes(d.bytesTotal || d.release.sizeBytes)}</span>
            </div>
          ))}
          {!rest.length && <p className="p-4 text-sm text-muted">No downloads yet.</p>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- live tv
const SOURCE_FIELDS: Record<string, { key: string; label: string; type?: string; placeholder?: string }[]> = {
  m3u: [{ key: 'url', label: 'Playlist URL', placeholder: 'https://…/playlist.m3u' }],
  xtream: [
    { key: 'server', label: 'Server', placeholder: 'http://provider:8080' },
    { key: 'username', label: 'Username' },
    { key: 'password', label: 'Password', type: 'password' },
  ],
  stalker: [
    { key: 'portal', label: 'Portal URL', placeholder: 'http://portal/stalker_portal/c/' },
    { key: 'mac', label: 'MAC address', placeholder: '00:1A:79:…' },
  ],
  hdhomerun: [{ key: 'host', label: 'Tuner address', placeholder: '192.168.1.50' }],
  plugin: [{ key: 'pluginId', label: 'Plugin id' }],
};

function Directory() {
  const act = useAct();
  const dir = useQuery({ queryKey: ['iptv-dir'], queryFn: api.live.directory, staleTime: Infinity });
  const [by, setBy] = useState<'countries' | 'categories' | 'languages'>('countries');
  const [code, setCode] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<DirectoryChannel | null>(null);
  const [filter, setFilter] = useState('');
  const list = useQuery({ queryKey: ['iptv-list', by, code], queryFn: () => api.live.directoryList(by, code), enabled: Boolean(code) });
  const options = by === 'countries' ? dir.data?.countries.map((c) => ({ value: c.code, label: `${c.flag ?? ''} ${c.name}` })) : by === 'categories' ? dir.data?.categories.map((c) => ({ value: c.id, label: c.name })) : dir.data?.languages.map((c) => ({ value: c.code, label: c.name }));
  const shown = (list.data ?? []).filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Card>
      <h3 className="font-display text-lg font-semibold">Public channel directory</h3>
      <p className="mt-1 text-sm text-muted">Free-to-air streams collected by iptv-org. Preview, tick the ones you want, add them to everyone's lineup.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Segmented size="sm" value={by} onChange={(v) => { setBy(v); setCode(''); }} options={[{ value: 'countries', label: 'Country' }, { value: 'categories', label: 'Category' }, { value: 'languages', label: 'Language' }]} />
        <Select value={code} onChange={(e) => setCode(e.target.value)} className="h-9 w-56">
          <option value="">Choose…</option>
          {options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        {list.data && <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" className="h-9 w-40" />}
      </div>
      {list.isLoading && code && <Spinner className="mt-4" />}
      {preview && (
        <div className="mt-4 aspect-video overflow-hidden rounded-2xl bg-black">
          <LiveVideo play={{ ...preview.preview, name: preview.name, logo: preview.logo }} onError={(m) => toast(m, 'bad')} />
        </div>
      )}
      {list.data && (
        <>
          <div className="mt-4 max-h-[420px] divide-y divide-line overflow-y-auto rounded-2xl border border-line">
            {shown.map((c) => (
              <label key={c.url} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-white/4">
                <input
                  type="checkbox"
                  checked={picked.has(c.url)}
                  onChange={(e) => {
                    const n = new Set(picked);
                    if (e.target.checked) n.add(c.url);
                    else n.delete(c.url);
                    setPicked(n);
                  }}
                  className="size-4 accent-[var(--a1)]"
                />
                {c.logo ? <img src={c.logo} alt="" loading="lazy" className="h-6 w-9 object-contain" /> : <Radio className="size-4 text-faint" />}
                <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
                <span className="text-xs text-faint">{c.group}</span>
                <button onClick={(e) => { e.preventDefault(); setPreview(c); }} className="rounded-lg px-2 py-1 text-xs text-muted hover:bg-white/8 hover:text-fg">
                  Preview
                </button>
              </label>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" onClick={() => setPicked(new Set(shown.map((c) => c.url)))}>
              Select all {shown.length}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!picked.size}
              onClick={() =>
                act(async () => {
                  const n = await api.live.directoryAdd((list.data ?? []).filter((c) => picked.has(c.url)).map(({ name, url, tvgId, logo, group, country }) => ({ name, url, tvgId, logo, group, country })));
                  toast(`Added ${n} channels`, 'ok');
                  setPicked(new Set());
                }, undefined, [['live-sources'], ['live-channels']])
              }
            >
              Add {picked.size || ''} to lineup
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

function LiveAdmin() {
  const act = useAct();
  const sources = useQuery({ queryKey: ['live-sources'], queryFn: api.live.sources });
  const [kind, setKind] = useState('m3u');
  const [name, setName] = useState('');
  const [epg, setEpg] = useState('');
  const [cfg, setCfg] = useState<Record<string, string>>({});
  const keys = [['live-sources'], ['live-channels'], ['admin-overview']];
  return (
    <div className="space-y-6">
      <Card>
        <h3 className="font-display text-lg font-semibold">Add a TV source</h3>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Select value={kind} onChange={(e) => { setKind(e.target.value); setCfg({}); }}>
            <option value="m3u">M3U playlist</option>
            <option value="xtream">Xtream Codes</option>
            <option value="stalker">Stalker / Ministra portal</option>
            <option value="hdhomerun">HDHomeRun tuner</option>
            {(sources.data?.plugins.length ?? 0) > 0 && <option value="plugin">Plugin</option>}
          </Select>
          <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          {kind === 'plugin' ? (
            <Select value={cfg.pluginId ?? ''} onChange={(e) => setCfg({ pluginId: e.target.value })} className="sm:col-span-2">
              <option value="">Choose a plugin…</option>
              {sources.data?.plugins.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          ) : (
            (SOURCE_FIELDS[kind] ?? []).map((f) => (
              <Input key={f.key} type={f.type} placeholder={f.placeholder ?? f.label} value={cfg[f.key] ?? ''} onChange={(e) => setCfg({ ...cfg, [f.key]: e.target.value })} className={SOURCE_FIELDS[kind]!.length === 1 ? 'sm:col-span-2' : undefined} />
            ))
          )}
          {kind !== 'hdhomerun' && <Input className="sm:col-span-2" placeholder="Guide (XMLTV) URL — optional" value={epg} onChange={(e) => setEpg(e.target.value)} />}
          <Button
            variant="primary"
            className="sm:col-span-2"
            disabled={!name.trim()}
            onClick={() =>
              act(async () => {
                const s = await api.live.addSource({ kind, name: name.trim(), config: cfg, epgUrl: epg.trim() || null });
                const r = await api.live.refreshSource(s.id);
                toast(`${r.source.channelCount} channels, ${r.programmes} guide entries`, 'ok');
                setName('');
                setCfg({});
                setEpg('');
              }, undefined, keys)
            }
          >
            Add & load channels
          </Button>
        </div>
      </Card>
      <div className="space-y-3">
        {sources.data?.sources.map((s) => (
          <Card key={s.id} className="flex flex-wrap items-center gap-3 p-4!">
            <Radio className="size-5 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="font-semibold">
                {s.name} <span className="text-xs font-normal text-faint">· {s.kind}</span>
              </div>
              <div className="text-xs text-faint">
                {s.channelCount} channels · {s.lastRefreshedAt ? `refreshed ${relTime(s.lastRefreshedAt)}` : 'never refreshed'}
                {s.epgUrl ? ' · guide' : ''}
              </div>
              {s.error && <div className="mt-1 text-xs text-bad">{s.error}</div>}
            </div>
            <Switch checked={s.enabled} onChange={(v) => act(() => api.live.updateSource(s.id, { enabled: v }), undefined, keys)} />
            <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={() => act(async () => {
              const r = await api.live.refreshSource(s.id);
              toast(`${r.source.channelCount} channels, ${r.programmes} guide entries`, 'ok');
            }, undefined, keys)}>
              Refresh
            </Button>
            <button onClick={() => confirm(`Remove ${s.name}?`) && act(() => api.live.deleteSource(s.id), 'Removed', keys)} aria-label="Remove" className="rounded-lg p-2 text-muted hover:text-bad">
              <Trash2 className="size-4" />
            </button>
          </Card>
        ))}
      </div>
      <Directory />
    </div>
  );
}

// ---------------------------------------------------------------- backups
function Backups() {
  const act = useAct();
  const { data } = useQuery({ queryKey: ['backups'], queryFn: api.admin.backups });
  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <div className="mr-auto">
            <h3 className="font-display text-lg font-semibold">Database backups</h3>
            <p className="text-sm text-muted">{data ? `Daily at ${String(data.hourUtc).padStart(2, '0')}:00 UTC, keeping the last ${data.keep}.` : '…'} Each user can export their own history and lists from Settings.</p>
          </div>
          <Button variant="primary" icon={<Archive className="size-4" />} onClick={() => act(() => api.admin.backupNow(), 'Backup created', [['backups']])}>
            Back up now
          </Button>
        </div>
      </Card>
      <div className="divide-y divide-line rounded-3xl border border-line">
        {data?.backups.map((b) => (
          <div key={b.name} className="flex items-center gap-3 px-4 py-3">
            <Lock className="size-4 text-faint" />
            <span className="min-w-0 flex-1 truncate font-mono text-sm">{b.name}</span>
            <span className="text-xs text-faint">{relTime(b.createdAt)}</span>
            <span className="w-20 text-right text-xs text-muted">{fmtBytes(b.size)}</span>
            <a href={api.admin.backupUrl(b.name)} download aria-label="Download backup" className="rounded-lg p-2 text-muted hover:bg-white/8 hover:text-fg">
              <Download className="size-4" />
            </a>
          </div>
        ))}
        {!data?.backups.length && <p className="p-4 text-sm text-muted">No backups yet.</p>}
      </div>
    </div>
  );
}

export default function Admin() {
  const { section = '' } = useParams();
  const { data: session } = useSession();
  if (!session?.account.isAdmin) return <Empty icon={<Shield />} title="Admins only" />;
  const active = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]!;
  return (
    <div className="px-5 pt-24 sm:px-10 sm:pt-28">
      <h1 className="flex items-center gap-3 font-display text-4xl font-bold sm:text-6xl">
        Server <Cpu className="size-8 text-faint sm:size-10" />
      </h1>
      <div className="mt-8 grid gap-8 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav className="scrollbar-none -mx-5 flex gap-1 overflow-x-auto px-5 lg:mx-0 lg:flex-col lg:px-0">
          {SECTIONS.map((s) => (
            <NavLink key={s.id} to={`/admin${s.id ? `/${s.id}` : ''}`} end className="relative flex shrink-0 items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium">
              {({ isActive }) => (
                <>
                  {isActive && <motion.span layoutId="admin-nav" className="absolute inset-0 rounded-xl bg-white/10" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
                  <s.icon className={cls('relative size-4', isActive ? 'text-accent' : 'text-faint')} />
                  <span className={cls('relative', isActive ? 'text-fg' : 'text-muted')}>{s.label}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <motion.div key={active.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="max-w-4xl pb-10">
          {active.id === '' && <Overview />}
          {active.id === 'people' && <People />}
          {active.id === 'plugins' && <Plugins />}
          {active.id === 'library' && <LibraryAdmin />}
          {active.id === 'downloads' && <DownloadsAdmin />}
          {active.id === 'live' && <LiveAdmin />}
          {active.id === 'backups' && <Backups />}
        </motion.div>
      </div>
    </div>
  );
}
