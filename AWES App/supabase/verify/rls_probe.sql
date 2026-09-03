-- Security probes. Run identically before and after the migration.
\set QUIET on
\pset tuples_only on
\pset format unaligned
\pset fieldsep ' | '
\set ON_ERROR_STOP off

\echo '--- as ANON ---'
set role anon;
select set_config('request.jwt.claim.sub','',false), set_config('request.jwt.claim.role','anon',false);
\echo -n 'anon reads dispatch_tickets  : '
select count(*)::text from public.dispatch_tickets;
\echo -n 'anon reads profiles roster   : '
select count(*)::text from public.profiles;
\echo -n 'anon reads jo_counters       : '
select count(*)::text from public.jo_counters;
\echo -n 'anon reads app_settings      : '
select count(*)::text from public.app_settings;
\echo -n 'anon reads service_reports   : '
select count(*)::text from public.service_reports;
\echo -n 'anon DELETES a dispatch ticket: '
do $$ begin
  delete from public.dispatch_tickets where id='JO-20260821-002';
  if found then raise notice 'DELETED (open)'; else raise notice 'blocked'; end if;
end $$;
reset role;

\echo ''
\echo '--- as TECHNICIAN Bryan (b1) ---'
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1',false),
       set_config('request.jwt.claim.role','authenticated',false);
\echo -n 'tech sees own DTR / all 18   : '
select count(*)::text from public.dtr_records;
\echo -n 'tech sees profiles rows      : '
select count(*)::text from public.profiles;
\echo -n 'tech reads app_settings keys : '
select count(*)::text from public.app_settings;
\echo -n 'tech can call next_sr_no     : '
do $$ declare v text; begin
  v := public.next_sr_no(current_date);
  raise notice 'OK -> %', v;
exception when others then raise notice 'FAILED (%) %', sqlstate, sqlerrm;
end $$;
\echo -n 'tech can call next_jo_no     : '
do $$ declare v text; begin
  v := public.next_jo_no(current_date);
  raise notice 'OK -> %', v;
exception when others then raise notice 'FAILED (%) %', sqlstate, sqlerrm;
end $$;
\echo -n 'tech approves OWN leave      : '
do $$ begin
  update public.leave_requests set status='approved',
    data = data || '{"status":"approved","decidedBy":"Bryan"}'
  where id='11111111-1111-1111-1111-111111111111';
  if found then raise notice 'ESCALATED - row now %', (select status from public.leave_requests where id='11111111-1111-1111-1111-111111111111');
  else raise notice 'blocked (0 rows)'; end if;
exception when others then raise notice 'blocked (%)', sqlstate;
end $$;
\echo -n 'tech submits OWN liquidation : '
do $$ begin
  update public.cash_advance_requests
    set data = data || '{"liquidation":{"status":"pending","items":[{"desc":"Bolts","amount":250}],"submittedAt":"2026-08-22T01:00:00Z","decidedAt":null,"decidedBy":null}}'
  where id='22222222-2222-2222-2222-222222222222';
  if found then raise notice 'OK (liquidation saved)'; else raise notice 'BLOCKED - feature broken'; end if;
exception when others then raise notice 'BLOCKED (%) %', sqlstate, sqlerrm;
end $$;
\echo -n 'tech self-approves liquidation: '
do $$ begin
  update public.cash_advance_requests
    set data = jsonb_set(data,'{liquidation,status}','"approved"')
  where id='22222222-2222-2222-2222-222222222222';
  if (select data->'liquidation'->>'status' from public.cash_advance_requests where id='22222222-2222-2222-2222-222222222222') = 'approved'
    then raise notice 'ESCALATED';
    else raise notice 'neutralised (still %)', (select data->'liquidation'->>'status' from public.cash_advance_requests where id='22222222-2222-2222-2222-222222222222'); end if;
exception when others then raise notice 'blocked (%)', sqlstate;
end $$;
\echo -n 'tech marks OWN CA disbursed   : '
do $$ begin
  update public.cash_advance_requests
    set status='approved', data = data || '{"status":"approved","disbursed":true,"amountGiven":5000}'
  where id='22222222-2222-2222-2222-222222222222';
  if (select status from public.cash_advance_requests where id='22222222-2222-2222-2222-222222222222')='approved'
    then raise notice 'ESCALATED';
    else raise notice 'neutralised (status=%, disbursed=%)',
      (select status from public.cash_advance_requests where id='22222222-2222-2222-2222-222222222222'),
      (select data->>'disbursed' from public.cash_advance_requests where id='22222222-2222-2222-2222-222222222222'); end if;
