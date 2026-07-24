// English Benz — patch year into lyrics exercise payloads from the songs table.
//
//   node scripts/backfill-payload-year.mjs
//
// Reads songs.year and writes it into each matching exercise payload.
// Safe to re-run: skips exercises that already have year in payload.

import { readFileSync } from 'node:fs';
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
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

// Load all songs that have a year
const { data: songs, error: se } = await db.from('songs').select('artist, title, year').not('year', 'is', null);
if (se) { console.error('DB error:', se.message); process.exit(1); }
if (!songs?.length) { console.log('No songs with year found — run backfill-years.mjs first.'); process.exit(0); }

// Build a lookup map keyed by "artist|title"
const yearMap = new Map();
for (const s of songs) yearMap.set((s.artist + '|' + s.title).toLowerCase(), s.year);
console.log(`${songs.length} songs with year loaded`);

// Fetch all lyrics exercises that lack year in payload
const { data: rows, error: re } = await db
  .from('exercises')
  .select('id, payload')
  .eq('type', 'lyrics')
  .is('payload->year', null);
if (re) { console.error('DB error:', re.message); process.exit(1); }
if (!rows?.length) { console.log('All exercise payloads already have year.'); process.exit(0); }

console.log(`${rows.length} exercises to patch\n`);

let patched = 0, missed = 0;
for (const row of rows) {
  const key = ((row.payload?.artist || '') + '|' + (row.payload?.title || '')).toLowerCase();
  const year = yearMap.get(key);
  if (!year) { missed++; continue; }
  const { error: ue } = await db.from('exercises')
    .update({ payload: Object.assign({}, row.payload, { year }) })
    .eq('id', row.id);
  if (ue) { console.error(`  ${row.id}: ${ue.message}`); missed++; }
  else patched++;
}

console.log(`Done. ${patched} patched, ${missed} not matched.`);
