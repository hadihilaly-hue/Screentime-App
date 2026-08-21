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
  -- What Claude said about the photos. Deliberately separate from `status`:
  -- status is the economy's state machine and is claimed by a compare-and-swap
  -- in completeTask, this is the verdict that decides whether that claim is
  -- allowed to be attempted at all. Written only by the verify-proof Edge
  -- Function (see the column grants at the bottom of this file).
  verification_verdict      text        check (verification_verdict is null
                                        or verification_verdict in ('verified', 'rejected', 'needs_followup')),
  verification_notes        text,
  followup_question         text,
  followup_answer           text,
  verified_by_ai_at         timestamptz,
  created_after_confirmation boolean    not null default false,
  edited_after_confirmation  boolean    not null default false,
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
  minutes_earned_total integer     not null default 0
                                   constraint balances_daily_cap
                                   check (minutes_earned_total between 0 and 60),
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

-- ---------------------------------------------------------------------------
-- verification_attempts  (one row per proof verification that reached Claude)
-- ---------------------------------------------------------------------------
-- Two jobs: it is the counter behind the three-attempts-per-task-per-day cost
-- guard, and it is the record of what was tried (spec section 7).
create table if not exists public.verification_attempts (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users (id) on delete cascade,
  task_id     uuid        not null references public.tasks (id) on delete cascade,
  -- Named `day`, not `date`, because unlike every other date column here it is
  -- the DATABASE's date (UTC), not the user's local one. It has to be: a guard
  -- that resets when the phone's clock says so is not a guard. The three
  -- attempts therefore reset at UTC midnight rather than at yours. This is a
  -- cost ceiling, not part of the section 3A schedule, so that seam is fine.
  day         date        not null default current_date,
  verdict     text,
  reason      text,
  photo_count smallint,
  is_followup boolean     not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists verification_attempts_task_day_idx
  on public.verification_attempts (task_id, day);

-- ============================================================================
-- Row Level Security — every policy keyed to the authenticated user
-- ============================================================================

alter table public.tasks                 enable row level security;
alter table public.balances              enable row level security;
alter table public.sessions              enable row level security;
alter table public.daily_state           enable row level security;
alter table public.verification_attempts enable row level security;

-- tasks: select/insert/update on your own rows. DELETE is allowed only while
-- the day's list is unconfirmed (spec section 4.2 lets you delete during Task
-- Review); afterwards the only way out of a task is status 'cancelled', so an
-- abandoned task stays visible in the weekly review (spec section 7).
drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks
  for select using ((select auth.uid()) = user_id);

-- Insert-only date guard: a task cannot be backdated into a fresh daily cap.
-- An RLS policy rather than a CHECK, because a CHECK would also fire on UPDATE
-- (breaking edits once the date rolls over) and would make dumps unrestorable
-- on a later day. The +/- 1 day window rather than equality is because the
-- client sends local dates while current_date is the database's UTC date.
drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks
  for insert with check (
    (select auth.uid()) = user_id
    and date between current_date - 1 and current_date + 1
  );

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

-- The UPDATE policy only matches sessions that are still RUNNING, so ended_at
-- can be stamped once and never rewritten. Without "ended_at is null" in the
-- USING clause, append-only was a client-side convention: every writer politely
-- filtered on it, and nothing stopped one that did not. A finished session is
-- part of the record (spec section 7), and its end time is the part that says
-- how much time was actually spent.
drop policy if exists sessions_update on public.sessions;
create policy sessions_update on public.sessions
  for update using ((select auth.uid()) = user_id and ended_at is null)
                with check ((select auth.uid()) = user_id);

-- daily_state: read / create / update your own. No delete, and the UPDATE
-- policy only matches rows that are still unconfirmed — so confirming works
-- but un-confirming does not. Without that, a confirmed day could be flipped
-- back to false, letting the tasks_delete policy match again.
drop policy if exists daily_state_select on public.daily_state;
create policy daily_state_select on public.daily_state
  for select using ((select auth.uid()) = user_id);

drop policy if exists daily_state_insert on public.daily_state;
create policy daily_state_insert on public.daily_state
  for insert with check ((select auth.uid()) = user_id);

drop policy if exists daily_state_update on public.daily_state;
create policy daily_state_update on public.daily_state
  for update using ((select auth.uid()) = user_id and not list_confirmed)
                 with check ((select auth.uid()) = user_id);

-- verification_attempts: read your own, and nothing else. The absence of an
-- insert, update and delete policy is the point — an ordinary signed-in client
-- cannot add, edit or remove a row. Only the verify-proof Edge Function can,
-- because it writes with the service_role key, which bypasses RLS. If the
-- client could write here, the daily attempt guard would be advisory: you would
-- delete three rows and start again.
drop policy if exists verification_attempts_select on public.verification_attempts;
create policy verification_attempts_select on public.verification_attempts
  for select using ((select auth.uid()) = user_id);

-- ============================================================================
-- Column privileges — the verdict is server-written
-- ============================================================================
-- RLS is row-level: it can say "this row is yours", never "this column is not".
-- Without the two statements below, verification_verdict is a field the browser
-- can PATCH to 'verified' directly, which would make the Edge Function
-- decorative. So table-wide UPDATE comes off `authenticated`, and exactly the
-- six columns the app writes go back on — no more.
--
-- The list is what src/ writes, not "everything harmless-looking".
-- created_after_confirmation is why that distinction matters: it is the spec
-- section 7 flag that makes a task added at 9pm visible in the weekly review,
-- nothing in the app ever updates it (addTasks sets it on INSERT, which this
-- revoke does not touch), and granting UPDATE on it would let one devtools
-- PATCH clear the evidence. proof_hint and claude_suggested_tier are out for
-- the same reason.
--
-- Adding a column the app needs to update means adding it to this list too.
-- Forgetting shows up as a loud "permission denied for column …" from
-- PostgREST rather than as a silent no-op.
--
-- TO UNDO: grant update on public.tasks to authenticated;
revoke update on public.tasks from authenticated;
grant update (
  title,                      -- TaskReview, inline title edit
  tier,                       -- TaskReview, re-tiering before confirmation
  status,                     -- cancelTask, and claimTaskVerified's CAS
  verified_at,                -- claimTaskVerified's CAS, same write
  edited_after_confirmation,  -- updateTask's late-edit flag
  proof_urls                  -- ProofCapture, after the upload
) on public.tasks to authenticated;

-- ============================================================================
-- Storage
-- ============================================================================
-- The `proofs` bucket and its four policies live in
-- supabase/migration-06-proofs-bucket.sql rather than here, because they write
-- to the `storage` schema and can fail on their own permission grounds. Run
-- that file too — proof submission has nowhere to put a photo without it.
