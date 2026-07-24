// English Benz — build levelled listening exercises from stored material.
//
// Draws short sentences from the `source_documents` shelf (books and news the
// pipeline already stored) and turns them into "Spot the transcription" rows at
// a given CEFR level. Nothing is invented: a sentence must appear in the source,
// and only sentences of 5-15 words qualify, because those are the ones that get
// an audio clip later.
//
//   cd scripts
//   node generate-from-shelf.mjs --type audio --level B2 --count 100
//   node generate-from-shelf.mjs --type translation --level C1 --count 20
//   node generate-from-shelf.mjs --type audio --level C2 --count 20 --source "White Fang"
//   node generate-from-shelf.mjs --type translation --level C2 --count 10 --dry-run
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
const TYPE = (flag('type', 'audio') || 'audio').toLowerCase();
const SOURCE = flag('source', '');            // substring match on the document title
const LEVEL = (flag('level', 'B2') || 'B2').toUpperCase();
const TARGET = Math.max(1, Math.min(parseInt(flag('count', '20'), 10) || 20, 400));
const PER_CALL = Math.max(1, Math.min(parseInt(flag('per-call', '12'), 10) || 12, 20));
const WINDOW = 14000;                    // characters of source shown per call
const MODEL = 'claude-sonnet-5';

if (!['B2', 'C1', 'C2'].includes(LEVEL)) { console.error('--level must be B2, C1 or C2'); process.exit(1); }
if (!['audio', 'translation'].includes(TYPE)) { console.error('--type must be audio or translation'); process.exit(1); }

const LEVEL_DESC = {
  B2: 'clear and moderately complex: common but varied vocabulary, straightforward clause structure',
  C1: 'more demanding: less frequent vocabulary, some idiom, longer or subordinated clauses',
  C2: 'near-native: nuanced or rare vocabulary and sophisticated structure',
};

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY, timeout: 180000, maxRetries: 1 });
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const hash = (s) => createHash('sha256').update(s.trim().toLowerCase()).digest('hex');
const words = (s) => s.split(/\s+/).filter(Boolean).length;

// Verbatim means "these words in this order", not "this exact whitespace".
// Books are typeset with hard breaks mid-sentence, so a sentence copied out of a
// passage arrives with the newline flattened to a space and an exact includes()
// rejects it — which silently threw away every candidate from one book. Compare
// whitespace-normalised, and cache the normalised source since it is re-scanned
// on every call.
const normWS = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const flatCache = new Map();
function containsVerbatim(doc, sentence) {
  let flat = flatCache.get(doc.id);
  if (!flat) { flat = normWS(doc.content); flatCache.set(doc.id, flat); }
  return flat.includes(normWS(sentence));
}

const envelope = (props) => ({
  type: 'object',
  properties: {
    exercises: {
      type: 'array',
      items: { type: 'object', properties: props, required: Object.keys(props), additionalProperties: false },
    },
  },
  required: ['exercises'],
  additionalProperties: false,
});

const AUDIO_SCHEMA = envelope({
  topic: { type: 'string' },
  correct_sentence: { type: 'string' },
  decoy_1: { type: 'string' },
  decoy_2: { type: 'string' },
});

const TR_SCHEMA = envelope({
  topic: { type: 'string' },
  english_sentence: { type: 'string' },
  correct_translation: { type: 'string' },
  distractor_1: { type: 'string' },
  distractor_2: { type: 'string' },
});

const SCHEMA = TYPE === 'translation' ? TR_SCHEMA : AUDIO_SCHEMA;
// The sentence field differs by type; everything downstream reads it through this.
const sentenceOf = (x) => String((TYPE === 'translation' ? x.english_sentence : x.correct_sentence) || '').trim();

// ---- the shelf --------------------------------------------------------------
const { data: docs, error: dErr } = await db
  .from('source_documents')
  .select('id,kind,title,content,char_count')
  .in('kind', ['book', 'news', 'pdf', 'url', 'text']);
if (dErr) { console.error('Could not read source_documents:', dErr.message); process.exit(1); }
let usable = (docs || []).filter((d) => (d.content || '').length > 500);
if (SOURCE) {
  const want = SOURCE.toLowerCase();
  usable = usable.filter((d) => (d.title || '').toLowerCase().includes(want));
  if (!usable.length) { console.error(`No stored document matches "${SOURCE}".`); process.exit(1); }
}
if (!usable.length) { console.error('Nothing on the shelf to draw from.'); process.exit(1); }

console.log(`Drawing ${TARGET} ${LEVEL} ${TYPE} exercises from ${usable.length} source${usable.length === 1 ? '' : 's'}:`);
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
  const { data, error } = await db.from('exercises').select('payload').eq('type', TYPE).range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  for (const r of data) {
    const p = r.payload || {};
    const s = TYPE === 'translation' ? p.english_sentence : p.correct_sentence;
    if (s) seen.add(String(s).trim().toLowerCase());
  }
  if (data.length < 1000) break;
}
console.log(`${seen.size} ${TYPE} sentences already exist; those will be skipped.\n`);

