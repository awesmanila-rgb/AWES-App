# Migration rehearsal harness

These three files let you re-run the exact verification I did, on a throwaway
PostgreSQL database, without touching production.

- `replica_baseline.sql` — the live AWES schema, functions, grants, RLS state and
  all 32 existing policies, reconstructed from the production catalogs. Includes
  minimal stand-ins for Supabase's `auth` schema (`auth.users`, `auth.uid()`,
  `auth.role()`) that read the same request GUCs PostgREST sets.
- `replica_seed.sql` — rows matching production's shape and counts
  (1 admin + 7 technicians, 18 DTR, 1 report, 5 dispatch tickets, 4 device locks,
  3 customers, 1 pending leave, 1 pending cash advance).
- `rls_probe.sql` — the probe suite. Runs as `anon`, then as a technician, then
  as admin, and reports what each can read and write.

```sh
createdb awes_backup
psql -d awes_backup -f replica_baseline.sql
psql -d awes_backup -f replica_seed.sql
psql -d awes_backup -f rls_probe.sql            # before
psql -d awes_backup -f ../migrations/20260822_security_and_schema.sql
psql -d awes_backup -f rls_probe.sql            # after
```

Note: `rls_probe.sql` mutates data, so reseed between runs if you want a clean
comparison. It uses session-scoped `set_config(..., false)` on purpose —
transaction-scoped settings are discarded by psql's autocommit and every check
silently returns zero rows.
