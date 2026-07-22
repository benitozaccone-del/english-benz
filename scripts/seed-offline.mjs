// English Benz — seed the built-in offline packs into Supabase.
//
// Reliable, free, no Claude API: reads the TR_FALLBACK / AUDIO_FALLBACK packs
// straight out of index.html (the single source of truth) and inserts
// them into the `exercises` table, deduped. Gives the app real content instantly.
//
//   cd scripts
//   node seed-offline.mjs
//
// Env vars (from .env): SUPABASE_URL, SUPABASE_SERVICE_KEY  (no Anthropic key needed)

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

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY. Fill scripts/.env.');
  process.exit(1);
}

// Pull the two pack literals out of the app file by balanced-delimiter scan.
// (Our pack strings contain no braces/brackets, so a simple depth count is safe.)
function extractLiteral(src, marker, open, close) {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error('Could not find ' + marker + ' in the app file.');
  const start = src.indexOf(open, i);
  let depth = 0, j = start;
  for (; j < src.length; j++) {
    if (src[j] === open) depth++;
    else if (src[j] === close && --depth === 0) { j++; break; }
  }
  return src.slice(start, j);
}

const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
// eslint-disable-next-line no-eval
const TR_FALLBACK = eval('(' + extractLiteral(html, 'var TR_FALLBACK', '{', '}') + ')');
// eslint-disable-next-line no-eval
const AUDIO_FALLBACK = eval('(' + extractLiteral(html, 'var AUDIO_FALLBACK', '[', ']') + ')');

const hash = (s) => createHash('sha256').update(s.trim().toLowerCase()).digest('hex');

const rows = [];
for (const level of Object.keys(TR_FALLBACK)) {
  for (const x of TR_FALLBACK[level]) {
    rows.push({
      type: 'translation', level, topic: x.topic || null, source: x.source || null,
      payload: x, content_hash: hash('tr:' + level + ':' + x.english_sentence),
    });
  }
}
for (const x of AUDIO_FALLBACK) {
  rows.push({
    type: 'audio', level: '', topic: x.topic || null, source: x.source || null,
    payload: x, content_hash: hash('audio:' + x.correct_sentence),
  });
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const { data, error } = await db
  .from('exercises')
  .upsert(rows, { onConflict: 'content_hash', ignoreDuplicates: true })
  .select('id');

if (error) { console.error('Insert failed:', error.message); process.exit(1); }
console.log(`Seeded offline packs: ${data ? data.length : 0} new exercises added (of ${rows.length}; duplicates skipped).`);
