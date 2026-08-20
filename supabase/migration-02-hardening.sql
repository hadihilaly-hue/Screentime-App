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

-- 2. Tasks can only be inserted dated today.
--    NOTE: this cannot be a CHECK constraint. Postgres requires functions in a
--    CHECK to be IMMUTABLE, and current_date is only STABLE, so
--    "check (date = current_date)" is rejected outright. An RLS policy may use
--    STABLE functions, so the guard goes there instead. It covers INSERT only —
--    deliberately not UPDATE, or marking a task done just after midnight would
--    fail its own with-check.
drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks
  for insert with check ((select auth.uid()) = user_id and date = current_date);

-- 3. The 60-minute daily earning cap (spec section 3), enforced in the database
--    rather than only in completeTask().
--    NOTE: section 3 says to tune these numbers after week 1. Changing the cap
--    now means editing this constraint, not just src/lib/constants.ts.
alter table public.balances drop constraint if exists balances_daily_cap;
alter table public.balances add constraint balances_daily_cap
  check (minutes_earned_total <= 60);
