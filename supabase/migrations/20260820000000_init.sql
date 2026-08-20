-- Scrip — Phase 1 schema.
-- Single-user-per-account app: every row is keyed to auth.uid() and Row Level
-- Security is on everywhere. `date` is always the *device-local* calendar day,
-- passed in by the client as a plain date. That is what makes "midnight reset"
-- work without a scheduled function: tomorrow is simply a different key.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type task_status as enum ('todo', 'pending', 'verified', 'rejected');
create type verification_verdict as enum ('VERIFIED', 'FOLLOW_UP', 'REJECTED', 'MANUAL');

-- ---------------------------------------------------------------------------
-- app_config — the economy's tunable numbers, one row per user.
-- Week 1 tuning is an UPDATE, not a redeploy.
-- ---------------------------------------------------------------------------
create table app_config (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  tier1_minutes      int not null default 20 check (tier1_minutes between 0 and 240),
  tier2_minutes      int not null default 12 check (tier2_minutes between 0 and 240),
  tier3_minutes      int not null default 5  check (tier3_minutes between 0 and 240),
  daily_cap_minutes  int not null default 60 check (daily_cap_minutes between 0 and 1440),
  follow_up_rate     numeric not null default 0.25 check (follow_up_rate between 0 and 1),
  -- Your device's IANA timezone. The server derives "today" from this rather
  -- than trusting a date the client sends, which is what stops a rolled-forward
  -- clock from minting a second daily cap or pre-loading tomorrow's balance.
  timezone           text not null default 'UTC',
  created_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- daily_state — did the morning gate get cleared today?
-- ---------------------------------------------------------------------------
create table daily_state (
  user_id        uuid not null references auth.users (id) on delete cascade,
  date           date not null,
  list_confirmed boolean not null default false,
  confirmed_at   timestamptz,
  raw_transcript text,
  created_at     timestamptz not null default now(),
  primary key (user_id, date)
);

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------
create table tasks (
  id                         uuid primary key default gen_random_uuid(),
  user_id                    uuid not null references auth.users (id) on delete cascade,
  date                       date not null,
  title                      text not null check (length(trim(title)) between 1 and 200),
  tier                       int  not null check (tier in (1, 2, 3)),
  status                     task_status not null default 'todo',
  claude_suggested_tier      int check (claude_suggested_tier in (1, 2, 3)),
  proof_hint                 text,
  self_report_only           boolean not null default false,
  proof_urls                 text[] not null default '{}',
  verification_notes         text,
  follow_up_question         text,
  follow_up_answer           text,
  created_after_confirmation boolean not null default false,
  minutes_awarded            int not null default 0,
  position                   int not null default 0,
  verified_at                timestamptz,
  created_at                 timestamptz not null default now()
);

create index tasks_user_date_idx on tasks (user_id, date);

-- ---------------------------------------------------------------------------
-- verification_attempts — the permanent record. Rejections stay visible in the
-- weekly review even after a successful retake. Nothing here is deletable.
-- ---------------------------------------------------------------------------
create table verification_attempts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  task_id            uuid not null references tasks (id) on delete cascade,
  date               date not null,
  verdict            verification_verdict not null,
  reason             text,
  follow_up_question text,
  follow_up_answer   text,
  proof_urls         text[] not null default '{}',
  forced_follow_up   boolean not null default false,
  created_at         timestamptz not null default now()
);

create index verification_attempts_user_date_idx on verification_attempts (user_id, date);
create index verification_attempts_task_idx on verification_attempts (task_id);

-- ---------------------------------------------------------------------------
-- balances — one row per day. Unused minutes expire because tomorrow gets a
-- fresh row; there is deliberately no rollover path.
-- ---------------------------------------------------------------------------
create table balances (
  user_id              uuid not null references auth.users (id) on delete cascade,
  date                 date not null,
  minutes_available    int not null default 0 check (minutes_available >= 0),
  minutes_earned_total int not null default 0 check (minutes_earned_total >= 0),
  minutes_spent_total  int not null default 0 check (minutes_spent_total >= 0),
  all_tasks_bonus      boolean not null default false,
  primary key (user_id, date)
);

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
create table sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  date          date not null,
  app_name      text not null check (length(trim(app_name)) between 1 and 60),
  minutes       int not null check (minutes between 1 and 240),
  from_bonus    boolean not null default false,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  acknowledged  boolean not null default false
);

