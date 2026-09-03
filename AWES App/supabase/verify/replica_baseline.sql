-- Faithful local replica of the live AWES Supabase schema (project ugxrrgocjpkzumhghzat),
-- reconstructed from list_tables + pg_policies + pg_constraint + pg_proc.
-- Used to rehearse the migration before it touches the real database.

create schema if not exists auth;

-- Minimal stand-ins for the Supabase-managed auth schema.
create table auth.users (
  id uuid primary key,
  email text
);

-- auth.uid() / auth.role() read the request GUCs, exactly as Supabase does.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon');
$$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public, auth to anon, authenticated, service_role;

-- ---------------- tables (live definitions) ----------------
create table public.profiles (
  id uuid primary key references auth.users(id),
  name text,
  role text check (role = any (array['admin','technician'])),
  active boolean not null default true,
  no_history boolean not null default false,
  no_report boolean not null default false,
  read_only boolean not null default false,
  created_at timestamptz not null default now(),
  must_change_password boolean not null default false
);

create table public.sr_counters (date_key text primary key, seq integer not null default 0);
create table public.jo_counters (the_date date primary key, seq integer not null default 0);

create table public.service_reports (
  id uuid primary key default gen_random_uuid(),
  sr_no text unique,
  technician_id uuid references public.profiles(id),
  date date,
  cust_name text,
  cust_address text default '', contact_no text default '', contact_person text default '',
  cust_email text default '', equip_type text default '', model_cu text default '',
  serial_cu text default '', model_fcu text default '', serial_fcu text default '',
  cool_cap text default '', mount_type text default '', brand text default '',
  refrigerant_type text default '', compressor_type text default '',
  equip_location text default '', trouble_call text default '',
  findings text[] default '{}', recommendations text[] default '{}',
  materials jsonb default '[]', services_done text[] default '{}',
  before_data jsonb default '{}', after_data jsonb default '{}', installation jsonb default '{}',
  time_in text default '', time_out text default '', remarks text default '',
  customer_printed_name text default '', technician_name text default '',
  customer_signature jsonb default '{}',      -- NOTE: jsonb in production, not text
  technician_signature jsonb default '{}',
  completed boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.device_locks (
  technician_id uuid primary key references public.profiles(id),
  device_id text not null,
  locked_at timestamptz not null default now()
);

create table public.app_settings (key text primary key, value jsonb not null default '{}');

create table public.dtr_records (
  id uuid primary key default gen_random_uuid(),
  technician_id uuid references public.profiles(id),
  date date,
  data jsonb not null default '{}',
  unique (technician_id, date)
);

create table public.leave_requests (
  id uuid primary key default gen_random_uuid(),
  technician_id uuid references public.profiles(id),
  status text not null default 'pending'
    constraint leave_requests_status_check check (status = any (array['pending','approved','disapproved'])),
  submitted_at timestamptz not null default now(),
  data jsonb not null default '{}'
);

create table public.cash_advance_requests (
  id uuid primary key default gen_random_uuid(),
  technician_id uuid references public.profiles(id),
  status text not null default 'pending'
    constraint cash_advance_requests_status_check check (status = any (array['pending','approved','disapproved'])),
  submitted_at timestamptz not null default now(),
  data jsonb not null default '{}'
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  address text default '', contact_no text default '', contact_person text default '',
  email text default '', updated_at timestamptz not null default now()
);

create table public.customer_equipment (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id),
  equip_type text default '', equip_location text default '', brand text default '',
  mount_type text default '', cool_cap text default '', model_cu text default '',
  serial_cu text default '', model_fcu text default '', serial_fcu text default '',
  refrigerant_type text default '', compressor_type text default '',
  updated_at timestamptz not null default now()
);

create table public.dispatch_tickets (
  id text primary key,
  status text default 'open',
  created_at timestamptz default now(),
  data jsonb
);

-- ---------------- live functions ----------------
create or replace function public.is_admin() returns boolean
  language sql stable security definer as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.clear_my_must_change_password() returns void
  language plpgsql security definer as $$
begin
  update public.profiles set must_change_password = false where id = auth.uid();
end;
$$;

-- NOTE: SECURITY INVOKER in production. Combined with the admin-only policy on
-- sr_counters, this is why technicians cannot get an SR number.
create or replace function public.next_sr_no(p_date date) returns text
  language plpgsql as $$
