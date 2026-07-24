// English Benz — admin content generator (Supabase Edge Function)
//
// Called by the in-app Admin panel. Verifies the caller is the admin, obtains
// source material, stores that material verbatim in `source_documents`, and then
// generates exercises from it. Keeps the Anthropic key server-side.
//
// Modes (POST body { mode: … }):
//   document  { text, filename? }  text already extracted in the browser (PDF)
//   url       { url }              this function fetches the page and strips the HTML
//   news      { }                  this function web-searches for recent articles
//   reuse     { document_id }      regenerate from material stored by an earlier run
//   list      { }                  list stored documents (no content, no generation)
//
// Everything generated points back at its source document, so any past upload can
// be mined again later without re-uploading it.
//
// Deploy:  supabase functions deploy generate-exercises
// Secret:  ANTHROPIC_API_KEY  (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ADMIN_EMAIL = 'benitozaccone@intuendi.com';
const MODEL = 'claude-sonnet-5';
const MAX_CHARS = 20000;          // per generation call; documents are stored in full

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const LEVEL_DESC: Record<string, string> = {
  B2: 'clear, moderately complex sentences using common but varied vocabulary and fairly straightforward clause structure',
  C1: 'more complex syntax, some idiomatic expressions, and less frequent vocabulary',
  C2: 'near-native complexity, nuanced or rare vocabulary, and sophisticated clause structure',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s.trim().toLowerCase()));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Anthropic helpers
// ---------------------------------------------------------------------------
async function anthropic(body: Record<string, unknown>, timeoutMs = 120000): Promise<any> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error('Anthropic HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
  return await res.json();
}

