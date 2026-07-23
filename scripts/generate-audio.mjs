// English Benz — build the audio clip repository with Speechify.
//
// Every "Spot the transcription" sentence is read aloud by an AI voice ONCE. The
// mp3 goes to the Supabase Storage bucket "clips" and a row in `audio_clips`
// indexes it. Re-running costs nothing: a clip is keyed by sha256(text|voice|
// model), so only sentences that have never been spoken in that voice are sent
// to the API. That matters — Speechify bills per character.
//
//   cd scripts
//   node generate-audio.mjs --voices        # list the voices your plan can use
//   node generate-audio.mjs                 # speak everything still missing (max 25)
//   node generate-audio.mjs --limit 100     # bigger run
//   node generate-audio.mjs --voice scott   # a different narrator
//   node generate-audio.mjs --dry-run       # show what would be spoken, call nothing
//
// Env vars (from .env): SPEECHIFY_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
// Optional: SPEECHIFY_VOICE_ID, SPEECHIFY_MODEL

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

const { SPEECHIFY_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY. Fill scripts/.env.');
  process.exit(1);
}
if (!SPEECHIFY_API_KEY) {
  console.error('Missing SPEECHIFY_API_KEY. Add it to scripts/.env:\n  SPEECHIFY_API_KEY=sk_...');
  process.exit(1);
}

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const LIST_VOICES = argv.includes('--voices');
const DRY_RUN = argv.includes('--dry-run');
const REVOICE = argv.includes('--revoice');   // deliberately speak sentences again in a new voice
const LIMIT = Math.max(1, Math.min(parseInt(flag('limit', '25'), 10) || 25, 500));

// A clip is worth hearing more than once, so the narrator varies between
// sentences. Each voice carries its own model: only some support simba-3.2, and
// asking an older voice for it fails the call outright.
const VOICE_POOL = [
  { id: 'imogen_32',   model: 'simba-3.2', locale: 'en-GB' },
  { id: 'beatrice_32', model: 'simba-3.2', locale: 'en-GB' },
  { id: 'harper_32',   model: 'simba-3.2', locale: 'en-US' },
  { id: 'wyatt_32',    model: 'simba-3.2', locale: 'en-US' },
  { id: 'dominic_32',  model: 'simba-3.2', locale: 'en-US' },
  { id: 'lexi',        model: 'simba-3.0', locale: 'en-US' },
  { id: 'sabrina',     model: 'simba-3.0', locale: 'en-US' },
];

// A single voice can still be forced for a run.
const FORCED_VOICE = flag('voice', process.env.SPEECHIFY_VOICE_ID || '');
const FORCED_MODEL = flag('model', process.env.SPEECHIFY_MODEL || '');

// Clips shorter than this are trivial to transcribe; longer ones are a memory
// test rather than a listening one, and the advanced mode becomes a slog.
const MIN_WORDS = parseInt(flag('min-words', '5'), 10) || 5;
const MAX_WORDS = parseInt(flag('max-words', '15'), 10) || 15;

const API = 'https://api.speechify.ai/v1';
const BUCKET = 'clips';

// Free tier: 50,000 characters a month, a hard cap rather than an overage charge,
// and 1 request/second on /v1/audio/speech. Both numbers are worth respecting
// here rather than discovering them as a wall of 429s halfway through a run.
const FREE_CHAR_CAP = parseInt(flag('cap', '50000'), 10) || 50000;
const MIN_GAP_MS = parseInt(flag('gap', '1100'), 10) || 1100;

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const hash = (s) => createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function speechify(path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { authorization: 'Bearer ' + SPEECHIFY_API_KEY, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`Speechify HTTP ${res.status}: ${body}`);
  }
  return res.json();
}

