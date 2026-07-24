// English Benz — add songs or albums to the lyrics exercise pool.
//
//   node add-song.mjs --artist "Pearl Jam" --title "Alive"
//   node add-song.mjs --artist "Pearl Jam" --title "Ten" --kind album
//   node add-song.mjs --artist "Oasis" --title "Wonderwall" --per-song 5
//
// Env vars (from .env): SUPABASE_URL, SUPABASE_SERVICE_KEY, MUSIXMATCH_KEY

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

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, MUSIXMATCH_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }
if (!MUSIXMATCH_KEY) { console.error('Missing MUSIXMATCH_KEY in scripts/.env'); process.exit(1); }

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const ARTIST   = flag('artist', '');
const TITLE    = flag('title', '');
const KIND     = flag('kind', 'song');      // song | album
const PER_SONG = Math.max(3, Math.min(parseInt(flag('per-song', '4'), 10) || 4, 8));

if (!ARTIST || !TITLE) {
  console.error('Usage: node add-song.mjs --artist "..." --title "..." [--kind album] [--per-song 4]');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const sleep  = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Musixmatch helpers ---------------------------------------------------

const MX_BASE = 'https://api.musixmatch.com/ws/1.1/';

async function mx(method, params) {
  const qs = new URLSearchParams({ apikey: MUSIXMATCH_KEY, ...params }).toString();
  const res = await fetch(`${MX_BASE}${method}?${qs}`);
  if (!res.ok) throw new Error(`Musixmatch HTTP ${res.status}`);
  const json = await res.json();
  const status = json?.message?.header?.status_code;
  if (status === 401) throw new Error('Musixmatch API key invalid (401)');
  if (status === 402) throw new Error('Musixmatch plan does not include this endpoint (402)');
  if (status !== 200) throw new Error(`Musixmatch status ${status}`);
  return json.message.body;
}

// ---- Timestamp helpers ---------------------------------------------------

function normalizeForMatch(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

async function fetchTimestampIndex(trackId, meta) {
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

// ---- Lyric processing (mirrors the Edge Function logic) ------------------

function splitLyricBody(body) {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l &&
      !l.startsWith('****') &&
      !/NOT for Commercial use/i.test(l) &&
      !/^\[/.test(l) &&
      !/This lyrics is not available/i.test(l) &&
      !/We detected that your/.test(l));
  const noticeIdx = lines.findIndex((l) => /^\*\*\*/.test(l));
  const notice = noticeIdx >= 0 ? lines.slice(noticeIdx).join(' ') : null;
  return { lines: noticeIdx >= 0 ? lines.slice(0, noticeIdx) : lines, notice };
}

function lyricWords(line) {
  return line.split(/\s+/).filter(Boolean).length;
}

function detectSections(lines) {
  const freq = new Map();
  for (const l of lines) freq.set(l, (freq.get(l) || 0) + 1);

  // Build runs of repeated vs non-repeated lines
  const runs = [];
  let cur = null;
  for (const l of lines) {
    const repeated = (freq.get(l) || 0) >= 2;
    if (!cur || cur.repeated !== repeated) { cur = { repeated, lines: [] }; runs.push(cur); }
    cur.lines.push(l);
  }

  const chorusRun = runs.filter((r) => r.repeated).sort((a, b) => b.lines.length - a.lines.length)[0];
  const verses    = runs.filter((r) => !r.repeated);

  return {
    chorus: chorusRun ? [...new Set(chorusRun.lines)] : [],
    verse1: verses[0]?.lines || [],
    verse2: verses.slice(1).flatMap((v) => v.lines),
  };
}

function pickFrom(pool, want, taken) {
  return pool
    .filter((l) => { const n = lyricWords(l); return n >= 5 && n <= 14 && !taken.has(l.toLowerCase()); })
    .sort((a, b) => lyricWords(b) - lyricWords(a))
    .slice(0, want);
}

function processTrack(track, allLines) {
  const sec    = detectSections(allLines);
  const taken  = new Set();
  const chosen = [];

  const plan = [
    { section: 'verse-1', want: 1 },
    { section: 'chorus',  want: 2 },
    { section: 'verse-2', want: Math.max(1, PER_SONG - 3) },
  ];

  for (const { section, want } of plan) {
    const pool = section === 'chorus' ? sec.chorus : (section === 'verse-1' ? sec.verse1 : sec.verse2);
    for (const line of pickFrom(pool, want, taken)) {
      taken.add(line.toLowerCase());
      const idx = allLines.indexOf(line);
      chosen.push({ line, section, context: idx > 0 ? allLines[idx - 1] : null });
    }
  }

  if (!chosen.length) {
    for (const line of pickFrom(allLines, PER_SONG, taken)) {
      taken.add(line.toLowerCase());
      const idx = allLines.indexOf(line);
      chosen.push({ line, section: 'line', context: idx > 0 ? allLines[idx - 1] : null });
    }
  }

  return chosen;
}

// ---- DB write ------------------------------------------------------------

async function upsertSong(track, notice) {
  const { data, error } = await db.from('songs').upsert({
    artist:              track.artist_name,
    title:               track.track_name,
    album:               track.album_name || null,
    year:                track.first_release_date ? parseInt(String(track.first_release_date).slice(0, 4), 10) || null : null,
    spotify_url:         track.track_spotify_id ? 'https://open.spotify.com/track/' + track.track_spotify_id : null,
    musixmatch_track_id: track.track_id,
    copyright_notice:    notice || null,
    license:             'musixmatch',
    active:              true,
  }, { onConflict: 'artist,title' }).select('id').single();
  if (error) throw new Error(error.message);
  return data.id;
}

async function upsertExercises(songId, track, chosen, notice, tsIndex) {
  const rows = chosen.map((c) => {
    const startMs = findTimestamp(tsIndex, c.line);
    return {
      type:    'lyrics',
      level:   '',
      source:  track.artist_name,
      song_id: songId,
      section: c.section,
      payload: {
        artist:    track.artist_name,
        title:     track.track_name,
        album:     track.album_name || '',
        spotify_url: track.track_spotify_id ? 'https://open.spotify.com/track/' + track.track_spotify_id : '',
        copyright: notice || '',
        section:   c.section,
        line:      c.line,
        context:   c.context || '',
        ...(startMs != null ? { start_ms: startMs } : {}),
      },
      content_hash: sha256('lyrics:' + track.artist_name + ':' + track.track_name + ':' + c.line),
    };
  });

  const { data, error } = await db.from('exercises')
    .upsert(rows, { onConflict: 'content_hash', ignoreDuplicates: true }).select('id');
  if (error) throw new Error(error.message);
  return data ? data.length : 0;
}

// ---- Main ----------------------------------------------------------------

async function addTrack(track) {
  const body = await mx('track.lyrics.get', { track_id: track.track_id });
  const lyricsBody = body?.lyrics?.lyrics_body;
  if (!lyricsBody) { console.log(`  ${track.track_name} — no lyrics`); return 0; }

  const { lines, notice } = splitLyricBody(lyricsBody);
  if (lines.length < 4) { console.log(`  ${track.track_name} — too short`); return 0; }

  const chosen = processTrack(track, lines);
  if (!chosen.length) { console.log(`  ${track.track_name} — nothing usable`); return 0; }

  const tsIndex  = await fetchTimestampIndex(track.track_id, { artist: track.artist_name, title: track.track_name, duration: track.track_length });
  const songId   = await upsertSong(track, notice);
  const inserted = await upsertExercises(songId, track, chosen, notice, tsIndex);
  console.log(`  ${track.artist_name} — ${track.track_name}: ${inserted} exercise${inserted === 1 ? '' : 's'} added`);
  return inserted;
}

async function run() {
  console.log(`\nAdding ${KIND === 'album' ? 'album' : 'song'}: ${ARTIST} — ${TITLE}\n`);

  if (KIND === 'song') {
    const body    = await mx('track.search', { q_artist: ARTIST, q_track: TITLE, page_size: 5, s_track_rating: 'desc' });
    const tracks  = body?.track_list?.map((t) => t.track) || [];
    const track   = tracks.find((t) => t.track_name.toLowerCase().includes(TITLE.toLowerCase())) || tracks[0];
    if (!track) { console.error('Song not found on Musixmatch.'); process.exit(1); }
    console.log(`Found: ${track.artist_name} — ${track.track_name} (id ${track.track_id})`);
    const n = await addTrack(track);
    console.log(`\nDone. ${n} exercise${n === 1 ? '' : 's'} stored.`);

  } else {
    const body   = await mx('track.search', { q_artist: ARTIST, q_album: TITLE, page_size: 20, s_track_rating: 'desc' });
    const tracks = (body?.track_list?.map((t) => t.track) || [])
      .filter((t) => t.album_name && t.album_name.toLowerCase().includes(TITLE.toLowerCase()));
    if (!tracks.length) { console.error('Album not found on Musixmatch.'); process.exit(1); }
    console.log(`Found ${tracks.length} tracks in "${TITLE}"\n`);
    let total = 0;
    for (const track of tracks) {
      total += await addTrack(track);
      await sleep(300);
    }
    console.log(`\nDone. ${total} exercise${total === 1 ? '' : 's'} stored across ${tracks.length} tracks.`);
  }
}

run().catch((e) => { console.error(e.message); process.exit(1); });
