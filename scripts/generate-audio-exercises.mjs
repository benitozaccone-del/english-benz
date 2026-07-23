// English Benz — build levelled listening exercises from stored material.
//
// Draws short sentences from the `source_documents` shelf (books and news the
// pipeline already stored) and turns them into "Spot the transcription" rows at
// a given CEFR level. Nothing is invented: a sentence must appear in the source,
// and only sentences of 5-15 words qualify, because those are the ones that get
// an audio clip later.
//
//   cd scripts
//   node generate-audio-exercises.mjs --level B2 --count 100
//   node generate-audio-exercises.mjs --level C1 --count 45
//   node generate-audio-exercises.mjs --level B2 --count 20 --dry-run
//
// Each call reads a random passage, so repeated runs over the same book keep
// finding fresh material instead of re-mining chapter one.
//
// Env vars (from .env): ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const here = dirname(fileURLToPath(import.meta.url));
try {
  for (const line of readFileSync(join(here, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* rely on real env */ }

const { ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing env vars. Fill scripts/.env.');
  process.exit(1);
}

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const DRY_RUN = argv.includes('--dry-run');
const LEVEL = (flag('level', 'B2') || 'B2').toUpperCase();
const TARGET = Math.max(1, Math.min(parseInt(flag('count', '20'), 10) || 20, 400));
const PER_CALL = Math.max(1, Math.min(parseInt(flag('per-call', '12'), 10) || 12, 20));
const WINDOW = 14000;                    // characters of source shown per call
const MODEL = 'claude-sonnet-5';

if (!['B2', 'C1', 'C2'].includes(LEVEL)) { console.error('--level must be B2, C1 or C2'); process.exit(1); }

const LEVEL_DESC = {
  B2: 'clear and moderately complex: common but varied vocabulary, straightforward clause structure',
  C1: 'more demanding: less frequent vocabulary, some idiom, longer or subordinated clauses',
  C2: 'near-native: nuanced or rare vocabulary and sophisticated structure',
};

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY, timeout: 180000, maxRetries: 1 });
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const hash = (s) => createHash('sha256').update(s.trim().toLowerCase()).digest('hex');
const words = (s) => s.split(/\s+/).filter(Boolean).length;

const SCHEMA = {
  type: 'object',
  properties: {
    exercises: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          correct_sentence: { type: 'string' },
          decoy_1: { type: 'string' },
          decoy_2: { type: 'string' },
        },
        required: ['topic', 'correct_sentence', 'decoy_1', 'decoy_2'],
        additionalProperties: false,
      },
    },
  },
  required: ['exercises'],
  additionalProperties: false,
};

// ---- the shelf --------------------------------------------------------------
const { data: docs, error: dErr } = await db
  .from('source_documents')
  .select('id,kind,title,content,char_count')
  .in('kind', ['book', 'news', 'pdf', 'url', 'text']);
if (dErr) { console.error('Could not read source_documents:', dErr.message); process.exit(1); }
const usable = (docs || []).filter((d) => (d.content || '').length > 500);
if (!usable.length) { console.error('Nothing on the shelf to draw from.'); process.exit(1); }

console.log(`Drawing ${TARGET} ${LEVEL} listening exercises from ${usable.length} sources:`);
for (const d of usable) console.log(`  ${d.kind.padEnd(6)} ${(d.title || '').slice(0, 55).padEnd(56)} ${Math.round((d.char_count || 0) / 1000)}k`);
console.log();

// A random window per call, snapped forward to a sentence boundary so a passage
// never opens mid-word.
function passage(text) {
  if (text.length <= WINDOW) return text;
  const start = Math.floor(Math.random() * (text.length - WINDOW));
  const dot = text.indexOf('. ', start);
  const from = (dot >= 0 && dot < start + 800) ? dot + 2 : start;
  return text.slice(from, from + WINDOW);
}

