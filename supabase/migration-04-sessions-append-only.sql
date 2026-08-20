-- ============================================================================
-- Migration 04 — make the sessions log append-only in the database
--
-- Run this in the Supabase SQL editor if your database was created before this
-- change. Fresh projects get it from schema.sql and can skip it. Idempotent.
--
-- Until now, "a session's end time is written once and never rewritten" was a
-- client-side convention: every writer filtered on `ended_at is null` by hand,
-- and nothing stopped one that forgot. Spec section 7 wants the log to be the
-- record, so the rule belongs in the database.
--
-- After this, an UPDATE only matches a session that is still running. Stamping
-- ended_at works exactly as before; a second write to the same row matches zero
-- rows instead of quietly moving the end time.
--
-- One behaviour changes, and it is the intended one: closing an already-closed
-- session now fails loudly instead of silently rewriting its end time.
--   - endStaleSessions (src/lib/db.ts) filters on ended_at is null — unaffected.
--   - closeRefusedSession (extension/spend.js) filters on ended_at is null, and
--     reads the row back rather than assuming what zero rows meant — unaffected.
--   - endSession (src/lib/db.ts) does not filter. It normally targets a row
--     getActiveSession returned, and that query selects running sessions only.
--     But if another client closed that session first — two app tabs on the
--     TIME'S UP screen, or a tab left open overnight while another runs
--     endStaleSessions — the click now raises "Could not close that session."
--     where it previously succeeded by moving the end time. That write was the
--     one this migration exists to stop, so the new error is correct; it is
--     listed here because it is a real, if rare, user-visible change.
--   - closeRefusedSession (extension/spend.js) filters on ended_at is null and
--     already treats "zero rows" as "not running", which is the outcome it
--     wants.
-- ============================================================================

drop policy if exists sessions_update on public.sessions;
create policy sessions_update on public.sessions
  for update using ((select auth.uid()) = user_id and ended_at is null)
                with check ((select auth.uid()) = user_id);
