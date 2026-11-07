# Switching on permanent-project reads (Phase 2) — rollout runbook

Phase 2 ships **off** (`CORE_READS=off`): every screen behaves exactly as before. Turn it on only after the parity check
passes against a copy of the live database.

## 1. Make a copy of the live database (never test on production)
Using the **external** connection strings from Render (database → Connect):
```
pg_dump "$LIVE_EXTERNAL_URL" --no-owner --no-acl | psql "$STAGING_URL"
```
(Or create a staging database from a Render backup if your plan offers it.)

## 2. Run the parity check on the copy
```
DATABASE_URL="$STAGING_URL" node scripts/core-parity.mjs
```
It builds the projects in memory and compares the old and new reads for every account. It saves nothing (with
PostgreSQL it creates the additive core tables if they are missing). Exit code 0 = PASS.
- **Must be zero:** permits missing or extra.
- **Expected and fine:** "joined" (one project now covers permits that were separate address groups — e.g. a GC picked
  the project, or an admin merged two addresses) and "split" (an admin separated records). Read the examples it prints.
- "Not yet linked" should be 0 after the first start of the new version.

## 3. Optional: click through a staging service
Run a second Render web service on the staging database with `CORE_READS=on` and `SCHEDULER=off`, sign in, and check
Command Center, Projects, the map and a few project profiles. `CORE_READS=on bash qa/run.sh` runs the automated browser
checks in this mode.

## 4. Turn it on in production
Render → buildintel → Environment → `CORE_READS=on` → save (the service restarts). Owner view: Launch Gates shows the
release line with `coreReads: on`; `/api/core/parity` runs the same comparison live.

**Rollback:** set `CORE_READS=off`. No data changes either way — the switch only changes how reads are grouped.
