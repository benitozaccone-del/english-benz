// English Benz — batch-add songs from a markdown table.
//
//   node add-songs-batch.mjs --file /path/to/songs.txt
//   node add-songs-batch.mjs --file songs.txt --per-song 4 --delay 800
//
// File format (| artist | song | table, any header, blank lines ignored):
//   | Pearl Jam | Alive |
//   | Sting     | Fields of Gold |
//
// Already-present songs are skipped (content_hash upsert is idempotent).
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY, MUSIXMATCH_KEY (from .env)

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
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
if (!MUSIXMATCH_KEY) { console.error('Missing MUSIXMATCH_KEY in scripts/.env'); process.exit(1); }

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const FILE     = flag('file', '');
const PER_SONG = Math.max(3, Math.min(parseInt(flag('per-song', '4'), 10) || 4, 8));
const DELAY    = Math.max(400, parseInt(flag('delay', '700'), 10) || 700);

if (!FILE) { console.error('Usage: node add-songs-batch.mjs --file /path/to/songs.txt'); process.exit(1); }

// Parse markdown table rows -> [{artist, title}], deduped
function parseTable(text) {
  const seen = new Set();
  const rows = [];
  for (const line of text.split('\n')) {
    const cols = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cols.length < 2) continue;
    if (/^[-:]+$/.test(cols[0])) continue;          // separator row
    if (/artist/i.test(cols[0]) && /song/i.test(cols[1])) continue; // header
    const artist = cols[0], title = cols[1];
    if (!artist || !title) continue;
    const key = artist.toLowerCase() + '|' + title.toLowerCase();
    if (!seen.has(key)) { seen.add(key); rows.push({ artist, title }); }
  }
  return rows;
}

const rows = parseTable(readFileSync(resolve(FILE), 'utf8'));
if (!rows.length) { console.error('No songs found in the file.'); process.exit(1); }
console.log(`\n${rows.length} unique songs to process (${PER_SONG} exercises each, ${DELAY}ms between calls)\n`);

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const sha256 = s => createHash('sha256').update(s).digest('hex');
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const MX_BASE = 'https://api.musixmatch.com/ws/1.1/';

async function mx(method, params) {
  const qs = new URLSearchParams({ apikey: MUSIXMATCH_KEY, ...params }).toString();
  const res = await fetch(`${MX_BASE}${method}?${qs}`);
  if (!res.ok) throw new Error(`Musixmatch HTTP ${res.status}`);
  const j = await res.json();
  const status = j?.message?.header?.status_code;
  if (status === 401) throw new Error('Musixmatch API key invalid');
  if (status === 402) throw new Error('Musixmatch plan limit (402)');
  if (status !== 200) throw new Error(`Musixmatch status ${status}`);
  return j.message.body;
}

function normalizeForMatch(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

async function fetchTimestampIndex(trackId, meta) {
  // richsync: word-level timestamps (commercial endpoint — 402 on free plan is fine)
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
  } catch (e) { /* fall through */ }
  // subtitle: line-level LRC timestamps (available on lower tiers)
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
  } catch (e) { /* no timestamps available */ }
  // LRClib: free community LRC database, no key required
  if (meta && meta.artist && meta.title) {
    try {
      const params = new URLSearchParams({ artist_name: meta.artist, track_name: meta.title });
      if (meta.duration) params.set('duration', String(Math.round(meta.duration)));
      const res = await fetch('https://lrclib.net/api/get?' + params);
      if (res.ok) {
        const j = await res.json();
        const raw = j.syncedLyrics;
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
      }
    } catch (e) { /* LRClib unavailable */ }
  }
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

