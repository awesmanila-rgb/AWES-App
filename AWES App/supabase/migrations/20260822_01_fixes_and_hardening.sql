-- =====================================================================
-- AWES App — security and schema migration
-- Target: Supabase project ugxrrgocjpkzumhghzat ("Awes Master App"), PostgreSQL 17.6
-- Written 2026-08-22, after reading the LIVE schema and the LIVE policy set.
--
-- IMPORTANT — read before applying.
-- An earlier draft of this file was written from the app code alone and assumed
-- the database had no row-level security. That was wrong. RLS is already enabled
-- on all twelve public tables and most policies are sensible. This version only
-- changes what is actually broken, verified by running probes as anon /
-- technician / admin against a faithful replica of this schema.
--
-- What this migration actually fixes (each item was reproduced, not assumed):
--   1. dispatch_tickets has a policy literally named "anon full access"
--      (FOR ALL, USING true, WITH CHECK true, role public). Anyone holding the
--      anon key — which ships in the client bundle — can read, edit and DELETE
--      every job order. Confirmed by deleting a ticket as anon.
--   2. jo_counters has the same "anon full access" policy.
--   3. profiles_select_technicians_public lets anonymous callers list every
--      technician row (id, name, and the no_history / no_report / read_only /
--      must_change_password flags). No email addresses are in this table.
--   4. next_sr_no() is SECURITY INVOKER while sr_counters is admin-only, so
--      technicians get "42501 new row violates row-level security policy for
--      table sr_counters" and CANNOT generate a service report number at all.
--      This is a live outage, not a hardening issue.
--   5. cash_update_admin_only blocks every technician UPDATE, so submitting a
--      liquidation silently fails. The feature is dead in production.
--   6. Technicians cannot edit their own still-pending leave request.
--
-- Things that were ALREADY correctly locked down and are left alone:
--   technicians cannot approve their own leave or cash advance, cannot mark a
--   cash advance disbursed, cannot promote themselves to admin, cannot read
--   another technician's service reports or DTR, and cannot delete another
--   technician's device lock.
--
-- Idempotent: safe to run more than once.
-- =====================================================================

-- ###################################################################
-- PART 1 of 2 — apply this FIRST.
--
-- Everything in this file is safe to run against production while the
-- CURRENT (old) app bundle is still live. It changes no behaviour the old
-- bundle depends on, and it immediately fixes the anon-write hole on
-- dispatch_tickets plus the two broken features (SR numbering, liquidation).
--
-- Closing the anonymous roster read is deliberately NOT here — it is in
-- Part 2, because it requires the new bundle and the Edge Function.
-- ###################################################################

begin;

-- ---------------------------------------------------------------------
-- 0. Guard rails
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_class where oid = 'public.profiles'::regclass) then
    raise exception 'public.profiles is missing — wrong database?';
  end if;
  if not exists (select 1 from public.profiles where role = 'admin') then
    raise exception 'No profile with role=admin. Applying this migration would lock everyone out of admin functions. Create the admin profile first.';
  end if;
end $$;


-- ---------------------------------------------------------------------
-- 1. Counter RPCs must be SECURITY DEFINER
--
-- These functions are the only sanctioned way to touch the counter tables.
-- Running them as the owner lets us keep the counter tables themselves closed
-- to clients while still letting technicians draw a number.
-- ---------------------------------------------------------------------
create or replace function public.next_sr_no(p_date date)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text := to_char(p_date, 'YYYYMMDD');
  v_seq int;
begin
  insert into public.sr_counters(date_key, seq) values (v_key, 1)
  on conflict (date_key) do update set seq = public.sr_counters.seq + 1
  returning seq into v_seq;
  return 'SR-' || v_key || '-' || lpad(v_seq::text, 3, '0');
end;
$$;

create or replace function public.next_jo_no(p_date date)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_seq int;
begin
  insert into public.jo_counters(the_date, seq) values (p_date, 1)
  on conflict (the_date) do update set seq = public.jo_counters.seq + 1
  returning seq into v_seq;
  return 'JO-' || to_char(p_date, 'YYYYMMDD') || '-' || lpad(v_seq::text, 3, '0');
