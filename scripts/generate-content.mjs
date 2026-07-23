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
// Searching once and reusing the result for all four batches keeps API cost low.
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

// ---- stage 1: search (free-form; tools rule out structured outputs) --------
async function searchNews(want) {
  // max_uses caps search rounds — uncapped the model can run ~10 searches, which
  // is slow and eats the token budget; too tight and it gathers too few sentences.
  const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }];
  const messages = [{
    role: 'user',
    content:
      'Search the web for notable news stories published in the last few days by BBC News, TIME, or The New York Times.\n' +
      `Then list ${want} short verbatim sentences drawn from those stories, each under 15 words.\n` +
      'At least half of them must be under 12 words, and include a range of complexity — ' +
      'some simple and everyday, some with more idiomatic or sophisticated phrasing.\n' +
      'Format each line exactly as:  <outlet> | <topic word> | <sentence>\n' +
      'Use one lowercase topic word from: politics, economy, technology, environment, health, sport, culture, science, society.\n' +
      'Output only those lines.',
  }];

  // Turn 1: let it search. Searching (thinking + tool calls) can consume the whole
  // budget, so we do NOT rely on this turn to also produce the final list.
  for (let step = 0; step < 4; step++) {
    const res = await anthropic.messages.create(
      { model: MODEL, max_tokens: 12000, messages, tools },
      { timeout: 300000 },   // searching legitimately takes longer than a plain call
    );
    messages.push({ role: 'assistant', content: res.content });
    if (res.stop_reason === 'pause_turn') continue;
    break;
  }

  // Turn 2: no tools, fresh budget — just write the list from what it already found.
  messages.push({
    role: 'user',
    content:
      `Now output only the ${want} lines, in the format "<outlet> | <topic word> | <sentence>", ` +
      'using sentences from the articles you just read. No preamble, no commentary.',
  });
  const res2 = await anthropic.messages.create(
    { model: MODEL, max_tokens: 4000, messages },
    { timeout: 180000 },
  );
  const text = res2.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

  // Never return empty: the format stage would otherwise invent sentences and
  // attribute them to real outlets.
  if (!text) throw new Error('search produced no usable sentences');
  return text;
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

async function translationRows(news, level) {
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
      content_hash: hash('tr:' + level + ':' + x.english_sentence),
    }));
}

async function audioRows(news) {
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
      content_hash: hash('audio:' + x.correct_sentence),
    }));
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
  console.log(`  got ${lines} candidate sentences\n`);

  let total = 0;
  for (const level of ['B2', 'C1', 'C2']) {
    try {
      const n = await insert(await translationRows(news, level));
      total += n;
      console.log(`  translation ${level}: +${n} new`);
    } catch (e) {
      console.warn(`  translation ${level}: failed — ${e.message}`);
    }
  }
  try {
    const n = await insert(await audioRows(news));
    total += n;
    console.log(`  audio: +${n} new`);
  } catch (e) {
    console.warn(`  audio: failed — ${e.message}`);
  }

  console.log(`\nDone. ${total} new exercises added (duplicates skipped).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