create index sessions_user_date_idx on sessions (user_id, date);

-- ---------------------------------------------------------------------------
-- cheat_reports — the honest half of Phase 1. Enforcement is honour-system, so
-- the only way to measure the cheat rate is to write it down. One row per day.
-- ---------------------------------------------------------------------------
create table cheat_reports (
  user_id    uuid not null references auth.users (id) on delete cascade,
  date       date not null,
  count      int not null default 0 check (count >= 0),
  note       text,
  created_at timestamptz not null default now(),
  primary key (user_id, date)
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table app_config            enable row level security;
alter table daily_state           enable row level security;
alter table tasks                 enable row level security;
alter table verification_attempts enable row level security;
alter table balances              enable row level security;
alter table sessions              enable row level security;
alter table cheat_reports         enable row level security;

create policy "own config" on app_config
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own daily_state" on daily_state
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Tasks: read/insert/update your own. Deleting is only possible while today's
-- list is still unconfirmed — once you have committed to the day, a task can be
-- edited but not made to disappear.
create policy "read own tasks" on tasks
  for select using (auth.uid() = user_id);

create policy "insert own tasks" on tasks
  for insert with check (auth.uid() = user_id);

create policy "update own tasks" on tasks
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "delete unconfirmed tasks" on tasks
  for delete using (
    auth.uid() = user_id
    and not exists (
      select 1 from daily_state d
      where d.user_id = tasks.user_id
        and d.date = tasks.date
        and d.list_confirmed
    )
  );

-- Verification attempts and balances are written by SECURITY DEFINER functions
-- and by the Edge Functions (service role). The client may only read them.
create policy "read own attempts" on verification_attempts
  for select using (auth.uid() = user_id);

create policy "read own balances" on balances
  for select using (auth.uid() = user_id);

-- Sessions are created/ended through RPCs so the balance math stays atomic.
create policy "read own sessions" on sessions
  for select using (auth.uid() = user_id);

create policy "own cheat reports" on cheat_reports
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Bootstrap: every new user gets a config row.
-- ---------------------------------------------------------------------------
create function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into app_config (user_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- "Today" is computed from the server clock and the user's stored timezone, not
-- from a date the client hands over. Rolling the device clock forward changes
-- nothing here; §3's "unused minutes expire at midnight, no banking" is only a
-- rule if the server owns the calendar.
create function user_today(p_user_id uuid) returns date
language plpgsql stable security definer set search_path = public as $$
declare
  tz text;
begin
  select timezone into tz from app_config where user_id = p_user_id;
  return (now() at time zone coalesce(tz, 'UTC'))::date;
end;
$$;

create function assert_user_today(p_user_id uuid, p_date date) returns void
language plpgsql stable security definer set search_path = public as $$
declare
  today date := user_today(p_user_id);
begin
  if p_date is null or p_date <> today then
    raise exception 'date % is not today (% in your timezone)', p_date, today;
  end if;
end;
$$;

-- A nonsense timezone would make every date check throw, so reject it up front.
create function validate_timezone() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception '% is not a known timezone', new.timezone;
  end if;
  return new;
end;
$$;

create trigger app_config_timezone_trg
  before insert or update of timezone on app_config
  for each row execute function validate_timezone();

create function ensure_config(p_user_id uuid) returns app_config
language plpgsql security definer set search_path = public as $$
declare
  cfg app_config;
begin
  insert into app_config (user_id) values (p_user_id) on conflict (user_id) do nothing;
  select * into cfg from app_config where user_id = p_user_id;
  return cfg;
end;
$$;

create function tier_minutes(p_user_id uuid, p_tier int) returns int
language plpgsql security definer set search_path = public as $$
declare
  cfg app_config := ensure_config(p_user_id);
begin
  return case p_tier
    when 1 then cfg.tier1_minutes
    when 2 then cfg.tier2_minutes
    else cfg.tier3_minutes
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Task insert guard. The client says what a task is called and how hard it is;
-- it does not get to say whether it added the task after locking the day, nor
-- to insert one that arrives already verified.
-- ---------------------------------------------------------------------------
create function tasks_insert_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- No dating a task into the future: that plus credit_manual_task would
  -- pre-load tomorrow's balance, which is the banking §3 forbids.
  perform assert_user_today(new.user_id, new.date);

  new.created_after_confirmation := coalesce(
    (select d.list_confirmed from daily_state d
      where d.user_id = new.user_id and d.date = new.date),
    false);
  new.status             := 'todo';
  new.minutes_awarded    := 0;
  new.verified_at        := null;
  new.proof_urls         := '{}';
  new.verification_notes := null;
  new.follow_up_question := null;
  new.follow_up_answer   := null;

  -- Nothing inserted through this path carries a Claude suggestion, a proof
  -- hint or a no-photo exemption — including inserts by the service role. Only
  -- create_structured_tasks() below sets those, after the row exists, so there
  -- is no caller-sniffing to get wrong.
  new.claude_suggested_tier := null;
  new.self_report_only      := false;
  new.proof_hint            := null;

  return new;
end;
$$;

create trigger tasks_insert_guard_trg
  before insert on tasks
  for each row execute function tasks_insert_guard();

-- ---------------------------------------------------------------------------
-- create_structured_tasks — the only way a task acquires a Claude suggestion,
-- a proof hint, or a no-photo-needed exemption. Service-role only; called by
-- the structure-tasks Edge Function with what Claude actually returned.
-- ---------------------------------------------------------------------------
create function create_structured_tasks(p_user_id uuid, p_date date, p_tasks jsonb)
returns setof tasks
language plpgsql security definer set search_path = public as $$
declare
  item     jsonb;
  new_id   uuid;
  idx      int := 0;
  base_pos int;
begin
  select coalesce(max(position) + 1, 0) into base_pos
  from tasks where user_id = p_user_id and date = p_date;

  for item in select * from jsonb_array_elements(p_tasks) loop
    insert into tasks (user_id, date, title, tier, position)
    values (
      p_user_id,
      p_date,
      left(trim(item ->> 'title'), 200),
      (item ->> 'tier')::int,
      base_pos + idx
    )
    returning id into new_id;

    -- Set after insert: the guard trigger deliberately strips these on the way in.
    update tasks set
      claude_suggested_tier = (item ->> 'tier')::int,
      proof_hint            = item ->> 'proof_hint',
      self_report_only      = coalesce((item ->> 'self_report_only')::boolean, false)
    where id = new_id;

    idx := idx + 1;
  end loop;

  return query select * from tasks
    where user_id = p_user_id and date = p_date and position >= base_pos
    order by position;
end;
$$;

-- ---------------------------------------------------------------------------
-- _credit_task — the only path by which minutes are created.
-- Enforces: no double credit, the daily cap, and the full-completion bonus.
-- ---------------------------------------------------------------------------
create function _credit_task(
  p_user_id uuid,
  p_task_id uuid,
  p_verdict verification_verdict,
  p_reason text,
  p_proof_urls text[],
  p_forced_follow_up boolean default false
) returns json
language plpgsql security definer set search_path = public as $$
declare
  t              tasks;
  cfg            app_config;
  full_value     int;
  awarded        int;
  bal            balances;
  remaining_cap  int;
  outstanding    int;
  bonus          boolean := false;
begin
  select * into t from tasks where id = p_task_id and user_id = p_user_id for update;
  if not found then
    raise exception 'task not found';
  end if;
  if t.status = 'verified' then
    raise exception 'task already verified';
  end if;

  perform assert_user_today(p_user_id, t.date);

  cfg := ensure_config(p_user_id);
  full_value := tier_minutes(p_user_id, t.tier);

  insert into balances (user_id, date) values (p_user_id, t.date) on conflict do nothing;
  select * into bal from balances where user_id = p_user_id and date = t.date for update;

  -- Daily cap applies to minutes *earned*, not minutes held.
  remaining_cap := greatest(cfg.daily_cap_minutes - bal.minutes_earned_total, 0);
  awarded := least(full_value, remaining_cap);

  update tasks set
    status             = 'verified',
    verified_at        = now(),
    minutes_awarded    = awarded,
    verification_notes = p_reason,
    proof_urls         = case when array_length(p_proof_urls, 1) is null then proof_urls else p_proof_urls end
  where id = p_task_id;

  -- Full completion: every task on the day's list is verified => unlimited
  -- until midnight. Checked after the update above so this task counts.
  select count(*) into outstanding
  from tasks where user_id = p_user_id and date = t.date and status <> 'verified';
  bonus := (outstanding = 0);

  update balances set
    minutes_available    = minutes_available + awarded,
    minutes_earned_total = minutes_earned_total + awarded,
    all_tasks_bonus      = balances.all_tasks_bonus or bonus
  where user_id = p_user_id and date = t.date
  returning * into bal;

  insert into verification_attempts
    (user_id, task_id, date, verdict, reason, proof_urls, forced_follow_up)
  values
    (p_user_id, p_task_id, t.date, p_verdict, p_reason, coalesce(p_proof_urls, '{}'), p_forced_follow_up);

  return json_build_object(
    'awarded', awarded,
    'full_value', full_value,
    'capped', awarded < full_value,
    'minutes_available', bal.minutes_available,
    'minutes_earned_total', bal.minutes_earned_total,
    'all_tasks_bonus', bal.all_tasks_bonus
  );
end;
$$;

-- Service-role entry point: called by the verify-proof Edge Function once
-- Claude has returned VERIFIED.
create function credit_verified_task(
  p_task_id uuid,
  p_reason text,
  p_proof_urls text[] default '{}',
  p_forced_follow_up boolean default false
) returns json
language plpgsql security definer set search_path = public as $$
declare
  owner uuid;
begin
  select user_id into owner from tasks where id = p_task_id;
  if owner is null then
    raise exception 'task not found';
  end if;
  return _credit_task(owner, p_task_id, 'VERIFIED', p_reason, p_proof_urls, p_forced_follow_up);
end;
$$;

-- A self-report task (§6a: "self-report, no photo needed") earns its minutes,
-- but no photo was ever looked at, so it is logged as MANUAL rather than
-- VERIFIED. Service-role only — verify-proof checks self_report_only first.
create function credit_self_reported_task(p_task_id uuid, p_reason text)
returns json
language plpgsql security definer set search_path = public as $$
declare
  owner uuid;
begin
  select user_id into owner from tasks where id = p_task_id;
  if owner is null then
    raise exception 'task not found';
  end if;
  return _credit_task(owner, p_task_id, 'MANUAL', p_reason, '{}', false);
end;
$$;

-- Client entry point for the no-AI path (Weekend 1, or a task whose proof_hint
-- is "self-report, no photo needed"). Logged as MANUAL so it is impossible to
-- mistake for a verified proof in the weekly review.
create function credit_manual_task(p_task_id uuid, p_note text default null)
returns json
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  return _credit_task(auth.uid(), p_task_id, 'MANUAL', coalesce(p_note, 'Self-reported, no photo verification.'), '{}', false);
end;
$$;

-- Record a rejection or a follow-up question without crediting anything.
create function log_verification_attempt(
  p_task_id uuid,
  p_verdict verification_verdict,
  p_reason text,
  p_follow_up_question text default null,
  p_follow_up_answer text default null,
  p_proof_urls text[] default '{}',
  p_forced_follow_up boolean default false
) returns void
language plpgsql security definer set search_path = public as $$
declare
  t tasks;
begin
  select * into t from tasks where id = p_task_id;
  if not found then
    raise exception 'task not found';
  end if;

  insert into verification_attempts
    (user_id, task_id, date, verdict, reason, follow_up_question, follow_up_answer, proof_urls, forced_follow_up)
  values
    (t.user_id, p_task_id, t.date, p_verdict, p_reason, p_follow_up_question, p_follow_up_answer,
     coalesce(p_proof_urls, '{}'), p_forced_follow_up);

  update tasks set
    status             = case when p_verdict = 'REJECTED' then 'rejected'::task_status else 'pending'::task_status end,
    verification_notes = p_reason,
    follow_up_question = p_follow_up_question,
    follow_up_answer   = p_follow_up_answer,
    proof_urls         = case when array_length(p_proof_urls, 1) is null then proof_urls else p_proof_urls end
  where id = p_task_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------
create function start_session(p_date date, p_app_name text, p_minutes int)
returns sessions
language plpgsql security definer set search_path = public as $$
declare
  bal balances;
  s   sessions;
  live int;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  perform assert_user_today(auth.uid(), p_date);

  if p_minutes not in (5, 10, 15, 20) then
    raise exception 'sessions are 5, 10, 15 or 20 minutes';
  end if;

  select count(*) into live from sessions
  where user_id = auth.uid() and ended_at is null;
  if live > 0 then
    raise exception 'a session is already running';
  end if;

  insert into balances (user_id, date) values (auth.uid(), p_date) on conflict do nothing;
  select * into bal from balances where user_id = auth.uid() and date = p_date for update;

  if not bal.all_tasks_bonus and bal.minutes_available < p_minutes then
    raise exception 'not enough minutes: % available, % requested', bal.minutes_available, p_minutes;
  end if;

  if not bal.all_tasks_bonus then
    update balances set
      minutes_available   = minutes_available - p_minutes,
      minutes_spent_total = minutes_spent_total + p_minutes
    where user_id = auth.uid() and date = p_date;
  else
    update balances set minutes_spent_total = minutes_spent_total + p_minutes
    where user_id = auth.uid() and date = p_date;
  end if;

  insert into sessions (user_id, date, app_name, minutes, from_bonus)
  values (auth.uid(), p_date, p_app_name, p_minutes, bal.all_tasks_bonus)
  returning * into s;

  return s;
end;
$$;

-- Ending a session is the acknowledgement tap on the "time's up" screen. There
-- is no refund for ending early: minutes are spent when the session starts.
create function end_session(p_session_id uuid) returns sessions
language plpgsql security definer set search_path = public as $$
declare
  s sessions;
begin
  update sessions set ended_at = coalesce(ended_at, now()), acknowledged = true
  where id = p_session_id and user_id = auth.uid()
  returning * into s;
  if not found then
    raise exception 'session not found';
  end if;
  return s;
end;
$$;

-- ---------------------------------------------------------------------------
-- Confirming the morning list
-- ---------------------------------------------------------------------------
create function confirm_day(p_date date, p_transcript text default null)
returns daily_state
language plpgsql security definer set search_path = public as $$
declare
  d daily_state;
  n int;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  perform assert_user_today(auth.uid(), p_date);

  select count(*) into n from tasks where user_id = auth.uid() and date = p_date;
  if n = 0 then
    raise exception 'cannot confirm an empty list';
  end if;

  insert into daily_state (user_id, date, list_confirmed, confirmed_at, raw_transcript)
  values (auth.uid(), p_date, true, now(), p_transcript)
  on conflict (user_id, date) do update set
    list_confirmed = true,
    confirmed_at   = coalesce(daily_state.confirmed_at, now()),
    raw_transcript = coalesce(excluded.raw_transcript, daily_state.raw_transcript)
  returning * into d;

  insert into balances (user_id, date) values (auth.uid(), p_date) on conflict do nothing;
  return d;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants — explicit rather than relying on default privileges. RLS is still
-- what decides which rows; these decide which verbs exist at all.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;

grant select, insert, update           on app_config     to authenticated;
grant select, insert, update           on daily_state    to authenticated;
grant select, insert, delete            on tasks          to authenticated;
-- Column-level: the client may rename, re-tier and reorder a task. It may NOT
-- touch status, minutes_awarded, claude_suggested_tier, created_after_confirmation
-- or proof_urls — those are the record §7 says must survive, and a blanket
-- UPDATE grant would let one console call erase all of them.
grant update (title, tier, position)   on tasks          to authenticated;
grant select, insert, update           on cheat_reports  to authenticated;
grant select                           on balances       to authenticated;
grant select                           on sessions       to authenticated;
grant select                           on verification_attempts to authenticated;

-- The client may only call the functions meant for it.

revoke all on function _credit_task(uuid, uuid, verification_verdict, text, text[], boolean) from public, anon, authenticated;
revoke all on function credit_verified_task(uuid, text, text[], boolean) from public, anon, authenticated;
revoke all on function credit_self_reported_task(uuid, text) from public, anon, authenticated;
revoke all on function create_structured_tasks(uuid, date, jsonb) from public, anon, authenticated;
revoke all on function log_verification_attempt(uuid, verification_verdict, text, text, text, text[], boolean) from public, anon, authenticated;
revoke all on function ensure_config(uuid) from public, anon, authenticated;
revoke all on function tier_minutes(uuid, int) from public, anon, authenticated;
revoke all on function assert_user_today(uuid, date) from public, anon, authenticated;
revoke all on function user_today(uuid) from public, anon, authenticated;

grant execute on function credit_manual_task(uuid, text) to authenticated;
grant execute on function start_session(date, text, int) to authenticated;
grant execute on function end_session(uuid) to authenticated;
grant execute on function confirm_day(date, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Storage — private bucket for proof photos, foldered by user id.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('proofs', 'proofs', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "upload own proofs" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'proofs' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "read own proofs" on storage.objects
  for select to authenticated
  using (bucket_id = 'proofs' and (storage.foldername(name))[1] = auth.uid()::text);
