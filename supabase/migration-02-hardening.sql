-- ============================================================================
-- EarnedTime migration 02 — anti-cheat hardening
-- Run in the Supabase SQL editor after schema.sql. Safe to re-run.
--
-- No triggers, no functions, no RPCs: Phase 1 enforcement is visibility
-- (spec section 7), and the project owner can bypass server logic anyway.
-- These are only the guards that cost nothing.
-- ============================================================================

-- 1. A confirmed day cannot be un-confirmed. The UPDATE policy stops matching
--    the row once list_confirmed is true, so the tasks_delete guard (which
--    depends on it) cannot be re-opened by flipping this back to false.
drop policy if exists daily_state_update on public.daily_state;
create policy daily_state_update on public.daily_state
  for update using ((select auth.uid()) = user_id and not list_confirmed)
                 with check ((select auth.uid()) = user_id);

-- 2. Tasks can only be inserted dated around today, closing the route of
--    backdating a task into a fresh daily cap.
--
--    NOTE 1: this is an RLS policy rather than a CHECK constraint on purpose.
--    A CHECK would work — Postgres does accept current_date in one — but it is
--    the wrong tool here for two reasons. A CHECK also fires on UPDATE, so it
--    would reject any edit to a task the moment the date rolls over, including
--    marking yesterday's task done at 00:01. And a date-dependent CHECK is a
--    restore hazard: COPY re-validates it, so a dump reloaded on a later day
--    fails on every row. RLS applies only to the commands its policy names.
--
--    NOTE 2: the window is +/- 1 day, not equality. The client sends the user's
--    LOCAL date while current_date here is the database's (UTC), and those
--    disagree for part of every day — in UTC-7, from 5pm local onwards UTC is
--    already tomorrow. Strict equality would reject every task created in the
--    evening. A one-day window absorbs every real timezone offset while still
--    blocking arbitrary backdating.
--
--    INSERT only, deliberately: on UPDATE it would make marking a task done
--    just after midnight fail its own with-check.
drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks
  for insert with check (
    (select auth.uid()) = user_id
    and date between current_date - 1 and current_date + 1
  );

-- 3. The 60-minute daily earning cap (spec section 3), enforced in the database
--    rather than only in completeTask().
--    NOTE: section 3 says to tune these numbers after week 1. Changing the cap
--    now means editing this constraint, not just src/lib/constants.ts.
alter table public.balances drop constraint if exists balances_daily_cap;
alter table public.balances add constraint balances_daily_cap
  check (minutes_earned_total between 0 and 60);
