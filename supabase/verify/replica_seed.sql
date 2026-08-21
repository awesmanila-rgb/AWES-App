-- Seed the replica with the same row shape/counts as production.
insert into auth.users(id,email) values
  ('00000000-0000-0000-0000-0000000000a1','awes.manila@gmail.com'),
  ('00000000-0000-0000-0000-0000000000b1','t1@awes-app.local'),
  ('00000000-0000-0000-0000-0000000000b2','t2@awes-app.local'),
  ('00000000-0000-0000-0000-0000000000b3','t3@awes-app.local'),
  ('00000000-0000-0000-0000-0000000000b4','t4@awes-app.local'),
  ('00000000-0000-0000-0000-0000000000b5','t5@awes-app.local'),
  ('00000000-0000-0000-0000-0000000000b6','t6@awes-app.local'),
  ('00000000-0000-0000-0000-0000000000b7','t7@awes-app.local');

insert into public.profiles(id,name,role,active) values
  ('00000000-0000-0000-0000-0000000000a1','Admin','admin',true),
  ('00000000-0000-0000-0000-0000000000b1','Bryan','technician',true),
  ('00000000-0000-0000-0000-0000000000b2','Diony','technician',true),
  ('00000000-0000-0000-0000-0000000000b3','Elmer','technician',true),
  ('00000000-0000-0000-0000-0000000000b4','Jason','technician',true),
  ('00000000-0000-0000-0000-0000000000b5','Magno','technician',true),
  ('00000000-0000-0000-0000-0000000000b6','Ruben','technician',true),
  ('00000000-0000-0000-0000-0000000000b7','Simon','technician',true);

insert into public.app_settings(key,value)
  values ('settings/fieldLists', '{"findings":["Dirty filter"],"recommendations":["Clean coil"]}');

-- 18 DTR rows spread over the 7 technicians, like production.
insert into public.dtr_records(technician_id,date,data)
select p.id, (date '2026-08-01' + (g||' days')::interval)::date,
       jsonb_build_object('status','present','timeIn','08:00','timeOut','17:00')
from (select id, row_number() over (order by name) rn from public.profiles where role='technician') p
cross join generate_series(0,2) g
where (p.rn-1)*3 + g < 18;

insert into public.service_reports(sr_no,technician_id,date,cust_name,completed,
       customer_signature,technician_signature,findings)
values ('SR-20260818-001','00000000-0000-0000-0000-0000000000b1','2026-08-18','Acme Foods',true,
        '{"dataUrl":"data:image/png;base64,AAA"}','{"dataUrl":"data:image/png;base64,BBB"}',
        array['Low refrigerant charge']);

insert into public.device_locks(technician_id,device_id) values
  ('00000000-0000-0000-0000-0000000000b1','dev-1'),
  ('00000000-0000-0000-0000-0000000000b2','dev-2'),
  ('00000000-0000-0000-0000-0000000000b3','dev-3'),
  ('00000000-0000-0000-0000-0000000000b4','dev-4');

insert into public.customers(name,address) values
  ('Acme Foods','QC'), ('Bayview Mall','Pasay'), ('Crown Hotel','Makati');
insert into public.customer_equipment(customer_id,equip_type,brand)
  select id,'Split Type','Carrier' from public.customers where name='Acme Foods';

insert into public.dispatch_tickets(id,status,data) values
  ('JO-20260818-001','open',    '{"assignedWorkerIds":["00000000-0000-0000-0000-0000000000b1"],"customer":"Acme Foods"}'),
  ('JO-20260819-001','acknowledged','{"assignedWorkerIds":["00000000-0000-0000-0000-0000000000b2","00000000-0000-0000-0000-0000000000b3"],"customer":"Bayview Mall"}'),
  ('JO-20260820-001','completed','{"assignedWorkerIds":["00000000-0000-0000-0000-0000000000b4"],"customer":"Crown Hotel"}'),
  ('JO-20260821-001','open',    '{"assignedWorkerIds":["00000000-0000-0000-0000-0000000000b5"],"customer":"Acme Foods"}'),
  ('JO-20260821-002','open',    '{"assignedWorkerIds":["00000000-0000-0000-0000-0000000000b6"],"customer":"Crown Hotel"}');

insert into public.sr_counters(date_key,seq) values ('20260818',1),('20260820',2);
insert into public.jo_counters(the_date,seq) values ('2026-08-18',1),('2026-08-19',1),('2026-08-21',2);

-- A pending leave + cash advance so the decision guards can be exercised.
insert into public.leave_requests(id,technician_id,status,data) values
  ('11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-0000000000b1','pending',
   '{"status":"pending","comment":"","submittedAt":"2026-08-20T01:00:00Z","decidedAt":null,"decidedBy":null,"type":"Vacation","from":"2026-09-01","to":"2026-09-03"}');

insert into public.cash_advance_requests(id,technician_id,status,data) values
  ('22222222-2222-2222-2222-222222222222','00000000-0000-0000-0000-0000000000b1','pending',
   '{"status":"pending","comment":"","submittedAt":"2026-08-20T01:00:00Z","decidedAt":null,"decidedBy":null,"disbursed":false,"dateGiven":null,"amountGiven":null,"disbursedAt":null,"disbursedBy":null,"liquidation":null,"amount":5000,"purpose":"Parts"}');
