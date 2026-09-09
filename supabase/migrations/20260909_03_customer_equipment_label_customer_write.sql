-- ---------------------------------------------------------------------
-- Let a customer name their own equipment.
--
-- 20260909_02_customer_equipment_label.sql added customer_equipment.label
-- but gave nothing permission to write it — the admin overlay wrote it
-- directly via cloudUpdateCustomerEquipment(), same as every other
-- equipment field. That's now the wrong owner: the label is meant to be
-- whatever the CUSTOMER wants their own unit called, not something an
-- admin sets on their behalf (see js/modules-src/customer-equipment-history.js).
-- Admin still SEES the label (read-only, alongside the fixed Equipment ID
-- — see admin.js's equipDetailRowsHtml), it just no longer sets it.
--
-- Customers otherwise only have a SELECT policy on customer_equipment (see
-- "customers read own equipment" in 20260905_customer_portal_multi_link.sql)
-- — there is no customer UPDATE policy on this table, deliberately: grants
-- in this project are wide open (see replica_baseline.sql's "grant all ...
-- to anon, authenticated"), so a blanket UPDATE policy scoped only by
-- customer_id would let a customer login rewrite ANY column on their own
-- equipment row (serials, model numbers, the PM date) straight from the
-- browser client, not just the label.
--
-- A single-purpose, security-definer RPC avoids that: it runs with the
-- privileges to write the row, but the only column it ever touches is
-- label, and only after checking the equipment's customer_id is one this
-- login is actually linked to (same ownership check the read policies use).
-- No new table-level UPDATE grant/policy is needed or added.
create or replace function public.customer_set_equipment_label(p_equipment_id uuid, p_label text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_owned boolean;
begin
  select exists(
    select 1 from public.customer_equipment ce
    where ce.id = p_equipment_id
      and ce.customer_id in (
        select customer_id from public.customer_login_links where profile_id = auth.uid()
      )
  ) into v_owned;

  if not v_owned then
    return false;
  end if;

  update public.customer_equipment
    set label = coalesce(trim(p_label), '')
    where id = p_equipment_id;

  return true;
end;
$$;

-- Callable by any signed-in customer login; the ownership check inside the
-- function (not a grant) is what actually restricts who can affect which
-- row, same reasoning as next_sr_no()/clear_my_must_change_password() in
-- replica_baseline.sql.
grant execute on function public.customer_set_equipment_label(uuid, text) to authenticated;

comment on function public.customer_set_equipment_label is
  'Lets a logged-in customer set customer_equipment.label on a unit belonging to a customer_id they are linked to (customer_login_links). Returns false (writes nothing) if the caller is not linked to that equipment''s customer_id. The only column this function ever writes is label.';
