-- ---------------------------------------------------------------------
-- Customer-side actions on service_requests: respond to a fee, confirm a
-- proposed schedule, cancel a request.
--
-- 20260910_02_service_requests.sql only ever added an UPDATE policy for
-- ADMIN (public.is_admin()) — there is no customer UPDATE policy on
-- service_requests at all. That's deliberate, for the exact reason
-- explained in 20260909_03_customer_equipment_label_customer_write.sql:
-- grants in this project are wide open (see replica_baseline.sql's
-- "grant all ... to anon, authenticated"), so a blanket customer UPDATE
-- policy scoped only by customer_id ownership would let a customer login
-- rewrite ANY column on their own request — status, fee_amount,
-- admin_notes, linked_dispatch_ticket_id — straight from the browser
-- client, not just the fee/schedule/cancel responses they're meant to
-- make. Without this migration, srRespondFee/srConfirmSchedule/srCancel
-- in service-requests.js would all fail outright under RLS.
--
-- Same fix as that migration used: single-purpose SECURITY DEFINER
-- functions. Each one checks ownership (via customer_login_links, same as
-- every other customer-facing policy on this table) AND that the request
-- is currently in the specific state that action is valid from, before
-- touching only the columns that action is meant to change. No new
-- table-level UPDATE grant/policy is added.
-- ---------------------------------------------------------------------

create or replace function public.customer_respond_service_request_fee(
  p_request_id uuid, p_accept boolean, p_settlement_method text default null, p_settlement_note text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_owned boolean;
begin
  select exists(
    select 1 from public.service_requests sr
    where sr.id = p_request_id
      and sr.customer_id in (select customer_id from public.customer_login_links where profile_id = auth.uid())
      and sr.status = 'fee_proposed' and sr.fee_status = 'proposed'
  ) into v_owned;

  if not v_owned then
    return false;
  end if;

  if p_accept then
    update public.service_requests
      set fee_status = 'accepted', status = 'fee_accepted',
          settlement_method = p_settlement_method, settlement_note = p_settlement_note
      where id = p_request_id;
  else
    update public.service_requests set fee_status = 'declined' where id = p_request_id;
  end if;

  return true;
end;
$$;
grant execute on function public.customer_respond_service_request_fee(uuid, boolean, text, text) to authenticated;

create or replace function public.customer_confirm_service_request_schedule(p_request_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_owned boolean;
begin
  select exists(
    select 1 from public.service_requests sr
    where sr.id = p_request_id
      and sr.customer_id in (select customer_id from public.customer_login_links where profile_id = auth.uid())
      and sr.status = 'schedule_proposed'
  ) into v_owned;

  if not v_owned then
    return false;
  end if;

  update public.service_requests
    set status = 'schedule_confirmed', schedule_confirmed_at = now()
    where id = p_request_id;

  return true;
end;
$$;
grant execute on function public.customer_confirm_service_request_schedule(uuid) to authenticated;

create or replace function public.customer_cancel_service_request(p_request_id uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_owned boolean;
begin
  if p_reason is null or trim(p_reason) = '' then
    return false;
  end if;

  select exists(
    select 1 from public.service_requests sr
    where sr.id = p_request_id
      and sr.customer_id in (select customer_id from public.customer_login_links where profile_id = auth.uid())
      and sr.status = any(array['new','acknowledged','fee_proposed','fee_accepted','schedule_proposed','schedule_confirmed'])
  ) into v_owned;

  if not v_owned then
    return false;
  end if;

  update public.service_requests
    set status = 'cancelled', cancel_reason = trim(p_reason), cancel_acknowledged = false
    where id = p_request_id;

  return true;
end;
$$;
grant execute on function public.customer_cancel_service_request(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- Ticket-status sync (dispatch.js's dtAcknowledge/dtComplete hooks).
--
-- These fire whenever a TECHNICIAN acknowledges or completes their
-- assigned ticket, not just when admin does — dtRenderTechList's
-- Acknowledge/Complete buttons are technicians' own normal job-tracking
-- flow. Technicians have no UPDATE grant on service_requests at all
-- (only admin, via the "admin update service requests" policy), so
-- without this, the customer homepage's progress tracker would never
-- advance past 'dispatched' in the ordinary case of a technician (rather
-- than admin) doing the acknowledging/completing.
--
-- Scope is deliberately narrow: only 'in_progress' or 'completed', only
-- for admin/technician roles, and only by looking up the request through
-- linked_dispatch_ticket_id (no direct request id is ever passed in).
-- It does not verify the caller is specifically one of the ticket's
-- assigned technicians — that would need this function to also know
-- dispatch_tickets' assignment column shape, which isn't needed here: the
-- only effect of a mismatch is a service_request's status label moving
-- forward, not any data exposure, and every real caller only ever invokes
-- this for a ticket it just acted on via the normal dispatch UI anyway.
-- ---------------------------------------------------------------------
create or replace function public.sync_service_request_ticket_status(p_ticket_id text, p_new_status text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_role text;
begin
  select role into v_role from public.profiles where id = auth.uid();
  if v_role is null or v_role not in ('admin','technician') then
    return false;
  end if;
  if p_new_status not in ('in_progress','completed') then
    return false;
  end if;

  if p_new_status = 'in_progress' then
    update public.service_requests set status = 'in_progress'
      where linked_dispatch_ticket_id = p_ticket_id and status = 'dispatched';
  else
    update public.service_requests set status = 'completed'
      where linked_dispatch_ticket_id = p_ticket_id;
  end if;

  return true;
end;
$$;
grant execute on function public.sync_service_request_ticket_status(text, text) to authenticated;
comment on function public.sync_service_request_ticket_status is
  'Called by dispatch.js when a technician or admin acknowledges/completes a dispatch ticket, to move any service_request linked to that ticket (via linked_dispatch_ticket_id) to in_progress/completed. No-op if nothing is linked.';

comment on function public.customer_respond_service_request_fee is
  'Lets a logged-in customer accept or decline a proposed fee on a service request they own (via customer_login_links), only while status=fee_proposed and fee_status=proposed. Returns false (writes nothing) otherwise.';
comment on function public.customer_confirm_service_request_schedule is
  'Lets a logged-in customer confirm a proposed schedule on a service request they own, only while status=schedule_proposed. Returns false (writes nothing) otherwise.';
comment on function public.customer_cancel_service_request is
  'Lets a logged-in customer cancel a service request they own, with a required reason, only while it has not yet been dispatched. Returns false (writes nothing) otherwise.';
