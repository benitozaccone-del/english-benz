-- English Benz — Supabase schema
-- Paste this whole file into the Supabase SQL editor (Dashboard → SQL → New query → Run).
-- Safe to re-run: every object uses "if not exists" / "or replace".
--
-- Data model
--   source_documents      raw plain text of everything ingested (PDF, URL, news, media),
--                         kept so new exercises can be generated from it later
--   exercises             shared, read-mostly content repository (grown by the pipeline)
--   phrasal_verbs         one row per verb: meaning, CEFR level, category membership
--   phrasal_verb_examples cloze sentences for a verb; grows as news supplies new usage
--   user_stats            per-user score + per-topic tallies, one row per (user, type, level)
--   presentations         per-user × per-exercise "times seen" + correct/wrong counters
--   activity_events       append-only log powering the Statistics view
--
-- "level" is '' (empty string, not NULL) for single-level content (audio) so it can
-- sit in a primary key. Translation uses 'B2' / 'C1' / 'C2'.

-- ---------------------------------------------------------------------------
-- Ingested source material
--
-- Every generation run stores the plain text it worked from. That makes a run
-- repeatable (generate more exercises from the same PDF months later without
-- re-uploading it) and gives every generated row a traceable origin.
-- Raw text can be sensitive, so there is deliberately NO read policy for
-- ordinary users: only the service role (the pipeline and the Edge Function)
-- can see the contents.
-- ---------------------------------------------------------------------------
create table if not exists public.source_documents (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('pdf', 'book', 'url', 'news', 'media', 'text')),
  title         text,                                 -- human label shown in the admin list
  origin        text,                                 -- filename, URL, or search description
  content       text not null,                        -- the extracted plain text
  content_hash  text not null unique,                 -- sha256 of the text; re-uploads dedupe
  char_count    integer not null default 0,
  meta          jsonb not null default '{}'::jsonb,   -- page count, outlets, mime type…
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists source_documents_kind_idx
  on public.source_documents (kind, created_at desc);

