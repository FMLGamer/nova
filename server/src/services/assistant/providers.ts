import { config } from '../../config.js';
import { db } from '../../db/index.js';
import { newId, seal, unseal } from '../../lib/crypto.js';
import { HttpError } from '../../lib/http.js';

export type ProviderKind = 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'ollama' | 'openai-compatible';

export interface ProviderDTO {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string | null;
  model: string;
  enabled: boolean;
  shared: boolean;
  hasKey: boolean;
}

interface Row {
  id: string;
  kind: ProviderKind;
  name: string;
  base_url: string | null;
  api_key_enc: string | null;
  model: string;
  enabled: number;
  account_id: string | null;
}

const DEFAULT_BASE: Record<ProviderKind, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  deepseek: 'https://api.deepseek.com/v1',
  ollama: 'http://localhost:11434/v1',
  'openai-compatible': '',
};

const toDTO = (r: Row): ProviderDTO => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  baseUrl: r.base_url,
  model: r.model,
  enabled: r.enabled === 1,
  shared: r.account_id === null,
  hasKey: Boolean(r.api_key_enc),
});

/** Server-wide providers plus the account's own. */
export function listProviders(accountId: string): ProviderDTO[] {
  return (db.prepare('SELECT * FROM assistant_providers WHERE account_id IS NULL OR account_id = ? ORDER BY account_id IS NOT NULL, created_at').all(accountId) as Row[]).map(toDTO);
}

export function saveProvider(input: {
  id?: string;
  accountId: string | null;
  kind: ProviderKind;
  name: string;
  baseUrl?: string | null;
  apiKey?: string | null;
  model: string;
  enabled?: boolean;
}): ProviderDTO {
  const id = input.id ?? newId();
  const existing = input.id ? (db.prepare('SELECT * FROM assistant_providers WHERE id = ?').get(input.id) as Row | undefined) : undefined;
  if (existing && existing.account_id !== input.accountId) throw new HttpError(403, 'Not your provider');
  const key = input.apiKey === undefined || input.apiKey === '••••••••' ? existing?.api_key_enc ?? null : input.apiKey ? seal(input.apiKey) : null;
  db.prepare(
    `INSERT INTO assistant_providers (id, kind, name, base_url, api_key_enc, model, enabled, account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name, base_url = excluded.base_url,
       api_key_enc = excluded.api_key_enc, model = excluded.model, enabled = excluded.enabled`,
  ).run(id, input.kind, input.name, input.baseUrl || null, key, input.model, input.enabled === false ? 0 : 1, input.accountId);
  return toDTO(db.prepare('SELECT * FROM assistant_providers WHERE id = ?').get(id) as Row);
}

export function deleteProvider(id: string, accountId: string | null): void {
  const r = db.prepare('SELECT account_id FROM assistant_providers WHERE id = ?').get(id) as { account_id: string | null } | undefined;
  if (!r) return;
  if (r.account_id !== accountId) throw new HttpError(403, 'Not your provider');
  db.prepare('DELETE FROM assistant_providers WHERE id = ?').run(id);
}

/** Boot: offer the configured local model (OLLAMA_URL + OLLAMA_MODEL) out of the box. */
export function seedLocalProvider(): void {
  if (!config.ollamaUrl || !config.ollamaModel) return;
  const exists = db.prepare("SELECT 1 FROM assistant_providers WHERE kind = 'ollama' AND account_id IS NULL").get();
  if (exists) return;
  saveProvider({
    accountId: null,
    kind: 'ollama',
    name: 'Local model',
    baseUrl: `${config.ollamaUrl.replace(/\/+$/, '')}/v1`,
    model: config.ollamaModel,
  });
}

// ---------------------------------------------------------------- chat

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
  toolCallId?: string;
  name?: string;
}

export interface ChatResult {
  text: string;
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
}

function resolve(providerId: string, accountId: string): Row {
  const r = db.prepare('SELECT * FROM assistant_providers WHERE id = ? AND (account_id IS NULL OR account_id = ?) AND enabled = 1').get(providerId, accountId) as
    | Row
    | undefined;
  if (!r) throw new HttpError(404, 'Assistant provider not available');
  return r;
}

function safeArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    return JSON.parse(String(raw || '{}')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function openaiChat(r: Row, messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatResult> {
  const base = (r.base_url || DEFAULT_BASE[r.kind]).replace(/\/+$/, '');
  const key = unseal(r.api_key_enc);
  const body = {
    model: r.model,
    messages: messages.map((m) =>
      m.role === 'tool'
        ? { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
        : m.toolCalls?.length
          ? {
              role: 'assistant',
              content: m.content || null,
              tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } })),
            }
          : { role: m.role, content: m.content },
    ),
    tools: tools.length ? tools.map((t) => ({ type: 'function', function: t })) : undefined,
    temperature: 0.3,
  };
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Models without tool support: retry once as plain chat.
    if (tools.length && /tool|function/i.test(text)) return openaiChat(r, messages, []);
    throw new HttpError(502, `The model answered ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
  };
  const msg = data.choices?.[0]?.message;
  return {
    text: msg?.content ?? '',
    toolCalls: (msg?.tool_calls ?? []).map((t) => ({ id: t.id || newId(), name: t.function.name, args: safeArgs(t.function.arguments) })),
  };
}

async function anthropicChat(r: Row, messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatResult> {
  const base = (r.base_url || DEFAULT_BASE.anthropic).replace(/\/+$/, '');
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const convo: { role: 'user' | 'assistant'; content: unknown }[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      convo.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }] });
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      convo.push({
        role: 'assistant',
        content: [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ...m.toolCalls.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.args })),
        ],
      });
    } else convo.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  const res = await fetch(`${base}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': unseal(r.api_key_enc), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: r.model,
      max_tokens: 2048,
      system,
      messages: convo,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new HttpError(502, `The model answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data = (await res.json()) as { content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[] };
  return {
    text: (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(''),
    toolCalls: (data.content ?? [])
      .filter((c) => c.type === 'tool_use')
      .map((c) => ({ id: c.id ?? newId(), name: c.name ?? '', args: safeArgs(c.input) })),
  };
}

export async function chat(providerId: string, accountId: string, messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatResult> {
  const r = resolve(providerId, accountId);
  return r.kind === 'anthropic' ? anthropicChat(r, messages, tools) : openaiChat(r, messages, tools);
}

/** One-shot completion used by subtitle translation ("assistant" provider). */
export async function complete(providerId: string, accountId: string, system: string, user: string): Promise<string> {
  const out = await chat(providerId, accountId, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], []);
  return out.text;
}
