-- ============================================================================
-- EarnedTime migration 03 — flag post-confirmation edits
-- Run after migration-02. Safe to re-run.
--
-- Spec section 4.2: "edits after confirmation allowed but flagged in the weekly
-- review". created_after_confirmation covered tasks ADDED late; retitling an
-- existing task was invisible. That matters in Weekend 2, where verify-proof
-- matches the photo against the title: do the easy task, retitle it to the hard
-- one, submit.
-- ============================================================================

alter table public.tasks
  add column if not exists edited_after_confirmation boolean not null default false;
