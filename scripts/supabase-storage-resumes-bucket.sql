-- The private Storage bucket that holds resumes and LinkedIn profile exports,
-- plus the access rules that scope every object in it to the person it belongs
-- to. Created by JOB-007. JOB-002's review found the bucket did not exist in the
-- live project; `lib/db/schema.ts` has been describing objects in it since then.
--
-- Why this lives in a SQL file and not in the Drizzle schema: a bucket is a row
-- in `storage.buckets` and the rules are policies on `storage.objects`, both in
-- a schema Supabase owns. `drizzle.config.ts` sets `schemaFilter: ["public"]`
-- precisely so that Drizzle never tries to manage Supabase's own schemas, and
-- widening that filter to reach one bucket would hand Drizzle the authority to
-- drop everything else in there as drift.
--
-- Run it with `npm run db:storage-bucket`. It is written to be safe to run
-- again: every statement either upserts or drops and recreates. Nothing here
-- deletes an object or a bucket, so there is no destructive path to gate.
--
-- ── The path convention the policies enforce ────────────────────────────────
-- Every object is stored at `<auth.uid()>/<uuid>.pdf`. The first path segment
-- is the owner's user id, and that is not a naming convention the application
-- is trusted to follow, it is the thing the policies below actually check. An
-- upload to any other prefix is refused by the database, so a browser holding a
-- valid session still cannot write into somebody else's folder, and the server
-- action re-checks the same prefix before it records a path in `resumes`.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'resumes',
  'resumes',
  -- Private. A resume carries a real person's full name, phone number, home
  -- city and work history, and a public bucket serves any object in it to
  -- anyone who can guess the path. Reads go through a signed URL instead.
  false,
  -- 10 MB. Comfortably above any real resume and below the point where an
  -- upload is worth doing anything but rejecting.
  10485760,
  -- PDF only. Both uploads are documents that get parsed downstream, and the
  -- parser reads PDF. Narrowing the type here means a bad upload fails at the
  -- door rather than three steps later inside a running application.
  array['application/pdf']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- There is deliberately no `alter table storage.objects enable row level
-- security` here, and it is worth saying why rather than leaving its absence
-- to be read as an oversight. Supabase enables it on that table already, and
-- the statement cannot be run from this file anyway: `storage.objects` is owned
-- by `supabase_storage_admin`, not by `postgres`, and enabling RLS requires
-- ownership. Creating policies on it does not, which is why everything below
-- works from an ordinary migration connection. `npm run db:storage-bucket`
-- reads `relrowsecurity` back rather than trusting that it is still on.

drop policy if exists "resumes_select_own" on storage.objects;
create policy "resumes_select_own"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'resumes'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

drop policy if exists "resumes_insert_own" on storage.objects;
create policy "resumes_insert_own"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'resumes'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

-- No update policy and no delete policy, deliberately, and for the same reason
-- `applications` has no update policy: a resume is the document an application
-- was actually submitted with, and a run in flight may still be reading it.
-- Replacing a resume writes a new object under a new name and flips `is_active`
-- on the `resumes` row, which leaves the old file where it is. The cost is that
-- superseded files accumulate; reaping them is a job for something holding the
-- service role key, and it needs its own ticket rather than a policy that lets
-- a browser delete storage.
