import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../lib/async.js';
import { cached } from '../lib/cache.js';
import { sha256 } from '../lib/crypto.js';
import { HttpError, parse } from '../lib/http.js';
import { complete } from '../services/assistant/providers.js';
import { integration } from '../services/integrations.js';

export const subtitleToolsRouter = Router();
subtitleToolsRouter.use(requireAuth);

interface Cue {
  head: string;
  text: string;
}

function splitVtt(vtt: string): { header: string; cues: Cue[] } {
  const blocks = vtt.replace(/\r/g, '').split(/\n\n+/);
  const header = blocks[0]?.startsWith('WEBVTT') ? blocks.shift()! : 'WEBVTT';
  const cues: Cue[] = [];
  for (const b of blocks) {
    const lines = b.split('\n');
    const t = lines.findIndex((l) => l.includes('-->'));
    if (t < 0) continue;
    cues.push({ head: lines.slice(0, t + 1).join('\n'), text: lines.slice(t + 1).join('\n') });
  }
  return { header, cues };
}

const SEP = '\n⁂\n';

async function googleTranslate(texts: string[], target: string): Promise<string[]> {
  const out: string[] = [];
  // Keep requests comfortably under URL limits.
  for (let i = 0; i < texts.length; ) {
    const batch: string[] = [];
    let len = 0;
    while (i < texts.length && len + texts[i]!.length < 1800) {
      batch.push(texts[i]!);
      len += texts[i]!.length + SEP.length;
      i++;
    }
    if (!batch.length) batch.push(texts[i++]!.slice(0, 1800));
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(batch.join(SEP))}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new HttpError(502, `Google Translate answered ${res.status}`);
    const data = (await res.json()) as [[string, string][]];
    const joined = (data[0] ?? []).map((p) => p[0]).join('');
    const parts = joined.split(/\s*⁂\s*/);
    for (let k = 0; k < batch.length; k++) out.push(parts[k] ?? batch[k]!);
  }
  return out;
}

async function deeplTranslate(texts: string[], target: string): Promise<string[]> {
  const key = integration('deeplApiKey');
  if (!key) throw new HttpError(503, 'DeepL is not configured');
  const host = key.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
  const out: string[] = [];
  for (let i = 0; i < texts.length; i += 50) {
    const res = await fetch(`https://${host}/v2/translate`, {
      method: 'POST',
      headers: { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: texts.slice(i, i + 50), target_lang: target.toUpperCase() }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new HttpError(502, `DeepL answered ${res.status}`);
    const data = (await res.json()) as { translations: { text: string }[] };
    out.push(...data.translations.map((t) => t.text));
  }
  return out;
}

async function modelTranslate(texts: string[], target: string, providerId: string, accountId: string): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < texts.length; i += 40) {
    const batch = texts.slice(i, i + 40);
    const numbered = batch.map((t, k) => `${k + 1}|${t.replace(/\n/g, ' / ')}`).join('\n');
    const answer = await complete(
      providerId,
      accountId,
      `Translate subtitle lines into the language with code "${target}". Keep the "N|" prefixes, one line per input line, no commentary.`,
      numbered,
    );
    const map = new Map<number, string>();
    for (const line of answer.split('\n')) {
      const m = line.match(/^\s*(\d+)\|(.*)$/);
      if (m) map.set(Number(m[1]), m[2]!.replace(/ \/ /g, '\n'));
    }
    batch.forEach((t, k) => out.push(map.get(k + 1) ?? t));
  }
  return out;
}

const schema = z.object({
  vtt: z.string().min(10).max(2_000_000),
  target: z.string().min(2).max(10),
  provider: z.enum(['google', 'deepl', 'assistant']).default('google'),
  providerId: z.string().optional(),
});

/** Translates a WebVTT file cue-by-cue, keeping timings exactly. */
subtitleToolsRouter.post(
  '/translate',
  asyncHandler(async (req, res) => {
    const b = parse(schema, req.body);
    const key = `subtr:${b.provider}:${b.target}:${sha256(b.vtt)}`;
    const vtt = await cached(key, 24 * 3600_000, async () => {
      const { header, cues } = splitVtt(b.vtt);
      const texts = cues.map((c) => c.text.replace(/<[^>]+>/g, ''));
      const translated =
        b.provider === 'deepl'
          ? await deeplTranslate(texts, b.target)
          : b.provider === 'assistant'
            ? await modelTranslate(texts, b.target, b.providerId ?? '', req.account!.id)
            : await googleTranslate(texts, b.target);
      return `${header}\n\n${cues.map((c, i) => `${c.head}\n${translated[i] ?? c.text}`).join('\n\n')}\n`;
    });
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.send(vtt);
  }),
);