declare v_key text := to_char(p_date,'YYYYMMDD'); v_seq int;
begin
  insert into public.sr_counters(date_key, seq) values (v_key, 1)
  on conflict (date_key) do update set seq = public.sr_counters.seq + 1
  returning seq into v_seq;
  return 'SR-'||v_key||'-'||lpad(v_seq::text,3,'0');
end; $$;

create or replace function public.next_jo_no(p_date date) returns text
  language plpgsql as $$
declare next_seq int;
begin
  insert into public.jo_counters (the_date, seq) values (p_date, 1)
  on conflict (the_date) do update set seq = public.jo_counters.seq + 1
  returning seq into next_seq;
  return 'JO-'||to_char(p_date,'YYYYMMDD')||'-'||lpad(next_seq::text,3,'0');
end; $$;

-- ---------------- grants as Supabase sets them ----------------
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;

-- ---------------- live RLS state ----------------
alter table public.profiles              enable row level security;
alter table public.sr_counters           enable row level security;
alter table public.jo_counters           enable row level security;
alter table public.service_reports       enable row level security;
alter table public.device_locks          enable row level security;
alter table public.app_settings          enable row level security;
alter table public.dtr_records           enable row level security;
alter table public.leave_requests        enable row level security;
alter table public.cash_advance_requests enable row level security;
alter table public.customers             enable row level security;
alter table public.customer_equipment    enable row level security;
alter table public.dispatch_tickets      enable row level security;

create policy "settings_admin_update"  on public.app_settings for update using (is_admin());
create policy "settings_admin_write"   on public.app_settings for insert with check (is_admin());
create policy "settings_select_authenticated" on public.app_settings for select using (auth.role() = 'authenticated');

create policy "cash_insert_own"        on public.cash_advance_requests for insert with check (technician_id = auth.uid());
create policy "cash_select_own_or_admin" on public.cash_advance_requests for select using ((technician_id = auth.uid()) or is_admin());
create policy "cash_update_admin_only" on public.cash_advance_requests for update using (is_admin());

create policy "cequip_delete_admin"        on public.customer_equipment for delete using (is_admin());
create policy "cequip_insert_authenticated" on public.customer_equipment for insert with check (auth.role() = 'authenticated');
create policy "cequip_select_authenticated" on public.customer_equipment for select using (auth.role() = 'authenticated');
create policy "cequip_update_admin"        on public.customer_equipment for update using (is_admin());

create policy "customers_delete_admin"        on public.customers for delete using (is_admin());
create policy "customers_insert_admin"        on public.customers for insert with check (is_admin());
create policy "customers_select_authenticated" on public.customers for select using (auth.role() = 'authenticated');
create policy "customers_update_admin"        on public.customers for update using (is_admin());

create policy "locks_delete_own_or_admin" on public.device_locks for delete using ((technician_id = auth.uid()) or is_admin());
create policy "locks_insert_own"          on public.device_locks for insert with check (technician_id = auth.uid());
create policy "locks_select_own_or_admin" on public.device_locks for select using ((technician_id = auth.uid()) or is_admin());

-- The wide-open one.
create policy "anon full access" on public.dispatch_tickets for all using (true) with check (true);
create policy "anon full access" on public.jo_counters     for all using (true) with check (true);

create policy "dtr_insert_own"          on public.dtr_records for insert with check (technician_id = auth.uid());
create policy "dtr_select_own_or_admin" on public.dtr_records for select using ((technician_id = auth.uid()) or is_admin());
create policy "dtr_update_own_or_admin" on public.dtr_records for update using ((technician_id = auth.uid()) or is_admin());

create policy "leave_insert_own"          on public.leave_requests for insert with check (technician_id = auth.uid());
create policy "leave_select_own_or_admin" on public.leave_requests for select using ((technician_id = auth.uid()) or is_admin());
create policy "leave_update_admin_only"   on public.leave_requests for update using (is_admin());

create policy "profiles_admin_write" on public.profiles for all using (is_admin()) with check (is_admin());
create policy "profiles_select_technicians_public" on public.profiles for select
  using ((role = 'technician') or (id = auth.uid()) or is_admin());

create policy "reports_admin_delete"       on public.service_reports for delete using (is_admin());
create policy "reports_insert_own"         on public.service_reports for insert with check (technician_id = auth.uid());
create policy "reports_select_own_or_admin" on public.service_reports for select using ((technician_id = auth.uid()) or is_admin());
create policy "reports_update_own_or_admin" on public.service_reports for update using ((technician_id = auth.uid()) or is_admin());

create policy "sr_counters_admin_only" on public.sr_counters for all using (is_admin());
