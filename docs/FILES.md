# BUILDINTEL — file map

## Run & deploy
| File | Purpose |
|---|---|
| `package.json`, `package-lock.json` | Node project (runtime dependencies: `pg`, `pdfjs-dist` 6.4.299 pinned); `npm run test:ci` for CI |
| `render.yaml` | Render blueprint: web service, PostgreSQL, persistent disk, environment |
| `Dockerfile` | Container build |
| `.env.example` | Every environment variable, with notes |
| `.github/workflows/ci.yml` | CI: runs the test suite (with PostgreSQL) |
| `README.md` | Overview, how the system flows, setup |

## Server (`src/`)
| File | Purpose |
|---|---|
| `server.js` | HTTP API, routes, security headers, scheduler, startup (`bootstrap`) |
| `config.js` | All settings from environment variables |
| `store.js` | Record store (shared + tenant-isolated collections), audit log |
| `pgstore.js` | PostgreSQL persistence (records + core tables in one transaction), cross-server job lock |
| `pgtls.js` | Database TLS rules (separate so tests don't need the PostgreSQL driver) |
| `open-store.js` | Chooses PostgreSQL or JSON-file storage |
| `core.js` | **Project Intelligence Core**: permanent projects, links, companies with evidence, phases, merge/split, review |
| `coredb.js` | Core relational tables (schema v2), dual-write, reconcile, SQL search |
| `permitsql.js` | Project search in PostgreSQL (`SQL_READS=on`): filters, grouping, totals, sorting and paging in the database |
| `parity.js` | Compares old (address) and new (project) reads — used before switching `CORE_READS` on |
| `permits.js` | Permit normalization, validation, de-duplication, classification, ingest |
| `sources/registry.js` | Data-source catalog and terms/authorization gate |
| `sources/adapters.js` | Socrata, ArcGIS, CSV import adapters; probes |
| `enrichment.js` | State contractor licenses; land-use and council signals |
| `leads.js` | Subscriber search, job-site grouping, work tags, contractors, command center, map, market |
| `marketplace.js` | Bid requests (trade packages), trades, invitations (eligible / invite-only), bids, receipts, award with e-signature |
| `publishing.js` | Project publishing: publisher verification, authority, permissions, publications, packages, checklist, publish/close/archive, coverage, bidder directory, market status |
| `admin/rbac.js`, `admin/service.js` | Super Admin portal: platform roles/permissions, redaction, audit helper; dashboard, companies, users, authority review, audit search |
| `entitlements.js` | One subscription catalog (subscriber + publisher lines), entitlements, seat/AI/publication limits, usage |
| `documents.js` | Plan room: PDF uploads, sheet index, addenda, signed links, planholders |
| `planroom.js` | National Plan Room foundation: drawing sets/sheets/revisions, text extraction and search, revision comparison, rights model |
| `measure.js` | On-drawing takeoff: scales, calibration, length/area/count, notes |
| `ai.js` | AI floor-plan reading (needs `ANTHROPIC_API_KEY`), accuracy scoring |
| `takeoff.js` | Estimates from analyses, measurements, permits or manual lines; proposals; submit as bid |
| `estimate.js` | Rate cards and cost-plus pricing (exact to the cent) |
| `prequal.js` | Contractor prequalification and bid leveling |
| `credentials.js` | Insurance certificates and licenses |
| `outreach.js` | Compliant email from subscribers to verified GC contacts |
| `outbound.js` | Email sending (Postmark), unsubscribe, proposal rendering |
| `autopilot.js` | Hourly cycle: collect → link projects → qualify → price → draft → send |
| `digest.js` | Alerts, stage changes, invitation and addendum notices, weekly digest |
| `engagement.js` | Follow-ups, replies, retention, analytics |
| `domain.js` | Contact verification, bid state machine, scoring |
| `billing.js` | Plans, trials, territories, Stripe checkout + webhook |
| `security.js` | Password hashing, sessions, signing, rate limits |
| `readiness.js` | Launch gates with evidence |
| `backup.js` | Encrypted database backups, document vault, restore tests, off-site copies |
| `cli.js` | Command line: readiness, cycle, backup, restore-test, migrate-to-pg |

## Web app (`public/`)
| File | Purpose |
|---|---|
| `index.html` | The customer interface (Command Center design system); accepts `/#open:<screen>` deep links |
| `admin.html`, `admin.js` | Super Admin portal at `/admin` (own shell; all data from `/api/admin/*`) |
| `vendor/pdf.min.mjs`, `vendor/pdf.worker.min.mjs` | Self-hosted PDF viewer (pdf.js 6.4.299 legacy build, Apache-2.0) |
| `vendor/leaflet.js`, `vendor/leaflet.css` | Self-hosted map library (Leaflet 1.9.4, BSD-2) |

## Tests & QA
| Path | Purpose |
|---|---|
| `test/*.test.js` | Automated tests (`npm test`); list in `docs/TEST-INVENTORY.md` |
| `qa/` | Browser checks: `bash qa/run.sh` (see `qa/README.md`); `qa/fixtures/` holds sample PDF drawings |

## Scripts
| File | Purpose |
|---|---|
| `scripts/test-inventory.mjs` | Writes the test inventory; fails if a test disappears |
| `scripts/test-ci.mjs` | CI test runner (`npm run test:ci`): uses the test process's exit code; fails on any failure, skip or missing test |
| `scripts/doctor.mjs` | Environment preflight (`npm run doctor`): Node version, dependencies at pinned versions, PostgreSQL (`--db`) |
| `scripts/verify-release.sh` | Full release verification in a clean copy; writes `docs/RELEASE-VERIFICATION.md` |
| `scripts/ai-accuracy.mjs` | Measures AI drawing accuracy against known answers |
| `scripts/core-parity.mjs` | Read-only parity check against any database copy (run before `CORE_READS=on`) |
| `scripts/onboard-bright-clean.sh`, `scripts/bright-clean-rates.json` | Bright Clean setup and rate template |

## Release evidence (`release-evidence/`)
Full logs, test output, browser screenshots and `MANIFEST.sha256` from the last `scripts/verify-release.sh` run.

## Documents (`docs/`)
| File | Purpose |
|---|---|
| `SUPER-ADMIN.md` | Super Admin portal: inventory, role matrix, 20 acceptance workflows with status and evidence |
| `MASTER-SPEC.md` | **Single source of truth**: every item DONE/PARTIAL/OPEN/BLOCKED with evidence; lifecycle acceptance standard |
| `BUILDINTEL-production-master-spec.md` | Parallel workstreams (R0, WS1–WS9) and agent briefs |
| `ACCEPTANCE.md` | Acceptance evidence: departments, reports, review findings |
| `PROJECT-CORE.md` | Project Intelligence Core design, status and phases |
| `CORE-ROLLOUT.md` | Step-by-step: copy live DB → parity check → switch on → rollback |
| `TEST-INVENTORY.md` | Every automated test by name |
| `RELEASE-VERIFICATION.md` | Latest release verification result (generated) |
| `V5-PUBLISHING.md` | Project Publishing & Subscription System: what is built (with evidence) and what is next |
| `V4-REMEDIATION.md` | v4 review findings: fixed items with proof, open engineering and owner items |
| `SCALING.md`, `LAUNCH_24H.md` | Scaling notes; launch checklist |
| `policies/*.md` | Draft terms, privacy, email and data-source policies (attorney review pending) |
