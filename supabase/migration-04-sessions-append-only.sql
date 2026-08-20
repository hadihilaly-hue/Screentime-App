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
-- rows instead of quietly moving the end time. Nothing in the app or the
-- extension updates a finished session, so this changes no working path:
--   - endStaleSessions (src/lib/db.ts) filters on ended_at is null.
--   - endSession (src/lib/db.ts) does not filter, but only ever targets a row
--     getActiveSession returned, and that query selects running sessions only.
--     It already treats zero rows as an error, so the one behaviour change is
--     that closing an already-closed session now says so instead of silently
--     moving its end time — which is the point.
--   - closeRefusedSession (extension/spend.js) filters on ended_at is null and
--     already treats "zero rows" as "not running", which is the outcome it
--     wants.
-- ============================================================================

drop policy if exists sessions_update on public.sessions;
create policy sessions_update on public.sessions
  for update using ((select auth.uid()) = user_id and ended_at is null)
                with check ((select auth.uid()) = user_id);
