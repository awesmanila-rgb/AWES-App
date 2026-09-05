-- =====================================================================
-- AWES App — technician usernames for the public sign-in screen
--
-- WHY
-- The sign-in picker (rendered before anyone is authenticated, via the
-- list-technicians Edge Function) currently shows every technician's real
-- full `name`. That means anyone who opens the app — no login needed — can
-- read the entire staff roster by name. This migration adds a separate
-- `username` column so the picker can show that instead, while `name`
-- keeps being the technician's real name used everywhere else (service
-- reports, DTR, cash advance, leave, dispatch, etc.).
--
-- This does NOT touch anon's access to `profiles` — that table is already
-- closed to anon (see 20260822_02_close_anon_roster.sql). list-technicians
-- is the only public path to any of this, and it explicitly whitelists
-- which columns it returns (see that function's source) — it must be
-- updated separately to select/return `username` instead of `name`.
--
-- Idempotent: safe to run more than once.
-- =====================================================================

begin;

alter table public.profiles add column if not exists username text;

-- Case-insensitive uniqueness, so 'Jdc07' and 'jdc07' can't collide and the
-- sign-in list never shows two identical buttons. Partial index (where
-- username is not null) so existing technicians with no username yet don't
-- collide with each other on the "null" default.
create unique index if not exists profiles_username_unique_ci
  on public.profiles (lower(username))
  where username is not null;

commit;

-- ---------------------------------------------------------------------
-- Post-migration checklist (needs your hands)
-- ---------------------------------------------------------------------
-- 1. Redeploy list-technicians so it returns `username` instead of `name`:
--      supabase functions deploy list-technicians --no-verify-jwt
-- 2. Rebuild and publish the web bundle (python3 build.py), which now has
--    an admin-side "Username" field for adding/editing a technician.
-- 3. Every existing technician has username = null until an admin sets one
--    from Manage Users → Edit. Until then, list-technicians falls back to
--    a non-identifying placeholder for that technician on the sign-in
--    screen (see that function's source) rather than ever showing `name`.
