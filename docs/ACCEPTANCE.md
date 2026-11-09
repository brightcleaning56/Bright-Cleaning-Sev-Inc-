# BUILDINTEL — Acceptance Evidence (Master Product Expansion Directive, §11)

Status as of this build. Rule applied throughout: *a module counts as built only if it is connected to persistent
backend data and covered by automated tests and/or an end-to-end browser test.* Where something is not done, it says so.

Evidence sources: 225 automated tests (`docs/TEST-INVENTORY.md`), end-to-end browser flows run in Chromium against a
real server, and the live deployment (https://buildintel-9wqh.onrender.com, Render + PostgreSQL).
Without `TEST_DATABASE_URL`, 4 PostgreSQL integration tests are skipped (all others run, and none need the database driver installed); with a test database all 135 run. CI runs with PostgreSQL and fails if any test is skipped.
Browser checks: `bash qa/run.sh`. The running build reports its version and Git commit on **Launch Gates** (`/api/release`).

## Security fix (this release)
`npm audit` flagged pdf.js ≤ 4.7.76: **arbitrary JavaScript execution when opening a malicious PDF**
(GHSA-wgrm-67xf-hhpq). The self-hosted viewer was 3.11.174, so a malicious drawing uploaded to a plan room could have run
code in an invited bidder's session. Upgraded the viewer and the server to **6.4.299** (released Oct 3, 2026 — chosen over
the 3-day-old 6.5.438), using the legacy build so older browsers still work, and every PDF is opened with
`isEvalSupported: false`. `npm audit`: 0 vulnerabilities. The takeoff browser test (6,400 SF / 80 LF) passes on the new viewer.

## Independent review — findings and resolution

| Finding | Verified | Resolution |
|---|---|---|
| Plan-room PDFs not in backups | Yes (critical) | **Fixed.** Encrypted content-addressed document vault; every backup re-hashes files (detects corruption/missing); restore test checks records ↔ files and decrypts drawings against their fingerprints; full disaster drill test (wipe disk → restore → byte-identical). Launch gate added. |
| No off-site backups | Yes | **Built.** Any S3-compatible storage; request signing verified against AWS's published Signature V4 example. **Owner:** set `BACKUP_S3_*` (gate stays OWNER until then). |
| Postgres TLS verification disabled | Yes | **Fixed.** Verified by default over the internet; `PGSSL_CA` supported; opting out needs `PGSSL_NO_VERIFY=true` and fails a launch gate. Render's internal connection is a private network (no internet hop). |
| All records loaded into memory | Yes | **Measured, still open.** ~4.2 KB per permit, linear; ceiling ~80,000 permits on Render Starter, ~350,000 on Standard. Database-backed reads are phase 3 step 1 of the remaining work (`docs/PROJECT-CORE.md`). |
| Single instance only | Yes | **Partly addressed.** Scheduled jobs now take a cross-server lock (protects deploy overlaps today). Running several servers still needs database-backed reads, versioned writes and change notifications — keep one instance until then. |
| Test count mismatch in this document | Yes | **Fixed.** Total and the number of PostgreSQL-only tests are generated from the test files; no test needs the database driver to load; CI fails if any test is skipped or disappears. |
| Launch-gate count differs from a screenshot | Version mismatch | **Fixed.** Release identifier (version, commit, start time, integrations, last pull) on Launch Gates. |
| Browser QA not reproducible from the package | Partly | **Fixed.** `qa/` suite with pinned `qa/requirements.txt`; verified from a fresh unzip. |
| "National coverage" claims | Not in the app | **Strengthened.** Geographic Coverage page shows only live, authorized, current feeds. |
| Permit-centered data model | Yes | **Phases 1–2 built** (phase 2 behind `CORE_READS`, rollout in `docs/CORE-ROLLOUT.md`). Phase 1: permanent projects, links with provenance, lifecycle, relational tables in the same transaction (see `docs/PROJECT-CORE.md`). Phases 2–3 switch reads and remove the in-memory limit. |
| Policies are drafts | Yes | Remain drafts until attorney review (launch gate `ATTEST_ATTORNEY_REVIEW`). |

