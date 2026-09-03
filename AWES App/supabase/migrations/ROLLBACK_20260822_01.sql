-- =====================================================================
-- ROLLBACK for 20260822_01_fixes_and_hardening.sql
--
-- Restores the exact policy set, function volatility and grants that were in
-- place on Supabase project ugxrrgocjpkzumhghzat before Part 1 was applied,
-- as captured from the live catalogs on 2026-08-22.
--
-- Only use this if Part 1 causes a problem in production. Note that running it
-- REOPENS the "anon full access" hole on dispatch_tickets and jo_counters, and
-- re-breaks SR numbering for technicians. It is a safety net, not a target state.
-- =====================================================================

begin;

-- --- guard triggers and their functions -------------------------------
drop trigger  if exists trg_guard_dispatch on public.dispatch_tickets;
drop trigger  if exists trg_guard_leave    on public.leave_requests;
drop trigger  if exists trg_guard_cash     on public.cash_advance_requests;
drop trigger  if exists trg_guard_profile  on public.profiles;
drop function if exists public.guard_dispatch_worker_fields();
drop function if exists public.guard_leave_decision();
drop function if exists public.guard_cash_decision();
drop function if exists public.guard_profile_privileges();
drop function if exists public.has_restriction(text);

-- --- counter RPCs back to SECURITY INVOKER ----------------------------
create or replace function public.next_sr_no(p_date date)
returns text language plpgsql as $$
declare
  v_key text := to_char(p_date, 'YYYYMMDD');
  v_seq int;
begin
  insert into public.sr_counters(date_key, seq) values (v_key, 1)
  on conflict (date_key) do update set seq = public.sr_counters.seq + 1
  returning seq into v_seq;
  return 'SR-' || v_key || '-' || lpad(v_seq::text, 3, '0');
end; $$;

create or replace function public.next_jo_no(p_date date)
returns text language plpgsql as $$
declare next_seq int;
begin
  insert into public.jo_counters (the_date, seq) values (p_date, 1)
  on conflict (the_date) do update set seq = public.jo_counters.seq + 1
  returning seq into next_seq;
  return 'JO-' || to_char(p_date, 'YYYYMMDD') || '-' || lpad(next_seq::text, 3, '0');
end; $$;

grant execute on function public.next_sr_no(date) to public, anon, authenticated, service_role;
grant execute on function public.next_jo_no(date) to public, anon, authenticated, service_role;

-- --- dispatch_tickets: restore the original wide-open policy ----------
drop policy if exists dispatch_select_assigned on public.dispatch_tickets;
drop policy if exists dispatch_insert_admin    on public.dispatch_tickets;
drop policy if exists dispatch_update_assigned on public.dispatch_tickets;
drop policy if exists dispatch_delete_admin    on public.dispatch_tickets;
create policy "anon full access" on public.dispatch_tickets
  for all using (true) with check (true);

-- --- jo_counters ------------------------------------------------------
drop policy if exists jo_counters_admin_only on public.jo_counters;
create policy "anon full access" on public.jo_counters
  for all using (true) with check (true);
grant all on public.jo_counters to anon;

-- --- sr_counters ------------------------------------------------------
drop policy if exists sr_counters_admin_only on public.sr_counters;
create policy sr_counters_admin_only on public.sr_counters
  for all using (is_admin());
grant all on public.sr_counters to anon;

-- --- leave / cash advance update policies -----------------------------
drop policy if exists cash_update_own_or_admin on public.cash_advance_requests;
create policy cash_update_admin_only on public.cash_advance_requests
  for update using (is_admin());

drop policy if exists leave_update_own_or_admin on public.leave_requests;
create policy leave_update_admin_only on public.leave_requests
  for update using (is_admin());

-- --- app_settings -----------------------------------------------------
drop policy if exists settings_select_nonsecret on public.app_settings;
create policy settings_select_authenticated on public.app_settings
  for select using (auth.role() = 'authenticated');
grant all on public.app_settings to anon;

-- --- search_path pins on the pre-existing definer functions -----------
alter function public.is_admin() reset search_path;
alter function public.clear_my_must_change_password() reset search_path;

-- Note: the added indexes and the service_reports.is_install column are left in
-- place on purpose. Both are additive and harmless, and dropping is_install
-- would discard any installation flags already saved by the new bundle.

commit;