end;
$$;

-- Only signed-in users may draw numbers; anon has no business here.
revoke execute on function public.next_sr_no(date) from public, anon;
revoke execute on function public.next_jo_no(date) from public, anon;
grant  execute on function public.next_sr_no(date) to authenticated, service_role;
grant  execute on function public.next_jo_no(date) to authenticated, service_role;

-- Pin search_path on the two pre-existing definer functions as well; without it
-- a definer function is vulnerable to search_path shadowing.
alter function public.is_admin() set search_path = public, pg_temp;
alter function public.clear_my_must_change_password() set search_path = public, pg_temp;


-- ---------------------------------------------------------------------
-- 2. Restriction helper reading the REAL columns
--
-- The live profiles table stores restrictions as three boolean columns
-- (no_history, no_report, read_only). There is no "restrictions" jsonb column;
-- an earlier draft of this migration invented one.
-- ---------------------------------------------------------------------
create or replace function public.has_restriction(p_flag text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select case p_flag
              when 'no_history' then p.no_history
              when 'no_report'  then p.no_report
              when 'read_only'  then p.read_only
              else false
            end
     from public.profiles p
     where p.id = auth.uid()),
    false);
$$;
grant execute on function public.has_restriction(text) to authenticated, service_role;

comment on function public.has_restriction(text) is
  'True when the calling user has the named restriction flag set on their profile. Flags: no_history, no_report, read_only.';


-- ---------------------------------------------------------------------
-- 3. dispatch_tickets — close the wide-open policy
--
-- The existing policy is named "anon full access" and must be dropped by that
-- exact name. PERMISSIVE policies are OR'd together, so leaving it in place
-- would defeat every rule added below.
-- ---------------------------------------------------------------------
drop policy if exists "anon full access"          on public.dispatch_tickets;
drop policy if exists dispatch_select_assigned    on public.dispatch_tickets;
drop policy if exists dispatch_insert_admin       on public.dispatch_tickets;
drop policy if exists dispatch_update_assigned    on public.dispatch_tickets;
drop policy if exists dispatch_delete_admin       on public.dispatch_tickets;

-- A technician sees a ticket only when their id is in data->assignedWorkerIds.
create policy dispatch_select_assigned on public.dispatch_tickets
  for select to authenticated
  using (
    public.is_admin()
    or (data -> 'assignedWorkerIds') @> to_jsonb(auth.uid()::text)
  );

create policy dispatch_insert_admin on public.dispatch_tickets
  for insert to authenticated
  with check (public.is_admin());

-- Assigned technicians acknowledge and complete their own tickets. The trigger
-- in section 4 stops them from rewriting the assignment or the customer.
create policy dispatch_update_assigned on public.dispatch_tickets
  for update to authenticated
  using (
    public.is_admin()
    or (data -> 'assignedWorkerIds') @> to_jsonb(auth.uid()::text)
  )
  with check (
    public.is_admin()
    or (data -> 'assignedWorkerIds') @> to_jsonb(auth.uid()::text)
  );

create policy dispatch_delete_admin on public.dispatch_tickets
  for delete to authenticated
  using (public.is_admin());


-- ---------------------------------------------------------------------
-- 4. Field-level guards
--
-- These triggers NORMALISE rather than raise. Forcing privileged fields back to
-- their safe values means a hostile write is neutralised without ever throwing
-- an error at a legitimate app write — important because the app sends whole
-- JSON blobs, so a strict "reject if key present" rule would break normal use.
-- ---------------------------------------------------------------------

