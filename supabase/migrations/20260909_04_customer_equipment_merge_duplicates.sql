-- ---------------------------------------------------------------------
-- One-time cleanup for duplicate customer_equipment rows left over from
-- before the add-equipment race was fixed in the app (e.g. the CEIC
-- duplicate). This does NOT add any ongoing uniqueness rule — an earlier
-- draft of this migration did (a unique index on customer_id + every
-- identity field), but that's the wrong fix: it re-implemented, at the
-- database layer, the exact "guess sameness from content" logic the app
-- no longer does. Going forward, whether an Add creates a new row is
-- decided once, explicitly, by which action the technician/admin took
-- (see equipPickedId in js/modules-src/customers.js and equipmentId on
-- dispatch-ticket items in js/modules-src/dispatch.js) — never by
-- comparing a new row's fields against what's already on file. Two
-- genuinely different units that happen to share identical fields (no
-- distinguishing serial, same location text, etc.) are legitimately two
-- rows, and nothing here — or in the app — treats that as an error.
--
-- What this migration merges is different: rows from BEFORE that fix
-- existed, created by app code that WAS trying (and, due to the race, a
-- rare number of times not quite fully able) to prevent exactly this —
-- i.e. genuine accidental double-entries of one physical unit, not two
-- distinct ones. For each group of rows sharing a customer_id and every
-- identity field, this keeps one survivor (preferring one that already
-- has a customer-set label or a next_pm_date, so that data isn't lost),
-- re-points any service_reports.equipment_id that referenced a row being
-- removed over to the survivor, then deletes the rest.
--
-- Safe to re-run: a no-op once no duplicates remain.
-- ---------------------------------------------------------------------

do $$
declare
  grp record;
  survivor_id uuid;
  dupe_id uuid;
  i int;
begin
  for grp in
    select
      customer_id,
      coalesce(equip_type,'') as e_type, coalesce(equip_location,'') as e_loc,
      coalesce(brand,'') as e_brand, coalesce(mount_type,'') as e_mount,
      coalesce(cool_cap,'') as e_cool, coalesce(model_cu,'') as e_mcu,
      coalesce(serial_cu,'') as e_scu, coalesce(model_fcu,'') as e_mfcu,
      coalesce(serial_fcu,'') as e_sfcu, coalesce(refrigerant_type,'') as e_ref,
      coalesce(compressor_type,'') as e_comp,
      array_agg(id order by (coalesce(label,'') <> '') desc, (next_pm_date is not null) desc, id) as ids
    from public.customer_equipment
    group by customer_id, e_type, e_loc, e_brand, e_mount, e_cool, e_mcu, e_scu, e_mfcu, e_sfcu, e_ref, e_comp
    having count(*) > 1
  loop
    survivor_id := grp.ids[1];
    for i in 2 .. array_length(grp.ids, 1) loop
      dupe_id := grp.ids[i];
      update public.service_reports set equipment_id = survivor_id where equipment_id = dupe_id;
      delete from public.customer_equipment where id = dupe_id;
    end loop;
  end loop;
end $$;
