-- Customer Portal — multiple customer records per login.
--
-- 20260904_01_customer_portal.sql gave each customer login exactly one
-- linked customer (profiles.customer_id, a single foreign key). Some
-- account holders manage more than one customer/site, so this migration
-- adds a join table and moves RLS onto it. Safe to re-run.
--
-- Run this AFTER 20260904_01_customer_portal.sql, and redeploy
-- admin-create-customer (its contract changed — see that function's
-- comments) before using the app's "Add a user" → Customer flow again.

-- 1. Join table: one row per (login, customer) pair a login can see.
create table if not exists public.customer_login_links (
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (profile_id, customer_id)
);
alter table public.customer_login_links enable row level security;

-- A customer login needs to read its own links client-side, to populate the
-- "viewing: [customer ▾]" switcher on the portal homepage. Admin access goes
-- through admin-create-customer's service-role key, which bypasses RLS
-- entirely, so no separate admin policy is needed here.
drop policy if exists "customer reads own links" on public.customer_login_links;
create policy "customer reads own links"
  on public.customer_login_links for select
  using (profile_id = auth.uid());

-- 2. Backfill: every existing single-customer login keeps working —
-- carry its old profiles.customer_id forward into one link row.
insert into public.customer_login_links (profile_id, customer_id)
select id, customer_id from public.profiles
where role = 'customer' and customer_id is not null
on conflict do nothing;

-- 3. customer_equipment / service_reports RLS — widen from "= the one
-- customer_id on my profile" to "any customer_id I'm linked to".
drop policy if exists "customers read own equipment" on public.customer_equipment;
create policy "customers read own equipment"
  on public.customer_equipment for select
  using (customer_id in (select customer_id from public.customer_login_links where profile_id = auth.uid()));

drop policy if exists "customers read own reports" on public.service_reports;
create policy "customers read own reports"
  on public.service_reports for select
  using (customer_id in (select customer_id from public.customer_login_links where profile_id = auth.uid()));

-- 4. profiles.customer_id is left in place (nothing drops it) but is no
-- longer written or read by the app as of this migration — every new
-- customer login the admin UI creates from here on is recorded only in
-- customer_login_links above, which is now the single source of truth for
-- "which customers can this login see".
