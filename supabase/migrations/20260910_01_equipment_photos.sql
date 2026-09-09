-- ---------------------------------------------------------------------
-- Equipment photos — admin uploads, customer views.
--
-- Adds:
--   1. A private Storage bucket ('equipment-photos') — private because
--      this app's whole data model is scoped per-customer via RLS
--      everywhere else (customers, customer_equipment, service_reports —
--      see customer_login_links), and a public bucket would mean anyone
--      with a guessed/leaked URL could view another customer's equipment
--      photos with no login at all. Signed URLs (short-lived, generated
--      on demand — see equipPhotoSignedUrls() in
--      js/modules-src/equipment-photos.js) are the private-bucket
--      equivalent of a plain <img src>.
--   2. public.equipment_photos — one row per uploaded photo, metadata
--      only; the actual bytes live in Storage. `folder` is a free-form,
--      admin-assigned tag ("2026 Site Survey", "Before/After") used to
--      group photos in the admin UI for archiving — it does NOT move the
--      underlying Storage object, which always stays at its original
--      customer_id/equipment_id path (see storage_path below).
--   3. RLS matching the "admin uploads, customer views" split: admin
--      (is_admin()) can insert/update/delete; both admin and a customer
--      login linked to that photo's customer_id (customer_login_links,
--      same pattern as customer_equipment's own read policy) can select.
--
-- Storage path convention (enforced by the INSERT policy below, not just
-- convention): {customer_id}/{equipment_id}/{timestamp}-{filename}. This
-- is what lets storage.foldername(name) do the ownership check directly
-- on the object path, and — as a side effect — means anyone browsing the
-- bucket in the Supabase dashboard already sees photos grouped by
-- customer then equipment, independent of the logical `folder` tag.
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'equipment-photos', 'equipment-photos', false,
  2 * 1024 * 1024, -- 2MB hard ceiling — defense in depth only; the app
                    -- compresses client-side to ~150KB before upload (see
                    -- compressImageForUpload() in equipment-photos.js), so
                    -- a normal upload never gets near this limit
  array['image/jpeg','image/png','image/webp']
)
on conflict (id) do nothing;

create table if not exists public.equipment_photos (
  id              uuid primary key default gen_random_uuid(),
  equipment_id    uuid not null references public.customer_equipment(id) on delete cascade,
  -- Denormalized from customer_equipment.customer_id — kept in sync at
  -- insert time only (equipment doesn't change owners), so both this
  -- table's own RLS and the admin folder browser can filter/group by
  -- customer without a join back to customer_equipment every time.
  customer_id     uuid not null references public.customers(id) on delete cascade,
  storage_path    text not null unique,
  folder          text not null default 'Uncategorized',
  caption         text default '',
  is_cover        boolean not null default false,
  file_size_bytes integer,
  uploaded_by     uuid references public.profiles(id),
  created_at      timestamptz not null default now()
);

alter table public.equipment_photos enable row level security;

drop policy if exists "read own or admin" on public.equipment_photos;
create policy "read own or admin"
  on public.equipment_photos for select
  using (
    public.is_admin()
    or customer_id in (select customer_id from public.customer_login_links where profile_id = auth.uid())
  );

-- Admin-only write, per the "customer views, doesn't upload" design —
-- mirrors the read-only treatment customer_equipment.id/label get on the
-- admin side, just reversed: here the CUSTOMER is the read-only party.
drop policy if exists "admin writes photos" on public.equipment_photos;
create policy "admin writes photos"
  on public.equipment_photos for all
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------- storage.objects policies ----------------

drop policy if exists "equipment photos read own or admin" on storage.objects;
create policy "equipment photos read own or admin"
  on storage.objects for select
  using (
    bucket_id = 'equipment-photos'
    and (
      public.is_admin()
      or (storage.foldername(name))[1]::uuid in (
        select customer_id from public.customer_login_links where profile_id = auth.uid()
      )
    )
  );

drop policy if exists "equipment photos admin write" on storage.objects;
create policy "equipment photos admin write"
  on storage.objects for all
  using (bucket_id = 'equipment-photos' and public.is_admin())
  with check (bucket_id = 'equipment-photos' and public.is_admin());

comment on table public.equipment_photos is
  'Metadata for photos uploaded against a customer_equipment unit. Admin uploads/manages (folder, cover, delete); the linked customer can only view. Actual image bytes live in the equipment-photos Storage bucket at storage_path.';
comment on column public.equipment_photos.folder is
  'Free-form, admin-assigned archive tag (e.g. "2026 Site Survey") — a logical grouping for the admin photo manager UI. Independent of storage_path, which always keeps the physical customer_id/equipment_id layout.';