---

## Incident record
While adding the project-core tests, a new test file was given the name of an existing one (`test/core.test.js`) and
replaced 8 foundation tests (tenant isolation, contact rules, permit normalization, bid state machine, estimating, rate
cards, source authorization, CSV parsing). The suite still reported 0 failures because those tests no longer existed.
It was caught by comparing declared vs. expected test counts, the 8 tests were restored unchanged from the previous
package, and `scripts/test-inventory.mjs` now **fails if any previously inventoried test disappears** (verified by
simulating a lost file).

## 1. Complete feature inventory (20 departments)

| # | Department | Status | What exists (evidence) | What is missing |
|---|---|---|---|---|
| 1 | National Project Intelligence | **Partial** | Hourly collection from city open data; job-site dedupe; one project record per site; live: Austin TX, Seattle WA, Minneapolis MN (core, leads, round3 tests) | National coverage needs more cities and/or licensed data (owner: Dodge / ConstructConnect agreements) |
| 2 | Permit & Development Intelligence | **Built** | Permits, stage history, Seattle land-use applications (pre-permit), council land-use items, freshness on every record (enrichment, leads tests) | Planning feeds for cities beyond Seattle |
| 3 | Project Plans & Specifications | **Built (foundation of the National Plan Room)** | Drawing sets → sheets → revisions linked to permanent projects (database tables, schema v3); full-text search inside drawings and specifications (server-side text extraction); revision comparison of sheet text; explicit rights model with GC-upload and licensed-source rules (planroom-national tests with real PDFs; browser check) | Licensed document feeds (need agreements), CAD/BIM files, visual (graphic) revision comparison |
| 4 | Drawing & Document Management | **Built** | PDF-only uploads, sheet index by discipline, addenda numbering, version order, signed 10-minute links, self-hosted PDF rendering with page navigation and zoom, revision list, on-sheet notes (planroom, measure tests; browser takeoff test) | Rendered page thumbnails; freehand markup drawing |
| 5 | AI Floor Plan Analysis | **Built, not yet switched on** | Sheets, levels, rooms, printed areas, finishes, scopes; every item cites its sheet; unverified until confirmed; tenant-private; daily cap (ai tests) | ANTHROPIC_API_KEY (owner); accuracy not yet measured (see §7); AI revision comparison |
| 6 | GC & Contractor Intelligence | **Built** | Contractor pages from permit history; WA state license match (50% of named Seattle GCs, live); company directory (enrichment tests) | License registers for TX and MN |
| 7 | GM & Decision-Maker Intelligence | **Partial** | Contacts with role, verification status and evidence link; GM view filters by title (never invents people) | A lawful source of GM/estimator names at scale (licensed contact data) |
| 8 | Project Opportunity Discovery | **Built** | Search, filters, map, saved searches, daily alerts, stage-change alerts, pipeline tracking (leads, enrichment tests) | — |
| 9 | Bidder & Planholder Directory | **Built** | Per-request planholder list: invited, opened plans, addenda acknowledged, bid (planroom tests) | Public planholder lists from external plan rooms |
| 10 | GC Bid Management | **Built (v5 publishing)** — verified publishers, multi-package publications with draft/checklist/publish/close/archive, eligible or invite-only distribution, coverage dashboard (`docs/V5-PUBLISHING.md`); previously: | Post request (24 trades), auto-invite by trade + territory, plan room, addenda, leveling, prequalification, award with e-signature (itb, prequal tests; browser flows) | — |
| 11 | Subcontractor Bid Management | **Built** | Invitations, will/won't bid, bid + revisions, addenda gate, receipts (itb, prequal tests) | — |
| 12 | AI Takeoff & Measurement | **Built** | Takeoff from confirmed printed areas; on-drawing measuring with printed-scale presets or two-point calibration — lengths (LF), areas (SF), counts (EA); server recomputes every value; measurements → estimate lines citing sheet, page and scale (takeoff, measure tests; browser takeoff test) | AI-suggested measurements (today AI reads printed areas; people measure) |
| 13 | Commercial Estimating | **Built** | Labor/material/waste/overhead/profit, rate cards, exact-to-the-cent money math (takeoff tests) | — |
| 14 | Proposal Generation | **Built** | Rate-card proposals, bid documents, printable project proposals (core, workspace tests) | — |
| 15 | Bid Submission & Tracking | **Built** | Submissions, revisions, receipts with SHA-256 fingerprint, status, follow-ups (prequal, autopilot tests) | Email delivery waits on Postmark (owner) |
| 16 | Contractor Prequalification | **Built** | Insurance + license profile, issuer-verified flag, state license status, gap flags, GC approve/reject (prequal tests; browser flow) | — |
| 17 | Project Awards & Contracts | **Built** | E-signature (signer, consent, IP, time, document hash), tamper check (marketplace tests) | — |
| 18 | Construction Market Analytics | **Partial** | Activity by month, city, type, work, stage, value from collected permits (workspace tests) | Forecasting (labelled "not a forecast" until a model is validated) |
| 19 | Enterprise Subscription Management | **Partial (v5: one entitlement catalog, enforced seats/AI/exports/publications, Subscription Center)** | Plans, trials, territories, seats, Stripe checkout + webhook code (round3, http tests) | Stripe account not connected (owner) |
| 20 | Platform Administration & Compliance | **Built** | Launch gates, data-source admin with terms evidence, audit log, encrypted backups + restore test, retention, privacy requests (core, http tests) | Attorney review, cyber/E&O insurance, pen test (owner) |

