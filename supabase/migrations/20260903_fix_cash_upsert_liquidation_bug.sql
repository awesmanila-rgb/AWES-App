-- ---------------------------------------------------------------------
-- Fix: technician liquidation submissions were silently discarded.
--
-- Root cause: js/modules-src/cash-advance.js's caSaveRequest() always
-- saves via `.upsert(payload)` — never a plain UPDATE — for every
-- technician save, including submitting a liquidation. An upsert against
-- an id that already exists is executed by Postgres as
-- `INSERT ... ON CONFLICT (id) DO UPDATE`, and Postgres fires the
-- BEFORE INSERT row trigger for the proposed row *before* it even checks
-- whether a conflict exists. So tg_op = 'INSERT' fires on every upsert,
-- not only on genuinely new rows.
--
-- guard_cash_decision()'s old INSERT branch assumed tg_op = 'INSERT'
-- meant "this row does not exist yet" and unconditionally reset
-- liquidation (and every decision field) to defaults. Once Postgres then
-- detected the conflict and moved to the UPDATE path, the "new" row
-- handed to the BEFORE UPDATE trigger already had liquidation = null
-- (wiped by the INSERT trigger moments earlier) — so the UPDATE trigger's
-- own logic saw no new liquidation and dutifully restored the OLD
-- liquidation value, discarding the technician's submission entirely.
-- The client never saw an error (the upsert itself succeeded), so this
-- failed completely silently: the technician got a success toast, and
-- the admin's "To Review Liquidation" tab stayed empty.
--
-- supabase/verify/rls_probe.sql didn't catch this because it exercises a
-- raw `UPDATE ... SET data = ...` statement, not the `.upsert()` the real
-- app uses, so it never hit the buggy code path.
--
-- Fix: stop trusting tg_op to mean "new row". Look up whether a row with
-- this id already exists; only treat it as a fresh insert if it truly
-- doesn't. If it does exist (i.e. this INSERT is really an edit arriving
-- via upsert), fall through to the exact same protective logic as a
-- genuine UPDATE, using the looked-up row as OLD.
-- ---------------------------------------------------------------------
create or replace function public.guard_cash_decision()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old public.cash_advance_requests%rowtype;
  v_is_new boolean;
  v_old_liq jsonb;
  v_new_liq jsonb;
begin
  if public.is_admin() then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    v_old := old;
    v_is_new := false;
  else
    -- tg_op = 'INSERT', but this may really be an upsert-as-edit (see
    -- comment above) — check whether the row actually already exists.
    select * into v_old from public.cash_advance_requests where id = new.id;
    v_is_new := not found;
  end if;

  if v_is_new then
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

  new.id := v_old.id;
  new.technician_id := v_old.technician_id;
  new.status := v_old.status;
  new.submitted_at := v_old.submitted_at;

  new.data := coalesce(new.data, '{}'::jsonb) || jsonb_build_object(
    'status',      coalesce(v_old.data -> 'status', to_jsonb(v_old.status)),
    'comment',     coalesce(v_old.data -> 'comment', '""'::jsonb),
    'decidedAt',   coalesce(v_old.data -> 'decidedAt', 'null'::jsonb),
    'decidedBy',   coalesce(v_old.data -> 'decidedBy', 'null'::jsonb),
    'disbursed',   coalesce(v_old.data -> 'disbursed', 'false'::jsonb),
    'dateGiven',   coalesce(v_old.data -> 'dateGiven', 'null'::jsonb),
    'amountGiven', coalesce(v_old.data -> 'amountGiven', 'null'::jsonb),
    'disbursedAt', coalesce(v_old.data -> 'disbursedAt', 'null'::jsonb),
    'disbursedBy', coalesce(v_old.data -> 'disbursedBy', 'null'::jsonb));

  -- Liquidation: the technician may create one and edit its contents, but
  -- the verdict fields inside it are the admin's.
  v_old_liq := v_old.data -> 'liquidation';
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

-- The trigger definition itself (before insert or update, per-row) is
-- unchanged — only the function body above changes — but re-issuing this
-- is harmless and keeps this migration self-contained.
drop trigger if exists trg_guard_cash on public.cash_advance_requests;
create trigger trg_guard_cash
  before insert or update on public.cash_advance_requests
  for each row execute function public.guard_cash_decision();

-- ---------------------------------------------------------------------
-- guard_leave_decision() has the identical tg_op = 'INSERT' assumption.
-- js/modules-src/leave.js's leaveSaveRequest() also always upserts, but
-- today it only ever does so with a freshly generated id (leaveSubmit()
-- never re-submits against an existing row), so this specific flaw is
-- currently latent there rather than actively discarding data. Hardening
-- it the same way now avoids the identical silent-discard bug the moment
-- any future edit/resubmit flow is added for leave requests.
-- ---------------------------------------------------------------------
create or replace function public.guard_leave_decision()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old public.leave_requests%rowtype;
  v_is_new boolean;
begin
  if public.is_admin() then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    v_old := old;
    v_is_new := false;
  else
    select * into v_old from public.leave_requests where id = new.id;
    v_is_new := not found;
  end if;

  if v_is_new then
    -- A new request always starts undecided, whatever the client sent.
    new.status := 'pending';
    new.data := coalesce(new.data, '{}'::jsonb) || jsonb_build_object(
      'status',    'pending',
      'comment',   '',
      'decidedAt', null,
      'decidedBy', null);
    return new;
  end if;

  -- Edit (whether a genuine UPDATE, or an upsert that turned out to
  -- target an existing row): ownership, status and the decision block
  -- are immutable.
  new.id := v_old.id;
  new.technician_id := v_old.technician_id;
  new.status := v_old.status;
  new.submitted_at := v_old.submitted_at;
  new.data := coalesce(new.data, '{}'::jsonb) || jsonb_build_object(
    'status',    coalesce(v_old.data -> 'status', to_jsonb(v_old.status)),
    'comment',   coalesce(v_old.data -> 'comment', '""'::jsonb),
    'decidedAt', coalesce(v_old.data -> 'decidedAt', 'null'::jsonb),
    'decidedBy', coalesce(v_old.data -> 'decidedBy', 'null'::jsonb));
  return new;
end;
$$;

drop trigger if exists trg_guard_leave on public.leave_requests;
create trigger trg_guard_leave
  before insert or update on public.leave_requests
  for each row execute function public.guard_leave_decision();
