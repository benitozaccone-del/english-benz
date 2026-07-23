// English Benz — content-generation pipeline
//
// Generates fresh exercises from recent news and inserts them into the Supabase
// `exercises` table, de-duplicated by content hash.
//
// Two stages, deliberately separated:
//   1. SEARCH  — one web-search call returns recent news sentences as plain text.
//                (Search results carry citations, which structured outputs reject,
//                 so this stage must stay free-form.)
//   2. FORMAT  — tool-free calls with a JSON schema turn those sentences into
//                exercises. Structured outputs guarantee valid JSON, so there is
//                no regex scraping and no parse errors.
// Searching once and reusing the result for every batch keeps API cost low.
//
// The raw search output is stored in `source_documents` before anything is
// generated from it, and every generated row points back at that document. So a
// run is repeatable: you can mine the same articles again later for a different
// kind of exercise without paying for the search twice.
//
// One of those batches mines phrasal verbs out of the same sentences. A verb the
// database already knows simply gains a real-world usage example; a verb it does
// not gains an entry tagged 'news'. That is the cheapest way to grow vocabulary
// content from language people actually publish.
//
// Run occasionally, from your own machine — this is the one paid, key-holding step.
// The browser app never calls the Claude API; it only reads what this script writes.
//
//   cd scripts
//   npm install
//   cp .env.example .env   # then fill in the three values
//   npm run generate                 # default: 8 items per level/type
//   node generate-content.mjs 12     # override the batch size
//
// Env vars (see .env.example): ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