// ---- --voices ---------------------------------------------------------------
// The endpoint is a keyset-paginated list: one page is ~50 voices out of ~950,
// alphabetical. Reading only the first page makes it look as though the account
// has a handful of English voices when it has over a hundred, so follow the
// cursor until has_more goes false.
async function listVoices() {
  const all = [];
  let cursor = null;
  for (let page = 0; page < 40; page++) {
    const qs = new URLSearchParams({ limit: '100' });
    if (cursor) qs.set('cursor', cursor);
    const d = await speechify('/voices?' + qs.toString());
    all.push(...(Array.isArray(d) ? d : (d.voices || [])));
    if (!d || !d.has_more || !d.next_cursor) break;
    cursor = d.next_cursor;
  }
  return all;
}

if (LIST_VOICES) {
  const voices = await listVoices();
  const filter = flag('locale', 'en');
  const matching = voices.filter((v) => (v.locale || '').toLowerCase().startsWith(filter.toLowerCase()));
  console.log(`${voices.length} voices on this plan · ${matching.length} matching locale "${filter}":\n`);
  for (const v of matching.sort((a, b) => (a.locale + a.id).localeCompare(b.locale + b.id))) {
    console.log(`  ${String(v.id).padEnd(22)} ${String(v.display_name || '').padEnd(20)} ${String(v.gender || '').padEnd(8)} ${v.locale || ''}`);
  }
  console.log('\nUse one with:  node generate-audio.mjs --voice <id>');
  console.log('Other locales: node generate-audio.mjs --voices --locale it');
  console.log('Or set SPEECHIFY_VOICE_ID in scripts/.env to make it the default.');
  process.exit(0);
}

// ---- what still needs a voice ----------------------------------------------
const { data: exercises, error: exErr } = await db
  .from('exercises')
  .select('id,payload')
  .eq('type', 'audio')
  .eq('active', true);
if (exErr) { console.error('Could not read exercises:', exErr.message); process.exit(1); }

const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;

// The voice is chosen from the sentence itself rather than at random, so a
// re-run after a failure retries the SAME voice instead of paying for a second
// reading. Across a set of sentences the effect is still an even scatter.
function voiceFor(text) {
  if (FORCED_VOICE) return { id: FORCED_VOICE, model: FORCED_MODEL || 'simba-3.0' };
  const pick = VOICE_POOL[parseInt(hash(text).slice(0, 8), 16) % VOICE_POOL.length];
  return { id: pick.id, model: FORCED_MODEL || pick.model };
}

// One row per distinct sentence; several exercises could share wording.
const wanted = [];
const seenText = new Set();
let tooShort = 0, tooLong = 0;
for (const e of exercises || []) {
  const text = (e.payload && e.payload.correct_sentence || '').trim();
  if (!text || seenText.has(text)) continue;
  const n = wordCount(text);
  if (n < MIN_WORDS) { tooShort++; continue; }
  if (n > MAX_WORDS) { tooLong++; continue; }
  seenText.add(text);
  const v = voiceFor(text);
  wanted.push({
    exercise_id: e.id, text, words: n, voice: v.id, model: v.model,
    content_hash: hash(text + '|' + v.id + '|' + v.model),
  });
}

// Dedupe on the TEXT, not on (text|voice|model). Since the voice varies, keying
// the "already done" check on the full hash would re-synthesise every sentence
// the moment the pool changed — exactly the repeat billing this file exists to
// avoid. content_hash stays voice-specific so --revoice can add a second reading.
const { data: existing, error: cErr } = await db.from('audio_clips').select('text');
if (cErr) { console.error('Could not read audio_clips:', cErr.message); process.exit(1); }
const have = new Set((existing || []).map((r) => (r.text || '').trim()));

// Keep "already voiced" and "deferred by --limit" apart: collapsing them reports
// work that has not happened as work that has.
const pending = REVOICE ? wanted : wanted.filter((w) => !have.has(w.text));
const todo = pending.slice(0, LIMIT);

