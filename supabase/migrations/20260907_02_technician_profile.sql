-- ---------------------------------------------------------------------
-- Technician Profile support: photo, violations record, and admin-uploaded
-- memo/documents. Attendance (dtr_records) and Leave (leave_requests)
-- already exist — this migration adds what's still missing.
--
-- Follows the existing base64-in-column pattern already used for cash
-- advance receipts and signatures (see cash-advance.js) rather than
-- introducing Supabase Storage buckets, to keep this app on one storage
-- model. Photos/memos are downscaled client-side before upload (see
-- js/modules-src/admin.js) so rows stay small.
--
-- Apply after 20260822_01_fixes_and_hardening.sql / _02_close_anon_roster.sql
-- (relies on public.is_admin()).
-- ---------------------------------------------------------------------

-- 1. Technician photo — one small extra column on the existing profile row.
alter table public.profiles add column if not exists photo_data text;
-- No new policy needed: profiles_select_self_or_admin (select) and
-- profiles_admin_update (update, added in 20260907_01) already cover this
-- column exactly like name/username/restrictions.

-- 2. Violations record — admin-authored, technician can view their own.
create table if not exists public.technician_violations (
  id            uuid primary key default gen_random_uuid(),
  technician_id uuid not null references auth.users(id) on delete cascade,
  occurred_on   date not null,
  description   text not null,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now()
);

create index if not exists tviolations_tech_idx on public.technician_violations (technician_id);

alter table public.technician_violations enable row level security;

drop policy if exists tviolations_select_own_or_admin on public.technician_violations;
create policy tviolations_select_own_or_admin on public.technician_violations
  for select to authenticated
  using (technician_id = auth.uid() or public.is_admin());

drop policy if exists tviolations_write_admin on public.technician_violations;
create policy tviolations_write_admin on public.technician_violations
  for insert to authenticated
  with check (public.is_admin());

drop policy if exists tviolations_update_admin on public.technician_violations;
create policy tviolations_update_admin on public.technician_violations
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists tviolations_delete_admin on public.technician_violations;
create policy tviolations_delete_admin on public.technician_violations
  for delete to authenticated
  using (public.is_admin());

-- 3. Memo / documents — admin uploads, technician can view (and download)
-- their own. file_data is a base64 data URL, same convention as cash
-- advance receipts; kept small since these are memos, not scans.
create table if not exists public.technician_documents (
  id            uuid primary key default gen_random_uuid(),
  technician_id uuid not null references auth.users(id) on delete cascade,
  title         text not null,
  file_data     text not null,
  uploaded_by   uuid references auth.users(id),
  created_at    timestamptz not null default now()
);

create index if not exists tdocuments_tech_idx on public.technician_documents (technician_id);

alter table public.technician_documents enable row level security;

drop policy if exists tdocuments_select_own_or_admin on public.technician_documents;
create policy tdocuments_select_own_or_admin on public.technician_documents
  for select to authenticated
  using (technician_id = auth.uid() or public.is_admin());

drop policy if exists tdocuments_write_admin on public.technician_documents;
create policy tdocuments_write_admin on public.technician_documents
  for insert to authenticated
  with check (public.is_admin());

drop policy if exists tdocuments_delete_admin on public.technician_documents;
create policy tdocuments_delete_admin on public.technician_documents
  for delete to authenticated
  using (public.is_admin());
-- No update policy: a memo is replaced by deleting and re-uploading, not edited in place.
