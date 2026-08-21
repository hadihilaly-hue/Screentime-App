-- ============================================================================
-- EarnedTime migration 06 — the `proofs` storage bucket
-- Run in the Supabase SQL editor after migration-05. Safe to re-run.
--
-- Separate from migration-05 because this writes to the `storage` schema rather
-- than `public`, and because if your project's SQL editor role is not allowed
-- to create policies on storage.objects you want that failure on its own,
-- pointing at one file, rather than half-way through a schema change.
--
-- If part 2 below fails with "must be owner of table objects", create the four
-- policies through the dashboard instead: Storage → Policies → `proofs` → New
-- policy, one per operation, with the same USING / WITH CHECK expression given
-- under each policy here.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The bucket — private
-- ---------------------------------------------------------------------------
-- public = false means there is no unauthenticated URL for these files at all.
-- Reading one requires either a signed URL or a request carrying the owner's
-- JWT. Photos of a teenager's homework should not be a guessable URL.
--
-- The `on conflict` clause is what makes this re-runnable AND makes it repair a
-- bucket that already exists as public — the dangerous direction to leave alone.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'proofs',
  'proofs',
  false,
  5242880,                                  -- 5 MB per file. The client targets
                                            -- ~1 MB after downscaling; this is
                                            -- the backstop for when it does not.
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 2. Policies — you reach your own folder and nothing else
-- ---------------------------------------------------------------------------
-- Object names are `{user_id}/{task_id}/{n}.jpg`, so the first path segment is
-- the owner's uid. storage.foldername(name) splits the path; [1] is that first
-- segment. Comparing it to auth.uid() is the whole rule.
--
-- The Edge Function does not rely on these: it reads with the service_role key,
-- which bypasses RLS. They exist for the browser, which uploads with the user's
-- own token.

-- Upload.
drop policy if exists proofs_insert on storage.objects;
create policy proofs_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'proofs'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Read back. Not for the thumbnails — those are local blob URLs made from the
-- photo before it is ever uploaded, and never come from Storage. This exists
-- because the app LISTS this folder before every submission, to clear the
-- previous attempt's photos (clearFolder in src/lib/proof.ts), and a list is a
-- select. It is also what any signed URL would need.
drop policy if exists proofs_select on storage.objects;
create policy proofs_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'proofs'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Overwrite. Needed because re-submitting after a rejection uploads
-- `{n}.jpg` over the previous `{n}.jpg` — upsert is an UPDATE when the object
-- already exists.
drop policy if exists proofs_update on storage.objects;
create policy proofs_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'proofs'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'proofs'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Delete. Needed for one specific case: re-submitting FEWER photos than last
-- time. The Edge Function reads whatever is in the folder, so a third photo
-- left over from a rejected three-photo attempt would be sent alongside a new
-- two-photo one. The app clears the folder before each upload.
--
-- This is the one place in EarnedTime where something is deletable, and it is
-- worth naming: spec section 7 says the record is not erasable, and a replaced
-- proof photo is genuinely gone. What survives is the attempt log — every
-- submission, its verdict and its reason stay in verification_attempts, which
-- the client cannot write or delete at all. The photos are evidence for one
-- decision; the decisions are the record.
drop policy if exists proofs_delete on storage.objects;
create policy proofs_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'proofs'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
