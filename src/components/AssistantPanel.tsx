import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Check, History, Plus, Sparkles, Undo2, Wrench, X } from 'lucide-react';
import { api, postSse } from '../lib/api';
import { cls } from '../lib/format';
import { errorText, toast, useApp } from '../lib/store';
import type { Receipt } from '../lib/types';
import { Markdown } from './Markdown';
import { Button, Menu, MenuItem, Select, Spinner } from './ui';

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string }
  | { kind: 'receipt'; receipt: Receipt }
  | { kind: 'error'; text: string };

const TOOL_LABELS: Record<string, string> = {
  search_catalog: 'Searched the catalogue',
  get_title: 'Looked up a title',
  add_to_my_list: 'Updated My List',
  remove_from_my_list: 'Updated My List',
  list_collections: 'Read your collections',
  create_collection: 'Created a collection',
  add_to_collection: 'Updated a collection',
  find_sources: 'Searched sources',
  request_download: 'Prepared a download',
  list_downloads: 'Checked downloads',
  cancel_download: 'Prepared a cancellation',
  auto_download: 'Prepared an auto-download rule',
  library_review: 'Checked library matches',
  fix_match: 'Prepared a match fix',
  whats_on_tv: 'Checked the TV guide',
};

const SUGGESTIONS = ['What should I watch tonight?', 'Make a collection of cozy anime', 'What new episodes air this week?', "What's on TV right now?"];

