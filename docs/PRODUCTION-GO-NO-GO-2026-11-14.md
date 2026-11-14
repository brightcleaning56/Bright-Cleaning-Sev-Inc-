# Production go / no-go: BUILDINTEL, 2026-11-14

## Verdict

**Not ready for open public launch or paid subscriptions.** The product works end to end across the roles it covers, and it is deployed and healthy on Render. Three things stop a public launch, and two of them need you:

1. **Email is not live.** Confirmation, invitation, award and reminder emails are logged but not sent (Postmark is not connected). Without email a new account cannot confirm itself, so nobody new can get in. This is the first blocker.
2. **Payments are not live.** Stripe is not connected, so plans cannot be bought or billed.
3. **Legal, security review and a penetration test are not done.** These need counsel, an insurer and an independent firm.

A **controlled pilot** with two or three general contractors and their subcontractors is reasonable once item 1 is done, with each pilot company onboarded by hand and no payment taken.

## What was verified (evidence in the repo)

| Check | Result | Where |
|---|---|---|
| Unit and integration tests | 285 of 285 pass | `npm run test:ci` |
| Browser checks across every screen | 21 of 21 pass, with core reads off and on | `qa/run.sh`, `docs/RELEASE-VERIFICATION.md` |
| End-to-end journey: Super Admin → owner → subcontractor → award → countersign → audit log | Passes every step | `qa/full_system_flow.py` |
| Golden path through the HTTP routes (sign-up to countersigned contract) | Passes | `test/golden-path.test.js` |
| Phone width: every main screen fits 390px | Passes | `qa/mobile_sweep.py` |
| Production health | Live on Render; no errors in recent logs | Render service logs |
| Release verification (clean install, audit, tests, browser) | Passed on the earlier release commit; re-run after the latest changes is recommended before launch | `scripts/verify-release.sh` |

Per role:

- **Super Admin:** verifies publishers with documents and a review history; suspends and reactivates companies with a reason; views uploaded documents (logged); audit log; a dashboard that says plainly which numbers cannot yet be measured. Works.
- **Owner / GC / developer:** signs up, confirms, gets verified, builds a project in a three-step wizard, adds trade packages with insurance minimums, publishes, sees the bid breadth, reminds and invites companies, compares bids (scope, exclusions, revisions, insurance, CSV export), awards with a signed record, amends contracts with the contractor's signature, duplicates projects, and sees the activity history and plan. Works.
- **Subcontractor:** adds trades and area, is invited automatically when a matching package opens, sees the insurance required and how many companies were invited, bids (or bids without an account through a link), revises a bid (the original is kept), sees invitations and contracts, and countersigns. Works.
- **Project manager / site manager / superintendent:** not served yet. Daily logs, photos, safety, punch lists and a field app are not built. This is a deliberate scope decision (see the market research): integrate with a field platform rather than rebuild one.
- **General manager:** served through the GC/owner screens (portfolio is one project at a time). A cross-project portfolio view is not built.
- **Service provider:** signs up and sees the cleaning and service workflow. Lightly tested beyond the sign-up and request paths.

## What is not verified

These are real gaps in the evidence, not in the code. Do not claim them as done.

- **Real email delivery and deliverability.** Only dry-run was tested. Needs Postmark, a verified domain, and bounce handling.
- **Real payments.** No charge has been taken or refunded in any test.
- **Load and scale.** The system has not been load-tested. It runs as a single instance on the Render starter plan. The store is in memory with snapshots to PostgreSQL, so memory grows with the data. Expect to need the database-backed reads (in the readiness plan) before more than a few hundred active companies.
- **Backup restore.** Backups are encrypted and written, but a restore into a clean environment has not been exercised in this session. Do this before launch.
- **Accessibility.** Keyboard and screen-reader behaviour was not audited against WCAG 2.2 AA.
- **Real devices.** Phone widths were checked in the browser at 390px, not on real phones.
- **Sign-in security.** Two-step sign-in exists for staff; the penetration test has not been run.
- **Public data sources.** Coverage is per city and per source. Each source's terms have not been reviewed for commercial use (owner action).

## Risks that a product fix will not remove

- **Network size.** The main reason a publisher would choose a bid platform is the number of companies it reaches. We currently reach companies that sign up. Supply has to be built through partnerships and outreach. Without it, the product is only as good as the pilot's own subcontractor list.
- **Pricing.** Every competitor is quote-based, and published prices conflict across sources. Our pricing is labelled "proposed until confirmed" on the website; that stays until real quotes are in.
- **Insurance policy.** The system lets an award go through below the insurance minimum with a recorded reason. Whether the business should block that is a decision for you.
- **Field tools.** A superintendent who lives in Procore or Fieldwire will not switch for bidding alone. The honest pitch is "the bid-to-field handoff", which needs an integration partner to be real.

## Why a customer should choose us (and where that claim is weak)

Strong, and checkable in the product:
- A verified publisher with recorded authority, so a bid invitation is never a cold lead from an unverified source.
- Every bidder sees why it was invited, how many others were invited, and the insurance it must hold before bidding.
- Bid comparison with scope, exclusions, revisions and insurance side by side, exportable to a spreadsheet, and an award that is signed by both parties with a recorded record.
- Contract amendments need the contractor's signature; the original proposal is never rewritten.
- Staff actions and document views are logged.

Weaker, and not to be claimed yet:
- "Largest network" (we do not have one).
- "Cheapest" (no confirmed prices).
- "Integrates with Procore" (no integration built).
- "Replaces your field tools" (no field tools built).

## Launch sequence (recommended)

1. **Now:** connect Postmark; set the owner variables on Render (`OWNER_EMAIL`, `OWNER_PASSWORD`, `BACKUP_KEY`, `BASE_URL`); run the restore test on a copy of the backups.
2. **Pilot (no payment):** two or three GCs and their subcontractors, onboarded by hand. Record every friction point. Watch what subcontractors actually do with invitations.
3. **Before any paid plan:** Stripe connected and tested with refunds; legal documents reviewed by counsel; penetration test; accessibility audit; real quotes for pricing.
4. **Before scale:** database-backed reads and a job queue (see `docs/PRODUCTION-READINESS-2026-11-10.md`); a load test at the expected pilot size times ten.

## Items only you can do

These are in `docs/OWNER-ACTIONS.md`. The most urgent are Postmark, the Render variables, and choosing the pilot companies.
