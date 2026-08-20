-- ============================================================================
-- EarnedTime migration 01
-- Run in the Supabase SQL editor after schema.sql. Safe to re-run.
--
-- 1. tasks.proof_hint  — required by spec sections 6a/6b, missing from the
--    section 5 table listing.
-- 2. 'cancelled' status — a post-confirmation task can be cancelled but never
--    erased, so an abandoned task stays visible in the weekly review.
-- 3. Deletes allowed only while the day's list is unconfirmed. After
--    confirmation the only way out of a task is 'cancelled'.
-- ============================================================================

alter table public.tasks add column if not exists proof_hint text;

alter table public.tasks drop constraint if exists tasks_status_check;
alter table public.tasks add constraint tasks_status_check
  check (status in ('todo', 'pending', 'verified', 'rejected', 'cancelled'));

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