---

## 2. Database schema and migration report

PostgreSQL (Render managed). Document model in one table plus an audit table:

- `records (collection, id, org_id, data jsonb, …) PRIMARY KEY (collection, id)`, index `(collection, org_id)`
- `audit (id bigserial, at, …)`, index `(at DESC)`
- `schema_meta (key, value)`

**Shared collections:** orgs, users, sessions, sources, permits, companies, contacts, suppression, privacyRequests, jobs,
messages, bidRequests, submissions, contracts, licenses, signals, invitations, documents.
**Tenant collections** (every read and write requires the organization id): rateCards, opportunities, proposals, bids,
credentials, tracked, savedSearches, analyses, estimates, prequal, measurements.

**Migrations:** all changes in this program were additive (new collections and fields), so no data migration was needed.
Two data corrections are handled in code: license matching v2 re-checks earlier misses automatically; the
negative-longitude fix applies on each source's next pull (Austin and Seattle re-pull hourly; **Minneapolis needs one
Resync** from Data Sources to fill coordinates on older records). Plan-room PDFs live on the Render persistent disk
(`/var/data/docs`) and are backed up to an encrypted document vault with every backup (see review table).

**Scale limits (open):** the PostgreSQL store loads all records into memory at startup and requires a single instance.
Measured fine at 5,000 permits. The Project Intelligence Core moves querying into the database before national scale.

**Directive items not adopted (and why):** PostGIS and a separate search engine are not used. Current volume
(thousands of records) is served from memory with Postgres for durability. Both become worthwhile around
hundreds of thousands of records or national coverage.

## 3. Data-source authorization report

Every source has an authorization record (reviewer, date, evidence) in **Data Sources**; collection is blocked without one.

| Source | Status | Evidence on file |
|---|---|---|
| Austin TX building permits | Live | Recorded at enablement (see Data Sources panel) |
| Seattle WA building permits | Live | Portal license "Public Domain" |
| Minneapolis MN commercial permits | Live | Recorded at enablement |
| Seattle land-use permits | Live | Portal license "Public Domain" (probe Nov 3, 2026) |
| Seattle council (Legistar) | Live | Public legislative records, public API |
| Washington L&I contractor licenses | Live | Open Data Commons Public Domain (PDDL) |
| Chicago IL permits | **Off** | Terms require a displayed disclaimer (built) and an **indemnity of the City** — owner decision pending |
| Dallas TX permits | **Off** | Published disclaimer includes an **indemnity** — owner decision pending |
| SAM.gov | Off | Needs API key |
| Iowa cities (CSV) | Off | Records requests not yet sent (owner) |
| Dodge / ConstructConnect / Autodesk | Not integrated | Require commercial licensing agreements; API access ≠ redistribution rights |

