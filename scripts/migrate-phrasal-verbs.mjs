// English Benz — move the hard-coded phrasal verbs into the database.
//
// Reads PV_TIER1 / PV_TIER2 / PV_DATA out of index.html (their original home) and
// writes them to `phrasal_verbs` + `phrasal_verb_examples`. Run this ONCE before
// deleting the literals from the app file; after that the app reads from the DB.
//
// Category tagging: the top-200 list is a superset of the top-100 one, so a core
// verb is tagged {top100, top200}. That keeps the app's category filter a single
// array containment test instead of a union of tiers.
//
// CEFR level: the course book doesn't ship levels, so one Claude call classifies
// the verbs. Without ANTHROPIC_API_KEY everything defaults to B2 and the script
// says so — the migration still works, the column is just less useful.
//
//   cd scripts
//   node migrate-phrasal-verbs.mjs            # insert; existing verbs untouched
//   node migrate-phrasal-verbs.mjs --refresh  # also update meaning/level/categories
//
// Env vars (from .env): SUPABASE_URL, SUPABASE_SERVICE_KEY, optionally ANTHROPIC_API_KEY

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const here = dirname(fileURLToPath(import.meta.url));
try {
  for (const line of readFileSync(join(here, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* rely on real env */ }

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY. Fill scripts/.env.');
  process.exit(1);
}
const REFRESH = process.argv.includes('--refresh');
const MODEL = 'claude-sonnet-5';

// ---- pull the literals out of the app file -------------------------------
// Balanced-delimiter scan, same approach as seed-offline.mjs.
function extractLiteral(src, marker, open, close) {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error('Could not find ' + marker + ' in index.html — already migrated?');
  const start = src.indexOf(open, i);
  let depth = 0, j = start;
  for (; j < src.length; j++) {
    if (src[j] === open) depth++;
    else if (src[j] === close && --depth === 0) { j++; break; }
  }
  return src.slice(start, j);
}

const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const TIER1 = eval('(' + extractLiteral(html, 'var PV_TIER1', '[', ']') + ')');   // eslint-disable-line no-eval
const TIER2 = eval('(' + extractLiteral(html, 'var PV_TIER2', '[', ']') + ')');   // eslint-disable-line no-eval
const DATA  = eval('(' + extractLiteral(html, 'var PV_DATA',  '{', '}') + ')');   // eslint-disable-line no-eval

const core = new Set(TIER1);
const verbs = [...new Set([...TIER1, ...TIER2])].filter((v) => DATA[v] && DATA[v].q && DATA[v].q.length);
console.log(`Found ${verbs.length} verbs with ${verbs.reduce((n, v) => n + DATA[v].q.length, 0)} examples in index.html.`);

// ---- CEFR classification --------------------------------------------------
async function classify(list) {
  if (!ANTHROPIC_API_KEY) {
    console.log('No ANTHROPIC_API_KEY — defaulting every verb to B2.');
    return {};
  }
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY, timeout: 180000, maxRetries: 1 });
  const schema = {
    type: 'object',
    properties: {
      verbs: {
        type: 'array',
        items: {
          type: 'object',
          properties: { verb: { type: 'string' }, level: { type: 'string', enum: ['B1', 'B2', 'C1', 'C2'] } },
          required: ['verb', 'level'],
          additionalProperties: false,
        },
      },
    },
    required: ['verbs'],
    additionalProperties: false,
  };

  const out = {};
  const SIZE = 50;                      // small batches keep each response well inside max_tokens
  for (let i = 0; i < list.length; i += SIZE) {
    const chunk = list.slice(i, i + SIZE);
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system:
        'You assign CEFR levels to English phrasal verbs for an Italian learner.\n' +
        'B1 = everyday and highly frequent; B2 = common but less transparent; ' +
        'C1 = lower frequency or figurative; C2 = rare, idiomatic or register-specific.\n' +
        'Judge the verb\'s most common meaning. Return one entry per verb given, verb spelled exactly as provided.',
      messages: [{ role: 'user', content: 'VERBS:\n' + chunk.join('\n') }],
      output_config: { format: { type: 'json_schema', schema } },
    });
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    for (const r of (JSON.parse(text).verbs || [])) out[r.verb] = r.level;
    console.log(`  classified ${Math.min(i + SIZE, list.length)}/${list.length}`);
  }
  return out;
}

const levels = await classify(verbs);

// ---- write the verbs ------------------------------------------------------
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const verbRows = verbs.map((v) => ({
  verb: v,
  meaning: DATA[v].m,
  level: levels[v] || 'B2',
  categories: core.has(v) ? ['top100', 'top200'] : ['top200'],
  source: 'Course book',
}));

// ignoreDuplicates by default so a re-run never clobbers categories that the news
// pipeline may have added ('news') to a verb that also lives in the top lists.
const { error: verbErr } = await db
  .from('phrasal_verbs')
  .upsert(verbRows, { onConflict: 'verb', ignoreDuplicates: !REFRESH });
if (verbErr) { console.error('Verb insert failed:', verbErr.message); process.exit(1); }

// Read the ids back — upsert with ignoreDuplicates returns only the new rows.
const ids = new Map();
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from('phrasal_verbs').select('id,verb').range(from, from + 999);
  if (error) { console.error('Could not read verb ids:', error.message); process.exit(1); }
  for (const r of data) ids.set(r.verb, r.id);
  if (data.length < 1000) break;
}

const hash = (s) => createHash('sha256').update(s.trim().toLowerCase()).digest('hex');

const exampleRows = [];
for (const v of verbs) {
  for (const q of DATA[v].q) {
    if (!ids.has(v)) continue;
    exampleRows.push({
      phrasal_verb_id: ids.get(v),
      sentence: q.s,
      answer: q.a,
      suffix: q.suf || '',
      source: 'Course book',
      content_hash: hash('pv:' + v + ':' + q.s),
    });
  }
}

const { data: exData, error: exErr } = await db
  .from('phrasal_verb_examples')
  .upsert(exampleRows, { onConflict: 'content_hash', ignoreDuplicates: true })
  .select('id');
if (exErr) { console.error('Example insert failed:', exErr.message); process.exit(1); }

const { count: verbCount } = await db.from('phrasal_verbs').select('*', { count: 'exact', head: true });
const { count: exCount }   = await db.from('phrasal_verb_examples').select('*', { count: 'exact', head: true });

console.log(`\nDone. ${exData ? exData.length : 0} new examples added.`);
console.log(`Database now holds ${verbCount} phrasal verbs and ${exCount} examples.`);
