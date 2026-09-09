-- ---------------------------------------------------------------------
-- Customer-facing label for customer_equipment.
--
-- customer_equipment.id (uuid) is now the fixed, stable identifier a
-- report is matched against (see equipment_id, added in
-- 20260909_service_reports_equipment_id.sql). That id is what
-- equipShortId()/equipDisplayName() (core.js) show throughout the app
-- wherever a piece of equipment needs to be identified in a list — but a
-- raw uuid means nothing to a customer looking at their own units. This
-- column lets an admin give a unit a plain-language name ("Server Room
-- AC", "Front Counter Unit 2") from the Manage Equipment List detail
-- overlay (admin.js); once set, equipDisplayName() shows that label
-- instead of the id everywhere a unit is listed or titled. The raw id is
-- still always shown as its own "Equipment ID" row wherever equipment
-- detail is shown, labeled or not.
--
-- Empty/null means no label has been set yet — callers fall back to the
-- shortened id in that case, they never show a blank.
-- ---------------------------------------------------------------------

alter table public.customer_equipment
  add column if not exists label text default '';

comment on column public.customer_equipment.label is
  'Optional customer-facing display name for this unit, set by an admin. When present, shown in place of the raw id (see equipDisplayName() in js/modules-src/core.js) everywhere equipment is listed or titled. Empty string/null falls back to a shortened form of the id.';
