# BUILDINTEL Production Master Specification (v1)

Source: the architecture, operating model and launch blueprint (modular monolith, Node 22, PostgreSQL, R2, Stripe,
Postmark, $45/month baseline). This document turns it into workstreams that several agents can run **in parallel**,
each with files, tests and acceptance evidence. It sits after the current release (v5 publishing — verified, packaged).

## How the parallel agents work (read first)

1. **One integration lead** (one Claude Code session, or a person) owns `main`, merges branches, and runs
   `bash scripts/verify-release.sh`. Nothing merges unless that report says **PASS**.
2. **Each agent = one Claude Code session on its own git branch** (e.g. `git worktree add ../bi-billing ws/billing`),
   given one brief from §4 below plus this file. Agents never push to `main`.
3. **Step R0 must land first** (integration lead, ~1 day): split `src/server.js` routes into `src/api/*.routes.js` and the
   front end into feature files. Today almost every feature touches those two files, so parallel branches would collide
   constantly. After R0, each workstream owns its own route/UI files.
4. **Order constraints:** WS1 (database core) changes storage for everyone — start it first; WS3–WS6 can run alongside
   it only in files WS1 doesn't own. WS5 (billing) and WS6 (notifications) need the owner's Stripe/Postmark test accounts.
5. **Rules for every agent:** don't remove features or APIs; every feature has backend + database + permission + error +
   test path; no skipped tests; no "complete" claims for simulated integrations; report changed files, migrations, tests
   added, and the verify-release result.

## 1. Status against the blueprint (as of the verified v5 build)

| Blueprint item | Status |
|---|---|
| Modular monolith, Node 22, PostgreSQL, self-hosted pdf.js (patched 6.4.299) | **Done** |
| CI exit-code fix (`tee`), no skipped DB tests, missing-test guard, clean-install verification | **Done** (`scripts/test-ci.mjs`, `verify-release.sh`) |
| One subscription catalog, entitlements, seat/AI/export/publication limits | **Done** (v5); Stripe for the new catalog **open** |
| Verified publishers, authority evidence, permissions, multi-package publishing, coverage, market status | **Done** (v5) |
| Permanent project core, links with evidence, phases, relational tables (schema v3), parity tool | **Done**; `CORE_READS` still off |
| Database-backed reads, versioned writes, change notifications (multi-instance) | **Open** → WS1 |
| PostgreSQL job queue (`SKIP LOCKED`) + transactional outbox | **Open** → WS1 |
| Company invitations, named roles, MFA, multi-company switch, revoke on removal | **Partial** (permissions + seats done) → WS2 |
| R2 object storage, presigned upload/download, per-package document grants, access log, malware/PDF checks | **Partial** (private disk + signed links + encrypted vault) → WS3 |
| Package state machine (deadline reached, evaluation, not awarded), late bids marked late | **Partial** → WS3 |
| Q&A/RFIs, request-access flow, bid revisions, award/regret notices | **Partial** (addenda + acknowledgement + receipts done) → WS4 |
| Stripe Checkout, Billing Portal, webhook ledger, grace period, cancel at period end, invoices, revenue dashboard | **Partial** (checkout + webhook code for old plans) → WS5 |
| Postmark delivery via outbox, digests, bounce/complaint handling | **Partial** (code, dry-run) → WS6 |
| AI accuracy on 100 sheets, result cache by hash/model/prompt, credit ledger, cost shown before running, AI-suggested measurements | **Partial** (harness, per-plan credits) → WS7 |
| E2E-001…020, tenant/role matrix, webhook replay, malicious PDF, mobile widths, performance targets | **Partial** (9 browser flows, 150 tests) → WS8 |
| Super-admin operations dashboard, budget alerts, monitoring | **Partial** (launch gates, release line, coverage) → WS9 |
| Versioned API (`/api/v1`), migration framework with row-count/checksum verification | **Open** → R0 / WS1 |

## 2. Owner track (Eric — no agent can do these)