const textOf = (data: any) =>
  (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();

// Wrap an item schema as {"exercises":[...]} — structured outputs need an object root.
function envelope(itemProps: Record<string, unknown>, required: string[]) {
  return {
    type: 'object',
    properties: {
      exercises: {
        type: 'array',
        items: { type: 'object', properties: itemProps, required, additionalProperties: false },
      },
    },
    required: ['exercises'],
    additionalProperties: false,
  };
}

// Structured outputs guarantee schema-valid JSON, so no regex scraping / no parse errors.
async function claudeJson(system: string, userText: string, schema: unknown): Promise<any[]> {
  const data = await anthropic({
    model: MODEL,
    max_tokens: 8000,
    system,
    messages: [{ role: 'user', content: userText }],
    output_config: { format: { type: 'json_schema', schema } },
  });
  if (data.stop_reason === 'max_tokens') throw new Error('Response hit max_tokens — try a smaller count.');
  const parsed = JSON.parse(textOf(data));
  return Array.isArray(parsed.exercises) ? parsed.exercises : [];
}

const TR_SCHEMA = envelope({
  source: { type: 'string' },
  topic: { type: 'string' },
  english_sentence: { type: 'string' },
  correct_translation: { type: 'string' },
  distractor_1: { type: 'string' },
  distractor_2: { type: 'string' },
}, ['source', 'topic', 'english_sentence', 'correct_translation', 'distractor_1', 'distractor_2']);

const AUDIO_SCHEMA = envelope({
  source: { type: 'string' },
  topic: { type: 'string' },
  correct_sentence: { type: 'string' },
  decoy_1: { type: 'string' },
  decoy_2: { type: 'string' },
}, ['source', 'topic', 'correct_sentence', 'decoy_1', 'decoy_2']);

const PV_SCHEMA = envelope({
  verb: { type: 'string' },
  meaning: { type: 'string' },
  level: { type: 'string', enum: ['B1', 'B2', 'C1', 'C2'] },
  sentence: { type: 'string' },
  answer: { type: 'string' },
  suffix: { type: 'string', enum: ['', 's', 'es', 'ed', 'ing'] },
  source: { type: 'string' },
}, ['verb', 'meaning', 'level', 'sentence', 'answer', 'suffix', 'source']);

// ---------------------------------------------------------------------------
// Source material
// ---------------------------------------------------------------------------

// Crude but dependency-free HTML → text. Scripts, styles and tags go; the
// entities that matter for reading are decoded; runs of whitespace collapse.
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|h[1-6]|li|br|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

async function fetchUrlText(raw: string): Promise<{ text: string; title: string }> {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error('That does not look like a valid URL.'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported.');
  }

  const res = await fetch(parsed.toString(), {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; EnglishBenz/1.0)', accept: 'text/html,text/plain' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error('Could not fetch that page (HTTP ' + res.status + ').');

  const ctype = res.headers.get('content-type') || '';
  const body = await res.text();
  const text = ctype.includes('text/html') ? htmlToText(body) : body.trim();
  const m = body.match(/<title[^>]*>([\s\S]{1,200}?)<\/title>/i);
  const title = m ? htmlToText(m[1]).slice(0, 150) : parsed.hostname;
  if (text.length < 200) throw new Error('That page had almost no readable text (paywall, or rendered by JavaScript?).');
  return { text, title };
}

// A usable line is "<outlet> | <topic> | <sentence>". Counting these — rather
// than trusting that any text came back — is what stops prose such as "I could
// not retrieve the articles" being handed on as source material and turned into
// invented quotes attributed to real outlets.
const LINE_RE = /^[^|\n]{2,40}\|[^|\n]{2,30}\|.{10,}$/;
const usableLines = (t: string) => (t || '').split('\n').map((l) => l.trim()).filter((l) => LINE_RE.test(l));

async function searchNews(want: number): Promise<string> {
  const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }];
  // Search by TOPIC, not by outlet: asking for "stories by BBC News" returns
  // pages *about* the BBC — homepages, app listings, Wikipedia — not article text.
  const messages: any[] = [{
    role: 'user',
    content:
      'Search the web for significant news stories published in the last few days. ' +
      'Cover a spread of subjects: world affairs, economy, technology, environment, health, sport, culture, science.\n' +
      `Read the articles you find, then list ${want} short verbatim sentences taken from them, each under 15 words.\n` +
      'Format each line exactly as:  <outlet> | <topic word> | <sentence>\n' +
      'The outlet is whichever publication actually carried the sentence.\n' +
      'Use one lowercase topic word from: politics, economy, technology, environment, health, sport, culture, science, society.\n' +
      'Output only those lines. If you genuinely cannot read any article text, say exactly NO SENTENCES.',
  }];

  let first = '';
  for (let step = 0; step < 4; step++) {
    const data = await anthropic({ model: MODEL, max_tokens: 12000, messages, tools }, 300000);
    messages.push({ role: 'assistant', content: data.content });
    first = textOf(data);
    if (data.stop_reason === 'pause_turn') continue;
    break;
  }
  const firstLines = usableLines(first);
  if (firstLines.length >= Math.max(4, Math.ceil(want / 2))) return firstLines.join('\n');

  // The second turn needs a generous budget: thinking spends from the same
  // allowance, and a small max_tokens here returns a lone thinking block, no text.
  messages.push({
    role: 'user',
    content: `Now output only the ${want} lines in that format, using sentences from the articles you just read. ` +
      'No preamble. If you could not read any article text, say exactly NO SENTENCES.',
  });
  const data2 = await anthropic({ model: MODEL, max_tokens: 8000, messages }, 180000);
  const lines = [...new Set(usableLines(textOf(data2)).concat(firstLines))];
  if (!lines.length) throw new Error('The search returned no verbatim sentences. Nothing was invented — try again later.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Musixmatch — lyrics for the "Fill the lyrics" game
//
// The key lives here, in the function's secrets, and never reaches the browser:
// the app is a static page, so anything it holds is public, and this one is
// billed. Calls from the browser would also be blocked by CORS.
// ---------------------------------------------------------------------------
const MX_BASE = 'https://api.musixmatch.com/ws/1.1/';

async function mx(method: string, params: Record<string, string | number>): Promise<any> {
  const key = Deno.env.get('MUSIXMATCH_API_KEY');
  if (!key) throw new Error('MUSIXMATCH_API_KEY is not set on this function.');
  const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), apikey: key });
  const res = await fetch(MX_BASE + method + '?' + qs.toString(), { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Musixmatch HTTP ${res.status}`);
  const data = await res.json();
  const status = data?.message?.header?.status_code;
  // Musixmatch reports failure inside a 200 response, so the HTTP check above is
  // not enough. 402 is the one worth naming: it means the plan does not cover
  // what was asked for, which reads as an empty result otherwise.
  if (status === 401) throw new Error('Musixmatch rejected the API key (401).');
  if (status === 402) throw new Error('Your Musixmatch plan does not include this (402) — full lyrics need a licensed tier.');
  if (status === 404) return null;
  if (status !== 200) throw new Error(`Musixmatch status ${status}`);
  return data.message.body;
}

/* The lyric body carries a commercial-use notice and, on preview tiers, a
   truncation marker. Neither is lyrics: left in, they would become exercises and
   the notice — which must be displayed — would be treated as a line to fill in. */
function splitLyricBody(body: string): { lines: string[]; notice: string } {
  const noticeParts: string[] = [];
  const lines: string[] = [];
  for (let raw of String(body || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (/\*{3}|NOT for Commercial use|Restricted|^\.{3}$|^\(\d+\)$/i.test(line)) { noticeParts.push(line.replace(/\*/g, '').trim()); continue; }
    if (/^[\[(].*[\])]$/.test(line)) continue;          // [Chorus], (instrumental)
    lines.push(line);
  }
  return { lines, notice: noticeParts.join(' ').trim() };
}

/* Structure without a model call: a chorus is the part that repeats, which is
   also exactly why it is the part you remember. Lines occurring more than once
   are chorus lines; the runs of non-repeating lines around them are verses. */
function detectSections(lines: string[]): { chorus: string[]; verse1: string[]; verse2: string[] } {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]/g, '').replace(/\s+/g, ' ').trim();
  const freq = new Map<string, number>();
  for (const l of lines) freq.set(norm(l), (freq.get(norm(l)) || 0) + 1);

  const runs: { repeated: boolean; lines: string[] }[] = [];
  for (const l of lines) {
    const repeated = (freq.get(norm(l)) || 0) >= 2;
    if (!runs.length || runs[runs.length - 1].repeated !== repeated) runs.push({ repeated, lines: [] });
    runs[runs.length - 1].lines.push(l);
  }
  const chorus = runs.filter((r) => r.repeated).sort((a, b) => b.lines.length - a.lines.length)[0];
  const verses = runs.filter((r) => !r.repeated && r.lines.length >= 2);
  return {
    chorus: chorus ? chorus.lines : [],
    verse1: verses[0] ? verses[0].lines : [],
    verse2: verses[1] ? verses[1].lines : (verses[0] ? verses[0].lines.slice(2) : []),
  };
}

const lyricWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

/* Prefer the most substantial line in a section: longest wins, which favours a
   line with something in it over "oh yeah". */
function pickFrom(section: string[], want: number, taken: Set<string>): string[] {
  return section
    .filter((l) => { const n = lyricWords(l); return n >= 5 && n <= 14 && !taken.has(l.toLowerCase()); })
    .sort((a, b) => lyricWords(b) - lyricWords(a))
    .slice(0, want);
}

// One song: fetch, find its structure, return the rows to store.
async function lyricRowsForTrack(track: any, perSong: number) {
  const trackId = track.track_id;
  const body = await mx('track.lyrics.get', { track_id: trackId });
  const lyricsBody = body?.lyrics?.lyrics_body;
  if (!lyricsBody) return null;

  const { lines, notice } = splitLyricBody(lyricsBody);
  if (lines.length < 4) return null;

  const sec = detectSections(lines);
  const taken = new Set<string>();
  const chosen: { line: string; section: string }[] = [];
  // 1 opening verse, 2 chorus, the rest from a later verse — weighted to where
  // memory is strongest rather than spread evenly through the song.
  const plan: Array<{ section: string; want: number }> = [
    { section: 'verse-1', want: 1 },
    { section: 'chorus', want: 2 },
    { section: 'verse-2', want: Math.max(1, perSong - 3) },
  ];
  for (const { section, want } of plan) {
    const pool = section === 'chorus' ? sec.chorus : (section === 'verse-1' ? sec.verse1 : sec.verse2);
    for (const line of pickFrom(pool, want, taken)) {
      taken.add(line.toLowerCase());
      chosen.push({ line, section });
    }
  }
  // A song with no detectable structure still yields exercises.
  if (!chosen.length) {
    for (const line of pickFrom(lines, perSong, taken)) { taken.add(line.toLowerCase()); chosen.push({ line, section: 'line' }); }
  }
  if (!chosen.length) return null;

  return {
    artist: track.artist_name,
    title: track.track_name,
    album: track.album_name || null,
    year: track.first_release_date ? parseInt(String(track.first_release_date).slice(0, 4), 10) || null : null,
    spotify_url: track.track_spotify_id ? 'https://open.spotify.com/track/' + track.track_spotify_id : null,
    musixmatch_track_id: trackId,
    copyright_notice: notice || null,
    chosen,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    // Verify the caller is the admin.
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: ures, error: uerr } = await admin.auth.getUser(token);
    if (uerr || !ures?.user || ures.user.email !== ADMIN_EMAIL) {
      return json({ error: 'Not authorized.' }, 403);
    }
    const userId = ures.user.id;

    const body = await req.json().catch(() => ({}));
    const mode = String(body.mode || 'document');
    const count = Math.max(1, Math.min(parseInt(body.count, 10) || 6, 15));

    // ---- list stored documents (no generation) ----------------------------
    if (mode === 'list') {
      const { data, error } = await admin
        .from('source_documents')
        .select('id,kind,title,origin,char_count,created_at')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return json({ documents: data || [] });
    }

    // ---- add songs from Musixmatch ----------------------------------------
    if (mode === 'song' || mode === 'album') {
      const artist = String(body.artist || '').trim();
      const wanted = String(body.title || body.album || '').trim();
      const perSong = Math.max(3, Math.min(parseInt(body.per_song, 10) || 4, 6));
      if (!artist || !wanted) return json({ error: 'Give both an artist and a song or album.' }, 400);

      let tracks: any[] = [];
      if (mode === 'song') {
        const found = await mx('track.search', { q_artist: artist, q_track: wanted, page_size: 3, s_track_rating: 'desc' });
        tracks = (found?.track_list || []).map((t: any) => t.track);
      } else {
        // q_album is passed in case the plan honours it, but the result is also
        // filtered by album name: if the parameter is ignored the search quietly
        // returns the artist's top tracks instead, which is not the album asked for.
        const found = await mx('track.search', { q_artist: artist, q_album: wanted, page_size: 100, s_track_rating: 'desc' });
        const all = (found?.track_list || []).map((t: any) => t.track);
        const want = wanted.toLowerCase();
        const onAlbum = all.filter((t: any) => String(t.album_name || '').toLowerCase().includes(want));
        tracks = onAlbum.length ? onAlbum : [];
        if (!tracks.length) {
          return json({ error: `Found no tracks on an album matching "${wanted}" for ${artist}. Check the album name.` }, 404);
        }
      }
      if (!tracks.length) return json({ error: `Nothing found for "${wanted}" by ${artist}.` }, 404);

      let songsAdded = 0, linesAdded = 0;
      const errors: string[] = [];

      for (const track of tracks.slice(0, mode === 'album' ? 30 : 1)) {
        try {
          const row = await lyricRowsForTrack(track, perSong);
          if (!row) { errors.push(`${track.track_name}: no usable lines`); continue; }

          const { data: song, error: sErr } = await admin
            .from('songs')
            .upsert({
              artist: row.artist, title: row.title, album: row.album, year: row.year,
              license: 'musixmatch', spotify_url: row.spotify_url,
              musixmatch_track_id: row.musixmatch_track_id, copyright_notice: row.copyright_notice,
            }, { onConflict: 'artist,title' })
            .select('id').single();
          if (sErr) { errors.push(`${track.track_name}: ${sErr.message}`); continue; }

          // sha256 is async, so the rows have to be awaited together rather than
          // built inside a plain map — `await` in a non-async callback does not compile.
          const rows = await Promise.all(row.chosen.map(async (c) => ({
            type: 'lyrics', level: '', source: row.artist, song_id: song.id, section: c.section,
            payload: {
              artist: row.artist, title: row.title, album: row.album || '',
              spotify_url: row.spotify_url || '', copyright: row.copyright_notice || '',
              section: c.section, line: c.line,
            },
            content_hash: await sha256('lyrics:' + row.artist + ':' + row.title + ':' + c.line),
          })));

          const { data: ins, error: eErr } = await admin
            .from('exercises').upsert(rows, { onConflict: 'content_hash', ignoreDuplicates: true }).select('id');
          if (eErr) { errors.push(`${track.track_name}: ${eErr.message}`); continue; }
          songsAdded++;
          linesAdded += ins ? ins.length : 0;
        } catch (e) {
          errors.push(`${track.track_name}: ${String((e as Error).message || e)}`);
          // A key or plan failure hits every remaining track the same way.
          if (/API key|plan does not include/i.test(String((e as Error).message))) break;
        }
      }

      return json({ songs: songsAdded, lyric_lines: linesAdded, tracks_seen: tracks.length, errors });
    }

    // ---- obtain the source material ---------------------------------------
    let docText = '';
    let kind = 'text';
    let title = '';
    let origin = '';
    let documentId: string | null = null;

    if (mode === 'reuse') {
      const id = String(body.document_id || '');
      if (!id) return json({ error: 'No document chosen.' }, 400);
      const { data, error } = await admin
        .from('source_documents').select('id,content,kind,title,origin').eq('id', id).maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: 'That document no longer exists.' }, 404);
      docText = data.content; kind = data.kind; title = data.title; origin = data.origin;
      documentId = data.id;
    } else if (mode === 'url') {
      const fetched = await fetchUrlText(String(body.url || ''));
      docText = fetched.text; kind = 'url'; title = fetched.title; origin = String(body.url);
    } else if (mode === 'news') {
      docText = await searchNews(count * 3);
      kind = 'news';
      title = 'News sentences · ' + docText.split('\n').length + ' lines';
      origin = 'web_search';
    } else {
      docText = String(body.text || '');
      kind = body.filename ? 'pdf' : 'text';
      title = String(body.filename || 'Pasted text');
      origin = String(body.filename || '');
    }
    if (!docText.trim()) return json({ error: 'No source text to work from.' }, 400);

    // ---- store the raw material BEFORE generating anything from it --------
    if (!documentId) {
      const h = await sha256(docText);
      const { data: ins, error: insErr } = await admin
        .from('source_documents')
        .upsert({
          kind, title, origin, content: docText, content_hash: h,
          char_count: docText.length, created_by: userId, meta: { mode },
        }, { onConflict: 'content_hash', ignoreDuplicates: true })
        .select('id');
      if (insErr) throw insErr;
      if (ins && ins.length) documentId = ins[0].id;
      else {
        const { data: found } = await admin.from('source_documents').select('id').eq('content_hash', h).maybeSingle();
        documentId = found ? found.id : null;
      }
    }

    // A book runs to hundreds of thousands of characters. Always taking the first
    // window would mean every run mined chapter one and produced the same
    // exercises; take a random window instead, snapped forward to a sentence
    // boundary so the passage does not open mid-word.
    const material = (() => {
      if (docText.length <= MAX_CHARS) return docText;
      const start = Math.floor(Math.random() * (docText.length - MAX_CHARS));
      const dot = docText.indexOf('. ', start);
      const from = (dot >= 0 && dot < start + 500) ? dot + 2 : start;
      return docText.slice(from, from + MAX_CHARS);
    })();
    const rows: any[] = [];
    const errors: string[] = [];

    // ---- translation, one call per CEFR level ------------------------------
    for (const level of ['B2', 'C1', 'C2']) {
      const system =
        `You create English-learning exercises for an Italian speaker at CEFR level ${level}, grounded in the MATERIAL the user provides.\n` +
        `Create up to ${count} exercises. For each, choose ONE short sentence — verbatim from the material where possible — under 15 words, ` +
        `matching level ${level} complexity (${LEVEL_DESC[level]}).\n` +
        `Set "source" to the outlet or document the sentence came from, "topic" to one short lowercase word, ` +
        `"correct_translation" to an accurate natural Italian translation, and the two distractors to plausible but clearly incorrect Italian translations.\n` +
        `Never invent a sentence that the material does not support.`;
      try {
        const items = await claudeJson(system, 'MATERIAL:\n' + material, TR_SCHEMA);
        for (const x of items) {
          if (x && x.english_sentence && x.correct_translation) {
            rows.push({
              type: 'translation', level, topic: x.topic || null, source: x.source || title || 'Document',
              payload: x, source_document_id: documentId,
              content_hash: await sha256('tr:' + level + ':' + x.english_sentence),
            });
          }
        }
      } catch (e) { errors.push('translation ' + level + ': ' + String((e as Error).message || e)); }
    }

    // ---- listening ---------------------------------------------------------
    try {
      const system =
        `You create listening-comprehension exercises for an English learner (B2-C1), grounded in the MATERIAL the user provides.\n` +
        `Create up to ${count} exercises. For each, choose ONE short sentence — verbatim from the material where possible — under 12 words, ` +
        `plus two near-identical decoys, each with exactly one word changed.\n` +
        `Set "source" to the outlet or document it came from and "topic" to one short lowercase word.`;
      const items = await claudeJson(system, 'MATERIAL:\n' + material, AUDIO_SCHEMA);
      for (const x of items) {
        if (x && x.correct_sentence && x.decoy_1 && x.decoy_2) {
          rows.push({
            type: 'audio', level: '', topic: x.topic || null, source: x.source || title || 'Document',
            payload: x, source_document_id: documentId,
            content_hash: await sha256('audio:' + x.correct_sentence),
          });
        }
      }
    } catch (e) { errors.push('audio: ' + String((e as Error).message || e)); }

    let inserted = 0;
    if (rows.length) {
      const { data, error } = await admin
        .from('exercises')
        .upsert(rows, { onConflict: 'content_hash', ignoreDuplicates: true })
        .select('id');
      if (error) throw error;
      inserted = data ? data.length : 0;
    }

    // ---- phrasal verbs -----------------------------------------------------
    // A verb the database already knows simply gains a real usage example; only a
    // genuinely new verb is inserted, tagged 'news' so it can be played on its own.
    let newVerbs = 0, newExamples = 0;
    try {
      const system =
        'You find phrasal verbs in real sentences and turn them into cloze exercises.\n' +
        `From the MATERIAL the user provides, pick up to ${count} sentences containing a genuine phrasal verb ` +
        '(a verb plus a particle whose combined meaning is not simply the sum of its parts).\n' +
        'For each: "verb" the base form lowercase; "meaning" one plain explanation written for a learner; ' +
        '"level" its CEFR difficulty; "sentence" the ORIGINAL sentence verbatim with the phrasal verb replaced by the literal text ___BLANK___; ' +
        '"answer" exactly the words removed, in the form they appeared; ' +
        '"suffix" how the answer is inflected ("" base, "s"/"es" third person, "ed" past, "ing" continuous); ' +
        '"source" the outlet or document it came from.\n' +
        'Skip a sentence rather than inventing a phrasal verb, and never alter the sentence beyond the replacement.';
      const items = (await claudeJson(system, 'MATERIAL:\n' + material, PV_SCHEMA))
        .filter((x: any) => x && x.verb && x.meaning && x.answer && x.sentence && x.sentence.includes('___BLANK___'));

      if (items.length) {
        const verbRows = items.map((x: any) => ({
          verb: String(x.verb).trim().toLowerCase(),
          meaning: x.meaning,
          level: x.level || 'B2',
          categories: ['news'],
          source: x.source || title || 'Document',
        }));
        const { data: vNew, error: vErr } = await admin
          .from('phrasal_verbs')
          .upsert(verbRows, { onConflict: 'verb', ignoreDuplicates: true })
          .select('id');
        if (vErr) throw vErr;
        newVerbs = vNew ? vNew.length : 0;

        const names = [...new Set(verbRows.map((r: any) => r.verb))];
        const { data: known, error: kErr } = await admin.from('phrasal_verbs').select('id,verb').in('verb', names);
        if (kErr) throw kErr;
        const ids = new Map((known || []).map((r: any) => [r.verb, r.id]));

        const exRows: any[] = [];
        for (const x of items) {
          const v = String(x.verb).trim().toLowerCase();
          if (!ids.has(v)) continue;
          exRows.push({
            phrasal_verb_id: ids.get(v), sentence: x.sentence, answer: x.answer,
            suffix: x.suffix || '', source: x.source || title || 'Document',
            source_document_id: documentId,
            content_hash: await sha256('pv:' + v + ':' + x.sentence),
          });
        }
        const { data: exNew, error: eErr } = await admin
          .from('phrasal_verb_examples')
          .upsert(exRows, { onConflict: 'content_hash', ignoreDuplicates: true })
          .select('id');
        if (eErr) throw eErr;
        newExamples = exNew ? exNew.length : 0;
      }
    } catch (e) { errors.push('phrasal verbs: ' + String((e as Error).message || e)); }

    return json({
      inserted, generated: rows.length,
      phrasal_verbs: newVerbs, phrasal_verb_examples: newExamples,
      document_id: documentId, document_title: title, chars: docText.length,
      errors,
    });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