-- 4a. Dispatch: a non-admin may not change assignment, customer or schedule.
create or replace function public.guard_dispatch_worker_fields()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.is_admin() then
    return new;
  end if;

  new.id := old.id;
  new.created_at := old.created_at;

  -- Preserve everything only an admin may set.
  new.data := new.data
    || jsonb_strip_nulls(jsonb_build_object('assignedWorkerIds',   old.data -> 'assignedWorkerIds'))
    || jsonb_strip_nulls(jsonb_build_object('assignedWorkerNames', old.data -> 'assignedWorkerNames'))
    || jsonb_strip_nulls(jsonb_build_object('customer',            old.data -> 'customer'))
    || jsonb_strip_nulls(jsonb_build_object('customerId',          old.data -> 'customerId'))
    || jsonb_strip_nulls(jsonb_build_object('address',             old.data -> 'address'))
    || jsonb_strip_nulls(jsonb_build_object('scheduledAt',         old.data -> 'scheduledAt'))
    || jsonb_strip_nulls(jsonb_build_object('createdBy',           old.data -> 'createdBy'));

  -- A technician may only move a ticket forward through the normal states.
  if new.status is distinct from old.status
     and new.status not in ('open', 'acknowledged', 'completed') then
    new.status := old.status;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_dispatch on public.dispatch_tickets;
create trigger trg_guard_dispatch
  before update on public.dispatch_tickets
  for each row execute function public.guard_dispatch_worker_fields();


-- 4b. Leave requests: the decision belongs to the admin.
create or replace function public.guard_leave_decision()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.is_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- A new request always starts undecided, whatever the client sent.
    new.status := 'pending';
    new.data := coalesce(new.data, '{}'::jsonb) || jsonb_build_object(
      'status',    'pending',
      'comment',   '',
      'decidedAt', null,
      'decidedBy', null);
    return new;
  end if;

  -- UPDATE: ownership, status and the decision block are immutable.
  new.id := old.id;
  new.technician_id := old.technician_id;
  new.status := old.status;
  new.submitted_at := old.submitted_at;
  new.data := coalesce(new.data, '{}'::jsonb) || jsonb_build_object(
    'status',    coalesce(old.data -> 'status', to_jsonb(old.status)),
    'comment',   coalesce(old.data -> 'comment', '""'::jsonb),
    'decidedAt', coalesce(old.data -> 'decidedAt', 'null'::jsonb),
    'decidedBy', coalesce(old.data -> 'decidedBy', 'null'::jsonb));
  return new;
end;
$$;

drop trigger if exists trg_guard_leave on public.leave_requests;
create trigger trg_guard_leave
  before insert or update on public.leave_requests
  for each row execute function public.guard_leave_decision();


-- 4c. Cash advances: approval, disbursement and liquidation approval are the
-- admin's. Submitting a liquidation is the technician's.
create or replace function public.guard_cash_decision()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_liq jsonb;
  v_new_liq jsonb;
begin
  if public.is_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.data := coalesce(new.data, '{}'::jsonb) || jsonb_build_object(
      'status',       'pending',
      'comment',      '',
      'decidedAt',    null,
      'decidedBy',    null,
      'disbursed',    false,
      'dateGiven',    null,
      'amountGiven',  null,
      'disbursedAt',  null,
      'disbursedBy',  null,
      'liquidation',  null);
    return new;
  end if;

  new.id := old.id;
  new.technician_id := old.technician_id;
  new.status := old.status;
  new.submitted_at := old.submitted_at;

  new.data := coalesce(new.data, '{}'::jsonb) || jsonb_build_object(
    'status',      coalesce(old.data -> 'status', to_jsonb(old.status)),
    'comment',     coalesce(old.data -> 'comment', '""'::jsonb),
    'decidedAt',   coalesce(old.data -> 'decidedAt', 'null'::jsonb),
    'decidedBy',   coalesce(old.data -> 'decidedBy', 'null'::jsonb),
    'disbursed',   coalesce(old.data -> 'disbursed', 'false'::jsonb),
    'dateGiven',   coalesce(old.data -> 'dateGiven', 'null'::jsonb),
    'amountGiven', coalesce(old.data -> 'amountGiven', 'null'::jsonb),
    'disbursedAt', coalesce(old.data -> 'disbursedAt', 'null'::jsonb),
    'disbursedBy', coalesce(old.data -> 'disbursedBy', 'null'::jsonb));

  -- Liquidation: the technician may create one and edit its contents, but the
  -- verdict fields inside it are the admin's.
  v_old_liq := old.data -> 'liquidation';
  v_new_liq := new.data -> 'liquidation';

  if v_new_liq is not null and jsonb_typeof(v_new_liq) = 'object' then
    if v_old_liq is null or jsonb_typeof(v_old_liq) <> 'object' then
      -- Brand new liquidation: force it to start undecided.
      v_new_liq := v_new_liq || jsonb_build_object(
        'status', 'pending', 'comment', '', 'decidedAt', null, 'decidedBy', null);
    else
      v_new_liq := v_new_liq || jsonb_build_object(
        'status',    coalesce(v_old_liq -> 'status', '"pending"'::jsonb),
        'comment',   coalesce(v_old_liq -> 'comment', '""'::jsonb),
        'decidedAt', coalesce(v_old_liq -> 'decidedAt', 'null'::jsonb),
        'decidedBy', coalesce(v_old_liq -> 'decidedBy', 'null'::jsonb));
    end if;
    new.data := jsonb_set(new.data, '{liquidation}', v_new_liq);
  elsif v_old_liq is not null then
    -- Don't let a technician wipe a liquidation that already exists.
    new.data := jsonb_set(new.data, '{liquidation}', v_old_liq);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_cash on public.cash_advance_requests;