// ---- minimal .env loader (no dependency) ----------------------------------
const here = dirname(fileURLToPath(import.meta.url));
try {
  for (const line of readFileSync(join(here, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env file — rely on real environment variables */ }

const { ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing env vars. Copy scripts/.env.example to scripts/.env and fill it in.');
  process.exit(1);
}

const BATCH = Math.max(1, Math.min(parseInt(process.argv[2] || '8', 10) || 8, 20));
const MODEL = 'claude-sonnet-5'; // balance of quality and cost for exercise generation

// Fail fast: a single request should never hang for minutes.
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY, timeout: 120000, maxRetries: 1 });
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const LEVEL_DESC = {
  B2: 'clear, moderately complex sentences using common but varied vocabulary and fairly straightforward clause structure',
  C1: 'more complex syntax, some idiomatic expressions, and less frequent vocabulary',
  C2: 'near-native complexity, nuanced or rare vocabulary, and sophisticated clause structure',
};

// ---- schemas (structured outputs need an object root) ----------------------
const envelope = (props, required) => ({
  type: 'object',
  properties: {
    exercises: {
      type: 'array',
      items: { type: 'object', properties: props, required, additionalProperties: false },
    },
  },
  required: ['exercises'],
  additionalProperties: false,
});

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

// "suffix" tells the app how to inflect the three wrong options so they match the
// tense of the right one — the same convention the course-book examples use.
const PV_SCHEMA = envelope({
  verb: { type: 'string' },
  meaning: { type: 'string' },
  level: { type: 'string', enum: ['B1', 'B2', 'C1', 'C2'] },
  sentence: { type: 'string' },
  answer: { type: 'string' },
  suffix: { type: 'string', enum: ['', 's', 'es', 'ed', 'ing'] },
  source: { type: 'string' },
}, ['verb', 'meaning', 'level', 'sentence', 'answer', 'suffix', 'source']);

// ---- stage 1: search (free-form; tools rule out structured outputs) --------

// A usable line is "<outlet> | <topic> | <sentence>". Counting these, rather than
// trusting that any text came back, is what keeps prose like "I was unable to
// retrieve verbatim text" from being handed to the format stage as raw material.
const LINE_RE = /^[^|\n]{2,40}\|[^|\n]{2,30}\|.{10,}$/;
const usableLines = (text) => (text || '').split('\n').map((l) => l.trim()).filter((l) => LINE_RE.test(l));

const textOf = (res) => res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

async function searchNews(want) {
  // max_uses caps search rounds — uncapped the model can run ~10 searches, which
  // is slow and eats the token budget; too tight and it gathers too few sentences.
  const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }];

  // Search by TOPIC, not by outlet. Asking for "stories by BBC News" makes the
  // search engine return pages *about* the BBC — homepages, app listings,
  // Wikipedia — and no article text at all. Searching the subject matter finds
  // real articles, and whichever reputable outlet published them is recorded.
  const messages = [{
    role: 'user',
    content:
      'Search the web for significant news stories published in the last few days. ' +
      'Cover a spread of subjects: world affairs, economy, technology, environment, health, sport, culture, science.\n' +
      `Read the articles you find, then list ${want} short verbatim sentences taken from them, each under 15 words.\n` +
      'At least half must be under 12 words, and include a range of complexity — ' +
      'some plain and everyday, some with more idiomatic or sophisticated phrasing.\n' +
      'Format each line exactly as:  <outlet> | <topic word> | <sentence>\n' +
      'The outlet is whichever publication actually carried the sentence (Reuters, AP, BBC News, The Guardian, …).\n' +
      'Use one lowercase topic word from: politics, economy, technology, environment, health, sport, culture, science, society.\n' +
      'Output only those lines, nothing else. If you genuinely cannot read any article text, say exactly NO SENTENCES.',
  }];

  // Turn 1: search, and take the list straight away if it already wrote one —
  // it usually does, and skipping turn 2 avoids a second billed call.
  let firstText = '';
  for (let step = 0; step < 4; step++) {
    const res = await anthropic.messages.create(
      { model: MODEL, max_tokens: 12000, messages, tools },
      { timeout: 300000 },   // searching legitimately takes longer than a plain call
    );
    messages.push({ role: 'assistant', content: res.content });
    firstText = textOf(res);
    if (res.stop_reason === 'pause_turn') continue;
    break;
  }
  const firstLines = usableLines(firstText);
  if (firstLines.length >= Math.max(4, Math.ceil(want / 2))) return firstLines.join('\n');

  // Turn 2: no tools, so the whole budget goes to writing. It must be generous —
  // adaptive thinking spends from the same allowance, and at 4000 tokens this
  // call returned a lone thinking block and no text at all.
  messages.push({
    role: 'user',
    content:
      `Now output only the ${want} lines, in the format "<outlet> | <topic word> | <sentence>", ` +
      'using sentences from the articles you just read. No preamble, no commentary. ' +
      'If you could not read any article text, say exactly NO SENTENCES.',
  });
  const res2 = await anthropic.messages.create(
    { model: MODEL, max_tokens: 8000, messages },
    { timeout: 180000 },
  );
  const lines = usableLines(textOf(res2)).concat(firstLines);

  // Never return prose: the format stage would treat an apology as source
  // material and invent sentences attributed to real outlets.
  if (!lines.length) throw new Error('search returned no verbatim sentences (nothing was fabricated)');
  return [...new Set(lines)].join('\n');
}

// ---- stage 2: format (no tools, schema-constrained -> always valid JSON) ---
async function structured(system, userText, schema) {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system,
    messages: [{ role: 'user', content: userText }],
    output_config: { format: { type: 'json_schema', schema } },
  });
  if (res.stop_reason === 'max_tokens') throw new Error('response hit max_tokens — use a smaller batch size');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = JSON.parse(text);
  return Array.isArray(parsed.exercises) ? parsed.exercises : [];
}

const hash = (s) => createHash('sha256').update(s.trim().toLowerCase()).digest('hex');

// ---- raw material -----------------------------------------------------------
// Store the text before generating anything from it. Identical text dedupes on
// content_hash, in which case we reuse the existing row's id.
async function saveSourceDocument({ kind, title, origin, content, meta }) {
  const h = hash(content);
  const { data, error } = await db
    .from('source_documents')
    .upsert(
      { kind, title, origin, content, content_hash: h, char_count: content.length, meta: meta || {} },
      { onConflict: 'content_hash', ignoreDuplicates: true },
    )
    .select('id');
  if (error) throw error;
  if (data && data.length) return data[0].id;
  const existing = await db.from('source_documents').select('id').eq('content_hash', h).maybeSingle();
  return existing.data ? existing.data.id : null;
}

