-- ---------------------------------------------------------------------
-- PM (preventive maintenance) due reminder — customer portal.
--
-- Adds an admin-settable "next PM date" per equipment record. The
-- customer portal's equipment status pill (see computeEquipmentStatus in
-- js/modules-src/customer-portal.js) is being switched over to derive
-- entirely from this date — overdue / due soon / on schedule / no date
-- set — instead of the old placeholder heuristic that guessed "Needs
-- attention" from whatever text happened to be in the last report's
-- remarks. Nobody at AWES is actually monitoring these units remotely, so
-- that heuristic implied a kind of live monitoring that never existed. If
-- a unit genuinely needs attention, the customer now taps "Request
-- Service" themselves rather than waiting for a status pill to notice.
--
-- No RLS change needed: customer_equipment's existing SELECT policy
-- ("customers read own equipment") and the admin/tech write access
-- already used by cloudUpdateCustomerEquipment() apply to every column on
-- the row, this new one included.
-- ---------------------------------------------------------------------

alter table public.customer_equipment
  add column if not exists next_pm_date date;

comment on column public.customer_equipment.next_pm_date is
  'Admin-set tentative date for this unit''s next preventive-maintenance visit. Drives the customer portal''s PM-due status pill (overdue / due soon / on schedule). Null = no PM scheduled yet.';
