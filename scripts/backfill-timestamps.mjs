// English Benz — backfill start_ms into existing lyrics exercises.
//
//   node backfill-timestamps.mjs
//   node backfill-timestamps.mjs --limit 50 --delay 800
//
// Queries exercises with type='lyrics' and no start_ms in payload,
// fetches richsync/subtitle from Musixmatch, patches each row.
// Already-timestamped exercises are skipped. Non-fatal 404s are logged.

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

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, MUSIXMATCH_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }
if (!MUSIXMATCH_KEY) { console.error('Missing MUSIXMATCH_KEY'); process.exit(1); }

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i+1] ? argv[i+1] : d; };
const LIMIT = parseInt(flag('limit', '500'), 10) || 500;
const DELAY = Math.max(300, parseInt(flag('delay', '600'), 10) || 600);

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MX_BASE = 'https://api.musixmatch.com/ws/1.1/';

async function mx(method, params) {
  const qs = new URLSearchParams({ apikey: MUSIXMATCH_KEY, ...params }).toString();
  const res = await fetch(`${MX_BASE}${method}?${qs}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const status = j?.message?.header?.status_code;
  if (status === 401) throw new Error('Musixmatch API key invalid (401)');
  if (status === 402) throw new Error('Musixmatch plan limit (402)');
  if (status !== 200) throw new Error(`Musixmatch status ${status}`);
  return j.message.body;
}

function normalizeForMatch(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

async function fetchTimestampIndex(trackId) {
  try {
    const b = await mx('track.richsync.get', { track_id: trackId });
    const raw = b?.richsync?.richsync_body;
    if (raw) {
      const items = JSON.parse(raw);
      const map = new Map();
      for (const it of items) {
        const k = normalizeForMatch(it.x || '');
        if (k) map.set(k, Math.round(it.ts * 1000));
      }
      if (map.size) return map;
    }
  } catch (e) { if (/401|402/.test(e.message)) throw e; }
  try {
    const b = await mx('track.subtitle.get', { track_id: trackId, subtitle_format: 'lrc' });
    const raw = b?.subtitle?.subtitle_body;
    if (raw) {
      const map = new Map();
      for (const line of raw.split('\n')) {
        const m = line.match(/^\[(\d+):(\d+\.\d+)\](.*)/);
        if (m) {
          const ms = (parseInt(m[1], 10) * 60 + parseFloat(m[2])) * 1000;
          const k = normalizeForMatch(m[3]);
          if (k) map.set(k, Math.round(ms));
        }
      }
      if (map.size) return map;
    }
  } catch (e) { if (/401|402/.test(e.message)) throw e; }
  return null;
}

function findTimestamp(index, line) {
  if (!index) return null;
  const key = normalizeForMatch(line);
  if (index.has(key)) return index.get(key);
  for (const [k, ms] of index) {
    if (k.includes(key) || key.includes(k)) return ms;
  }
  return null;
}

// Fetch exercises that lack start_ms, grouped by musixmatch_track_id
const { data: rows, error } = await db
  .from('exercises')
  .select('id, payload, songs(musixmatch_track_id)')
  .eq('type', 'lyrics')
  .is('payload->start_ms', null)
  .limit(LIMIT);

if (error) { console.error('DB error:', error.message); process.exit(1); }
if (!rows || !rows.length) { console.log('Nothing to backfill.'); process.exit(0); }

// Group by track ID so we only call Musixmatch once per track
const byTrack = new Map();
for (const row of rows) {
  const tid = row.songs?.musixmatch_track_id;
  if (!tid) continue;
  if (!byTrack.has(tid)) byTrack.set(tid, []);
  byTrack.get(tid).push(row);
}

console.log(`\n${rows.length} exercises across ${byTrack.size} tracks to backfill\n`);

let patched = 0, noTs = 0, failed = 0;
let tracksDone = 0;

for (const [trackId, exercises] of byTrack) {
  tracksDone++;
  process.stdout.write(`[${tracksDone}/${byTrack.size}] track ${trackId} (${exercises.length} ex) … `);
  let index;
  try {
    index = await fetchTimestampIndex(trackId);
  } catch (e) {
    console.log(`ERROR: ${e.message}`);
    failed += exercises.length;
    if (/401|402/.test(e.message)) { console.error('Stopping.'); break; }
    await sleep(DELAY);
    continue;
  }

  if (!index) { console.log('no timestamps'); noTs += exercises.length; await sleep(DELAY); continue; }

  let trackPatched = 0;
  for (const row of exercises) {
    const line = row.payload?.line;
    if (!line) continue;
    const startMs = findTimestamp(index, line);
    if (startMs == null) continue;
    const newPayload = Object.assign({}, row.payload, { start_ms: startMs });
    const { error: ue } = await db.from('exercises').update({ payload: newPayload }).eq('id', row.id);
    if (!ue) { trackPatched++; patched++; }
    else { failed++; }
  }
  console.log(`${trackPatched}/${exercises.length} patched`);
  if (tracksDone < byTrack.size) await sleep(DELAY);
}

console.log(`\nDone. ${patched} patched, ${noTs} no timestamps available, ${failed} failed.`);