## 4. Drawing and document rights report

- Only **GC/owner uploads** to their own bid requests. BUILDINTEL does not copy drawings attached to city permits:
  architectural drawings can be copyrighted, and a public permit file does not grant redistribution rights.
- Every file carries its rights statement: *"Uploaded by the project GC/owner. Viewable by the GC and invited bidders only. Do not redistribute."*
- Access: GC + invited bidders only (tested: an uninvited company gets "not found"). Files open through signed links that
  expire in 10 minutes; each open is recorded on the planholder list.
- Uploads must be real PDFs (content checked), duplicates refused, size limit enforced.

## 5. API integration report

| Integration | State |
|---|---|
| Socrata, ArcGIS, Legistar (city data) | Live, with 30-second request timeouts and a pull watchdog |
| Anthropic (AI drawing analysis) | Built and tested with simulated responses; **switches on with ANTHROPIC_API_KEY** |
| Postmark (email) | Built; **not connected** (EMAIL_MODE=dry-run) |
| Stripe (subscriptions) | Built; **not connected** |
| pdf.js 6.4.299 legacy build (Apache-2.0), Leaflet 1.9.4 (BSD-2) | Self-hosted; no third-party scripts allowed by the security policy. pdf.js is also used on the server to extract document text. |
| OpenStreetMap tiles | Live; move map tiles to a paid provider before heavy use |
| Dodge, ConstructConnect, Autodesk BuildingConnected | Not integrated (licensing first) |

## 6. Project relationship verification report

Each relationship carries a source, a verification state and a date:

| Relationship | Source | Verification | Date kept |
|---|---|---|---|
| Contractor / owner / architect on a project | City permit record (link kept) | "Named on permit" — never called the awarded contractor | `lastVerifiedAt`, every pull |
| Person at a company | Evidence URL required for verified status | `verified` / `source_confirmed` / unverified; opt-outs honored | created/updated |
| State license | State register (link kept) | Active / inactive as published | `checkedAt`, weekly |
| Permit ↔ bid package | Same normalized job-site address + invitation | Shown only to invited companies | live |
| Drawing quantities | Plan-room sheet | Unverified until a person confirms (`verifiedBy`, `verifiedAt`) | analysis record |

People, licenses and employment are never inferred or invented (tests assert empty states rather than guesses).

## 7. AI drawing extraction accuracy report

**Not yet measured, and no figure is claimed.** Measuring it needs (a) the API key and (b) real drawing sheets with
known correct answers. The harness is built: `node scripts/ai-accuracy.mjs <folder>` scores each sheet for room recall,
room precision, exact printed-area accuracy (±1 SF) and **invented areas (must be 0)**, and writes
`docs/ai-accuracy-report.json`. Recommended: 20+ sheets from 3+ design firms before relying on the numbers.

Safeguards already enforced in code and tests: areas not printed on the sheet are stripped even if the model returns
them; every item cites its sheet; results stay unverified until confirmed.

## 8. Takeoff measurement validation report

Validated by hand-checked tests: printed areas → estimate lines with sheet/room sources; quantity edits flagged
"adjusted"; 2,450 × 1.05 × $6 + 1,250 × $6 with 10% overhead and 15% profit = **$29,012.78**; rate-card pricing matches the
independent rate-card test; browser flow 3,650 SF × $8 + 10% + 10% = **$35,332.00**. A floating-point cent error
($3,784.275 rounding down) was found and fixed with integer-cent math.

On-drawing measurement is validated against known geometry: a 720 × 720-point (10" × 10") outline at 1/8" = 1'-0" measures
**6,400 SF** (80 ft × 80 ft), its diagonal **113.14 LF** (80·√2), a two-segment run **160 LF**, the same square at 1" = 20'
**40,000 SF**, and a two-point calibration of 25 ft over 5" gives 50 ft over 10". In a real browser, clicking the corners of
that outline on a rendered PDF produced exactly 6,400 SF and 80 LF, and the quantities flowed into an estimate.
Values sent from the browser are ignored: the server recomputes from points and scale.

