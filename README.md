# BUILDINTEL

**Construction lead intelligence for contractors and suppliers** (the iSqFt / BidClerk category), built on
automated public permit data, plus an optional bid autopilot and a buyer portal for GCs and property managers.

## Public website and application routes
- Public product website: `/` (feature overview, workflows, roles, data rights, source coverage, pricing disclosures). Product pages: `/platform`, `/project-intelligence`, `/marketplace`, `/plan-room`, `/takeoff-estimating`, `/bid-management`, `/service-contractors`, `/data-trust`, `/solutions`, `/pricing`, `/about`, `/contact`, `/faq`.
- Authenticated subscriber/publisher workspace: `/app` or `/login`.
- Protected platform Super Admin portal: `/admin`.
- UI screen gallery: `/ui-screens` (live previews of every public page included in this source package).
- Website accuracy and route contract: `docs/WEBSITE-SPEC.md`. The website is checked by `test/website.test.js` (routes, content policy, every internal link) and by `qa/website_flow.py` in the browser QA.

## Acceptance evidence
**Release check:** `TEST_DATABASE_URL=postgres://… bash scripts/verify-release.sh` (clean install, all tests with no skips, audit, browser QA in both modes) → `docs/RELEASE-VERIFICATION.md`. Latest: PASS.
Design for the next version: `docs/PROJECT-CORE.md` (Project Intelligence Core).
Backups include plan-room drawings (encrypted vault + restore drill). Off-site copies: set `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_REGION`, `BACKUP_S3_KEY_ID`, `BACKUP_S3_SECRET`.
Database TLS: verified by default; `PGSSL_CA` for a provider CA; `PGSSL_NO_VERIFY=true` only as an explicit (gate-failing) override.
Browser QA (dead controls, menu routing, every screen, all core flows): `bash qa/run.sh` (see `qa/README.md`).
Automated tests: `npm test`; the 2 PostgreSQL integration tests run only when `TEST_DATABASE_URL` points at a test database.
See `docs/ACCEPTANCE.md` (status of all 20 departments + the 12 required reports) and `docs/TEST-INVENTORY.md`.
AI accuracy: `ANTHROPIC_API_KEY=… node scripts/ai-accuracy.mjs <folder of PDFs + .truth.json>`.

## Publishing & subscriptions (v5)
Verified publishers publish projects with several trade packages (draft → checklist → publish); subscribers discover projects and bid. One entitlement catalog (`src/entitlements.js`, proposed prices). See `docs/V5-PUBLISHING.md`.

## How the system flows (iSqFt-style bidding + automated project discovery)
1. **Discover:** permits and land-use applications arrive hourly from city feeds → job sites, schedules, contractors, licenses.
2. **Subscriber acts on a lead:** saved-search alerts → project page → track → email the GC from the platform (compliant, logged).
3. **GC / property manager asks for bids:** posts a request for any of 24 trades (plans link, due date) → every subscriber whose trades
   and territory match is invited automatically (late joiners too) and notified.
4. **Subscriber responds:** will bid / won't bid → submits a bid (amount, scope, exclusions, documents); can revise until award.
   Cleaning companies with approved rates can also auto-price cleaning requests.
   Plan room: the GC uploads drawings/specs (PDF) to the request; sheets are indexed by discipline from file names; only the GC and
   invited bidders can open them (10-minute signed links); addenda are numbered, bidders are emailed and must acknowledge every
   addendum before bidding; the GC sees a planholder list (who opened plans, acknowledged addenda, bid).
5. **GC decides:** sees invited / will-bid / won't-bid counts and every bid side by side → awards with an e-signature → contract
   record for both sides.

## Command center & AI
- Command center: real KPIs for the company's territory (active job sites, new this month, reported value with its coverage %, open bid
  requests, early signals), live coverage list, project map (OpenStreetMap; move to a licensed tile provider before heavy use).
- AI floor-plan analyzer (needs ANTHROPIC_API_KEY): reads a plan-room drawing, returns sheets, rooms, printed areas, finishes and scopes,
  each with its source sheet. Areas not printed on the drawing are left blank — never estimated. Results are "unverified" until a person
  confirms them. Private to each company; AI_DAILY_LIMIT caps cost.

## Takeoff → estimate → bid
- Start an estimate from a CONFIRMED AI analysis (unconfirmed readings are refused): one line per room with a printed area, each keeping
  its sheet and room as the source; edited quantities are flagged "adjusted". Or build an estimate manually.
- Labor + material unit costs, waste %, overhead and profit (money math in integer cents — exact to the cent), plus rate-card lines for
  cleaning companies. "Submit as bid" sends the total as the bid; the bid lists every quantity with its source. Locked once submitted.

