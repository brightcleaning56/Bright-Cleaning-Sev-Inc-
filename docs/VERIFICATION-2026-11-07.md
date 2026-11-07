# Independent verification of the uploaded BUILDINTEL v1.9.0 (2026-11-07)

This repository now holds the uploaded `BUILDINTEL-Admin-UI-Refresh.zip` codebase. It replaces the earlier
owner-console build, which remains in git history (commit `b8d2250` and earlier).

## What was checked
| Check | Result |
|---|---|
| `release-evidence/MANIFEST.sha256` against the shipped evidence files | 32 of 32 match |
| Dependency install (`npm ci`) and security audit | 0 vulnerabilities |
| Full suite, fresh PostgreSQL 16 database, serial (`npm test`) | **175 of 175 pass, 0 fail, 0 skipped**, two consecutive runs |
| Full suite on the zip as uploaded, same database | **10 fail**: the schema bug below |
| Bright Clean rate cards and onboarding | Rates are all `null`; the API refuses any null. New cards are drafts until an owner approves them. |
| Entitlement prices | Labelled "proposed — confirm before charging" |
| Email | `EMAIL_MODE` defaults to `dry-run`. Live needs `EMAIL_MODE=live` and a Postmark token. |
| Sample data | Not in the production path |
| Source registry | Every source is disabled until terms are reviewed, with a named reviewer and evidence. Chicago's terms include an indemnity clause, flagged in code. |
| Startup secrets | Server exits if `APP_SECRET` is under 32 characters |
| Hard-coded secrets | None found. Matches are test fixtures only. |
| Admin UI (`/admin`) | Signs in and renders in file-storage mode, no page errors |

## Defects found and fixed
1. **Fresh database install failed (blocker).** `src/coredb.js` ran `ALTER TABLE bi_project_phases` before
   creating that table. Every new database failed at startup, so a new Render Postgres would not have come up.
   Fixed by ordering the statement after the `CREATE`. Regression test: `test/schema-fresh.test.js`, which runs
   the real `PgStore.init()` on an empty schema. Confirmed it fails with the bug and passes with the fix.
2. **Test suite was not isolated.** Test files ran in parallel against one database and truncated each other's
   data. Symptoms: counts such as 1890 and 2226 in a test that expects 2000. `npm test` now runs one file at a time.
3. **Background reloads ran after shutdown.** The change listener could query a closed pool and log errors.
   Pool shutdown now stops the listener first, whether it goes through `close()` or a direct `pool.end()`.

## What is not verified here
- Browser QA suite (`qa/run.sh`), which the project's own release claim relies on. Only the admin sign-in and
  dashboard were captured in a browser for this report.
- Deployment. Nothing has been deployed from this codebase.
- Anything that needs a person or account: attorney review, insurance, penetration test, data-source authorization,
  Bright Clean rate approval, email domain verification, payment processor setup.

## Commands used
```bash
cd release-evidence && sha256sum -c MANIFEST.sha256
createdb repo_check && TEST_DATABASE_URL=postgres://… npm test
node scripts/doctor.mjs
```
