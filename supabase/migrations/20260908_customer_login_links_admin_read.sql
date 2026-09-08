-- ---------------------------------------------------------------------
-- Fix: Manage Users -> Customer Portal Logins always shows "No customer
-- records linked", even right after assigning one.
--
-- Root cause: public.customer_login_links has exactly one RLS policy
-- ("customer reads own links", see 20260905_customer_portal_multi_link.sql),
-- scoped to `profile_id = auth.uid()`. That's correct for a customer login
-- reading its own rows, but the admin UI (cloudListCustomerLogins, in
-- js/modules-src/auth.js) queries this table directly from the client with
-- the ADMIN's own session, not through a service-role Edge Function. Since
-- auth.uid() there is the admin's id — never any customer login's id — the
-- policy matches zero rows for every login the admin looks at, regardless
-- of what's actually linked.
--
-- This adds an admin-only SELECT policy, mirroring the "for all" /
-- is_admin() shape already used elsewhere (see profiles_admin_update in
-- 20260907_01_profiles_admin_write.sql). The existing customer-facing
-- policy is untouched.
-- ---------------------------------------------------------------------

drop policy if exists "admin reads all links" on public.customer_login_links;
create policy "admin reads all links"
  on public.customer_login_links for select
  to authenticated
  using (public.is_admin());

-- Verify (run as the admin role in supabase/verify/rls_probe.sql style):
--   select * from public.customer_login_links; -- as admin: should now
--   return every row, not just rows where profile_id = the admin's own id.
