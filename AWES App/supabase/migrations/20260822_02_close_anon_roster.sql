-- =====================================================================
-- AWES App — PART 2 of 2: close the anonymous technician-roster read
-- Target: Supabase project ugxrrgocjpkzumhghzat ("Awes Master App")
--
-- >>> DO NOT RUN THIS UNTIL BOTH OF THESE ARE TRUE: <<<
--   (a) the list-technicians Edge Function is deployed, and
--   (b) the NEW app bundle is the one being served.
--
-- The sign-in screen populates its technician picker while the visitor is still
-- anonymous. The old bundle does that by selecting straight from public.profiles,
-- which is exactly the read this file removes. The new bundle calls the
-- list-technicians Edge Function instead, which runs with the service-role key
-- and returns only {id, name}.
--
-- Run this against the old bundle and the sign-in dropdown will be empty.
--
-- Idempotent: safe to run more than once.
-- =====================================================================

begin;

-- Refuse to run if the roster is still being read directly by an old client.
-- (Advisory only - it cannot detect the client version, so the check above is
-- still yours to make.)
do $$
begin
  if not exists (select 1 from public.profiles where role = 'admin') then
    raise exception 'No profile with role=admin - refusing to tighten profiles policies.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- profiles — stop the anonymous roster read
-- The login screen populates its technician picker by selecting from profiles
-- while still anonymous. That is why the permissive policy exists. The
-- replacement path is supabase/functions/list-technicians, which runs with the
-- service-role key and returns only {id, name}. If you apply this section
-- before deploying that function, the technician dropdown on the sign-in screen
-- will come up empty.
--
-- To roll just this section back:
--   drop policy if exists profiles_select_self_or_admin on public.profiles;
--   create policy profiles_select_technicians_public on public.profiles
--     for select using ((role = 'technician') or (id = auth.uid()) or is_admin());
-- ---------------------------------------------------------------------
drop policy if exists profiles_select_technicians_public on public.profiles;
drop policy if exists profiles_select_self_or_admin      on public.profiles;

create policy profiles_select_self_or_admin on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

revoke all on public.profiles from anon;



commit;

-- =====================================================================
-- ROLLBACK — if the sign-in dropdown comes up empty, run this immediately:
--
--   drop policy if exists profiles_select_self_or_admin on public.profiles;
--   create policy profiles_select_technicians_public on public.profiles
--     for select using ((role = 'technician') or (id = auth.uid()) or is_admin());
--   grant select on public.profiles to anon;
--
-- That restores the previous behaviour exactly.
-- =====================================================================
