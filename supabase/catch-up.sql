-- =====================================================================
-- Scrip — catch-up script
--
-- Brings a database that already has the FIRST published schema
-- (commit 9b95e6b) up to the current schema (commit b71560f).
--
-- Idempotent: safe to run more than once. Run it in the Supabase SQL
-- editor, which executes as `postgres`.
--
-- If your database has NO Scrip tables at all, do not run this — run
-- supabase/migrations/20260820000000_init.sql instead.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. New columns on app_config
-- ---------------------------------------------------------------------
alter table app_config add column if not exists timezone         text not null default 'UTC';
alter table app_config add column if not exists last_active_date date;

-- ---------------------------------------------------------------------
-- 2. New table: timezone_changes
-- ---------------------------------------------------------------------
create table if not exists timezone_changes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  from_zone  text not null,
  to_zone    text not null,
  created_at timestamptz not null default now()
);

create index if not exists timezone_changes_user_idx on timezone_changes (user_id, created_at);

alter table timezone_changes enable row level security;

drop policy if exists "read own timezone changes" on timezone_changes;
create policy "read own timezone changes" on timezone_changes
  for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- 3. Drop the functions that were renamed or changed signature.
--    (CREATE OR REPLACE cannot change a function's argument list.)
-- ---------------------------------------------------------------------
drop function if exists assert_plausible_date(date);
drop function if exists assert_user_today(uuid, date);
drop function if exists log_verification_attempt(uuid, verification_verdict, text, text, text, text[]);

-- ---------------------------------------------------------------------
-- 4. The calendar. "Today" is derived from the server clock and your
--    stored timezone, and days only run forwards.
-- ---------------------------------------------------------------------

create or replace function user_today(p_user_id uuid) returns date
language plpgsql stable security definer set search_path = public as $$
declare
  tz text;
begin
  select timezone into tz from app_config where user_id = p_user_id;
  return (now() at time zone coalesce(tz, 'UTC'))::date;
end;
$$;

create or replace function require_today(p_user_id uuid, p_date date) returns void
language plpgsql security definer set search_path = public as $$
declare
  today date := user_today(p_user_id);
  hwm   date;
begin
  if p_date is null or p_date <> today then
    raise exception 'date % is not today (% in your timezone)', p_date, today;
  end if;

  select last_active_date into hwm from app_config where user_id = p_user_id;
  if hwm is not null and p_date < hwm then
    raise exception
      'you have already moved past % (last active %). Days do not run backwards.',
      p_date, hwm;
  end if;

  if hwm is null or p_date > hwm then
    update app_config set last_active_date = p_date where user_id = p_user_id;
  end if;
end;
$$;

create or replace function set_timezone(p_timezone text) returns text
language plpgsql security definer set search_path = public as $$
declare
  current_zone text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select timezone into current_zone from app_config where user_id = auth.uid();
  if current_zone is null then
    raise exception 'no config row';
  end if;

  if p_timezone is null or p_timezone = current_zone then
    return current_zone;
  end if;
  if not exists (select 1 from pg_timezone_names where name = p_timezone) then
    return current_zone;
  end if;

  update app_config set timezone = p_timezone where user_id = auth.uid();
  insert into timezone_changes (user_id, from_zone, to_zone)
  values (auth.uid(), current_zone, p_timezone);

  return p_timezone;
end;
$$;

create or replace function validate_timezone() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception '% is not a known timezone', new.timezone;
  end if;
  return new;
end;
$$;

drop trigger if exists app_config_timezone_trg on app_config;
create trigger app_config_timezone_trg
  before insert or update of timezone on app_config
  for each row execute function validate_timezone();

-- ---------------------------------------------------------------------
-- 5. Task insert guard, and the one path allowed to write the columns
--    that classify a task.
-- ---------------------------------------------------------------------

create or replace function tasks_insert_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- No dating a task into the future: that plus credit_manual_task would
  -- pre-load tomorrow's balance, which is the banking §3 forbids.
  perform require_today(new.user_id, new.date);

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

create or replace function create_structured_tasks(p_user_id uuid, p_date date, p_tasks jsonb)
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

drop trigger if exists tasks_insert_guard_trg on tasks;
create trigger tasks_insert_guard_trg
  before insert on tasks
  for each row execute function tasks_insert_guard();

-- ---------------------------------------------------------------------
-- 6. Crediting, logging and sessions — updated bodies
-- ---------------------------------------------------------------------

create or replace function _credit_task(
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

  perform require_today(p_user_id, t.date);

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

create or replace function credit_self_reported_task(p_task_id uuid, p_reason text)
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

create or replace function log_verification_attempt(
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

create or replace function start_session(p_date date, p_app_name text, p_minutes int)
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
  perform require_today(auth.uid(), p_date);

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

create or replace function confirm_day(p_date date, p_transcript text default null)
returns daily_state
language plpgsql security definer set search_path = public as $$
declare
  d daily_state;
  n int;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  perform require_today(auth.uid(), p_date);

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

-- ---------------------------------------------------------------------
-- 7. Grants. Narrow the client down to the columns and functions it
--    actually needs; RLS still decides which rows.
-- ---------------------------------------------------------------------
revoke update on app_config  from authenticated;
revoke update on daily_state from authenticated;
revoke insert on daily_state from authenticated;
revoke update on tasks       from authenticated;

grant select, insert on app_config to authenticated;
grant update (tier1_minutes, tier2_minutes, tier3_minutes, daily_cap_minutes)
  on app_config to authenticated;

grant select on daily_state      to authenticated;
grant select on timezone_changes to authenticated;

grant select, insert, delete         on tasks to authenticated;
grant update (title, tier, position) on tasks to authenticated;

revoke all on function _credit_task(uuid, uuid, verification_verdict, text, text[], boolean) from public, anon, authenticated;
revoke all on function credit_verified_task(uuid, text, text[], boolean)                     from public, anon, authenticated;
revoke all on function credit_self_reported_task(uuid, text)                                 from public, anon, authenticated;
revoke all on function create_structured_tasks(uuid, date, jsonb)                            from public, anon, authenticated;
revoke all on function log_verification_attempt(uuid, verification_verdict, text, text, text, text[], boolean) from public, anon, authenticated;
revoke all on function require_today(uuid, date)                                             from public, anon, authenticated;
revoke all on function user_today(uuid)                                                      from public, anon, authenticated;
revoke all on function ensure_config(uuid)                                                   from public, anon, authenticated;
revoke all on function tier_minutes(uuid, int)                                               from public, anon, authenticated;

grant execute on function set_timezone(text)         to authenticated;
grant execute on function credit_manual_task(uuid, text) to authenticated;
grant execute on function start_session(date, text, int)  to authenticated;
grant execute on function end_session(uuid)           to authenticated;
grant execute on function confirm_day(date, text)     to authenticated;

-- ---------------------------------------------------------------------
-- 8. Set your timezone, so "today" means what your phone means by it.
--    Replace the value if you are not on US Pacific.
-- ---------------------------------------------------------------------
update app_config set timezone = 'America/Los_Angeles'
where timezone = 'UTC';

commit;