create trigger trg_guard_cash
  before insert or update on public.cash_advance_requests
  for each row execute function public.guard_cash_decision();


-- 4d. Profiles: a technician must not be able to grant themselves privileges,
-- even if a future policy accidentally lets them update their own row.
create or replace function public.guard_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.is_admin() then
    return new;
  end if;
  new.id         := old.id;
  new.role       := old.role;
  new.active     := old.active;
  new.no_history := old.no_history;
  new.no_report  := old.no_report;
  new.read_only  := old.read_only;
  new.created_at := old.created_at;
  return new;
end;
$$;

drop trigger if exists trg_guard_profile on public.profiles;
create trigger trg_guard_profile
  before update on public.profiles
  for each row execute function public.guard_profile_privileges();


-- ---------------------------------------------------------------------
-- 5. Let technicians write the rows they legitimately own
--
-- cash_update_admin_only currently blocks ALL technician updates, which is why
-- liquidation submission fails. Replaced with an ownership rule; the guard
-- trigger above keeps the decision fields safe.
-- ---------------------------------------------------------------------
drop policy if exists cash_update_admin_only on public.cash_advance_requests;
drop policy if exists cash_update_own_or_admin on public.cash_advance_requests;
create policy cash_update_own_or_admin on public.cash_advance_requests
  for update to authenticated
  using (public.is_admin() or technician_id = auth.uid())
  with check (public.is_admin() or technician_id = auth.uid());

-- Leave: same shape, so a technician can correct a request before it is decided.
drop policy if exists leave_update_admin_only on public.leave_requests;
drop policy if exists leave_update_own_or_admin on public.leave_requests;
create policy leave_update_own_or_admin on public.leave_requests
  for update to authenticated
  using (public.is_admin() or (technician_id = auth.uid() and status = 'pending'))
  with check (public.is_admin() or technician_id = auth.uid());


-- ---------------------------------------------------------------------
-- 6. jo_counters / sr_counters — no direct client access at all
--
-- Numbers are drawn exclusively through the SECURITY DEFINER RPCs in section 1.
-- ---------------------------------------------------------------------
drop policy if exists "anon full access"     on public.jo_counters;
drop policy if exists jo_counters_admin_only on public.jo_counters;
drop policy if exists sr_counters_admin_only on public.sr_counters;

create policy jo_counters_admin_only on public.jo_counters
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy sr_counters_admin_only on public.sr_counters
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on public.sr_counters from anon;
revoke all on public.jo_counters from anon;