async function translationRows(news, level, docId) {
  const system =
    `You create language-learning exercises for an Italian speaker learning English at CEFR level ${level}.\n` +
    `From the NEWS SENTENCES the user provides, pick up to ${BATCH} whose vocabulary and structure best match level ${level} ` +
    `(${LEVEL_DESC[level]}), and build one exercise from each.\n` +
    'Keep "source" as the outlet name and "topic" as the topic word given for that sentence. ' +
    'The distractors must be plausible but clearly incorrect Italian translations.';
  const items = await structured(system, 'NEWS SENTENCES:\n' + news, TR_SCHEMA);
  return items
    .filter((x) => x && x.english_sentence && x.correct_translation)
    .map((x) => ({
      type: 'translation',
      level,
      topic: x.topic || null,
      source: x.source || null,
      payload: x,
      source_document_id: docId,
      content_hash: hash('tr:' + level + ':' + x.english_sentence),
    }));
}

async function audioRows(news, docId) {
  const system =
    'You create listening-comprehension exercises for an English learner (B2-C1 level).\n' +
    `From the NEWS SENTENCES the user provides, pick up to ${BATCH} that are under 12 words and clear when read aloud. ` +
    'For each, produce two near-identical decoys, each differing from the original by exactly one word.\n' +
    'Keep "source" as the outlet name and "topic" as the topic word given for that sentence.';
  const items = await structured(system, 'NEWS SENTENCES:\n' + news, AUDIO_SCHEMA);
  return items
    .filter((x) => x && x.correct_sentence && x.decoy_1 && x.decoy_2)
    .map((x) => ({
      type: 'audio',
      level: '',
      topic: x.topic || null,
      source: x.source || null,
      payload: x,
      source_document_id: docId,
      content_hash: hash('audio:' + x.correct_sentence),
    }));
}

// ---- phrasal verbs mined from the same sentences ---------------------------
// Returns { verbs, examples } counts. Known verbs gain an example and keep their
// existing categories; unknown ones are inserted tagged 'news'.
async function phrasalVerbRows(news, docId) {
  const system =
    'You find phrasal verbs in real news sentences and turn them into cloze exercises.\n' +
    `From the NEWS SENTENCES the user provides, pick up to ${BATCH} that contain a genuine phrasal verb ` +
    '(a verb plus a particle whose combined meaning is not simply the sum of its parts, e.g. "carry out", "step down", "call for").\n' +
    'For each one:\n' +
    '  verb     — the base form, lowercase, e.g. "step down"\n' +
    '  meaning  — one plain sentence explaining it, written for a learner\n' +
    '  level    — CEFR difficulty of the verb: B1 everyday, B2 common, C1 less frequent, C2 rare or idiomatic\n' +
    '  sentence — the ORIGINAL sentence verbatim, with the phrasal verb replaced by the literal text ___BLANK___\n' +
    '  answer   — exactly the words you removed, in the form they appeared (e.g. "stepped down")\n' +
    '  suffix   — how "answer" is inflected: "" base, "s"/"es" third person, "ed" past, "ing" continuous\n' +
    '  source   — the outlet named for that sentence\n' +
    'Skip any sentence with no real phrasal verb rather than inventing one. ' +
    'Never alter the sentence beyond replacing the verb with ___BLANK___.';

  const items = (await structured(system, 'NEWS SENTENCES:\n' + news, PV_SCHEMA)).filter(
    (x) => x && x.verb && x.meaning && x.answer && x.sentence && x.sentence.includes('___BLANK___'),
  );
  if (!items.length) return { verbs: 0, examples: 0 };

  // Insert unseen verbs. ignoreDuplicates keeps an existing verb's categories
  // intact — a top-100 verb found in the news must not be demoted to 'news'.
  const verbRows = items.map((x) => ({
    verb: x.verb.trim().toLowerCase(),
    meaning: x.meaning,
    level: x.level || 'B2',
    categories: ['news'],
    source: x.source || 'News',
  }));
  const { data: newVerbs, error: vErr } = await db
    .from('phrasal_verbs')
    .upsert(verbRows, { onConflict: 'verb', ignoreDuplicates: true })
    .select('id');
  if (vErr) throw vErr;

  const names = [...new Set(verbRows.map((r) => r.verb))];
  const { data: known, error: kErr } = await db.from('phrasal_verbs').select('id,verb').in('verb', names);
  if (kErr) throw kErr;
  const ids = new Map(known.map((r) => [r.verb, r.id]));

  const exampleRows = items
    .filter((x) => ids.has(x.verb.trim().toLowerCase()))
    .map((x) => ({
      phrasal_verb_id: ids.get(x.verb.trim().toLowerCase()),
      sentence: x.sentence,
      answer: x.answer,
      suffix: x.suffix || '',
      source: x.source || 'News',
      source_document_id: docId,
      content_hash: hash('pv:' + x.verb.trim().toLowerCase() + ':' + x.sentence),
    }));

  const { data: exData, error: eErr } = await db
    .from('phrasal_verb_examples')
    .upsert(exampleRows, { onConflict: 'content_hash', ignoreDuplicates: true })
    .select('id');
  if (eErr) throw eErr;

  return { verbs: newVerbs ? newVerbs.length : 0, examples: exData ? exData.length : 0 };
}