exception when others then raise notice 'blocked (%)', sqlstate;
end $$;
\echo -n 'tech promotes self to admin   : '
do $$ begin
  update public.profiles set role='admin' where id='00000000-0000-0000-0000-0000000000b1';
  if (select role from public.profiles where id='00000000-0000-0000-0000-0000000000b1')='admin'
    then raise notice 'ESCALATED'; else raise notice 'blocked'; end if;
exception when others then raise notice 'blocked (%)', sqlstate;
end $$;
\echo -n 'tech reads ANOTHER tech report: '
do $$ declare n int; begin
  select count(*) into n from public.service_reports where technician_id <> '00000000-0000-0000-0000-0000000000b1';
  raise notice '% rows', n;
end $$;
\echo -n 'tech steals another device_lock: '
do $$ begin
  delete from public.device_locks where technician_id='00000000-0000-0000-0000-0000000000b2';
  if found then raise notice 'DELETED someone elses lock'; else raise notice 'blocked'; end if;
exception when others then raise notice 'blocked (%)', sqlstate;
end $$;
\echo -n 'tech sees dispatch tickets     : '
select count(*)::text from public.dispatch_tickets;
reset role;

\echo ''
\echo '--- as ADMIN ---'
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1',false),
       set_config('request.jwt.claim.role','authenticated',false);
\echo -n 'admin sees all DTR            : '
select count(*)::text from public.dtr_records;
\echo -n 'admin sees all reports        : '
select count(*)::text from public.service_reports;
\echo -n 'admin sees all dispatch       : '
select count(*)::text from public.dispatch_tickets;
\echo -n 'admin sees all profiles       : '
select count(*)::text from public.profiles;
\echo -n 'admin decides leave           : '
do $$ begin
  update public.leave_requests set status='approved',
    data = data || '{"status":"approved","comment":"ok","decidedBy":"Admin"}'
  where id='11111111-1111-1111-1111-111111111111' and status='pending';
  if found then raise notice 'OK'; else raise notice 'FAILED - admin blocked'; end if;
exception when others then raise notice 'FAILED (%) %', sqlstate, sqlerrm;
end $$;
\echo -n 'admin decides liquidation     : '
do $$ begin
  update public.cash_advance_requests
    set data = jsonb_set(data,'{liquidation,status}','"approved"')
  where id='22222222-2222-2222-2222-222222222222';
  if (select data->'liquidation'->>'status' from public.cash_advance_requests where id='22222222-2222-2222-2222-222222222222')='approved'
    then raise notice 'OK'; else raise notice 'FAILED - admin blocked'; end if;
exception when others then raise notice 'FAILED (%) %', sqlstate, sqlerrm;
end $$;
\echo -n 'admin records disbursement    : '
do $$ begin
  update public.cash_advance_requests set status='approved',
    data = data || '{"status":"approved","disbursed":true,"dateGiven":"2026-08-22","amountGiven":5000,"disbursedBy":"Admin"}'
  where id='22222222-2222-2222-2222-222222222222';
  if (select data->>'disbursed' from public.cash_advance_requests where id='22222222-2222-2222-2222-222222222222')='true'
    then raise notice 'OK'; else raise notice 'FAILED - admin blocked'; end if;
exception when others then raise notice 'FAILED (%) %', sqlstate, sqlerrm;
end $$;
\echo -n 'admin writes app_settings     : '
do $$ begin
  insert into public.app_settings(key,value) values ('settings/fieldLists','{"findings":["x"]}')
  on conflict (key) do update set value=excluded.value;
  raise notice 'OK';
exception when others then raise notice 'FAILED (%) %', sqlstate, sqlerrm;
end $$;
\echo -n 'admin calls next_sr_no        : '
do $$ declare v text; begin
  v := public.next_sr_no(current_date); raise notice 'OK -> %', v;
exception when others then raise notice 'FAILED (%) %', sqlstate, sqlerrm;
end $$;
reset role;
