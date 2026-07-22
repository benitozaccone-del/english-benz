-- English Benz — Supabase schema
-- Paste this whole file into the Supabase SQL editor (Dashboard → SQL → New query → Run).
-- Safe to re-run: every object uses "if not exists" / "or replace".
--
-- Data model
--   exercises          shared, read-mostly content repository (grown by the pipeline)
--   user_stats         per-user score + per-topic tallies, one row per (user, type, level)
--   presentations      per-user × per-exercise "times seen" + correct/wrong counters
--   activity_events    append-only log powering the Statistics view
--
-- "level" is '' (empty string, not NULL) for single-level content (audio) so it can
-- sit in a primary key. Translation uses 'B2' / 'C1' / 'C2'.

-- ---------------------------------------------------------------------------
-- Content repository
-- ---------------------------------------------------------------------------
create table if not exists public.exercises (
  id            uuid primary key default gen_random_uuid(),
  type          text not null check (type in ('translation', 'audio')),
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

-- ---------------------------------------------------------------------------
-- Row-level security
--   exercises        : any signed-in user may read; only the service role writes
--                      (the content pipeline uses the service key, which bypasses RLS)
--   everything else  : a user sees and edits only their own rows
-- ---------------------------------------------------------------------------
alter table public.exercises        enable row level security;
alter table public.user_stats       enable row level security;
alter table public.presentations    enable row level security;
alter table public.activity_events  enable row level security;

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

-- ---------------------------------------------------------------------------
-- RPCs the app calls
-- ---------------------------------------------------------------------------

-- Pick the exercises this user has seen least (random tiebreak) for a type/level.
-- Pass p_level = '' to ignore level (audio).
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
  order by coalesce(p.times_seen, 0) asc, random()
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

grant execute on function public.next_exercises(text, text, integer)  to authenticated;
grant execute on function public.record_presentation(uuid, boolean)   to authenticated;
