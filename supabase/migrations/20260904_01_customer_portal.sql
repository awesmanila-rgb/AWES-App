-- Customer Portal — schema + RLS for read-only customer logins.
--
-- Run this once in Supabase Dashboard → SQL Editor, BEFORE creating any
-- customer login (profiles.role = 'customer'). Safe to re-run.
--
-- NOTE ON THE VENDOR-SUPPLIED migration.sql: it assumed profiles.role had
-- no CHECK constraint. Your live schema actually has one restricting it to
-- ('admin','technician') — inserting role='customer' would have been
-- rejected outright. Step 1 below widens that constraint first.

-- 1. Allow the new role value.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role = any (array['admin','technician','customer']));

-- 2. Link a login (profiles row) to a specific customer record.
alter table public.profiles add column if not exists customer_id uuid references public.customers(id);

-- 3. Link a service report directly to a customer, instead of relying on
--    the free-text cust_name match. Nullable so existing rows aren't broken.
alter table public.service_reports add column if not exists customer_id uuid references public.customers(id);

-- Backfill existing reports by matching their cust_name text to
-- customers.name. Spot-check afterward — anything that didn't match
-- (typos, inconsistent naming) is left with customer_id still null, and a
-- customer login won't see that report in their portal until it's fixed.
update public.service_reports sr
set customer_id = c.id
from public.customers c
where sr.customer_id is null
  and sr.cust_name = c.name;

-- 4. Row-level security — let a customer login read only their own rows.
-- customer_equipment and service_reports already have RLS enabled; these
-- are ADDITIONAL permissive policies alongside the existing tech/admin
-- ones (Postgres OR's multiple permissive policies together), so existing
-- admin/technician access is completely unaffected by this.
drop policy if exists "customers read own equipment" on public.customer_equipment;
create policy "customers read own equipment"
  on public.customer_equipment for select
  using (customer_id = (select customer_id from public.profiles where id = auth.uid()));

drop policy if exists "customers read own reports" on public.service_reports;
create policy "customers read own reports"
  on public.service_reports for select
  using (customer_id = (select customer_id from public.profiles where id = auth.uid()));

-- profiles' own self-select policy (profiles_select_technicians_public,
-- which already includes `id = auth.uid()`) and customers' own select
-- policy (customers_select_authenticated, `auth.role() = 'authenticated'`)
-- already cover what a logged-in customer needs to read for their own
-- profile row and customer record — no change needed there.

-- 5. Creating an actual customer login (repeat per customer, after the
-- above has been run — this is a manual/dashboard step, not something the
-- app's admin UI does, so admin-side behavior in the app itself doesn't
-- change):
--   a) Supabase Dashboard → Authentication → Users → Add user, with the
--      email + password you want that customer to sign in with.
--   b) insert into public.profiles (id, name, role, customer_id)
--      values ('<new auth user id from step a>', '<customer contact name>',
--              'customer', '<matching row id from public.customers>');
