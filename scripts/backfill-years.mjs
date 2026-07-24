// English Benz — backfill song years from MusicBrainz (free, no key needed).
//
//   node scripts/backfill-years.mjs
//   node scripts/backfill-years.mjs --delay 1200
//
// Queries songs with null year, looks each one up on MusicBrainz,
// and writes the first-release year back to the songs table.

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

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i+1] ? argv[i+1] : d; };
const DELAY = Math.max(1000, parseInt(flag('delay', '1100'), 10) || 1100); // MusicBrainz: 1 req/s

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA = 'EnglishBenz/1.0 (benitozaccone@intuendi.com)';

async function mbLookup(artist, title) {
  const q = `recording:"${title}" AND artist:"${artist}"`;
  const url = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(q)}&fmt=json&limit=5`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  const j = await res.json();
  const recs = j.recordings || [];
  // pick the one whose title matches best, then take the earliest release year
  const clean = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = clean(title);
  const matches = recs.filter(r => clean(r.title || '').includes(target) || target.includes(clean(r.title || '')));
  const pool = matches.length ? matches : recs;
  const years = pool
    .map(r => r['first-release-date'])
    .filter(Boolean)
    .map(d => parseInt(d.slice(0, 4), 10))
    .filter(y => y > 1900 && y <= new Date().getFullYear());
  return years.length ? Math.min(...years) : null;
}

const { data: songs, error } = await db
  .from('songs')
  .select('id, artist, title')
  .is('year', null)
  .order('artist');

if (error) { console.error('DB error:', error.message); process.exit(1); }
if (!songs || !songs.length) { console.log('All songs already have a year.'); process.exit(0); }

console.log(`\n${songs.length} songs without a year\n`);

let patched = 0, missed = 0;
for (let i = 0; i < songs.length; i++) {
  const s = songs[i];
  process.stdout.write(`[${i+1}/${songs.length}] ${s.artist} — ${s.title} … `);
  let year = null;
  try { year = await mbLookup(s.artist, s.title); } catch (e) { console.log(`ERROR: ${e.message}`); missed++; await sleep(DELAY); continue; }
  if (!year) { console.log('not found'); missed++; }
  else {
    const { error: ue } = await db.from('songs').update({ year }).eq('id', s.id);
    if (ue) { console.log(`DB error: ${ue.message}`); missed++; }
    else { console.log(year); patched++; }
  }
  if (i < songs.length - 1) await sleep(DELAY);
}

console.log(`\nDone. ${patched} updated, ${missed} not found or failed.`);