async function insert(rows) {
  if (!rows.length) return 0;
  // ignoreDuplicates: rows whose content_hash already exists are skipped, not updated.
  const { data, error } = await db
    .from('exercises')
    .upsert(rows, { onConflict: 'content_hash', ignoreDuplicates: true })
    .select('id');
  if (error) throw error;
  return data ? data.length : 0;
}

async function main() {
  console.log(`Generating ~${BATCH} items per level/type with ${MODEL}…\n`);

  console.log('  searching recent news…');
  let news;
  try {
    news = await searchNews(BATCH * 3); // one search, reused by every batch below
  } catch (e) {
    console.error('  search failed — ' + e.message);
    process.exit(1);
  }
  const lines = news.split('\n').map((l) => l.trim()).filter(Boolean).length;
  console.log(`  got ${lines} candidate sentences`);

  // Keep the raw material first, so everything generated below is traceable and
  // the same articles can be mined again later without re-running the search.
  let docId = null;
  try {
    docId = await saveSourceDocument({
      kind: 'news',
      title: `News sentences · ${lines} lines`,
      origin: 'web_search: BBC News / TIME / The New York Times',
      content: news,
      meta: { lines, model: MODEL },
    });
    console.log(`  stored as source document ${docId}\n`);
  } catch (e) {
    console.warn(`  could not store the source document — ${e.message}\n`);
  }

  let total = 0;
  for (const level of ['B2', 'C1', 'C2']) {
    try {
      const n = await insert(await translationRows(news, level, docId));
      total += n;
      console.log(`  translation ${level}: +${n} new`);
    } catch (e) {
      console.warn(`  translation ${level}: failed — ${e.message}`);
    }
  }
  try {
    const n = await insert(await audioRows(news, docId));
    total += n;
    console.log(`  audio: +${n} new`);
  } catch (e) {
    console.warn(`  audio: failed — ${e.message}`);
  }
  try {
    const pv = await phrasalVerbRows(news, docId);
    console.log(`  phrasal verbs: +${pv.verbs} new verbs, +${pv.examples} new usage examples`);
  } catch (e) {
    console.warn(`  phrasal verbs: failed — ${e.message}`);
  }

  console.log(`\nDone. ${total} new exercises added (duplicates skipped).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
