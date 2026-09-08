-- ---------------------------------------------------------------------
-- Fix: Customer Portal "Recent Service Reports" card shows nothing (or
-- only whatever existed the moment the customer portal was first set up).
--
-- Root cause: service_reports.customer_id (added in 20260904_01_customer_
-- portal.sql) is what the customer-read RLS policy actually filters on —
-- "customers read own reports" checks customer_id, never cust_name. But
-- js/modules-src/core.js's reportToRow() (what every report save/upsert
-- goes through) was only ever setting cust_name, never customer_id.
-- 20260904's own migration backfilled customer_id once, for whatever rows
-- already existed at that exact moment — every report saved since (which
-- by now is most of them) was left with customer_id = null and so has
-- been invisible to every customer login, no matter how well its
-- cust_name matched.
--
-- This re-runs that same backfill for everything that's accumulated
-- since. It only fixes rows that already exist — reportToRow() has been
-- fixed alongside this (see core.js) so new reports set customer_id
-- themselves going forward. Both changes are needed together; this file
-- alone won't keep future reports visible.
-- ---------------------------------------------------------------------

update public.service_reports sr
set customer_id = c.id
from public.customers c
where sr.customer_id is null
  and sr.cust_name = c.name;

-- Spot-check afterward, same as 20260904's own note: any row still left
-- with customer_id null after this means its cust_name didn't exactly
-- match any customers.name (typo, extra whitespace, a customer since
-- renamed or removed) and needs fixing by hand.
--   select sr_no, cust_name, date from public.service_reports
--   where customer_id is null order by date desc;
