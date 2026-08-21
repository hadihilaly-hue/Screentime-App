-- ============================================================================
-- EarnedTime migration 05 — proof verification
-- Run in the Supabase SQL editor after migration-04. Safe to re-run.
--
-- Adds the columns Claude's verdict is written to, the attempt log the daily
-- cost guard counts, and the column privileges that make both of those mean
-- something. Storage is a separate file: migration-06-proofs-bucket.sql.
--
-- Nothing here touches balances, sessions or daily_state. The credit path is
-- unchanged: the app still calls completeTask(), which still claims the task
-- with a compare-and-swap and then credits the balance with another one. This
-- migration only decides whether that call is allowed to be made.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The verdict, on the task row
-- ---------------------------------------------------------------------------
-- verification_notes already exists (schema.sql, spec section 5) and is where
-- the one-line reason goes. The rest are new.
--
-- verification_verdict is deliberately NOT the same field as status. status is
-- the economy's state machine and is claimed by a compare-and-swap in
-- completeTask; verdict is what Claude said. Keeping them apart is what lets
-- the existing credit path stay untouched: the Edge Function writes the verdict
-- and stops, and the app calls the same completeTask it always called.
alter table public.tasks
  add column if not exists verification_verdict text,
  add column if not exists followup_question    text,
  add column if not exists followup_answer      text,
  add column if not exists verified_by_ai_at    timestamptz;

alter table public.tasks drop constraint if exists tasks_verification_verdict_check;
alter table public.tasks add constraint tasks_verification_verdict_check
  check (verification_verdict is null
         or verification_verdict in ('verified', 'rejected', 'needs_followup'));

-- ---------------------------------------------------------------------------
-- 2. The attempt log
-- ---------------------------------------------------------------------------
-- One row per call to the Edge Function that actually reached the Anthropic
-- API, successfully or not. Two jobs: it is the counter behind the three-a-day
-- guard, and it is the record of what was tried (spec section 7 — everything is
-- logged, nothing is deletable).
create table if not exists public.verification_attempts (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users (id) on delete cascade,
  task_id     uuid        not null references public.tasks (id) on delete cascade,
  -- Named `day`, not `date`, because unlike every other date column in this
  -- schema it is the DATABASE's date (UTC), not the user's local one. It has to
  -- be: a guard that resets when the phone's clock says so is not a guard. The
  -- practical consequence is that the three attempts reset at UTC midnight,
  -- which is early evening in the US, not at your midnight. This is a cost
  -- ceiling, not part of the schedule, so that is an acceptable seam.
  day         date        not null default current_date,
  verdict     text,
  reason      text,
  photo_count smallint,
  is_followup boolean     not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists verification_attempts_task_day_idx
  on public.verification_attempts (task_id, day);

alter table public.verification_attempts enable row level security;

-- You can read your own attempts. That is the whole policy list, on purpose:
-- with no insert, update or delete policy, an ordinary signed-in client cannot
-- add a row, edit one, or delete one. Only the Edge Function can, because it
-- writes with the service_role key, which bypasses RLS. If the client could
-- write this table the daily guard would be advisory — you could delete the
-- three rows and start again.
drop policy if exists verification_attempts_select on public.verification_attempts;
create policy verification_attempts_select on public.verification_attempts
  for select using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- 3. Column privileges: the verdict is server-written
-- ---------------------------------------------------------------------------
-- RLS is row-level; it cannot say "this row is yours but that column is not".
-- Column privileges can, and without them "Claude said verified" is a field the
-- browser can PATCH to whatever it likes — which would make the whole Edge
-- Function decorative.
--
-- So: take table-wide UPDATE away from `authenticated`, and hand back exactly
-- the six columns the app actually writes — no more. The verification columns
-- can then only be written by the Edge Function's service_role client.
--
-- The list is exactly what src/ writes, not "everything that looked harmless".
-- created_after_confirmation is the reason that distinction matters: it is the
-- spec section 7 flag that makes a task added at 9pm visible to future-you in
-- the weekly review, nothing in the app ever updates it (addTasks sets it on
-- INSERT, which this revoke does not touch), and granting UPDATE on it would
-- mean one devtools PATCH clears the evidence. proof_hint and
-- claude_suggested_tier are out for the same reason: unwritten by the app, and
-- both are inputs the verifier and the weekly review read.
--
-- NOTE FOR LATER: adding a column that the app needs to update means adding it
-- to this grant list too. Forgetting shows up as a loud
-- "permission denied for column …" from PostgREST, not as a silent no-op.
--
-- TO UNDO all of this: grant update on public.tasks to authenticated;
revoke update on public.tasks from authenticated;
grant update (
  title,                      -- TaskReview, inline title edit
  tier,                       -- TaskReview, re-tiering before confirmation
  status,                     -- cancelTask, and claimTaskVerified's CAS
  verified_at,                -- claimTaskVerified's CAS, same write
  edited_after_confirmation,  -- updateTask's late-edit flag
  proof_urls                  -- ProofCapture, after the upload
) on public.tasks to authenticated;

-- Sanity note on what stays possible for the app after the revoke:
--   * TaskReview edits title and tier                     — granted
--   * updateTask flags edited_after_confirmation          — granted
--   * cancelTask writes status                            — granted
--   * claimTaskVerified writes status + verified_at       — granted (the CAS)
--   * ProofCapture writes proof_urls                      — granted
--   * addTasks sets created_after_confirmation on INSERT  — unaffected
--   * anything UPDATING created_after_confirmation, proof_hint,
--     claude_suggested_tier, verification_verdict, verification_notes,
--     followup_question, followup_answer or verified_by_ai_at
--                                                          — denied, by design
--
-- Re-running this file after an earlier version repairs the grant: the revoke
-- drops every column-level privilege, and only the six above come back.
