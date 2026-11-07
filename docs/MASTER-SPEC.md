# BUILDINTEL Master Specification — single source of truth

Every item carries one status, backed by evidence a reviewer can check:
**DONE** (works end to end in the browser with real database records, correct permissions, a reproducible test) ·
**PARTIAL** (some of that is missing — the gap is stated) · **OPEN** (not built) · **BLOCKED** (waiting on a named
owner action). Evidence refers to `docs/TEST-INVENTORY.md` (test names), `qa/` (browser flows) and
`release-evidence/` (logs, screenshots and a SHA-256 manifest from the last `scripts/verify-release.sh` run).

**Completion rule.** No agent or developer marks anything DONE because an endpoint returns successfully. The full
user workflow must work in the browser, with real database records, correct permissions, correct notifications (once
email is connected) and a reproducible test. A simulated integration is never DONE.

**Release rule.** Merge and release only when `verify-release.sh` reports PASS (clean `npm ci`, every test with
PostgreSQL and none skipped, dependency audit, browser QA with core reads off and on) and `release-evidence/` is
included. Reviewers without internet access can use the offline bundle (dependencies included).

## Acceptance standard — the full lifecycle (scored against the current build)

| # | Step | Status | Evidence / gap |
|---|---|---|---|
| L1 | Developer signs up and verifies the company | PARTIAL | Signup, email link, staff verification with recorded check (marketplace HTTP test; publishing tests). Email delivery BLOCKED on Postmark (O3) |
| L2 | Invites GM and estimator | PARTIAL | Owner adds members with permissions, seats enforced (HTTP seats test). Email invitations, named roles: OPEN (WS2) |
| L3 | Creates a commercial project | DONE | Publication with authority (publishing lifecycle test; `qa/publishing_flow.py`) |
| L4 | Six trade packages | DONE | Multiple packages per project (lifecycle test; flow adds packages) |
| L5 | Uploads drawings and specifications | PARTIAL | Per-package PDF plan room, sheet index, revisions, text search (planroom tests). R2 storage, virus scan, bulk/folder upload: OPEN (WS3) |
| L6 | Assigns package access | PARTIAL | Package-level access (GC + invited). Document-level grants within a package: OPEN (WS3) |
| L7 | Invites qualified subcontractors | DONE | Eligible (trade + territory) or invite-only, bidder directory (lifecycle test; flow) |
| L8 | Publishes the project | DONE | Checklist-gated publish; drafts invisible (lifecycle + discovered-permit tests; flow) |
| L9 | Subcontractor receives the invitation | PARTIAL | In-app invitation (flow step 6). Email: BLOCKED on Postmark |
| L10 | Subcontractor subscribes; activates only after Stripe confirms | BLOCKED | Entitlements built; Stripe for the new catalog OPEN (WS5), needs O1 + O2 |
| L11 | Views only authorized documents | DONE | Rights model + signed links (planroom-national, planroom tests) |
| L12 | Estimator reviews drawings, prepares a takeoff | DONE | Takeoff 6,400 SF / 80 LF and AI → estimate flows (browser). AI accuracy on real sheets: BLOCKED (O6) |
| L13 | Bidder submits a bid | DONE | Receipt + SHA-256 (marketplace tests; bid flows) |
| L14 | GC receives the bid and receipt | DONE | Leveling flow (browser) |
| L15 | GC compares bids and awards | DONE | Leveling + e-signed award (prequal flow; marketplace tests) |
| L16 | All activity in the project history | PARTIAL | Core links, phases, audit log. A single per-project timeline screen: OPEN |
| L17 | Super Admin sees subscriber, publisher, project, bid, revenue and usage records | PARTIAL | **Super Admin portal Phases 0–3 DONE, Phase 4 credential-free parts DONE, staff MFA DONE** (`/admin`, `docs/SUPER-ADMIN.md`): 9 platform roles / 23 permissions enforced server-side, step-up for high-risk actions, dashboard computed from records, companies (10-tab profile, verification, suspend/reactivate), users (sessions, roles), project authority review, append-only audit search. Workflows 1–10 and 15 DONE with tests (projects, duplicates/merge, corrections, bid oversight, plan-access revocation added). Revenue BLOCKED on Stripe; billing/sources/AI Phase 4; cases/health Phase 5; MFA OPEN (WS2) |

## Release 5.1 — Infrastructure and security