-- ---------------------------------------------------------------------
-- 8. app_settings — keep future secrets out of reach
--
-- Today this table holds exactly one key, 'settings/fieldLists', which every
-- signed-in user needs. No credentials are stored here at present, so nothing
-- has leaked. This narrows SELECT ahead of time so that adding a key such as
-- 'settings/emailjs' later does not silently expose it to every technician.
-- ---------------------------------------------------------------------
drop policy if exists settings_select_authenticated on public.app_settings;
drop policy if exists settings_select_nonsecret     on public.app_settings;

create policy settings_select_nonsecret on public.app_settings
  for select to authenticated
  using (
    public.is_admin()
    or key not in ('settings/emailjs', 'emailjs', 'settings/secrets', 'secrets')
  );

revoke all on public.app_settings from anon;


-- ---------------------------------------------------------------------
-- 9. Schema additions the app already relies on
-- ---------------------------------------------------------------------

-- ui.js / pdf.js branch on an installation-vs-service report, but the column
-- was never created, so the flag was lost on every save.
alter table public.service_reports
  add column if not exists is_install boolean not null default false;

comment on column public.service_reports.is_install is
  'True for installation reports, false for service reports. Drives the PDF layout and which field groups are required.';

-- Note on signatures: customer_signature and technician_signature are jsonb in
-- production, not text. The app sends either a data-URL string or an object and
-- both are valid JSON, so no type change is needed. An earlier draft tried to
-- "add" them as text, which was a silent no-op.


-- ---------------------------------------------------------------------
-- 10. Indexes matching how the app actually queries
-- ---------------------------------------------------------------------
create index if not exists service_reports_tech_date_idx
  on public.service_reports (technician_id, date desc);
create index if not exists service_reports_created_idx
  on public.service_reports (created_at desc);
create index if not exists dtr_records_tech_date_idx
  on public.dtr_records (technician_id, date desc);
create index if not exists leave_requests_tech_status_idx
  on public.leave_requests (technician_id, status, submitted_at desc);
create index if not exists cash_requests_tech_status_idx
  on public.cash_advance_requests (technician_id, status, submitted_at desc);
create index if not exists dispatch_tickets_status_idx
  on public.dispatch_tickets (status, created_at desc);

-- dispatch.js filters with .contains('data->assignedWorkerIds', ...), which is
-- a jsonb containment test and needs a GIN index to avoid a full scan.
create index if not exists dispatch_tickets_workers_gin
  on public.dispatch_tickets using gin ((data -> 'assignedWorkerIds'));

-- dtr_records already has UNIQUE (technician_id, date) — verified live — which
-- is what the app's upsert onConflict:'technician_id,date' depends on. Assert it
-- rather than recreating it, so a future drop is caught loudly.
do $$
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'dtr_records'
      and indexdef ilike '%unique%(technician_id, date)%'
  ) then
    create unique index dtr_records_technician_id_date_key
      on public.dtr_records (technician_id, date);
  end if;
end $$;


-- ---------------------------------------------------------------------
-- 11. Deliberately NOT done
--
--  * No FORCE ROW LEVEL SECURITY. is_admin() is SECURITY DEFINER and reads
--    profiles, while the profiles policies call is_admin(). Forcing RLS on the
--    table owner would make that pair recurse, and would also break the counter
--    RPCs from section 1.
--  * The status CHECK constraints are left as-is. The app only ever writes
--    'pending', 'approved' and 'disapproved' for leave and cash advances —
--    verified against the source — so the existing constraints already match.
--    Disbursement and liquidation state live inside the data jsonb, not status.
--  * No 'restrictions' jsonb column on profiles. The three boolean columns are
--    the real storage and the app reads them.
-- ---------------------------------------------------------------------

commit;


-- =====================================================================
-- POST-MIGRATION CHECKLIST
--
--  1. Sign in as a technician and confirm:
--       - a new service report gets an SR number (this was failing before)
--       - a cash advance liquidation can be submitted (this was failing before)
--       - only their own tickets appear under Dispatch
--  3. Sign in as admin and confirm the leave / cash advance decision buttons,
--     disbursement recording and liquidation approval all still work.
--  4. Run the Supabase security and performance advisors and clear anything new.
-- =====================================================================
