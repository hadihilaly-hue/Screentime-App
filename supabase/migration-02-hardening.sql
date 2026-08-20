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
