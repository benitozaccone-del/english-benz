// English Benz — load songs for the "Fill the lyrics" game.
//
// Takes a JSON file YOU supply and turns each song's lines into exercises. No
// Claude API call is involved: the exercise is the line itself, and the blanking
// happens in the browser, so this costs nothing to run and works offline.
//
//   cd scripts
//   node ingest-lyrics.mjs songs.json
//   node ingest-lyrics.mjs songs.json --dry-run
//   node ingest-lyrics.mjs songs.json --min-words 6 --max-words 12
//
// Expected shape — an array, or an object with a "songs" array:
//
//   [
//     {
//       "artist": "…",
//       "title": "…",
//       "album": "…",                 // optional, shown as the memory cue
//       "year": 1927,                 // optional
//       "license": "public-domain",   // public-domain | cc-by | licensed | own
//       "spotify_url": "https://open.spotify.com/track/…",   // optional
//       "lyrics": "line\nline\n…"     // or "lines": ["…", "…"]
//     }
//   ]
//
// On licensing: a song lyric is a whole work, not an excerpt, so what you load
// here matters more than anywhere else in this project. The "license" field is
// recorded per song and reported back at the end of a run, so a library of
// mixed provenance stays auditable. This script never fetches anything — it only
// stores what is in your file.
//
// Env vars (from .env): SUPABASE_URL, SUPABASE_SERVICE_KEY

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

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const DRY_RUN = argv.includes('--dry-run');
const MIN_WORDS = parseInt(flag('min-words', '5'), 10) || 5;
const MAX_WORDS = parseInt(flag('max-words', '14'), 10) || 14;
const PER_SONG = Math.max(1, parseInt(flag('per-song', '6'), 10) || 6);
const file = argv.find((a) => !a.startsWith('--') && a !== flag('min-words', null) && a !== flag('max-words', null) && a !== flag('per-song', null));

if (!file) {
  console.error('Usage: node ingest-lyrics.mjs <songs.json> [--dry-run] [--per-song 6]');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const hash = (s) => createHash('sha256').update(s.trim().toLowerCase()).digest('hex');
const words = (s) => s.split(/\s+/).filter(Boolean).length;

let raw;
try { raw = JSON.parse(readFileSync(file, 'utf8')); }
catch (e) { console.error(`Could not read ${file}: ${e.message}`); process.exit(1); }
const songs = Array.isArray(raw) ? raw : (raw.songs || []);
if (!songs.length) { console.error('No songs found in that file.'); process.exit(1); }

// A line worth asking about: long enough that blanking a quarter leaves something
// to think about, short enough to type. Section markers like [Chorus] are not lyrics.
function usableLines(song) {
  const text = song.lines ? song.lines.join('\n') : String(song.lyrics || '');
  const seen = new Set();
  const out = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (/^[\[(].*[\])]$/.test(line)) continue;          // [Chorus], (instrumental)
    const n = words(line);
    if (n < MIN_WORDS || n > MAX_WORDS) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;                        // choruses repeat; ask once
    seen.add(key);
    out.push(line);
  }
  return out;
}

// Spread the picks across the song rather than taking the opening lines.
function spread(lines, n) {
  if (lines.length <= n) return lines;
  const step = lines.length / n;
  return Array.from({ length: n }, (_, i) => lines[Math.floor(i * step)]);
}

let songCount = 0, lineCount = 0, skipped = 0;
const byLicense = new Map();

for (const s of songs) {
  const artist = String(s.artist || '').trim();
  const title = String(s.title || '').trim();
  if (!artist || !title) { skipped++; continue; }

  const lines = spread(usableLines(s), PER_SONG);
  if (!lines.length) {
    console.warn(`  ${artist} — ${title}: no lines of ${MIN_WORDS}-${MAX_WORDS} words`);
    skipped++;
    continue;
  }

  const license = String(s.license || 'unspecified');
  byLicense.set(license, (byLicense.get(license) || 0) + 1);

  if (DRY_RUN) {
    console.log(`  ${artist} — ${title}${s.album ? ' (' + s.album + ')' : ''}: ${lines.length} lines [${license}]`);
    songCount++; lineCount += lines.length;
    continue;
  }

  const { data: songRow, error: sErr } = await db
    .from('songs')
    .upsert({
      artist, title,
      album: s.album || null,
      year: s.year || null,
      license,
      spotify_url: s.spotify_url || null,
    }, { onConflict: 'artist,title' })
    .select('id')
    .single();
  if (sErr) { console.warn(`  ${artist} — ${title}: ${sErr.message}`); skipped++; continue; }

  // Artist/title/album/spotify are copied into the payload as well as being
  // reachable through song_id. The app reads every exercise through its payload,
  // so this keeps the game to a single round trip and no join; re-running the
  // ingester refreshes them if a song's details change.
  const rows = lines.map((line) => ({
    type: 'lyrics',
    level: '',
    topic: null,
    source: artist,
    song_id: songRow.id,
    payload: {
      artist, title,
      album: s.album || '',
      spotify_url: s.spotify_url || '',
      line,
    },
    content_hash: hash('lyrics:' + artist + ':' + title + ':' + line),
  }));

  const { data, error } = await db
    .from('exercises')
    .upsert(rows, { onConflict: 'content_hash', ignoreDuplicates: true })
    .select('id');
  if (error) { console.warn(`  ${artist} — ${title}: ${error.message}`); skipped++; continue; }

  songCount++;
  lineCount += data ? data.length : 0;
  console.log(`  ${artist} — ${title}: +${data ? data.length : 0} lines [${license}]`);
}

console.log(`\n${DRY_RUN ? 'Dry run — nothing stored. ' : ''}${songCount} songs, ${lineCount} lines${skipped ? `, ${skipped} skipped` : ''}.`);
if (byLicense.size) {
  console.log('by licence: ' + [...byLicense.entries()].map(([k, v]) => `${k} ${v}`).join(' · '));
  if (byLicense.has('unspecified')) {
    console.log('Some songs carry no "license" field — worth setting, since lyrics are whole works.');
  }
}
if (!DRY_RUN) {
  const { count } = await db.from('exercises').select('*', { count: 'exact', head: true }).eq('type', 'lyrics');
  console.log(`The lyrics pool now holds ${count} lines.`);
}