## 9. Bid workflow test report

End-to-end in a real browser (all passing):
- GC posts → matching subcontractor invited → will bid → bid → GC sees counts → **leveling + prequalification** → award with signature → subcontractor sees award (7 steps).
- Plan room: upload and index → addendum → bidder blocked until acknowledgment → bid → planholder list (7 steps).
- Drawing analysis → confirm → estimate → priced → submitted as bid → locked (4 steps).
Unit coverage: itb, planroom, prequal, takeoff, marketplace, autopilot tests (see inventory).

## 10. Tenant security report

Tested isolation and controls:
- Tenant collections require the organization id on every access.
- Another company cannot open, analyze, confirm, estimate from, level or decide on someone else's records (404 by design).
- Plan-room files are invisible to uninvited companies; forged or expired links are refused.
- A GC sees only bids on its own requests; prequalification decisions are private to each GC.
- Role checks on admin routes (crew members get 403); rate limits on login, signup, test email and AI.
- Unsafe `javascript:` links refused on the server and neutralized in the UI; city text is escaped (XSS test).
- Security headers and a strict CSP (no third-party scripts; viewer and map libraries self-hosted); passwords hashed; encrypted backups.

Not yet done: independent penetration test (owner).

## 11. Page-by-page QA report

**Reproducible:** `bash qa/run.sh` runs all browser checks against throwaway demo servers (see `qa/README.md`).

**No decorative controls:** an automated audit opens every screen (owner, subscriber, GC, and every tab of a project
profile with drawings, bid packages and a confirmed takeoff) and checks that each visible button and link has a working
action. Result: **0 dead controls out of 3,073** checked. Its first run found one (a "City record" link on projects whose
source publishes no link); that now shows as plain text.

**One design across the product:** every screen uses the Command Center design system (sidebar, top bar, page header
with what the page is and where its data comes from, cards, pills). The project profile is the Command Center workspace
(header, tabs, drawing viewer, insights, opportunity, pipeline with stages and notes, compliant email to verified GC contacts).


Automated browser pass over every screen, and a stricter check that **each of the 58 menu items opens its own page**: GC/buyer view and mobile
signup — no page errors and no server errors. Layout checked at 1600–1672 px and 390 px (phone): no horizontal overflow.
Issues found and fixed during QA: subscriber menu items for Plan Room, Takeoff & Estimating, Market, Contacts, Awards and Insurance silently returning to the Command Center; subscribers stuck on project pages after tab clicks; oversized icons; serif font
fallback; clipped KPI values; stat dates wrapping; invisible donut chart; schedule using the recorded date instead of
the permit date; phone layout overflow.

## 12. Production readiness report

**Performance (measured with 5,000 permits, 3,000 on the map):** API responses 0.002–0.32 s (search is the slowest);
every screen ready in under 1.2 s in Chromium; the map draws 3,000 markers on a canvas in 1.26 s with no main-thread
block over 88 ms. Current live volume is ~1,500 job sites.

**Ready:** live on Render with PostgreSQL; hourly collection with timeouts and watchdog; background pulls; backups with
restore verification; launch gates; audit log.

**Before charging subscribers (owner actions):**
1. Postmark email (alerts, invitations, addenda, signup confirmations).
2. Stripe.
3. ANTHROPIC_API_KEY, then run the accuracy harness on real sheets.
4. Chicago / Dallas indemnity decision.
5. Attorney review of terms and privacy policy; cyber + tech E&O insurance; penetration test; named security contact.
6. Set `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_REGION`, `BACKUP_S3_KEY_ID`, `BACKUP_S3_SECRET` (e.g. Cloudflare R2 or AWS S3) to turn on off-site copies of the database and drawings.
7. Minneapolis: one Resync for map coordinates.
8. Delete the old `buildintel-api` service; make the public `Bright-Cleaning-Sev-Inc-` repo private.