// Both types share the sentence-selection rules; only the task built on top differs.
const SELECTION =
  `From the PASSAGE the user provides, choose up to ${PER_CALL} sentences that are:\n` +
  `  - VERBATIM from the passage, copied exactly, not paraphrased or joined together\n` +
  `  - between 5 and 15 words long\n` +
  `  - ${LEVEL_DESC[LEVEL]}\n` +
  `  - self-contained, making sense on their own without surrounding context\n` +
  `  - free of speaker attributions like "he said" where they make no sense alone\n` +
  `"topic" is one short lowercase word describing the subject.\n` +
  `Return fewer than ${PER_CALL} rather than inventing sentences or bending the word limit.\n`;

const system = TYPE === 'translation'
  ? `You build translation exercises for an Italian speaker learning English at CEFR level ${LEVEL}.\n` +
    SELECTION +
    `Put the chosen sentence in "english_sentence". Give an accurate, natural Italian ` +
    `translation in "correct_translation", and two plausible but clearly incorrect Italian ` +
    `translations as the distractors — wrong in meaning, not merely clumsy in style.`
  : `You build listening-comprehension exercises for an English learner at CEFR level ${LEVEL}.\n` +
    SELECTION +
    `Put the chosen sentence in "correct_sentence", and add it must also be clear when read ` +
    `aloud on its own. Write two decoys: the same sentence with EXACTLY ONE word changed, ` +
    `to a word that sounds plausible but different. Vary which word you change.`;

let made = 0, calls = 0, rejected = 0, capped = 0;
const pending = [];
const perSource = new Map();

// Round-robin the sources rather than picking at random. Yield per call varies a
// lot by author — terse prose clears the 5-15 word filter far more often than
// long subordinated sentences — so random selection quietly hands most of the
// batch to one book. The cap is the backstop when even fair turns skew.
const MAX_PER_SOURCE = Math.max(1, Math.ceil(TARGET / usable.length * (parseFloat(flag('skew', '1.8')) || 1.8)));

while (made + pending.length < TARGET && calls < Math.ceil(TARGET / 2) + 25) {
  const doc = usable[calls % usable.length];
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
    const msg = String(e.message || e);
    // Credit, key and permission failures will hit every remaining call the same
    // way. Retrying them just burns the loop budget and buries the real cause
    // under dozens of identical lines, so stop and say why.
    if (/credit balance|authentication|invalid x-api-key|permission|quota/i.test(msg)) {
      console.error(`\nStopping: this will not succeed on retry.\n  ${msg.slice(0, 220)}`);
      break;
    }
    console.warn(`  call ${calls}: failed — ${msg.slice(0, 160)}`);
    continue;
  }

  let kept = 0;
  for (const x of items) {
    if (made + pending.length >= TARGET) break;
    const s = sentenceOf(x);
    const complete = TYPE === 'translation'
      ? !!(x.correct_translation && x.distractor_1 && x.distractor_2)
      : !!(x.decoy_1 && x.decoy_2);
    if (!s || !complete) { rejected++; continue; }
    const n = words(s);
    if (n < 5 || n > 15) { rejected++; continue; }              // outside the clip range
    if (!containsVerbatim(doc, s)) { rejected++; continue; }     // not actually in the source
    const key = s.toLowerCase();
    if (seen.has(key)) { rejected++; continue; }
    const used = perSource.get(doc.id) || 0;
    if (used >= MAX_PER_SOURCE) { capped++; continue; }
    perSource.set(doc.id, used + 1);
    seen.add(key);

    const src = doc.title || doc.kind;
    // Payload shapes must match exactly what the app's renderers read.
    const payload = TYPE === 'translation'
      ? { source: src, topic: x.topic || '', english_sentence: s,
          correct_translation: x.correct_translation, distractor_1: x.distractor_1, distractor_2: x.distractor_2 }
      : { source: src, topic: x.topic || '', correct_sentence: s, decoy_1: x.decoy_1, decoy_2: x.decoy_2 };

    pending.push({
      type: TYPE,
      level: LEVEL,
      topic: x.topic || null,
      source: src,
      payload,
      source_document_id: doc.id,
      content_hash: hash(TYPE === 'translation' ? 'tr:' + LEVEL + ':' + s : 'audio:' + s),
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
  pending.slice(0, 12).forEach((r, i) => {
    const s = sentenceOf(r.payload);
    console.log(`  ${String(i + 1).padStart(3)}. [${String(words(s)).padStart(2)}w] ${s}`);
  });
  console.log(`\nDry run — ${pending.length} would be added, ${rejected} rejected by the checks.`);
  process.exit(0);
}

made += await flush();
const { count } = await db.from('exercises').select('*', { count: 'exact', head: true }).eq('type', TYPE).eq('level', LEVEL);
console.log(`\nDone. ${made} new ${LEVEL} ${TYPE} exercises (${rejected} rejected as too long, too short, or not verbatim).`);
if (capped) console.log(`${capped} more were dropped to keep any one source under ${MAX_PER_SOURCE} of the batch.`);
if (made < TARGET) console.log(`Short of the ${TARGET} asked for — the shelf did not yield enough at this level.`);
console.log(`The repository now holds ${count} at ${LEVEL}.`);