| Item | Status | Evidence / gap |
|---|---|---|
| Route/UI split so agents can work in parallel (R0) | OPEN | — |
| Database-backed reads for projects/permits/search/map/profile (WS1) | PARTIAL — **Stage A done:** `bi_permits` table (filter columns derived by the app's own functions, same transaction), project search in PostgreSQL behind `SQL_READS` with **identical results in 336 combinations** (`test/sql-reads.test.js`) and 3–5× faster at 50,000 permits (339 ms vs 1,035 ms). **Stage B open:** map, Command Center, profile and the other ~25 readers, then stop loading permits into memory (the remaining blocker for more than one server) | Parity tool + relational tables exist; memory measured (`docs/SCALING.md`) |
| Optimistic concurrency (versioned writes) (WS1) | DONE | Every record has a version; a stale write or delete is rejected, the database copy kept and reloaded, recorded in the audit log and the `write_conflicts` launch gate (`test/multi-instance.test.js`, proven to fail without the check) |
| Change notifications between servers (WS1) | DONE (notifications split by size — a 2,000-record save regression test guards the 8,000-byte limit) | PostgreSQL LISTEN/NOTIFY sent inside the write transaction; other servers reload exactly the changed records (create/update/delete test with two instances). Cross-server job lock also DONE |
| PostgreSQL job queue + transactional outbox (WS1) | OPEN | — |
| Company email invitations, named roles, session revocation, MFA (WS2) | PARTIAL | Permissions + seats DONE; session revocation DONE (admin); **MFA for platform staff DONE** (TOTP, RFC 6238-verified); email invitations, named company roles and customer MFA OPEN |
| R2 document storage with presigned upload/download (WS3) | BLOCKED | Needs O4; encrypted local vault + signed links DONE |
| Document-level entitlements (WS3) | PARTIAL | Rights model (GC upload / licensed) DONE; per-document grants OPEN |
| Virus scanning, PDF validation, size/page caps (WS3) | PARTIAL | PDF-only + size cap DONE; malware scan OPEN |
| Backup and restore verification | DONE | Disaster-drill test; restore gate. Off-site copy BLOCKED on O4 |

## Release 5.2 — Commercial operations

| Item | Status | Evidence / gap |
|---|---|---|
| Stripe for the new entitlement catalog (Checkout, Portal, webhook ledger, grace, cancel at period end, invoices) | BLOCKED | Needs O1 + O2; catalog + enforcement DONE |
| Postmark delivery through the outbox; digests; bounces | BLOCKED | Needs O3 + outbox (WS1) |
| Publisher onboarding in the main app shell | OPEN | Publishing Center works in the older page layout |
| Package Q&A / RFIs | OPEN | — |
| Bid revisions | OPEN | — |
| Scheduled publication | OPEN | — |
| Award and regret notifications | PARTIAL | Award + e-signature DONE; notices need Postmark |
| Revenue and subscription dashboard | OPEN | Usage per company DONE (Subscription Center) |
| Watermarked viewing | OPEN | — |

## Release 5.3 — Launch readiness

| Item | Status | Evidence / gap |
|---|---|---|
| AI accuracy on ≥100 real sheets | BLOCKED | Harness DONE; needs O6 |
| Full desktop and mobile browser QA | PARTIAL | 9 desktop flows + dead-control audit (0 dead of 3,432); mobile widths OPEN |
| Security testing (tenant/role matrix for v5, webhook replay, malicious PDF, XSS/SQLi) + external pen test | PARTIAL | Tenant, XSS, forged-link, brute-force tests DONE; pen test BLOCKED (O7) |
| Real publishers and projects; first paying subscriber; real bids | BLOCKED | Needs O9 (+ Stripe, Postmark) |
| Production backup drill, launch approval, rollback rehearsal | OPEN | — |

## Publisher experience — acceptance

| Requirement | Status |
|---|---|
| Complete project wizard ahead of quick post | DONE (Publishing Center first; quick post labeled single-package) |
| Each package opens its own plan-room manager | PARTIAL (uploads per package in "Your requests"; dedicated manager OPEN) |
| Document count, state and current revision per package; "none (intentional)" vs. "missing" never ambiguous | DONE (coverage test "states the document situation explicitly") |
| Distribution setting and bidder-list size visible | DONE |
| Publication blockers shown on each package | DONE |
| Package Q&A, addenda and deadline controls in one place | PARTIAL (addenda DONE; Q&A + deadline changes OPEN) |
| Full coverage dashboard | DONE (invited, opened plans, will bid, bids per package) |
| Same modern app shell as subscribers | OPEN |

## Subscriber onboarding — acceptance

| Requirement | Status |
|---|---|
| Sign up, confirm email, choose trades and markets | DONE (signup HTTP test; profile flow) |
| Free plan receives invitations; paid plans unlock discovery | DONE (entitlement test) |
| Trial and its expiry | DONE (entitlement test) |
| Pay and activate only after Stripe confirms | BLOCKED (O1, O2) |
| Team seats and permissions | DONE (seats/permissions tests) |
| Market status and "Can I bid?" on every project | DONE (market-status tests) |
| Invitations by email | BLOCKED (O3) |

## Owner actions (BLOCKED items wait on these)
O1 prices · O2 Stripe test account · O3 Postmark + domain DNS · O4 Cloudflare R2 · O5 PostgreSQL 1 GB · O6 AI key +
100 real sheets · O7 attorney, insurance, pen test, security contact · O8 Chicago/Dallas terms, Iowa records, licensed
data · O9 pilot publishers and first paying subscribers.

## Workstreams and agent briefs
See `docs/BUILDINTEL-production-master-spec.md` (R0, WS1–WS9). Statuses live **here**; when an item changes, update this
file in the same branch with its evidence.
