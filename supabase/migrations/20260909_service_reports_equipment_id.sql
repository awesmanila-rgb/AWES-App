-- ---------------------------------------------------------------------
-- Stable equipment link for service_reports.
--
-- Until now, a report's connection to a specific piece of equipment was
-- worked out live, every time, by matchReportHistoryForEquipment() (core.js)
-- comparing the equipment record's CURRENT serial_cu/serial_fcu (or, if it
-- has neither, its current equip_location + equip_type text) against
-- whatever was typed on each report at the time it was filed. That's
-- fragile in exactly the ways it sounds: fixing a typo'd serial, or adding
-- a serial for the first time to a unit that had none, silently orphans
-- every report saved before that edit — they simply stop matching, with no
-- error and no indication anything went wrong. See the app's own commit
-- history / support thread around 2026-09-08 and 09-09 for the concrete
-- case this came from (a unit's service history disappearing from the
-- customer portal and the admin equipment overlay disagreeing with each
-- other, both traced back to this).
--
-- This adds a real foreign key instead. Going forward (see saveReport() in
-- js/modules-src/ui.js and reportToRow() in core.js), every report is
-- stamped with the customer_equipment.id it was actually filed against,
-- resolved once at save time — before any serial/location text can drift.
-- matchReportHistoryForEquipment() now checks equipment_id FIRST and only
-- falls back to the old serial/location+type comparison for reports saved
-- before this column existed (or saved fully offline, where no durable id
-- was available yet — see cloudAddCustomerEquipment()'s comment on that
-- gap). Old reports are left with equipment_id null here; nothing in this
-- migration can safely backfill it automatically, since the very
-- serial/location matching this column exists to replace is the only thing
-- available to backfill it FROM. Optional one-time backfill using that
-- same fallback logic, safe to run once and re-run (only fills rows still
-- null):
--
--   update public.service_reports sr
--   set equipment_id = ce.id
--   from public.customer_equipment ce
--   where sr.equipment_id is null
--     and sr.customer_id = ce.customer_id
--     and (
--       (ce.serial_cu <> '' and sr.serial_cu = ce.serial_cu) or
--       (ce.serial_fcu <> '' and sr.serial_fcu = ce.serial_fcu) or
--       (
--         coalesce(ce.serial_cu,'') = '' and coalesce(ce.serial_fcu,'') = ''
--         and sr.equip_location = ce.equip_location
--         and sr.equip_type = ce.equip_type
--       )
--     );
--
-- Spot-check afterward for customers with more than one unit sharing an
-- empty serial + the same location/type text — those rows are genuinely
-- ambiguous and this backfill may pick either one; anything that matters
-- should be verified by hand:
--   select sr.sr_no, sr.equipment_id, sr.serial_cu, sr.serial_fcu, sr.equip_location, sr.equip_type
--   from public.service_reports sr where sr.equipment_id is null order by sr.date desc;
-- ---------------------------------------------------------------------

alter table public.service_reports
  add column if not exists equipment_id uuid references public.customer_equipment(id);

comment on column public.service_reports.equipment_id is
  'Stable link to the specific customer_equipment row this visit was for, resolved once at save time. Preferred over serial/location+type matching wherever present — see matchReportHistoryForEquipment() in js/modules-src/core.js. Null on reports saved before this column existed.';

-- No RLS change needed: this is just an additional column on a table that
-- already has the "customers read own reports" / admin / technician
-- policies in place (see 20260904_01_customer_portal.sql and
-- 20260905_customer_portal_multi_link.sql) — those already govern row
-- visibility and are unaffected by adding a column.
