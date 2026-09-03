-- ---------------------------------------------------------------------
-- Movement trail for the technician live tracker
--
-- technician_locations holds one row per technician (upserted on
-- technician_id) — the current dot on the admin map, nothing more. It has
-- no history, and it is NOT one of the twelve tables RLS was enabled on in
-- 20260822_01_fixes_and_hardening.sql, so as it stands any authenticated
-- user can read and write every technician's row.
--
-- This migration:
--   1. Locks down technician_locations the same way the other tables were
--      locked down (own-row read/write, admin reads all).
--   2. Adds an append-only technician_location_history table so the admin
--      map can draw where a technician has actually BEEN, not just where
--      they are right now — including points that were captured offline
--      and queued on the phone, which now arrive later carrying their
--      original capture time instead of being dropped.
--
-- Apply after 20260822_01_fixes_and_hardening.sql / _02_close_anon_roster.sql,
-- since it relies on public.is_admin() defined there.
-- ---------------------------------------------------------------------

-- 1. Secure the existing latest-position table -------------------------
alter table if exists public.technician_locations enable row level security;

drop policy if exists tlocations_insert_own on public.technician_locations;
create policy tlocations_insert_own on public.technician_locations
  for insert to authenticated
  with check (technician_id = auth.uid());

drop policy if exists tlocations_update_own on public.technician_locations;
create policy tlocations_update_own on public.technician_locations
  for update to authenticated
  using (technician_id = auth.uid())
  with check (technician_id = auth.uid());

drop policy if exists tlocations_select_own_or_admin on public.technician_locations;
create policy tlocations_select_own_or_admin on public.technician_locations
  for select to authenticated
  using (technician_id = auth.uid() or public.is_admin());

-- 2. Append-only movement history --------------------------------------
create table if not exists public.technician_location_history (
  id            bigint generated always as identity primary key,
  technician_id uuid not null references auth.users(id) on delete cascade,
  lat           double precision not null,
  lng           double precision not null,
  accuracy      double precision,
  heading       double precision,
  speed         double precision,
  recorded_at   timestamptz not null,        -- when the phone captured the point
  created_at    timestamptz not null default now()  -- when it reached the server
);

create index if not exists tlocation_history_tech_time_idx
  on public.technician_location_history (technician_id, recorded_at);

alter table public.technician_location_history enable row level security;

drop policy if exists tlhistory_insert_own on public.technician_location_history;
create policy tlhistory_insert_own on public.technician_location_history
  for insert to authenticated
  with check (technician_id = auth.uid());

drop policy if exists tlhistory_select_own_or_admin on public.technician_location_history;
create policy tlhistory_select_own_or_admin on public.technician_location_history
  for select to authenticated
  using (technician_id = auth.uid() or public.is_admin());

-- No update policy at all — a recorded point is never corrected, only
-- superseded by the next one. Admins get delete, for manual pruning.
drop policy if exists tlhistory_delete_admin on public.technician_location_history;
create policy tlhistory_delete_admin on public.technician_location_history
  for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------
-- Retention note: at one point roughly every 20s during an active shift,
-- one technician logs ~1,400 rows on an 8-hour day. Small per row, but it
-- adds up across a team over months. Nothing prunes this automatically —
-- if you want a rolling window, run something like this periodically
-- (pg_cron, or a scheduled Edge Function):
--
--   delete from public.technician_location_history
--   where recorded_at < now() - interval '90 days';
-- ---------------------------------------------------------------------
