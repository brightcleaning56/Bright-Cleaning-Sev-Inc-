# BUILDINTEL v4 — remediation and acceptance checklist

Source: independent review of the v4 package. Each item: what was found, what changed, how it is proven.
Release rule: **all automated items pass in `scripts/verify-release.sh`** (clean install, real PostgreSQL, no skipped
tests, audit, browser QA in both modes); owner items are tracked as launch gates.

## A. Fixed in this release

| # | Finding | Fix (files) | Proof |
|---|---|---|---|
| A1 | `test:ci` piped through `tee`: a failing suite could exit 0 | `scripts/test-ci.mjs` runs the tests itself and exits with their exit code; also fails on any skipped test, a disappeared test, or an incomplete environment (`package.json`, `.github/workflows/ci.yml`) | Reproduced the bug (failing test + `tee` → exit 0). New runner: failing test → exit 1; no database → exit 1; missing/mismatched dependency → exit 1; healthy → exit 0 (143/143) |
| A2 | Plan-room tests failed where `pdfjs-dist` wasn't installed — environment, not code, but indistinguishable | `scripts/doctor.mjs` (`npm run doctor`): checks Node version, every dependency installed **at the pinned version**, PostgreSQL reachable; runs first in CI and in release verification | Hiding `pdfjs-dist` → "pdfjs-dist is 5.6.205 but package.json pins 6.4.299: run npm ci" (it also exposed an older copy in a parent folder that Node would have used silently) |
| A3 | No proof the plan room works with real dependencies | Release verification does a clean `npm ci` from the lockfile, then runs the plan-room tests (real PDFs) and browser QA | `docs/RELEASE-VERIFICATION.md` |
| A4 | Skipped PostgreSQL tests | CI and release verification **fail** if any test is skipped | Release verification: 0 skipped |
| A5 | Memory figures contradict (`SCALING.md` ~250k vs `PROJECT-CORE.md` ~80k) | `SCALING.md` rewritten from measurements: 4.2 KB/permit, ~80,000 permits on Starter (512 MB), ~350,000 on Standard (2 GB) | Measurement table in `SCALING.md` (5k–100k permits) |
| A6 | (found while fixing A1) Project anchor permit could switch when two permits linked in the same millisecond — following and estimates could attach to the wrong permit | Every project link gets a global sequence number; anchor chosen by sequence (`src/core.js`, `src/leads.js`) | Frozen-clock test (all timestamps identical): fails on the old ordering ("project 1"), passes now; 5 repeated runs clean |

## B. Open — engineering (next releases, each verified the same way)

| # | Item | Acceptance |
|---|---|---|
| B1 | Project core phase 3: database-backed reads for permits/projects | Search, map, command center and profile served from SQL; parity tool PASS on a live-database copy; memory no longer grows with permit count |
| B2 | Versioned writes + change notifications | Two app instances writing concurrently: no lost update (test), caches refresh within seconds |
| B3 | AI-suggested measurements (geometry) | Accuracy harness on ≥20 real sheets from ≥3 firms; invented areas = 0; area error reported |
| B4 | CAD/BIM ingestion, visual revision comparison | Defined file types; comparison tested on real revisions |

## C. Open — owner actions (launch gates)

| # | Item | How it's verified |
|---|---|---|
| C1 | Postmark (email) | Launch Gates → "Send test email to me" → delivered |
| C2 | Stripe (payments) | Test-mode checkout → webhook → plan active |
| C3 | Off-site backups (`BACKUP_S3_*`) | "Off-site backup copy" gate PASS |
| C4 | `ANTHROPIC_API_KEY` + accuracy run | `docs/ai-accuracy-report.json` with ≥20 sheets |
| C5 | Licensed data/document agreements (Dodge, ConstructConnect) | Signed terms recorded in Data Sources |
| C6 | Chicago / Dallas indemnity decision | Terms recorded, feed live |
| C7 | Attorney review, cyber/E&O insurance, penetration test, security contact | Launch gates `ATTEST_*`, `SECURITY_CONTACT` |
| C8 | Live deployment matches the verified build | Launch Gates release line shows the verified version/commit; Geographic Coverage shows "database tables match records" |
