-- ---------------------------------------------------------------------
-- Service Requests v2 — fee approval + schedule confirmation workflow,
-- per-request messaging, cancellation with reason, and new intake fields
-- (access requirements, on-site contact). Builds on
-- 20260910_02_service_requests.sql — run that one first if you haven't.
--
-- Status machine (replaces the simpler one from v1):
--   new
--     -> acknowledged          (admin reviewed, no fee needed)
--     -> fee_proposed          (admin set a fee, waiting on customer)
--        -> fee_accepted       (customer accepted fee + settlement method)
--   [acknowledged or fee_accepted]
--     -> schedule_proposed     (admin set a specific date/time)
--     -> schedule_confirmed    (customer agreed to that date/time)
--     -> dispatched            (admin created the dispatch ticket)
--     -> in_progress           (assigned technician acknowledged the ticket)
--     -> completed             (ticket completed — see dtComplete hook)
--   cancelled                  (customer cancelled, with a reason, from any
--                               state before dispatched)
--
-- 'scheduled' (v1's old post-conversion status) is gone, replaced by the
-- more granular schedule_proposed/schedule_confirmed/dispatched sequence.
-- Any existing row still holding 'scheduled' is migrated to 'dispatched'
-- below so the check constraint doesn't reject it.
-- ---------------------------------------------------------------------

-- Fee & settlement (admin proposes, customer responds)
alter table public.service_requests add column if not exists fee_amount numeric(12,2);
alter table public.service_requests add column if not exists fee_status text
  check (fee_status is null or fee_status = any (array['proposed','accepted','declined']));
alter table public.service_requests add column if not exists settlement_method text; -- e.g. 'cash','bank_transfer','gcash' — free text, no fixed list yet
alter table public.service_requests add column if not exists settlement_note text;

-- Schedule proposal (admin proposes an actual date/time, customer confirms)
alter table public.service_requests add column if not exists proposed_schedule_date date;
alter table public.service_requests add column if not exists proposed_schedule_time text; -- free-text like dispatch_tickets' own expected-time field
alter table public.service_requests add column if not exists schedule_confirmed_at timestamptz;

-- Cancellation
alter table public.service_requests add column if not exists cancel_reason text;
alter table public.service_requests add column if not exists cancel_acknowledged boolean not null default false;

-- New intake fields (access requirements + on-site contact)
alter table public.service_requests add column if not exists access_gate_pass boolean not null default false;
alter table public.service_requests add column if not exists access_ladder boolean not null default false;
alter table public.service_requests add column if not exists access_work_permit boolean not null default false;
alter table public.service_requests add column if not exists access_others boolean not null default false;
alter table public.service_requests add column if not exists access_others_detail text;
alter table public.service_requests add column if not exists contact_person text;
alter table public.service_requests add column if not exists contact_number text;

-- Migrate any existing 'scheduled' rows before widening the status check
-- (the old constraint only allowed 'scheduled' as the post-conversion
-- state; the new one drops it in favor of dispatched/in_progress).
update public.service_requests set status = 'dispatched' where status = 'scheduled';

-- Widen the status check constraint. Postgres names an inline column check
-- constraint "<table>_<column>_check" by default — that's what
-- 20260910_02's `status text ... check(...)` produced, so this is safe to
-- drop by that name.
alter table public.service_requests drop constraint if exists service_requests_status_check;
alter table public.service_requests add constraint service_requests_status_check
  check (status = any (array[
    'new','acknowledged','fee_proposed','fee_accepted',
    'schedule_proposed','schedule_confirmed','dispatched',
    'in_progress','completed','cancelled'
  ]));

-- ---------------------------------------------------------------------
-- Per-request messaging — one thread per service request, customer and
-- admin only (mirrors dispatch_ticket_messages' realtime pattern in
-- dispatch.js, but scoped to service_requests instead of dispatch_tickets,
-- and to customer+admin instead of assigned technicians+admin).
-- ---------------------------------------------------------------------
create table if not exists public.service_request_messages (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.service_requests(id) on delete cascade,
  sender_id uuid not null references public.profiles(id),
  sender_name text not null, -- denormalized at send time, same as dispatch_ticket_messages — avoids a join with profiles (which customers can't read anyway) just to render a sender label
  sender_role text not null check (sender_role = any (array['customer','admin'])),
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists service_request_messages_request_id_idx on public.service_request_messages(request_id);

alter table public.service_request_messages enable row level security;

-- Customers: read/send messages only on their own requests.
drop policy if exists "customers read own request messages" on public.service_request_messages;
create policy "customers read own request messages"
  on public.service_request_messages for select to authenticated
  using (request_id in (
    select id from public.service_requests
    where customer_id in (select customer_id from public.customer_login_links where profile_id = auth.uid())
  ));

drop policy if exists "customers send own request messages" on public.service_request_messages;
create policy "customers send own request messages"
  on public.service_request_messages for insert to authenticated
  with check (
    sender_id = auth.uid() and sender_role = 'customer'
    and request_id in (
      select id from public.service_requests
      where customer_id in (select customer_id from public.customer_login_links where profile_id = auth.uid())
    )
  );

-- Admin: full read/send on every thread.
drop policy if exists "admin read all request messages" on public.service_request_messages;
create policy "admin read all request messages"
  on public.service_request_messages for select to authenticated
  using (public.is_admin());

drop policy if exists "admin send request messages" on public.service_request_messages;
create policy "admin send request messages"
  on public.service_request_messages for insert to authenticated
  with check (sender_id = auth.uid() and sender_role = 'admin' and public.is_admin());

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'service_request_messages'
  ) then
    alter publication supabase_realtime add table public.service_request_messages;
  end if;
end $$;
