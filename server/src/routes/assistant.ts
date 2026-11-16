import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireAuth, requireProfile } from '../auth/middleware.js';
import { db } from '../db/index.js';
import { asyncHandler } from '../lib/async.js';
import { newId } from '../lib/crypto.js';
import { HttpError, parse } from '../lib/http.js';
import { openSse } from '../lib/sse.js';
import { getAccountSettings } from '../services/entitlements.js';
import { getPreferences } from '../services/profiles.js';
import { chat, deleteProvider, listProviders, saveProvider, type ChatMessage, type ProviderKind } from '../services/assistant/providers.js';
import { applyPlan, BUILTIN_TOOLS, pluginTools, runTool, undo, type ToolContext } from '../services/assistant/tools.js';

export const assistantRouter = Router();
assistantRouter.use(requireAuth, (req, _res, next) => {
  if (!getAccountSettings(req.account!.id, req.account!.is_admin === 1).assistantEnabled) {
    throw new HttpError(403, 'The assistant is not enabled for this account');
  }
  next();
});

// ---------------------------------------------------------------- providers
assistantRouter.get('/providers', (req, res) => {
  res.json({ providers: listProviders(req.account!.id) });
});

const providerSchema = z.object({
  id: z.string().optional(),
  kind: z.enum(['openai', 'anthropic', 'gemini', 'deepseek', 'ollama', 'openai-compatible']),
  name: z.string().min(1).max(60),
  baseUrl: z.string().url().max(500).nullish(),
  apiKey: z.string().max(500).nullish(),
  model: z.string().min(1).max(120),
  enabled: z.boolean().optional(),
  shared: z.boolean().default(false),
});

assistantRouter.post('/providers', (req, res) => {
  const b = parse(providerSchema, req.body);
  if (b.shared && req.account!.is_admin !== 1) throw new HttpError(403, 'Only admins can add shared providers');
  res.json({
    provider: saveProvider({ ...b, kind: b.kind as ProviderKind, accountId: b.shared ? null : req.account!.id }),
  });
});

assistantRouter.delete('/providers/:id', (req, res) => {
  const shared = db.prepare('SELECT account_id FROM assistant_providers WHERE id = ?').get(req.params.id) as { account_id: string | null } | undefined;
  if (shared && shared.account_id === null) {
    if (req.account!.is_admin !== 1) throw new HttpError(403, 'Only admins can remove shared providers');
    deleteProvider(req.params.id, null);
  } else deleteProvider(req.params.id, req.account!.id);
  res.status(204).end();
});

// ---------------------------------------------------------------- threads
assistantRouter.use(requireProfile);

assistantRouter.get('/threads', (req, res) => {
  res.json({
    threads: db
      .prepare('SELECT id, title, context, updated_at AS updatedAt FROM assistant_threads WHERE profile_id = ? ORDER BY updated_at DESC LIMIT 30')
      .all(req.profile!.id),
  });
});

assistantRouter.get('/threads/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM assistant_threads WHERE id = ? AND profile_id = ?').get(req.params.id, req.profile!.id);
  if (!t) throw new HttpError(404, 'Conversation not found');
  const messages = (db.prepare('SELECT role, content, created_at AS createdAt FROM assistant_messages WHERE thread_id = ? ORDER BY created_at').all(req.params.id) as {
    role: string;
    content: string;
  }[]).map((m) => ({ ...m, content: JSON.parse(m.content) as unknown }));
  const receipts = db.prepare('SELECT id, summary, status, created_at AS createdAt FROM assistant_receipts WHERE thread_id = ? ORDER BY created_at').all(req.params.id);
  res.json({ thread: t, messages, receipts });
});

assistantRouter.delete('/threads/:id', (req, res) => {
  db.prepare('DELETE FROM assistant_threads WHERE id = ? AND profile_id = ?').run(req.params.id, req.profile!.id);
  res.status(204).end();
});

const askSchema = z.object({
  threadId: z.string().nullish(),
  providerId: z.string().min(1),
  message: z.string().min(1).max(8000),
  context: z
    .object({ kind: z.string().max(40), id: z.string().max(200).nullish(), label: z.string().max(300).nullish(), data: z.record(z.unknown()).nullish() })
    .nullish(),
});