function splitLyricBody(body) {
  const lines = body.split('\n').map(l => l.trim()).filter(l => l &&
    !l.startsWith('****') && !/NOT for Commercial use/i.test(l) &&
    !/^\[/.test(l) && !/This lyrics is not available/i.test(l) &&
    !/We detected that your/.test(l));
  const ni = lines.findIndex(l => /^\*\*\*/.test(l));
  return { lines: ni >= 0 ? lines.slice(0, ni) : lines, notice: ni >= 0 ? lines.slice(ni).join(' ') : null };
}

const lyricWords = l => l.split(/\s+/).filter(Boolean).length;

function detectSections(lines) {
  const freq = new Map();
  for (const l of lines) freq.set(l, (freq.get(l) || 0) + 1);
  const runs = []; let cur = null;
  for (const l of lines) {
    const rep = (freq.get(l) || 0) >= 2;
    if (!cur || cur.rep !== rep) { cur = { rep, lines: [] }; runs.push(cur); }
    cur.lines.push(l);
  }
  const ch = runs.filter(r => r.rep).sort((a, b) => b.lines.length - a.lines.length)[0];
  const vs = runs.filter(r => !r.rep);
  return { chorus: ch ? [...new Set(ch.lines)] : [], verse1: vs[0]?.lines || [], verse2: vs.slice(1).flatMap(v => v.lines) };
}

function pickFrom(pool, want, taken) {
  return pool.filter(l => { const n = lyricWords(l); return n >= 5 && n <= 14 && !taken.has(l.toLowerCase()); })
    .sort((a, b) => lyricWords(b) - lyricWords(a)).slice(0, want);
}

function processTrack(lines) {
  const sec = detectSections(lines); const taken = new Set(); const chosen = [];
  const plan = [{ section: 'verse-1', want: 1 }, { section: 'chorus', want: 2 }, { section: 'verse-2', want: Math.max(1, PER_SONG - 3) }];
  for (const { section, want } of plan) {
    const pool = section === 'chorus' ? sec.chorus : (section === 'verse-1' ? sec.verse1 : sec.verse2);
    for (const line of pickFrom(pool, want, taken)) {
      taken.add(line.toLowerCase());
      const idx = lines.indexOf(line);
      chosen.push({ line, section, context: idx > 0 ? lines[idx - 1] : null });
    }
  }
  if (!chosen.length) {
    for (const line of pickFrom(lines, PER_SONG, taken)) {
      taken.add(line.toLowerCase());
      const idx = lines.indexOf(line);
      chosen.push({ line, section: 'line', context: idx > 0 ? lines[idx - 1] : null });
    }
  }
  return chosen;
}

async function addSong({ artist, title }) {
  const body = await mx('track.search', { q_artist: artist, q_track: title, page_size: 5, s_track_rating: 'desc' });
  const tracks = body?.track_list?.map(t => t.track) || [];
  const track = tracks.find(t => t.track_name.toLowerCase().includes(title.toLowerCase())) || tracks[0];
  if (!track) return { skipped: 'not found on Musixmatch' };

  const lb = await mx('track.lyrics.get', { track_id: track.track_id });
  const lyricsBody = lb?.lyrics?.lyrics_body;
  if (!lyricsBody) return { skipped: 'no lyrics' };

  const { lines, notice } = splitLyricBody(lyricsBody);
  if (lines.length < 4) return { skipped: 'too short' };

  const chosen = processTrack(lines);
  if (!chosen.length) return { skipped: 'nothing usable' };

  const tsIndex = await fetchTimestampIndex(track.track_id, { artist: track.artist_name, title: track.track_name, duration: track.track_length });

  const { data: song, error: sErr } = await db.from('songs').upsert({
    artist: track.artist_name, title: track.track_name,
    album: track.album_name || null,
    year: track.first_release_date ? parseInt(String(track.first_release_date).slice(0, 4), 10) || null : null,
    spotify_url: track.track_spotify_id ? 'https://open.spotify.com/track/' + track.track_spotify_id : null,
    musixmatch_track_id: track.track_id, copyright_notice: notice || null,
    license: 'musixmatch', active: true,
  }, { onConflict: 'artist,title' }).select('id').single();
  if (sErr) throw new Error(sErr.message);

  const exerciseRows = chosen.map(c => {
    const startMs = findTimestamp(tsIndex, c.line);
    return {
      type: 'lyrics', level: '', source: track.artist_name, song_id: song.id, section: c.section,
      payload: { artist: track.artist_name, title: track.track_name, album: track.album_name || '',
        spotify_url: track.track_spotify_id ? 'https://open.spotify.com/track/' + track.track_spotify_id : '',
        copyright: notice || '', section: c.section, line: c.line, context: c.context || '',
        ...(startMs != null ? { start_ms: startMs } : {}) },
      content_hash: sha256('lyrics:' + track.artist_name + ':' + track.track_name + ':' + c.line),
    };
  });

  const { data: ins, error: eErr } = await db.from('exercises')
    .upsert(exerciseRows, { onConflict: 'content_hash', ignoreDuplicates: true }).select('id');
  if (eErr) throw new Error(eErr.message);
  return { added: ins ? ins.length : 0 };
}

let added = 0, skipped = 0, failed = 0;
for (let i = 0; i < rows.length; i++) {
  const { artist, title } = rows[i];
  process.stdout.write(`[${i + 1}/${rows.length}] ${artist} — ${title} … `);
  try {
    const r = await addSong({ artist, title });
    if (r.skipped) { console.log(`skipped (${r.skipped})`); skipped++; }
    else { console.log(`${r.added} exercises`); added += r.added; }
  } catch (e) {
    console.log(`ERROR: ${e.message}`); failed++;
    if (/API key|plan limit/i.test(e.message)) { console.error('Stopping — API key or plan issue.'); break; }
  }
  if (i < rows.length - 1) await sleep(DELAY);
}

console.log(`\nDone. ${added} exercises added, ${skipped} skipped, ${failed} failed.`);
