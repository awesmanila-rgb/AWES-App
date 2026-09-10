-- ---------------------------------------------------------------------
-- Service Requests — customer-filed, admin-only review (see
-- js/modules-src/service-requests.js and customer-portal.js).
--
-- Direction is the reverse of Leave/Cash Advance (technician files, admin
-- reviews) but scoped even tighter than that: unlike leave/cash-advance,
-- which technicians and admin both see, a service request is visible to
-- the filing customer and to admin ONLY — technicians never get a row
-- back from this table under RLS, even though they're the ones who may
-- eventually work the job once it's converted to a dispatch ticket.
--
-- Adds:
--   1. public.service_requests — one row per customer-submitted request.
--   2. RLS: customers insert/select their own rows; admin selects/updates
--      all rows; technicians get nothing (no policy grants them access).
--   3. Realtime — added to the supabase_realtime publication so admin's
--      dashboard badge/overview and the customer's own portal update the
--      instant a row changes, the same mechanism already used for
--      technician_locations (tracker.js) and dispatch_ticket_messages
--      (dispatch.js). Also (re)adds customer_equipment and service_reports
--      to the same publication, since customer-portal.js's realtime
--      subscriptions (added alongside this feature) depend on it and
--      those two tables were never explicitly published before.
--
-- Run this once in Supabase Dashboard → SQL Editor. Safe to re-run.
-- ---------------------------------------------------------------------

create table if not exists public.service_requests (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id),
  equipment_id uuid references public.customer_equipment(id), -- nullable: null = general inquiry, not tied to one unit
  description text not null,
  urgency text not null default 'normal' check (urgency = any (array['normal','urgent'])),
  requested_date date, -- customer's preferred date, optional
  status text not null default 'new'
    check (status = any (array['new','acknowledged','scheduled','in_progress','completed','cancelled'])),
  admin_notes text,
  linked_dispatch_ticket_id text, -- dispatch_tickets.id is a text JO- id, not uuid — see dispatch.js dtGenLocalId()
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists service_requests_customer_id_idx on public.service_requests(customer_id);
create index if not exists service_requests_status_idx on public.service_requests(status);

-- Keep updated_at current on every change, so "new since last check" /
-- ordering logic in the admin queue can rely on it later without each
-- caller having to remember to set it manually.
create or replace function public.service_requests_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists service_requests_set_updated_at on public.service_requests;
create trigger service_requests_set_updated_at
  before update on public.service_requests
  for each row execute function public.service_requests_touch_updated_at();

alter table public.service_requests enable row level security;

-- Customers: file their own requests and read only their own history.
-- No customer UPDATE/DELETE policy — once submitted, only admin moves the
-- status forward (or cancels it on the customer's behalf).
--
-- Uses customer_login_links, not profiles.customer_id — see
-- 20260905_customer_portal_multi_link.sql, which moved every other
-- customer-facing RLS policy (customer_equipment, service_reports) onto
-- that join table because one login can be linked to more than one
-- customer record. profiles.customer_id is no longer written or read by
-- the app; a policy still keyed on it would silently limit a multi-linked
-- login to only its original/single customer.
drop policy if exists "customers insert own service requests" on public.service_requests;
create policy "customers insert own service requests"
  on public.service_requests for insert to authenticated
  with check (customer_id in (select customer_id from public.customer_login_links where profile_id = auth.uid()));

drop policy if exists "customers read own service requests" on public.service_requests;
create policy "customers read own service requests"
  on public.service_requests for select to authenticated
  using (customer_id in (select customer_id from public.customer_login_links where profile_id = auth.uid()));

-- Admin: full read/write. Deliberately admin-only (not admin+technician
-- like some other tables) — technicians are not meant to see incoming
-- requests at all until admin converts one to a dispatch ticket they're
-- assigned to.
--
-- Uses public.is_admin() rather than a raw
-- "(select role from public.profiles where id = auth.uid()) = 'admin'"
-- subquery — that's the established helper this app's other RLS policies
-- already call (see 20260822_01_fixes_and_hardening.sql: it's SECURITY
-- DEFINER specifically so a policy can check the caller's role without
-- running into profiles' own RLS/recursion, and every other admin-gated
-- policy in this schema goes through it rather than querying profiles
-- directly).
drop policy if exists "admin read all service requests" on public.service_requests;
create policy "admin read all service requests"
  on public.service_requests for select to authenticated
  using (public.is_admin());

drop policy if exists "admin update service requests" on public.service_requests;
create policy "admin update service requests"
  on public.service_requests for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Realtime — idempotent adds; ALTER PUBLICATION ... ADD TABLE errors if the
-- table is already a member, so guard each one individually.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'service_requests'
  ) then
    alter publication supabase_realtime add table public.service_requests;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'customer_equipment'
  ) then
    alter publication supabase_realtime add table public.customer_equipment;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'service_reports'
  ) then
    alter publication supabase_realtime add table public.service_reports;
  end if;
end $$;
