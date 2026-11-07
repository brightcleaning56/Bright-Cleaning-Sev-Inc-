# Project Intelligence Core (BUILDINTEL 2.0) — design and migration plan

## Why
Today a "project" is a group of permits that share a normalized address (`siteKey`). Bid requests, plan rooms and
estimates attach to a permit or a bid request, and the Command Center links them by address at read time. That works for
a pilot, but a development has one planning case, several permits, several drawing sets and revisions, several bid
packages, changing teams and phases — and its address can change (lot split, new street number). The project must
become the permanent parent record.

## Status

**Phase 1 — done (this build).**
- Core records: `projects`, `projectLinks`, `projectCompanies` (with an evidence list per relationship), `projectPhases`
  (sequence-numbered history), `projectAliases`, `reviewQueue`.
- Relational tables (schema v2): `bi_projects`, `bi_project_links`, `bi_project_companies`, `bi_project_phases`,
  `bi_project_aliases`, indexed; written **in the same transaction** as the document records; copied in automatically on
  first start; `reconcileCore` proves row counts match. `searchCoreSql` returns the same results as the in-memory search
  (tested against real PostgreSQL).
- Linking: permits, land-use filings, bid requests, plan-room files and awards; idempotent; incremental on each hourly
  pull, full scan at startup; ambiguous matches go to a review queue; merge (old IDs keep resolving) and split.
- Read API: `/api/core/projects/:id` (territory + bid-package visibility), `/api/core/lookup`, `/api/core/search`;
  owner: stats/reconcile, review queue, merge, split, full backfill.
- UI: permanent project ID and phase on the profile; lifecycle, team with evidence, and linked records on Updates;
  core health and review queue on Geographic Coverage (owner).
- Measured at 5,000 permits: first backfill 1.3 s; hourly pull with nothing new 9 ms; 40 new permits 40 ms; full re-scan 91 ms.

**Phase 2 — done, behind a switch (`CORE_READS`, default off).** Projects, Command Center, map, profiles and the pipeline
group by permanent project when on (same response fields, project IDs in links; old permit links still resolve). The
project's **anchor permit** (first linked, never moves) carries following and estimates. Planning-only projects have a
profile from the core record. GCs can **pick the project** when posting (link recorded as "chosen by GC", confirmed;
state checked). Parity: `scripts/core-parity.mjs` (CLI, read-only — verified the data file is unchanged) and
`/api/core/parity` (owner). Rollout steps: `docs/CORE-ROLLOUT.md`. Browser suite passes 8/8 with the switch off and on.

**Phase 3 — step 1 done:**
- **Cross-server lock** for scheduled work (PostgreSQL advisory lock): the hourly pull (scheduled and "Run now") and the
  daily jobs run on only one server. This already matters during Render deploys, when old and new servers overlap.
  Tested with two server instances against real PostgreSQL.
- **Measured memory and speed** (unique addresses, worst case): ~4.2 KB per permit, linear — 50,000 permits 203 MB,
  100,000 permits 405 MB. Practical ceiling: ~80,000 permits on Render Starter (512 MB), ~350,000 on Standard (2 GB).
- **Fixed a quadratic slowdown** found by that measurement (phase recompute scanned all history per project:
  67 s at 10,000 permits → 0.78 s; 100,000 permits now 7.4 s). A regression test checks growth stays linear and was
  verified to fail against the old code.

**Plan Room tables (schema v3):** `bi_drawing_sets`, `bi_drawing_sheets`, `bi_drawing_revisions`, written in the same
transaction as the records and included in the reconcile check; text index kept per document (bounded: 400 pages,
500,000 characters).

**Phase 3 — remaining (each its own release, tested on a live-database copy):**
1. Database-backed reads for permits and projects (search, map, command center, profile) using the relational tables,
   so these no longer need everything in memory.
2. Optimistic concurrency on record writes (version numbers), so two servers writing the same record can't silently
   overwrite each other.
3. Change notifications between servers (PostgreSQL LISTEN/NOTIFY) so caches stay current.
4. Then run more than one server. Until steps 1–3 land, keep `numInstances: 1` (render.yaml).

## Principles
1. **Additive.** No existing collection, API or screen is removed. Permits, documents, analyses, measurements,
   estimates, bids, invitations and contracts keep working and gain a `projectId`.
2. **Every relationship has provenance:** source (record + link), how it was established (named on permit, matched
   address, GC upload, user link), verification state, first seen, last seen/verified. Nothing is inferred silently.
3. **Stable IDs.** `BI-` + 8 characters, never reused. Merges keep the surviving ID and record an alias; splits are logged.
4. **Database-backed querying.** Core entities live in real PostgreSQL tables with indexes, so search and the map
   no longer need all records in memory, and more than one instance can run (scheduled work takes a database lock).

## Entities (PostgreSQL tables)

| Table | Key fields | Notes |
|---|---|---|
| `projects` | id, name, status, primary_address, city, state, lat/lng, project_type, est_value, building_sf, phase, created_at | The parent record |
| `project_aliases` | alias_id → project_id | Survives merges |
| `project_phases` | project_id, phase (planning · design · permitting · bidding · construction · closeout), start, end, source | Lifecycle |
| `project_sources` | project_id, kind (permit · land_use · council · bid_request · upload · licensed), source_id, external_id, url, first_seen, last_seen | Provenance for everything |
| `project_permits` | project_id, permit_id, link_method (address · permit_no · manual), confidence | Many permits per project |
| `companies` / `project_companies` | role (owner · developer · GC · CM · architect · engineer · trade), source, verified, first_seen, last_seen | Team over time |
| `people` / `affiliations` / `project_contacts` | person ↔ company with dates; person ↔ project role; evidence URL; verification | Employment history kept, never presented as current when stale |
| `drawing_sets` / `drawing_sheets` / `drawing_revisions` | set (discipline package) → sheets → revisions with addendum number and file hash | Generalizes today's plan-room files |
| `project_bid_packages` | project_id ↔ bid request | Many packages per project |
| `project_planholders` | package ↔ company, intent, opened, acknowledged addenda | From invitations |
| `project_awards` | package, company, amount, contract id, date | From contracts |

## Linking rules (deterministic, explainable)
1. A new permit joins an existing project when its normalized address matches, its permit number references one, or
   a user links it; otherwise it creates a project. Each link stores its method and confidence.
2. Land-use applications create **planning-phase** projects; a later permit at that address joins the same project.
3. A GC bid request at a project's address links to it; GCs can also pick the project explicitly when posting.
4. Ambiguous matches (two candidate projects) go to an admin review queue instead of guessing.

## Migration (no downtime, reversible)
1. Create tables (schema version 2). 2. Backfill: one project per current `siteKey`; link permits, signals, bid
requests, documents. 3. Dual-write: ingest and posting write both models. 4. Switch reads (Command Center, profile,
search, map) to the core tables. 5. Remove the in-memory requirement for permits/projects. Each step ships with tests
and the `qa/` browser suite; production switches only after testing against a copy of the live database.

## Acceptance test (from the review)
One development end-to-end: discovered from an authorized source → permanent project → permit + planning history →
owner/developer/GC/architect with evidence → authorized drawing set → indexed drawings and specs → AI rooms and areas →
estimator confirms → Bright Clean estimate → proposal → authorized procurement contact → approved submission →
submission evidence → followed to award. Steps that depend on data BUILDINTEL does not yet have (licensed drawings,
GM contacts) are run with GC-uploaded documents and verified contacts, and reported as such.