| # | Action | Unblocks |
|---|---|---|
| O1 | Confirm or change prices (Free/$99/$199/$349; publisher Free/$149/$399) | WS5 |
| O2 | Stripe account (test mode first) → `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | WS5 |
| O3 | Postmark server + sending domain DNS → `POSTMARK_TOKEN`, `PLATFORM_FROM` | WS6 |
| O4 | Cloudflare R2 bucket + keys (documents + off-site backups) | WS3, backups gate |
| O5 | Upgrade Render PostgreSQL to 1 GB (~$19/mo) | WS1 load tests |
| O6 | `ANTHROPIC_API_KEY` + 100 real sheets with known answers | WS7 |
| O7 | Attorney review, cyber/E&O insurance, penetration test, security contact | Launch |
| O8 | Chicago/Dallas terms decision; Iowa records requests; licensed data agreements | Coverage |
| O9 | 10–20 pilot publishers and the first paying subscribers (Bright Clean as first real subscriber) | Pilot |

## 3. Workstreams

| WS | Name | Owns (files) | Depends on |
|---|---|---|---|
| R0 | Route/UI split (integration lead) | `src/server.js` → `src/api/*.routes.js`; `public/index.html` → feature files | — |
| WS1 | Database core & jobs | `store.js`, `pgstore.js`, `coredb.js`, `src/jobs.js` (new), migrations | R0 |
| WS2 | Identity, companies, roles | `security.js`, `api/auth.routes.js`, `api/company.routes.js`, `src/orgs.js` (new) | R0 |
| WS3 | Publishing state machine & plan room storage | `publishing.js`, `documents.js`, `planroom.js`, `src/storage.js` (new) | R0, O4 |
| WS4 | Marketplace: Q&A, access requests, bid revisions | `marketplace.js`, `src/qa.js` (new), `api/bidding.routes.js` | R0 |
| WS5 | Billing & revenue | `billing.js`, `entitlements.js`, `api/billing.routes.js` | R0, O1, O2 |
| WS6 | Notifications | `outbound.js`, `digest.js`, `src/notify.js` (new) | WS1 outbox, O3 |
| WS7 | AI & takeoff accuracy | `ai.js`, `measure.js`, `takeoff.js`, `scripts/ai-accuracy.mjs` | O6 |
| WS8 | QA, security & performance | `test/`, `qa/`, `scripts/` | all (runs continuously) |
| WS9 | Platform operations | `readiness.js`, `api/admin.routes.js` | WS1, WS5 |

## 4. Agent briefs (paste one into each Claude Code session, with this file and the repo)

**Common header for every brief:**
> You are working on BUILDINTEL (repo root). Read `docs/FILES.md`, `docs/V5-PUBLISHING.md`, `docs/PROJECT-CORE.md` and
> `BUILDINTEL-production-master-spec.md`. Work only on branch `ws/<name>` and only in the files your workstream owns
> (ask the integration lead before touching others). Keep every existing feature and API. Every change needs tests.
> Finish with `TEST_DATABASE_URL=… bash scripts/verify-release.sh` = PASS and a summary: files changed, migrations,
> tests added, evidence for each acceptance item, anything not done.

**R0 — Route/UI split (integration lead).** Move route definitions from `src/server.js` into `src/api/*.routes.js`
(auth, company, projects, publishing, planroom, bidding, billing, admin) with identical paths and behavior; add
`/api/v1/...` aliases. Split the `public/index.html` script into feature files served from `/app/*.js` (CSP stays
`script-src 'self'`). *Acceptance:* zero behavior change — same 150 tests, same 9 browser flows, dead-control audit 0.

**WS1 — Database core & jobs.** (a) Serve projects/permits/search/map/command center/profile from SQL (`bi_*` tables +
`records` with indexes; add `pg_trgm`, full-text, PostGIS if available); permits no longer held in memory.
(b) Versioned writes: `version` per record; a stale write is rejected and reported, never silently overwrites.
(c) `LISTEN/NOTIFY` cache invalidation between instances. (d) `jobs` table with `FOR UPDATE SKIP LOCKED`, retries with
backoff + jitter, dead letters; `outbox_events` written in the same transaction as the business change.
(e) Numbered migrations with row-count/checksum verification. *Acceptance:* parity PASS on a live-DB copy; memory flat
as permits grow (measure 10k/100k); E2E-019 (two instances write concurrently, no lost update); p95 search < 1 s.

**WS2 — Identity, companies, roles.** Company invitations by email (user sets own password; replaces owner-set
passwords), join-existing-company flow, named roles (Owner, Admin, GM, Project Executive, Precon Manager, Estimator,
PM, Bidder, Read-only) mapped onto existing permissions, resource-level checks (assigned projects), MFA (TOTP) for
platform admins and company owners, multi-company membership with explicit company switch, removing a member revokes
sessions and document access. *Acceptance:* E2E-001, 002, 017; role/permission matrix test across two companies.

**WS3 — Publishing state machine & plan room storage.** Package states: draft → ready → open → deadline_reached →
evaluation → awarded/not_awarded → closed; late bids accepted but marked late (publisher decides). Cloudflare R2:
presigned uploads (5–15 min) direct from the browser, presigned views (5–10 min), SHA-256 dedupe, PDF validation and
size/page caps, malware-scan hook, per-package/per-document access grants, access log (view/download/replace),
revocation on suspension or membership removal; keep the local-disk path for development. *Acceptance:* E2E-004, 005,
007, 008; forged/expired URL tests; no public bucket.

**WS4 — Marketplace.** Package Q&A/RFIs (question → answer to all invited bidders → clarification log in the bid
record), request-access flow for discoverable packages with publisher approval, bid revisions (new receipt + hash, old
kept), award and regret notices, "needs clarification" intent. *Acceptance:* E2E-006, 009–013 with two independent
bidder companies.

**WS5 — Billing & revenue.** Stripe prices for every catalog plan, Checkout, Billing Portal, signature-verified
webhook ledger (idempotent; replay-safe), entitlements change only on verified events, grace period on failed payment,
cancel at period end, invoices/receipts in the Subscription Center, revenue dashboard (MRR, churn, failed payments,
fees, gross margin by plan). *Acceptance:* E2E-014, 015, 016 in Stripe test mode; webhook replay test.

**WS6 — Notifications.** Deliver from the outbox via Postmark: invitations, addenda, deadline changes, Q&A answers,
bid receipts, awards/regrets, billing notices; digest batching for non-urgent alerts; suppression list, bounce and
complaint webhooks; daily send caps. *Acceptance:* every event type delivered in Postmark test mode; a failed send
retries and is visible to admins (no silent failure).

**WS7 — AI & takeoff.** Run `scripts/ai-accuracy.mjs` on ≥100 sheets (≥3 firms, several disciplines); report
classification accuracy, room/finish precision and recall, printed-area accuracy, invented-area rate. Cache results by
document hash + model + prompt version; credit ledger per company; show estimated cost before running; AI-suggested
measurements that enter an estimate only after estimator confirmation. *Acceptance:* report published; invented
quantities entering estimates without confirmation = 0; repeat analysis of an unchanged sheet costs nothing.

**WS8 — QA, security & performance.** Implement E2E-001…020 as automated tests (browser where user-facing); tenant and
role matrix for the new model; signed-URL forgery/expiry; billing-bypass; webhook replay; malicious/oversized PDFs;
XSS/SQL injection; session revocation; browser QA at desktop and mobile widths; performance baseline vs. targets
(API p95 < 500 ms, search < 1 s, dashboard < 2 s). *Acceptance:* evidence package items 1–14 from the blueprint.

**WS9 — Platform operations.** Super-admin dashboard (companies, verified publishers, subscribers, projects, open
packages, invitations, bids, awards, MRR, failed jobs, AI/storage/email usage, source freshness, backups, security
events); budget alerts at 50/75/90% that throttle AI and exports first, never bidding or billing. *Acceptance:* every
number reconciles to stored records.

## 5. Release gates (unchanged)
Every merge: verify-release PASS (clean install, all tests with PostgreSQL and no skips, audit, browser QA in both
modes). Production: owner track O1–O7 complete, E2E-001…020 passing, keep `numInstances: 1` until WS1 (b)+(c) pass.
