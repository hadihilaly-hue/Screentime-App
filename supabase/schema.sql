-- ============================================================================
-- EarnedTime — Phase 1 schema (spec section 5)
-- Paste into the Supabase SQL editor and run once.
-- Safe to re-run: everything is guarded with "if not exists" / "drop policy if exists".
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------
create table if not exists public.tasks (
  id                        uuid        primary key default gen_random_uuid(),
  user_id                   uuid        not null references auth.users (id) on delete cascade,
  date                      date        not null default current_date,
  title                     text        not null check (length(btrim(title)) > 0),
  tier                      smallint    not null check (tier in (1, 2, 3)),
  status                    text        not null default 'todo'
                                        check (status in ('todo', 'pending', 'verified', 'rejected', 'cancelled')),
  claude_suggested_tier     smallint    check (claude_suggested_tier in (1, 2, 3)),
  proof_hint                text,
  proof_urls                text[]      not null default '{}',
  verification_notes        text,
  created_after_confirmation boolean    not null default false,
  verified_at               timestamptz,
  created_at                timestamptz not null default now()
);

create index if not exists tasks_user_date_idx on public.tasks (user_id, date);

-- ---------------------------------------------------------------------------
-- balances  (one row per user per day)
-- ---------------------------------------------------------------------------
create table if not exists public.balances (
  user_id              uuid        not null references auth.users (id) on delete cascade,
  date                 date        not null default current_date,
  minutes_available    integer     not null default 0 check (minutes_available >= 0),
  minutes_earned_total integer     not null default 0 check (minutes_earned_total >= 0),
  all_tasks_bonus      boolean     not null default false,
  updated_at           timestamptz not null default now(),
  primary key (user_id, date)
);

-- ---------------------------------------------------------------------------
-- sessions  (append-only log of spent time)
-- ---------------------------------------------------------------------------
create table if not exists public.sessions (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users (id) on delete cascade,
  date       date        not null default current_date,
  app_name   text        not null check (length(btrim(app_name)) > 0),
  minutes    integer     not null check (minutes > 0),
  started_at timestamptz not null default now(),
  ended_at   timestamptz
);

create index if not exists sessions_user_date_idx on public.sessions (user_id, date);

-- ---------------------------------------------------------------------------
-- daily_state  (did the morning gate get cleared today?)
-- ---------------------------------------------------------------------------
create table if not exists public.daily_state (
  user_id        uuid        not null references auth.users (id) on delete cascade,
  date           date        not null default current_date,
  list_confirmed boolean     not null default false,
  confirmed_at   timestamptz,
  primary key (user_id, date)
);

-- ============================================================================
-- Row Level Security — every policy keyed to the authenticated user
-- ============================================================================

alter table public.tasks       enable row level security;
alter table public.balances    enable row level security;
alter table public.sessions    enable row level security;
alter table public.daily_state enable row level security;

-- tasks: select/insert/update on your own rows. DELETE is allowed only while
-- the day's list is unconfirmed (spec section 4.2 lets you delete during Task
-- Review); afterwards the only way out of a task is status 'cancelled', so an
-- abandoned task stays visible in the weekly review (spec section 7).
drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks
  for select using ((select auth.uid()) = user_id);

drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks
  for insert with check ((select auth.uid()) = user_id);

drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks
  for update using ((select auth.uid()) = user_id)
              with check ((select auth.uid()) = user_id);

drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks
  for delete using (
    (select auth.uid()) = user_id
    and not exists (
      select 1
      from public.daily_state ds
      where ds.user_id = tasks.user_id
        and ds.date    = tasks.date
        and ds.list_confirmed
    )
  );

-- balances: read / create / update your own. No delete.
drop policy if exists balances_select on public.balances;
create policy balances_select on public.balances
  for select using ((select auth.uid()) = user_id);

drop policy if exists balances_insert on public.balances;
create policy balances_insert on public.balances
  for insert with check ((select auth.uid()) = user_id);

drop policy if exists balances_update on public.balances;
create policy balances_update on public.balances
  for update using ((select auth.uid()) = user_id)
              with check ((select auth.uid()) = user_id);

-- sessions: append-only. Insert + update (to stamp ended_at), never delete.
-- Spec section 7: "Everything is logged, nothing is deletable."
drop policy if exists sessions_select on public.sessions;
create policy sessions_select on public.sessions
  for select using ((select auth.uid()) = user_id);

drop policy if exists sessions_insert on public.sessions;
create policy sessions_insert on public.sessions
  for insert with check ((select auth.uid()) = user_id);

drop policy if exists sessions_update on public.sessions;
create policy sessions_update on public.sessions
  for update using ((select auth.uid()) = user_id)
                with check ((select auth.uid()) = user_id);

-- daily_state: read / create / update your own. No delete — you don't get to
-- un-confirm a day after the fact.
drop policy if exists daily_state_select on public.daily_state;
create policy daily_state_select on public.daily_state
  for select using ((select auth.uid()) = user_id);

drop policy if exists daily_state_insert on public.daily_state;
create policy daily_state_insert on public.daily_state
  for insert with check ((select auth.uid()) = user_id);

drop policy if exists daily_state_update on public.daily_state;
create policy daily_state_update on public.daily_state
  for update using ((select auth.uid()) = user_id)
                 with check ((select auth.uid()) = user_id);