function systemPrompt(username: string, isAdmin: boolean, context: unknown): string {
  return [
    'You are Nova, the assistant inside a personal media server (movies, shows, anime, live TV, books).',
    `You are talking to ${username}${isAdmin ? ' (server administrator)' : ''}. Act only through the provided tools, with their permissions.`,
    'Media ids look like movie:603, tv:1399, anime:21. Always look titles up with search_catalog before using an id you were not given.',
    'Personal edits (My List, collections) apply immediately and can be undone by the user. Shared changes (downloads, rules, library matches) are only PROPOSED; the user confirms them in the panel — never say they are done.',
    'Be brief and friendly. Use short lists. Do not invent titles, sources or numbers.',
    context ? `The user opened you from: ${JSON.stringify(context)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

assistantRouter.post(
  '/ask',
  asyncHandler(async (req, res) => {
    const b = parse(askSchema, req.body);
    const isAdmin = req.account!.is_admin === 1;
    let threadId = b.threadId ?? null;
    if (threadId) {
      const own = db.prepare('SELECT 1 FROM assistant_threads WHERE id = ? AND profile_id = ?').get(threadId, req.profile!.id);
      if (!own) throw new HttpError(404, 'Conversation not found');
    } else {
      threadId = newId();
      db.prepare('INSERT INTO assistant_threads (id, profile_id, title, context) VALUES (?, ?, ?, ?)').run(
        threadId,
        req.profile!.id,
        b.message.slice(0, 80),
        b.context ? JSON.stringify(b.context) : null,
      );
    }
    const history = (db.prepare('SELECT role, content FROM assistant_messages WHERE thread_id = ? ORDER BY created_at').all(threadId) as {
      role: ChatMessage['role'];
      content: string;
    }[]).map((m) => JSON.parse(m.content) as ChatMessage);
    const save = (m: ChatMessage) =>
      db.prepare('INSERT INTO assistant_messages (id, thread_id, role, content) VALUES (?, ?, ?, ?)').run(newId(), threadId, m.role, JSON.stringify(m));
    const userMsg: ChatMessage = { role: 'user', content: b.message };
    save(userMsg);

    const sse = openSse(req, res);
    sse.send('thread', { threadId });
    const ctx: ToolContext = {
      accountId: req.account!.id,
      profileId: req.profile!.id,
      isAdmin,
      prefs: getPreferences(req.profile!.id),
      threadId,
    };
    const tools = [...BUILTIN_TOOLS.filter((t) => !t.admin || isAdmin), ...pluginTools()].map(({ name, description, parameters }) => ({ name, description, parameters }));
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(req.profile!.name, isAdmin, b.context) }, ...history.slice(-30), userMsg];
    try {
      for (let step = 0; step < 6; step++) {
        const out = await chat(b.providerId, req.account!.id, messages, tools);
        if (!out.toolCalls.length) {
          const final: ChatMessage = { role: 'assistant', content: out.text || '…' };
          save(final);
          sse.send('message', { text: final.content });
          break;
        }
        const assistantMsg: ChatMessage = { role: 'assistant', content: out.text, toolCalls: out.toolCalls };
        messages.push(assistantMsg);
        save(assistantMsg);
        for (const call of out.toolCalls) {
          sse.send('tool', { name: call.name, args: call.args });
          let content: string;
          try {
            const outcome = await runTool(call.name, call.args, ctx);
            if (outcome.receipt) sse.send('receipt', outcome.receipt);
            content = JSON.stringify(outcome.result).slice(0, 12_000);
          } catch (err) {
            content = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
          }
          const toolMsg: ChatMessage = { role: 'tool', content, toolCallId: call.id, name: call.name };
          messages.push(toolMsg);
          save(toolMsg);
        }
      }
      db.prepare("UPDATE assistant_threads SET updated_at = datetime('now') WHERE id = ?").run(threadId);
    } catch (err) {
      sse.send('error', { error: err instanceof Error ? err.message : 'The assistant failed' });
    } finally {
      sse.close();
    }
  }),
);

// ---------------------------------------------------------------- receipts (preview / apply / undo)
function receiptCtx(req: Request, threadId: string): ToolContext {
  return {
    accountId: req.account!.id,
    profileId: req.profile!.id,
    isAdmin: req.account!.is_admin === 1,
    prefs: getPreferences(req.profile!.id),
    threadId,
  };
}

interface ReceiptRow {
  id: string;
  thread_id: string | null;
  summary: string;
  plan: string | null;
  undo: string | null;
  status: string;
}

function ownReceipt(id: string, profileId: string): ReceiptRow {
  const r = db.prepare('SELECT * FROM assistant_receipts WHERE id = ? AND profile_id = ?').get(id, profileId) as ReceiptRow | undefined;
  if (!r) throw new HttpError(404, 'Not found');
  return r;
}

assistantRouter.get('/receipts', (req, res) => {
  res.json({
    receipts: db
      .prepare('SELECT id, summary, status, created_at AS createdAt FROM assistant_receipts WHERE profile_id = ? ORDER BY created_at DESC LIMIT 50')
      .all(req.profile!.id),
  });
});

assistantRouter.post(
  '/receipts/:id/apply',
  asyncHandler(async (req, res) => {
    const r = ownReceipt(req.params.id, req.profile!.id);
    if (r.status !== 'pending' || !r.plan) throw new HttpError(409, 'Nothing to apply');
    const message = await applyPlan(JSON.parse(r.plan) as { name: string; args: Record<string, unknown> }, receiptCtx(req, r.thread_id ?? ''));
    db.prepare("UPDATE assistant_receipts SET status = 'applied' WHERE id = ?").run(r.id);
    res.json({ ok: true, message });
  }),
);

assistantRouter.post('/receipts/:id/discard', (req, res) => {
  const r = ownReceipt(req.params.id, req.profile!.id);
  if (r.status === 'pending') db.prepare("UPDATE assistant_receipts SET status = 'discarded' WHERE id = ?").run(r.id);
  res.json({ ok: true });
});

assistantRouter.post(
  '/receipts/:id/undo',
  asyncHandler(async (req, res) => {
    const r = ownReceipt(req.params.id, req.profile!.id);
    if (r.status !== 'applied' || !r.undo) throw new HttpError(409, 'This change cannot be undone');
    await undo(JSON.parse(r.undo) as { name: string; args: Record<string, unknown> }, receiptCtx(req, r.thread_id ?? ''));
    db.prepare("UPDATE assistant_receipts SET status = 'undone' WHERE id = ?").run(r.id);
    res.json({ ok: true });
  }),
);
