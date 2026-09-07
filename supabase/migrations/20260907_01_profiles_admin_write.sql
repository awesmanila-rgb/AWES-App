-- ---------------------------------------------------------------------
-- Fix: "Remove" and "Save Changes" in Manage Users -> User & Roles do
-- nothing (cloudSetUser / cloudDeleteUser both silently fail).
--
-- Root cause: public.profiles has a SELECT policy
-- (profiles_select_self_or_admin, see 20260822_02_close_anon_roster.sql)
-- but NO UPDATE or DELETE policy at all. With RLS enabled and no
-- permissive UPDATE/DELETE policy, every admin update/delete against
-- another user's profile row is blocked by Postgres before it even
-- reaches the trg_guard_profile trigger — the app's admin-only patch
-- goes nowhere and cloudSetUser()/cloudDeleteUser() return false.
--
-- This adds the missing policies, admin-only, mirroring the "for all"
-- shape already used elsewhere in this schema (see e.g. app_settings in
-- 20260822_01_fixes_and_hardening.sql). Password resets still go through
-- the admin-create-technician / admin-create-customer Edge Functions
-- (service-role key), not through these policies.
-- ---------------------------------------------------------------------

drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists profiles_admin_delete on public.profiles;
create policy profiles_admin_delete on public.profiles
  for delete to authenticated
  using (public.is_admin());

-- Verify (run as the admin role in supabase/verify/rls_probe.sql style):
--   update public.profiles set active=false where id='<some technician id>';
--   delete from public.profiles where id='<some removed user id>';
-- Both should now succeed for an admin and continue to fail for anyone else.
