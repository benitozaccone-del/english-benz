// English Benz — content-generation pipeline
//
// Generates fresh exercises via the Claude API (with web search over recent news)
// and inserts them into the Supabase `exercises` table, de-duplicated by content hash.
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

// Fail fast: a single web-search request should never hang for minutes.
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY, timeout: 120000, maxRetries: 1 });
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const LEVEL_DESC = {
  B2: 'clear, moderately complex sentences using common but varied vocabulary and fairly straightforward clause structure',
  C1: 'more complex syntax, some idiomatic expressions, and less frequent vocabulary',
  C2: 'near-native complexity, nuanced or rare vocabulary, and sophisticated clause structure',
};

// ---- Claude call with web search + pause_turn handling ---------------------
async function generate(systemPrompt) {
  const tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  const messages = [{ role: 'user', content: 'Generate the exercise batch now.' }];

  for (let step = 0; step < 4; step++) {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: systemPrompt,
      messages,
      tools,
    });
    if (res.stop_reason === 'pause_turn') {
      // Server tool paused mid-loop — echo the turn back to resume.
      messages.push({ role: 'assistant', content: res.content });
      continue;
    }
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const clean = text.replace(/```json|```/g, '').trim();
    const match = clean.match(/\[[\s\S]*\]/);
    return JSON.parse(match ? match[0] : clean);
  }
  throw new Error('Model kept pausing without producing a final answer.');
}

const hash = (s) => createHash('sha256').update(s.trim().toLowerCase()).digest('hex');

// ---- translation exercises (Italian speaker learning English) --------------
async function translationBatch(level) {
  const system =
    `You create language-learning exercises for an Italian speaker learning English at CEFR level ${level}.\n` +
    'Search the web once for notable news stories published very recently (this week) by BBC, TIME, or The New York Times.\n' +
    `Create ${BATCH} different exercises. For each, pick ONE short verbatim sentence or clause, under 15 words, whose ` +
    `vocabulary and structure matches CEFR level ${level} complexity (${LEVEL_DESC[level]}).\n` +
    'Return a JSON array of exactly ' + BATCH + ' objects, each with EXACTLY these fields:\n' +
    '{"source": "BBC News" | "TIME" | "The New York Times", "topic": one short lowercase word from ' +
    '[politics, economy, technology, environment, health, sport, culture, science, society], ' +
    '"english_sentence": "the exact short quoted sentence, under 15 words", ' +
    '"correct_translation": "an accurate, natural Italian translation", ' +
    '"distractor_1": "a plausible but clearly incorrect Italian translation", ' +
    '"distractor_2": "another plausible but clearly incorrect Italian translation"}\n' +
    'Return ONLY the raw JSON array. No markdown fences, no preamble.';

  const items = await generate(system);
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

// ---- audio (listening) exercises -------------------------------------------
async function audioBatch() {
  const system =
    'You create listening-comprehension exercises for an English learner (B2-C1 level).\n' +
    'Search the web once for notable news stories published very recently (this week) by BBC, TIME, or The New York Times.\n' +
    `Create ${BATCH} different exercises. For each, pick ONE short verbatim sentence under 12 words, clear enough to be ` +
    'read aloud in about 5 seconds. Create two near-identical decoys, each with exactly one word changed.\n' +
    'Return a JSON array of exactly ' + BATCH + ' objects, each with EXACTLY these fields:\n' +
    '{"source": "BBC News" | "TIME" | "The New York Times", "topic": one short lowercase word from ' +
    '[politics, economy, technology, environment, health, sport, culture, science, society], ' +
    '"correct_sentence": "the exact short quoted sentence, under 12 words", ' +
    '"decoy_1": "near-identical sentence with one word changed", ' +
    '"decoy_2": "near-identical sentence with a different one word changed"}\n' +
    'Return ONLY the raw JSON array. No markdown fences, no preamble.';

  const items = await generate(system);
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
  let total = 0;

  for (const level of ['B2', 'C1', 'C2']) {
    try {
      const inserted = await insert(await translationBatch(level));
      total += inserted;
      console.log(`  translation ${level}: +${inserted} new`);
    } catch (e) {
      console.warn(`  translation ${level}: failed — ${e.message}`);
    }
  }

  try {
    const inserted = await insert(await audioBatch());
    total += inserted;
    console.log(`  audio: +${inserted} new`);
  } catch (e) {
    console.warn(`  audio: failed — ${e.message}`);
  }

  console.log(`\nDone. ${total} new exercises added (duplicates skipped).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