export default function AssistantPanel() {
  const close = useApp((s) => s.closeAssistant);
  const context = useApp((s) => s.assistant.context);
  const qc = useQueryClient();
  const providers = useQuery({ queryKey: ['assistant-providers'], queryFn: api.assistant.providers });
  const threads = useQuery({ queryKey: ['assistant-threads'], queryFn: api.assistant.threads });
  const usable = (providers.data ?? []).filter((p) => p.enabled);
  const [providerId, setProviderId] = useState<string>(() => localStorage.getItem('nova.assistant.provider') ?? '');
  const [threadId, setThreadId] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState(context?.kind === 'prompt' ? (context.label ?? '') : '');
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!usable.length) return;
    if (!usable.some((p) => p.id === providerId)) setProviderId(usable[0]!.id);
  }, [usable, providerId]);
  useEffect(() => localStorage.setItem('nova.assistant.provider', providerId), [providerId]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [items]);
  useEffect(() => () => abort.current?.abort(), []);

  const loadThread = async (id: string) => {
    const t = await api.assistant.thread(id);
    setThreadId(id);
    const out: Item[] = [];
    for (const m of t.messages) {
      const c = m.content as { role?: string; content?: string; toolCalls?: { name: string }[] };
      if (m.role === 'user' && c.content) out.push({ kind: 'user', text: c.content });
      if (m.role === 'assistant') {
        for (const call of c.toolCalls ?? []) out.push({ kind: 'tool', name: call.name });
        if (c.content && !c.toolCalls?.length) out.push({ kind: 'assistant', text: c.content });
      }
    }
    for (const r of t.receipts) out.push({ kind: 'receipt', receipt: r });
    setItems(out);
  };

  const send = async (text: string) => {
    if (!text.trim() || !providerId || busy) return;
    setInput('');
    setBusy(true);
    setItems((it) => [...it, { kind: 'user', text }]);
    abort.current = new AbortController();
    try {
      await postSse(
        '/api/assistant/ask',
        { threadId, providerId, message: text, context: context && context.kind !== 'prompt' ? context : null },
        (event, data) => {
          const d = data as Record<string, unknown>;
          if (event === 'thread') setThreadId(String(d.threadId));
          else if (event === 'tool') setItems((it) => [...it, { kind: 'tool', name: String(d.name) }]);
          else if (event === 'receipt') setItems((it) => [...it, { kind: 'receipt', receipt: d as unknown as Receipt }]);
          else if (event === 'message') setItems((it) => [...it, { kind: 'assistant', text: String(d.text) }]);
          else if (event === 'error') setItems((it) => [...it, { kind: 'error', text: String(d.error) }]);
        },
        abort.current.signal,
      );
    } catch (e) {
      if (!(e instanceof DOMException)) setItems((it) => [...it, { kind: 'error', text: errorText(e) }]);
    } finally {
      setBusy(false);
      qc.invalidateQueries({ queryKey: ['assistant-threads'] });
      qc.invalidateQueries({ queryKey: ['list'] });
      qc.invalidateQueries({ queryKey: ['collections'] });
    }
  };

  const updateReceipt = (id: string, status: Receipt['status']) =>
    setItems((it) => it.map((x) => (x.kind === 'receipt' && x.receipt.id === id ? { ...x, receipt: { ...x.receipt, status } } : x)));

  const act = async (r: Receipt, what: 'apply' | 'discard' | 'undo') => {
    try {
      if (what === 'apply') {
        const res = await api.assistant.apply(r.id);
        updateReceipt(r.id, 'applied');
        toast(res.message || 'Done', 'ok');
      } else if (what === 'discard') {
        await api.assistant.discard(r.id);
        updateReceipt(r.id, 'discarded');
      } else {
        await api.assistant.undo(r.id);
        updateReceipt(r.id, 'undone');
        toast('Undone', 'ok');
      }
      qc.invalidateQueries();
    } catch (e) {
      toast(errorText(e), 'bad');
    }
  };

  return (
    <AnimatePresence>
      <motion.div className="fixed inset-0 z-[110] lg:pointer-events-none" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        <div className="absolute inset-0 bg-black/40 lg:hidden" onClick={close} />
        <motion.aside
          initial={{ x: 40, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 900, damping: 60 }}
          className="glass-strong pointer-events-auto absolute top-0 right-0 bottom-0 flex w-full flex-col shadow-[-30px_0_80px_-20px_rgb(0_0_0/0.8)] sm:top-3 sm:right-3 sm:bottom-3 sm:w-[420px] sm:rounded-3xl"
        >
          <div className="flex items-center gap-2 px-4 pt-4 pb-3">
            <span className="bg-gradient-accent grid size-8 place-items-center rounded-xl text-on-accent">
              <Sparkles className="size-4" />
            </span>
            <div className="flex-1 font-display text-lg font-semibold">Assistant</div>
            <Menu
              width="w-72"
              trigger={(_o, toggle) => (
                <button onClick={toggle} aria-label="Conversations" className="grid size-9 place-items-center rounded-full text-muted hover:bg-white/8 hover:text-fg">
                  <History className="size-[18px]" />
                </button>
              )}
            >
              {(closeMenu) => (
                <div className="max-h-80 overflow-y-auto">
                  {!threads.data?.length && <div className="px-3 py-4 text-sm text-muted">No conversations yet.</div>}
                  {threads.data?.map((t) => (
                    <MenuItem
                      key={t.id}
                      active={t.id === threadId}
                      onClick={() => {
                        closeMenu();
                        loadThread(t.id).catch((e) => toast(errorText(e), 'bad'));
                      }}
                    >
                      {t.title}
                    </MenuItem>
                  ))}
                </div>
              )}
            </Menu>
            <button
              onClick={() => {
                setThreadId(null);
                setItems([]);
              }}
              aria-label="New conversation"
              className="grid size-9 place-items-center rounded-full text-muted hover:bg-white/8 hover:text-fg"
            >
              <Plus className="size-[18px]" />
            </button>
            <button onClick={close} aria-label="Close assistant" className="grid size-9 place-items-center rounded-full text-muted hover:bg-white/8 hover:text-fg">
              <X className="size-[18px]" />
            </button>
          </div>

          {context && context.kind !== 'prompt' && context.label && (
            <div className="mx-4 mb-2 flex items-center gap-2 rounded-xl bg-white/6 px-3 py-2 text-xs text-muted">
              <span className="font-medium text-fg">About</span> {context.label}
            </div>
          )}

          <div ref={scroller} className="flex-1 space-y-3 overflow-y-auto px-4 py-2">
            {providers.isSuccess && !usable.length && (
              <div className="rounded-2xl border border-line p-4 text-sm text-muted">
                Connect a model first — Anthropic, OpenAI, Gemini, DeepSeek or a local Ollama.{' '}
                <Link to="/settings/assistant" onClick={close} className="text-accent underline">
                  Add one in Settings
                </Link>
                .
              </div>
            )}
            {!items.length && usable.length > 0 && (
              <div className="space-y-2 pt-6">
                <p className="mb-4 text-sm text-muted">Ask about anything in your library, or let me organise it for you. Shared changes always wait for your OK.</p>
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => send(s)} className="block w-full rounded-2xl border border-line px-4 py-3 text-left text-sm transition-colors hover:border-line-strong hover:bg-white/4">
                    {s}
                  </button>
                ))}
              </div>
            )}
            {items.map((it, i) => (
              <motion.div key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
                {it.kind === 'user' && <div className="ml-10 rounded-2xl rounded-br-md bg-white/10 px-4 py-2.5 text-sm">{it.text}</div>}
                {it.kind === 'assistant' && (
                  <div className="mr-4 text-fg/95">
                    <Markdown text={it.text} />
                  </div>
                )}
                {it.kind === 'tool' && (
                  <div className="flex items-center gap-2 text-xs text-faint">
                    <Wrench className="size-3.5" /> {TOOL_LABELS[it.name] ?? it.name.replace(/__/g, ' · ').replace(/_/g, ' ')}
                  </div>
                )}
                {it.kind === 'error' && <div className="rounded-xl bg-bad/10 px-3 py-2 text-sm text-bad">{it.text}</div>}
                {it.kind === 'receipt' && (
                  <div className="rounded-2xl border border-line bg-white/[0.03] p-3">
                    <div className="text-sm">{it.receipt.summary}</div>
                    <div className="mt-2.5 flex items-center gap-2">
                      {it.receipt.status === 'pending' && (
                        <>
                          <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} onClick={() => act(it.receipt, 'apply')}>
                            Apply
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => act(it.receipt, 'discard')}>
                            Discard
                          </Button>
                        </>
                      )}
                      {it.receipt.status === 'applied' && (
                        <>
                          <span className="text-xs text-ok">Applied</span>
                          <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />} onClick={() => act(it.receipt, 'undo')}>
                            Undo
                          </Button>
                        </>
                      )}
                      {(it.receipt.status === 'discarded' || it.receipt.status === 'undone') && <span className="text-xs text-faint capitalize">{it.receipt.status}</span>}
                    </div>
                  </div>
                )}
              </motion.div>
            ))}
            {busy && (
              <div className="flex items-center gap-2 text-xs text-faint">
                <Spinner className="size-3.5" /> Thinking…
              </div>
            )}
          </div>

          <div className="p-3">
            {usable.length > 1 && (
              <Select value={providerId} onChange={(e) => setProviderId(e.target.value)} className="mb-2 h-9 text-xs">
                {usable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.model}
                  </option>
                ))}
              </Select>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
              className="flex items-end gap-2 rounded-2xl border border-line bg-white/[0.04] p-1.5 focus-within:border-accent/50"
            >
              <textarea
                autoFocus
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send(input);
                  }
                }}
                placeholder={usable.length ? 'Ask or tell me what to do…' : 'Add a model to start'}
                disabled={!usable.length}
                className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2 text-sm placeholder:text-faint focus:outline-none"
              />
              <button
                type="submit"
                disabled={!input.trim() || busy || !providerId}
                aria-label="Send"
                className={cls('grid size-9 shrink-0 place-items-center rounded-xl transition-all', input.trim() ? 'bg-gradient-accent text-on-accent' : 'bg-white/8 text-faint')}
              >
                <ArrowUp className="size-4" />
              </button>
            </form>
          </div>
        </motion.aside>
      </motion.div>
    </AnimatePresence>
  );
}