## Subscriber product (lead intelligence)
- Self-serve signup for any trade: 14-day trial, one state, no card.
- Project search across the subscriber's territory: keywords, city, building type, stage, value, verified-contact filter; sort by newest, value or soonest start.
- Project page: official record link, stage history, contractor/owner/architect from the record with verified contacts and evidence links, and an estimated schedule showing when each trade is likely on site (interior jobs vs new builds), clearly labeled as an estimate.
- Saved searches with daily email alerts for new projects and stage changes.
- Tracking (watching → contacted → bidding → won/lost) with notes; CSV export by plan.
- Plans priced by territory: Local (1 state), Regional (3), National (all). Prices are placeholders set in Stripe.
- Contractor pages (permit activity per GC, built from city records) with state license status where a license register is connected (Washington L&I).
- Planning pipeline: land-use items from city council records (Legistar), ahead of permits.
- Freshness on every lead (when it was last checked against the city record) and stage-change alerts for tracked projects.
- New data feeds: Austin, Chicago, Seattle open data (confirm each field map with POST /api/sources/:id/probe before enabling).

Construction intelligence + bid autopilot for commercial cleaning contractors (tenant #1: Bright Clean),
general contractors and property managers.

**Launch:** read `docs/LAUNCH_24H.md`.

## What runs without people
Every `CYCLE_MINUTES` the autopilot:
1. Pulls new records from authorized sources (Socrata permits, SAM.gov solicitations, CSV imports). Unauthorized sources are blocked in code.
2. Normalizes, validates, dedupes and classifies them (office, retail, warehouse, medical…), keeping the source link on every record. Missing values stay empty.
3. Scores each project per tenant: service area, project type, scope ends in a clean, permit status, size, minimum contract.
4. Estimates from owner-approved rate cards (cost-plus: labor + burden + equipment + supplies + mobilization + overhead + contingency, priced to margin, floored at the minimum). No square footage → "needs measurement", never a guess.
5. Finds a verified GC contact (evidence required), renders the proposal and creates the bid.
6. Auto-approves within the owner's limits, otherwise waits for one click.
7. Sends through Postmark with CAN-SPAM identity, postal address and one-click unsubscribe. "Sent" only with a provider message ID; webhooks drive delivered / bounced / complaint → suppression.
8. Prices open buyer requests (GCs, property managers) and submits proposals into their inbox; their award marks the bid won.
9. Sends one follow-up after `followUpDays`; GC replies attach to the bid and stop it; "remove me" replies suppress.
10. Applies the retention schedule (expired sessions, old previews, contacts unverified for 24 months, expired requests).
11. Pauses all bidding if there's no current general liability certificate on file; proposals state insurance and licenses as "on file" until verified with the issuer.
12. Buyer awards are electronically signed: signer name, consent wording, time, IP, browser and a SHA-256 of the exact proposal, downloadable by both sides with a tamper check.
Weekly (Monday): digest email to owners — what to approve, replies, GC contacts to add, expiring insurance, failing sources, launch gates.
Daily: encrypted backup + real restore test.

Owner-facing: launch gates, overview (pipeline value, win rate by channel), bids with replies, opportunities,
"Add GCs next" (contractors blocking the most bid value), pricing, data sources. Buyer-facing: signup with email
verification, post requests, compare proposals, award.

## Run locally
```
cp .env.example .env    # fill APP_SECRET, OWNER_EMAIL, OWNER_PASSWORD, BACKUP_KEY
set -a; . ./.env; set +a
npm test                # 150 tests (set TEST_DATABASE_URL to include the Postgres integration tests)
npm start               # http://localhost:3000
npm run readiness       # launch gates with evidence
```

## Layout
`src/store.js` tenant-isolated store + audit · `src/permits.js` normalization/dedupe ·
`src/sources/` registry (compliance gate) + adapters · `src/estimate.js` rate cards + engine ·
`src/domain.js` matching, contacts, bid state machine · `src/outbound.js` compliance + proposal + Postmark ·
`src/autopilot.js` cycle + email webhooks · `src/marketplace.js` buyer requests/awards · `src/engagement.js` follow-ups, replies, retention, analytics, GC directory · `src/credentials.js` insurance/licenses · `src/digest.js` weekly email · `src/pgstore.js` Postgres · `src/billing.js` Stripe · `src/backup.js` · `src/readiness.js` ·
`src/server.js` API + scheduler · `public/index.html` operator dashboard · `docs/policies/` drafts for counsel.

## Storage
PostgreSQL when `DATABASE_URL` is set (render.yaml provisions it); JSON file otherwise.
`node src/cli.js migrate-to-pg` moves a pilot over. See docs/SCALING.md. One runtime dependency: `pg`.

## CI
`.github/workflows/ci.yml` runs every test against a real Postgres 16 plus `npm audit` on each push.
