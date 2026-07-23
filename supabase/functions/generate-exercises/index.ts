// English Benz — admin exercise generator (Supabase Edge Function)
//
// Called by the in-app Admin panel. Verifies the caller is the admin, sends the
// uploaded document's text to Claude, and inserts the generated exercises into
// the `exercises` table (deduped). Keeps the Anthropic key server-side.
//
// Deploy (Supabase dashboard → Edge Functions → Deploy a new function):
//   name: generate-exercises   — paste this file's contents.
// Set one secret (Edge Functions → Manage secrets, or Project Settings → Edge Functions):
//   ANTHROPIC_API_KEY = sk-ant-...
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ADMIN_EMAIL = 'benitozaccone@intuendi.com';
const MODEL = 'claude-sonnet-5';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const LEVEL_DESC: Record<string, string> = {
  B2: 'clear, moderately complex sentences using common but varied vocabulary and fairly straightforward clause structure',
  C1: 'more complex syntax, some idiomatic expressions, and less frequent vocabulary',
  C2: 'near-native complexity, nuanced or rare vocabulary, and sophisticated clause structure',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s.trim().toLowerCase()));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Wrap an item schema as {"exercises":[...]} — structured outputs need an object root.
function envelope(itemProps: Record<string, unknown>, required: string[]) {
  return {
    type: 'object',
    properties: {
      exercises: {
        type: 'array',
        items: { type: 'object', properties: itemProps, required, additionalProperties: false },
      },
    },
    required: ['exercises'],
    additionalProperties: false,
  };
}

// Structured outputs guarantee schema-valid JSON, so no regex scraping / no parse errors.
async function claudeJson(system: string, userText: string, schema: unknown): Promise<any[]> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      system,
      messages: [{ role: 'user', content: userText }],
      output_config: { format: { type: 'json_schema', schema } },
    }),
  });
  if (!res.ok) throw new Error('Anthropic HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  if (data.stop_reason === 'max_tokens') throw new Error('Response hit max_tokens — try a smaller count.');
  const text = (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  const parsed = JSON.parse(text);
  return Array.isArray(parsed.exercises) ? parsed.exercises : [];
}

const TR_SCHEMA = envelope({
  source: { type: 'string' },
  topic: { type: 'string' },
  english_sentence: { type: 'string' },
  correct_translation: { type: 'string' },
  distractor_1: { type: 'string' },
  distractor_2: { type: 'string' },
}, ['source', 'topic', 'english_sentence', 'correct_translation', 'distractor_1', 'distractor_2']);

const AUDIO_SCHEMA = envelope({
  source: { type: 'string' },
  topic: { type: 'string' },
  correct_sentence: { type: 'string' },
  decoy_1: { type: 'string' },
  decoy_2: { type: 'string' },
}, ['source', 'topic', 'correct_sentence', 'decoy_1', 'decoy_2']);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    // Verify the caller is the admin.
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: ures, error: uerr } = await admin.auth.getUser(token);
    if (uerr || !ures?.user || ures.user.email !== ADMIN_EMAIL) {
      return json({ error: 'Not authorized.' }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const docText = String(body.text || '').slice(0, 20000);
    const count = Math.max(1, Math.min(parseInt(body.count, 10) || 6, 15));
    if (!docText.trim()) return json({ error: 'No document text provided.' }, 400);

    const rows: any[] = [];
    const errors: string[] = [];

    // Translation exercises, grounded in the document, per CEFR level.
    for (const level of ['B2', 'C1', 'C2']) {
      const system =
        `You create English-learning exercises for an Italian speaker at CEFR level ${level}, grounded in the DOCUMENT the user provides.\n` +
        `Create ${count} exercises. For each, choose ONE short sentence — verbatim from the document where possible, otherwise closely based on its content — under 15 words, matching level ${level} complexity (${LEVEL_DESC[level]}).\n` +
        `Return a JSON array of exactly ${count} objects, each with EXACTLY: ` +
        `{"source": "Document", "topic": one short lowercase word describing the sentence's subject, ` +
        `"english_sentence": "the short English sentence, under 15 words", ` +
        `"correct_translation": "an accurate, natural Italian translation", ` +
        `"distractor_1": "a plausible but clearly incorrect Italian translation", ` +
        `"distractor_2": "another plausible but clearly incorrect Italian translation"}\n` +
        `Return the exercises in the required structured format.`;
      try {
        const items = await claudeJson(system, 'DOCUMENT:\n' + docText, TR_SCHEMA);
        for (const x of items) {
          if (x && x.english_sentence && x.correct_translation) {
            rows.push({
              type: 'translation', level, topic: x.topic || null, source: x.source || 'Document',
              payload: x, content_hash: await sha256('tr:' + level + ':' + x.english_sentence),
            });
          }
        }
      } catch (e) { errors.push('translation ' + level + ': ' + String((e as Error).message || e)); }
    }

    // Listening (audio) exercises.
    try {
      const system =
        `You create listening-comprehension exercises for an English learner (B2-C1), grounded in the DOCUMENT the user provides.\n` +
        `Create ${count} exercises. For each, choose ONE short sentence — verbatim from the document where possible — under 12 words, plus two near-identical decoys, each with exactly one word changed.\n` +
        `Return a JSON array of exactly ${count} objects, each with EXACTLY: ` +
        `{"source": "Document", "topic": one short lowercase word, ` +
        `"correct_sentence": "the exact short sentence, under 12 words", ` +
        `"decoy_1": "near-identical sentence with one word changed", ` +
        `"decoy_2": "near-identical sentence with a different one word changed"}\n` +
        `Return the exercises in the required structured format.`;
      const items = await claudeJson(system, 'DOCUMENT:\n' + docText, AUDIO_SCHEMA);
      for (const x of items) {
        if (x && x.correct_sentence && x.decoy_1 && x.decoy_2) {
          rows.push({
            type: 'audio', level: '', topic: x.topic || null, source: x.source || 'Document',
            payload: x, content_hash: await sha256('audio:' + x.correct_sentence),
          });
        }
      }
    } catch (e) { errors.push('audio: ' + String((e as Error).message || e)); }

    let inserted = 0;
    if (rows.length) {
      const { data, error } = await admin
        .from('exercises')
        .upsert(rows, { onConflict: 'content_hash', ignoreDuplicates: true })
        .select('id');
      if (error) throw error;
      inserted = data ? data.length : 0;
    }

    return json({ inserted, generated: rows.length, errors });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