-- ---------------------------------------------------------------------------
-- Content repository
-- ---------------------------------------------------------------------------
create table if not exists public.exercises (
  id            uuid primary key default gen_random_uuid(),
  type          text not null check (type in ('translation', 'audio', 'lyrics')),
  level         text not null default '',            -- 'B2' | 'C1' | 'C2' | '' (audio)
  topic         text,
  source        text,
  payload       jsonb not null,                       -- exercise content, in the app's shape
  content_hash  text not null unique,                 -- dedupe key (sha256 of the source sentence)
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create index if not exists exercises_type_level_idx
  on public.exercises (type, level) where active;

-- Provenance. Added after the first release, hence "if not exists".
alter table public.exercises
  add column if not exists source_document_id uuid references public.source_documents (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Songs
--
-- The "Fill the lyrics" game needs the artist, title and album on screen: the
-- prompt IS the memory cue, so a line without its song is unanswerable. Songs
-- are their own table rather than fields repeated on every line, because one
-- song yields many lines and its metadata is written once.
--
-- "license" records how each song may be used — 'public-domain', 'cc-by',
-- 'licensed', 'own'. Lyrics are whole works rather than excerpts, so knowing the
-- provenance of a row matters more here than anywhere else in the schema.
--
-- "spotify_url" is optional; the app falls back to a search link built from the
-- artist and title, so the listen link works for songs that were never tagged.
-- ---------------------------------------------------------------------------
create table if not exists public.songs (
  id                 uuid primary key default gen_random_uuid(),
  artist             text not null,
  title              text not null,
  album              text,
  year               integer,
  license            text not null default 'unspecified',
  spotify_url        text,
  source_document_id uuid references public.source_documents (id) on delete set null,
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  unique (artist, title)
);

create index if not exists songs_artist_idx on public.songs (artist) where active;

-- Lyric lines live in `exercises` (type 'lyrics') so the game inherits
-- least-seen-first scheduling, the failure-weighted reordering, the retry list
-- and per-user progress without a line of new logic.
alter table public.exercises
  add column if not exists song_id uuid references public.songs (id) on delete cascade;

create index if not exists exercises_song_idx on public.exercises (song_id);

-- Which part of the song a lyric line came from. Recorded rather than implied so
-- the card can say "chorus" — which is a real hint, since the chorus is the part
-- you are most likely to remember.
alter table public.exercises
  add column if not exists section text;

-- The notice Musixmatch requires to be shown with its lyrics, kept per song.
alter table public.songs
  add column if not exists copyright_notice text;
alter table public.songs
  add column if not exists musixmatch_track_id bigint;

-- The type list above only takes effect on a fresh database: "create table if not
-- exists" skips an existing table, constraint and all. Replace it explicitly so
-- re-running this file actually widens the allowed types.
alter table public.exercises drop constraint if exists exercises_type_check;
alter table public.exercises
  add constraint exercises_type_check check (type in ('translation', 'audio', 'lyrics'));

-- ---------------------------------------------------------------------------
-- Phrasal verbs
--
-- Two tables rather than one because the two halves grow at different rates:
-- a verb's meaning and level are written once, while usage examples accumulate
-- every time the news pipeline finds the verb in a real sentence.
--
-- "categories" is the multivalued membership column: {'top100','top200'} for a
-- core verb, {'top200'} for the wider set, {'news'} for verbs discovered in
-- real articles. The top-200 list is a superset of the top-100 one, so core
-- verbs carry BOTH tags — that way a category filter is a single array test
-- rather than a union of tiers.
-- ---------------------------------------------------------------------------
create table if not exists public.phrasal_verbs (
  id          uuid primary key default gen_random_uuid(),
  verb        text not null unique,                   -- "come across" (lowercase, base form)
  meaning     text not null,
  level       text not null default 'B2' check (level in ('B1', 'B2', 'C1', 'C2')),
  categories  text[] not null default '{}',           -- 'top100' | 'top200' | 'news'
  source      text,                                   -- where the verb entry came from
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists phrasal_verbs_categories_idx
  on public.phrasal_verbs using gin (categories);
create index if not exists phrasal_verbs_level_idx
  on public.phrasal_verbs (level) where active;

create table if not exists public.phrasal_verb_examples (
  id                 uuid primary key default gen_random_uuid(),
  phrasal_verb_id    uuid not null references public.phrasal_verbs (id) on delete cascade,
  sentence           text not null,                   -- contains the ___BLANK___ placeholder
  answer             text not null,                   -- the inflected form that fills the blank
  suffix             text not null default '',        -- '' | 's' | 'es' | 'ed' | 'ing'
  source             text,                            -- 'Course book' | 'BBC News' | …
  source_document_id uuid references public.source_documents (id) on delete set null,
  content_hash       text not null unique,
  active             boolean not null default true,
  created_at         timestamptz not null default now()
);

create index if not exists phrasal_verb_examples_verb_idx
  on public.phrasal_verb_examples (phrasal_verb_id) where active;

-- ---------------------------------------------------------------------------
-- Audio clips
--
-- Text-to-speech is billed per character, so a sentence is synthesised ONCE and
-- the mp3 is kept forever. content_hash covers text + voice + model: change the
-- voice and you get a new clip, re-run the generator and you pay nothing.
--
-- The bytes live in Supabase Storage (bucket "clips"), not in a column. Postgres
-- on the free tier is 500 MB and base64 in a row inflates every read; object
-- storage serves the file directly to an <audio> element. This table is the
-- queryable index over that bucket.
-- ---------------------------------------------------------------------------
create table if not exists public.audio_clips (
  id            uuid primary key default gen_random_uuid(),
  exercise_id   uuid references public.exercises (id) on delete cascade,
  text          text not null,                        -- exactly what was spoken
  voice_id      text not null,
  model         text not null default 'simba-english',
  format        text not null default 'mp3',
  storage_path  text not null,                        -- path inside the bucket
  bytes         integer not null default 0,
  duration_ms   integer,
  content_hash  text not null unique,                 -- sha256(text|voice|model)
  created_at    timestamptz not null default now()
);

create index if not exists audio_clips_exercise_idx
  on public.audio_clips (exercise_id);

-- ---------------------------------------------------------------------------
-- Per-user progress
-- ---------------------------------------------------------------------------
create table if not exists public.user_stats (
  user_id     uuid not null references auth.users (id) on delete cascade,
  type        text not null,                          -- 'pv' | 'translation' | 'audio'
  level       text not null default '',
  correct     integer not null default 0,
  wrong       integer not null default 0,
  topics      jsonb not null default '{}'::jsonb,     -- { topic: { correct, wrong } }
  updated_at  timestamptz not null default now(),
  primary key (user_id, type, level)
);

create table if not exists public.presentations (
  user_id        uuid not null references auth.users (id) on delete cascade,
  exercise_id    uuid not null references public.exercises (id) on delete cascade,
  times_seen     integer not null default 0,
  correct_count  integer not null default 0,
  wrong_count    integer not null default 0,
  last_seen      timestamptz,
  primary key (user_id, exercise_id)
);

create table if not exists public.activity_events (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  game        text not null,                          -- 'pv' | 'translation' | 'audio'
  ok          boolean not null,
  created_at  timestamptz not null default now()
);

create index if not exists activity_events_user_idx
  on public.activity_events (user_id, created_at desc);

-- Generic per-user key-value store. Backs the app's score/topic/activity/queue
-- blobs so the existing game logic syncs across devices without change.
create table if not exists public.kv (
  user_id     uuid not null references auth.users (id) on delete cascade,
  key         text not null,
  value       jsonb,
  updated_at  timestamptz not null default now(),
  primary key (user_id, key)
);

-- ---------------------------------------------------------------------------
-- Row-level security
--   exercises        : any signed-in user may read; only the service role writes
--                      (the content pipeline uses the service key, which bypasses RLS)
--   phrasal_verbs    : same — shared learning content, readable by everyone
--   source_documents : NO user policy at all. RLS is on with no select policy, so
--                      raw ingested text is reachable only by the service role.
--   everything else  : a user sees and edits only their own rows
-- ---------------------------------------------------------------------------
alter table public.source_documents      enable row level security;
alter table public.phrasal_verbs         enable row level security;
alter table public.phrasal_verb_examples enable row level security;
alter table public.audio_clips           enable row level security;

drop policy if exists audio_clips_read on public.audio_clips;
create policy audio_clips_read on public.audio_clips
  for select to authenticated using (true);

alter table public.songs enable row level security;
drop policy if exists songs_read on public.songs;
create policy songs_read on public.songs
  for select to authenticated using (true);

-- The mp3s themselves live in the "clips" storage bucket, which is PRIVATE.
-- Some clips are read from copyrighted books, and a public bucket would put
-- narrated book sentences on an open, unauthenticated URL. Signed-in users can
-- mint short-lived signed URLs instead; this policy is what allows that.
drop policy if exists clips_read_authenticated on storage.objects;
create policy clips_read_authenticated on storage.objects
  for select to authenticated using (bucket_id = 'clips');

drop policy if exists phrasal_verbs_read on public.phrasal_verbs;
create policy phrasal_verbs_read on public.phrasal_verbs
  for select to authenticated using (true);

drop policy if exists phrasal_verb_examples_read on public.phrasal_verb_examples;
create policy phrasal_verb_examples_read on public.phrasal_verb_examples
  for select to authenticated using (true);

alter table public.exercises        enable row level security;
alter table public.user_stats       enable row level security;
alter table public.presentations    enable row level security;
alter table public.activity_events  enable row level security;
alter table public.kv               enable row level security;

drop policy if exists exercises_read on public.exercises;
create policy exercises_read on public.exercises
  for select to authenticated using (true);

drop policy if exists user_stats_own on public.user_stats;
create policy user_stats_own on public.user_stats
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists presentations_own on public.presentations;
create policy presentations_own on public.presentations
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists activity_own on public.activity_events;
create policy activity_own on public.activity_events
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists kv_own on public.kv;
create policy kv_own on public.kv
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- RPCs the app calls
-- ---------------------------------------------------------------------------

-- Pick what this user should see next for a type/level.
-- Pass p_level = '' to ignore level (audio).
--
-- Ordering is least-seen-first, but each wrong answer counts as two views
-- REMOVED. Plain least-seen-first has a perverse effect for learning: answering
-- an exercise pushes it to the back of the queue whether you got it right or
-- wrong, so the ones you fail are exactly the ones you wait longest to meet
-- again. Subtracting for failures pulls them forward without pinning them to
-- the front — get it right and it drifts back naturally.
create or replace function public.next_exercises(
  p_type  text,
  p_level text default '',
  p_limit integer default 5
)
returns setof public.exercises
language sql
stable
as $$
  select e.*
  from public.exercises e
  left join public.presentations p
    on p.exercise_id = e.id and p.user_id = auth.uid()
  where e.type = p_type
    and (p_level = '' or e.level = p_level)
    and e.active
  order by (coalesce(p.times_seen, 0) - 2 * coalesce(p.wrong_count, 0)) asc, random()
  limit greatest(1, least(p_limit, 50));
$$;

-- Exercises this user has actually got wrong, worst first. Powers the "try
-- again" list in Statistics, so a failure can be revisited on demand rather
-- than waiting for it to come round.
create or replace function public.challenging_exercises(
  p_type  text default '',
  p_limit integer default 12
)
returns table (
  id uuid, type text, level text, topic text, source text, payload jsonb,
  times_seen integer, wrong_count integer, correct_count integer, last_seen timestamptz
)
language sql
stable
as $$
  select e.id, e.type, e.level, e.topic, e.source, e.payload,
         p.times_seen, p.wrong_count, p.correct_count, p.last_seen
  from public.presentations p
  join public.exercises e on e.id = p.exercise_id
  where p.user_id = auth.uid()
    and p.wrong_count > 0
    and e.active
    and (p_type = '' or e.type = p_type)
  order by p.wrong_count desc, p.last_seen desc nulls last
  limit greatest(1, least(p_limit, 50));
$$;

-- Record that the current user was shown an exercise and whether they got it right.
-- Increments times_seen and the correct/wrong counters atomically.
create or replace function public.record_presentation(
  p_exercise uuid,
  p_correct  boolean
)
returns void
language sql
as $$
  insert into public.presentations
    (user_id, exercise_id, times_seen, correct_count, wrong_count, last_seen)
  values
    (auth.uid(), p_exercise, 1,
     case when p_correct then 1 else 0 end,
     case when p_correct then 0 else 1 end,
     now())
  on conflict (user_id, exercise_id) do update set
    times_seen    = public.presentations.times_seen + 1,
    correct_count = public.presentations.correct_count + (case when p_correct then 1 else 0 end),
    wrong_count   = public.presentations.wrong_count + (case when p_correct then 0 else 1 end),
    last_seen     = now();
$$;

-- Fetch the phrasal-verb pool for one game mode, each verb with its examples
-- inlined as JSON so the app gets everything in a single round trip.
-- p_category '' means "any category"; p_level '' means "any level".
-- Verbs with no active example are skipped — they would render an empty question.
create or replace function public.next_phrasal_verbs(
  p_category text default '',
  p_level    text default '',
  p_limit    integer default 200
)
returns table (
  id         uuid,
  verb       text,
  meaning    text,
  level      text,
  categories text[],
  examples   jsonb
)
language sql
stable
as $$
  select
    pv.id, pv.verb, pv.meaning, pv.level, pv.categories,
    jsonb_agg(
      jsonb_build_object('s', ex.sentence, 'a', ex.answer, 'suf', ex.suffix, 'src', ex.source)
      order by ex.created_at
    ) as examples
  from public.phrasal_verbs pv
  join public.phrasal_verb_examples ex
    on ex.phrasal_verb_id = pv.id and ex.active
  where pv.active
    and (p_category = '' or pv.categories @> array[p_category])
    and (p_level = ''    or pv.level = p_level)
  group by pv.id
  limit greatest(1, least(p_limit, 500));
$$;

grant execute on function public.next_exercises(text, text, integer)          to authenticated;
grant execute on function public.record_presentation(uuid, boolean)           to authenticated;
grant execute on function public.next_phrasal_verbs(text, text, integer)      to authenticated;
grant execute on function public.challenging_exercises(text, integer)         to authenticated;

-- Clear this user's per-exercise history for one game type (or all, with '').
-- Separate from resetting a score: the score is a tally, this is the record of
-- what you have already been shown, and wiping it puts every exercise back in
-- circulation. Runs as the invoker, so row-level security still confines the
-- delete to the caller's own rows.
create or replace function public.forget_progress(p_type text default '')
returns integer
language plpgsql
security invoker
as $$
declare
  removed integer;
begin
  delete from public.presentations p
  using public.exercises e
  where p.exercise_id = e.id
    and p.user_id = auth.uid()
    and (p_type = '' or e.type = p_type);
  get diagnostics removed = row_count;
  return removed;
end;
$$;

grant execute on function public.forget_progress(text) to authenticated;