// ---- existing sentences, so we never pay to regenerate one ------------------
const seen = new Set();
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from('exercises').select('payload').eq('type', 'audio').range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  for (const r of data) {
    const s = r.payload && r.payload.correct_sentence;
    if (s) seen.add(s.trim().toLowerCase());
  }
  if (data.length < 1000) break;
}
console.log(`${seen.size} listening sentences already exist; those will be skipped.\n`);

const system =
  `You build listening-comprehension exercises for an English learner at CEFR level ${LEVEL}.\n` +
  `From the PASSAGE the user provides, choose up to ${PER_CALL} sentences that are:\n` +
  `  - VERBATIM from the passage, copied exactly, not paraphrased or joined together\n` +
  `  - between 5 and 15 words long\n` +
  `  - ${LEVEL_DESC[LEVEL]}\n` +
  `  - clear when read aloud on their own, without needing surrounding context\n` +
  `  - free of speaker attributions like "he said" where they make no sense alone\n` +
  `For each, write two decoys: the same sentence with EXACTLY ONE word changed, ` +
  `to a word that sounds plausible but different. Vary which word you change.\n` +
  `"topic" is one short lowercase word describing the subject.\n` +
  `Return fewer than ${PER_CALL} rather than inventing sentences or bending the word limit.`;

let made = 0, calls = 0, rejected = 0;
const pending = [];

while (made + pending.length < TARGET && calls < Math.ceil(TARGET / 2) + 20) {
  const doc = usable[Math.floor(Math.random() * usable.length)];
  calls++;
  let items = [];
  try {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system,
      messages: [{ role: 'user', content: 'PASSAGE:\n' + passage(doc.content) }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    });
    items = JSON.parse(res.content.filter((b) => b.type === 'text').map((b) => b.text).join('')).exercises || [];
  } catch (e) {
    console.warn(`  call ${calls}: failed — ${e.message}`);
    continue;
  }

  let kept = 0;
  for (const x of items) {
    if (made + pending.length >= TARGET) break;
    const s = (x.correct_sentence || '').trim();
    if (!s || !x.decoy_1 || !x.decoy_2) { rejected++; continue; }
    const n = words(s);
    if (n < 5 || n > 15) { rejected++; continue; }              // outside the clip range
    if (!doc.content.includes(s)) { rejected++; continue; }      // not actually in the source
    const key = s.toLowerCase();
    if (seen.has(key)) { rejected++; continue; }
    seen.add(key);
    pending.push({
      type: 'audio',
      level: LEVEL,
      topic: x.topic || null,
      source: doc.title || doc.kind,
      payload: { source: doc.title || doc.kind, topic: x.topic || '', correct_sentence: s, decoy_1: x.decoy_1, decoy_2: x.decoy_2 },
      source_document_id: doc.id,
      content_hash: hash('audio:' + s),
    });
    kept++;
  }
  console.log(`  call ${String(calls).padStart(2)}  ${String(kept).padStart(2)} kept from ${String(items.length).padStart(2)}  ${(doc.title || doc.kind).slice(0, 45)}`);

  if (pending.length >= 40 && !DRY_RUN) { made += await flush(); }
}

async function flush() {
  if (!pending.length) return 0;
  const batch = pending.splice(0, pending.length);
  const { data, error } = await db.from('exercises').upsert(batch, { onConflict: 'content_hash', ignoreDuplicates: true }).select('id');
  if (error) { console.error('  insert failed:', error.message); return 0; }
  return data ? data.length : 0;
}

if (DRY_RUN) {
  pending.slice(0, 15).forEach((r, i) => console.log(`  ${String(i + 1).padStart(3)}. [${String(words(r.payload.correct_sentence)).padStart(2)}w] ${r.payload.correct_sentence}`));
  console.log(`\nDry run — ${pending.length} would be added, ${rejected} rejected by the checks.`);
  process.exit(0);
}

made += await flush();
const { count } = await db.from('exercises').select('*', { count: 'exact', head: true }).eq('type', 'audio').eq('level', LEVEL);
console.log(`\nDone. ${made} new ${LEVEL} listening exercises (${rejected} rejected as too long, too short, or not verbatim).`);
console.log(`The repository now holds ${count} at ${LEVEL}.`);