console.log(`${wanted.length} sentences of ${MIN_WORDS}-${MAX_WORDS} words · ${wanted.length - pending.length} already voiced · ${todo.length} to generate`);
if (pending.length > todo.length) console.log(`${pending.length - todo.length} more still need a clip — raise --limit to reach them`);
if (tooShort || tooLong) console.log(`skipped ${tooShort} under ${MIN_WORDS} words and ${tooLong} over ${MAX_WORDS}`);
console.log(FORCED_VOICE ? `voice "${FORCED_VOICE}"` : `voices: ${VOICE_POOL.map((v) => v.id).join(', ')}\n`);
if (!todo.length) { console.log('Nothing to do — every eligible sentence already has a clip.'); process.exit(0); }

// Spend so far this calendar month, inferred from the clips we made. It is our
// own tally, not Speechify's — anything voiced outside this script is invisible
// to it — but it is enough to stop a run walking into a hard cap mid-way.
const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
const { data: monthRows } = await db.from('audio_clips').select('text').gte('created_at', monthStart);
const spent = (monthRows || []).reduce((n, r) => n + (r.text || '').length, 0);
const planned = todo.reduce((n, t) => n + t.text.length, 0);
const left = FREE_CHAR_CAP - spent;

console.log(`\nbudget: ~${spent} of ${FREE_CHAR_CAP} characters used this month, ~${left} left`);
console.log(`this run would use ~${planned}`);
if (planned > left) {
  console.error(`\nStopping: that would exceed the cap by ~${planned - left} characters.`);
  console.error(`Lower --limit, or raise --cap if you are on a paid plan.`);
  process.exit(1);
}

if (DRY_RUN) {
  todo.forEach((t, i) => console.log(`  ${String(i + 1).padStart(3)}. [${String(t.words).padStart(2)}w ${t.voice.padEnd(12)}] ${t.text}`));
  console.log(`\nDry run — nothing sent. Would synthesise ${planned} characters.`);
  process.exit(0);
}

// ---- synthesise, upload, record ---------------------------------------------
// Sequential on purpose: a free plan's rate limit is easy to trip, and a failed
// call still bills characters.
let made = 0, billed = 0;
const failures = [];

for (const item of todo) {
  try {
    const out = await speechify('/audio/speech', {
      method: 'POST',
      body: JSON.stringify({ input: item.text, voice_id: item.voice, model: item.model, audio_format: 'mp3' }),
    });
    if (!out.audio_data) throw new Error('response carried no audio_data');

    const bytes = Buffer.from(out.audio_data, 'base64');
    const path = `${item.content_hash}.mp3`;

    const up = await db.storage.from(BUCKET).upload(path, bytes, { contentType: 'audio/mpeg', upsert: true });
    if (up.error) throw new Error('upload failed: ' + up.error.message);

    const ins = await db.from('audio_clips').upsert({
      exercise_id: item.exercise_id,
      text: item.text,
      voice_id: item.voice,
      model: item.model,
      format: 'mp3',
      storage_path: path,
      bytes: bytes.length,
      content_hash: item.content_hash,
    }, { onConflict: 'content_hash', ignoreDuplicates: true });
    if (ins.error) throw new Error('insert failed: ' + ins.error.message);

    made++;
    billed += out.billable_characters_count || item.text.length;
    console.log(`  ✓ ${(bytes.length / 1024).toFixed(0).padStart(3)} kB  ${item.voice.padEnd(12)} ${item.text.slice(0, 55)}`);
    await sleep(MIN_GAP_MS);   // free tier allows 1 request/second
  } catch (e) {
    failures.push({ text: item.text, why: e.message });
    console.warn(`  ✗ ${item.text.slice(0, 60)} — ${e.message}`);
    // A 429 or a quota error will hit every remaining item; stop rather than burn through them.
    if (/\b429\b|quota|limit/i.test(e.message)) {
      console.warn('\nStopping early — that looks like a rate or quota limit.');
      break;
    }
  }
}

const { count } = await db.from('audio_clips').select('*', { count: 'exact', head: true });
console.log(`\nDone. ${made} new clips (${billed} characters billed). ${failures.length} failed.`);
console.log(`Repository now holds ${count} clips.`);
if (failures.length) console.log('Re-run to retry the failures — clips already made are never regenerated.');
