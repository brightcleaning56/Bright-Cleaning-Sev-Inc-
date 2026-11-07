# Super Admin portal — status against the implementation specification

Baseline: built on the **latest verified source** (source hash in `docs/RELEASE-VERIFICATION.md`), not the
`buildintel.zip` bundled in the implementation package — that copy predates versioned writes, change notifications,
database-backed search and the notification-size fix. Delivered: **Phases 0–3, and Phase 4 except the parts that need owner credentials** (Stripe, AI provider). **MFA for platform staff** is in.

Portal: `/admin` (own files `public/admin.html`, `public/admin.js`; API `/api/admin/*`; service `src/admin/`).
Every route checks an explicit permission on the server; the page holds no data.

## Phase 0 — inventory of existing administrative capability (reused, not duplicated)
31 platform-owner routes existed, all gated by one "platform owner" check. They keep working unchanged:
publisher review/decide (`publishing.js` — the admin portal calls the same `decideVerification`), project-core stats,
review, merge, split, parity and backfill (`core.js`), sources, probe, import, resync (`sources/`), readiness, release,
backup, cycle, jobs, audit, privacy requests, org creation/verification, credentials verification, directory import,
test email. The portal links to the ones not yet re-hosted (Coverage, Data sources, Launch gates) via `/#open:<screen>`.

## Roles and permissions (`src/admin/rbac.js`)
9 platform roles × 23 permission keys, exactly as specified; deny by default; platform roles are separate from company
roles (a company owner never passes an admin check). Platform roles live on the user record (`platformRoles`); the
original owner account (`role: platform_owner`) keeps full authority. Denied attempts are audited (`admin.denied`).

| Role | Permissions |
|---|---|
| platform_owner | all 23 |
| platform_admin | all except roles.manage, security.manage |
| verification_reviewer | dashboard, company read/verify, publisher review, user read, audit read |
| marketplace_ops | dashboard, company read, project.*, bid.*, document access revoke, user read |
| billing_admin | dashboard, company read, billing.* |
| data_ops | dashboard, project.*, source manage, AI manage |
| support_agent | dashboard, company read, user read, support manage |
| security_auditor | dashboard, audit read, company read, user read (read-only) |
| read_only_analyst | dashboard, company read, project read, bid read, billing read |

**Step-up:** high-risk actions require re-confirmation valid 10 minutes, bound to the session (HTTP 428 until confirmed).
**MFA (staff): DONE.** Authenticator-app codes (TOTP, verified against the RFC 6238 test vectors), secrets stored
encrypted, each code usable once. Once enrolled, sign-in and step-up require the code; security admins can reset a lost
authenticator (step-up, reason, signs the user out). Launch gate `staff_mfa` lists staff without MFA. MFA for customer
accounts remains OPEN (WS2).

## Acceptance workflows (specification §9)

| # | Workflow | Status | Evidence |
|---|---|---|---|
| 1 | Owner grants reviewer; non-owner cannot grant owner | DONE | `admin.test.js` workflow 1; browser grant/revoke |
| 2 | Request more information → approve; history persists | DONE | workflow 2 test |
| 3 | Suspend (sessions revoked, members blocked) → reactivate with history | DONE | workflows 3+5 test; browser step 4 |
| 4 | Cross-company user search; company admins cannot see other companies | DONE | permission matrix (company users denied on every admin route); existing tenant tests |
| 5 | Revoked session can no longer call protected routes | DONE | workflows 3+5 test; browser step 5 |
| 6 | Project authority approved separately from company verification | DONE | workflow 6 test (CM blocked until authority approved) |
| 7 | Duplicate projects: preview, merge, integrity | DONE | likely-duplicate detection + ambiguity queue; merge preview (what moves); merge/split need step-up and reuse `core.js`; package and bid records unchanged, old ID resolves (`admin-phase3.test.js` workflow 7) |
| 8 | Correct a project field with provenance | DONE | typed corrections (name, type) with original value kept; source permits never edited; stale/invalid with reason (workflow 8 test; browser step 1) |
| 9 | Inspect bid/document activity without altering originals | DONE | package oversight shows bids as submitted (amount, time, late, receipt, fingerprint); no edit route exists (workflow 9 test) |
| 10 | Revoke a document grant; old link denied | DONE | revoke/restore a company's plan access per package; quarantine/release a file; checked again when any link opens — a link issued before revocation is refused (workflow 10 test; browser step 2). R2 storage itself remains BLOCKED on the owner |
| 11 | Subscription view; no payment state without Stripe | DONE | Subscriptions screen; manual adjustments (comp plan, trial extension) grant access but payment state stays "none — manual"; revenue unavailable; step-up + audit (`admin-phase4.test.js` workflow 11; browser step 1). Invoices/refunds/reconciliation BLOCKED on Stripe |
| 12 | Retry failed webhook/import/job idempotently | PARTIAL | Import retry per source (cross-server lock; second retry inserts nothing — test), pause/resume using the collector's own compliance rule, resync, import history. Webhooks BLOCKED (Stripe); general job queue OPEN (WS1) |
| 13 | AI cost/accuracy review and limits | PARTIAL | Usage per company, per-company limits that can only lower the plan allowance (enforced by the analyzer — test); estimator confirmation still required. Cost and accuracy BLOCKED (AI key + labeled sheets) |
| 14 | Support case with internal vs customer notes | PARTIAL | internal notes on companies; case system Phase 5 |
| 15 | Auditor searches but cannot modify the audit log | DONE | workflow 15 test (PATCH/DELETE/PUT → 404); PostgreSQL audit search test |
| 16 | Denied access events and incidents | PARTIAL | denials audited and searchable (`outcome=denied`); incidents Phase 5 |
| 17 | Health distinguishes unconfigured from healthy | PARTIAL | dashboard marks email "dry-run (setting, not a measurement)", Stripe "not connected"; health center Phase 5 |
| 18 | Scoped, audited, expiring exports | OPEN | Phase 4 |
| 19 | Verified privacy request processing | PARTIAL | existing privacy routes; portal screen Phase 5 |
| 20 | Mobile completes high-priority workflows | PARTIAL | collapsible menu (workspace first), 390 px checks for companies and projects; full mobile E2E Phase 6 |

## Engineering rules applied
Server-side permission on every route; identity from the session and stored user only; no client-supplied role/org;
tenant boundaries unchanged; every mutation audited with actor, action, target, time, request ID, outcome, reason and a
redacted before/after (secret-looking fields are redacted — test: the password never appears in the audit log);
paginated lists with a 100-row cap and allow-listed sorts (prototype keys rejected); state transitions validated; no-op
changes refused rather than audited as changes; no fabricated metrics (unavailable values state why); audit log is
append-only (no edit or delete route). Organization/user lists are paged on the server from the record store; the audit
search runs as a SQL query in PostgreSQL. Moving organization/user lists to SQL queries follows WS1 stage B.

## Phase 3 (this release)
Projects directory and profile, duplicate review (likely duplicates + ambiguity queue, merge preview, merge/split),
typed corrections with history, stale/invalid status, bid and award oversight (read-only), plan-room document
administration (revoke/restore access, quarantine/release), trades and markets. Mobile: collapsible navigation.

## Phase 4 (this release, credential-free parts)
Subscriptions (plans, entitlements, usage, manual adjustments — never a payment), data sources (compliance using the
collector's own rule, freshness, records, import history, pause/resume, probe, retry, resync — the same code as the owner
routes), AI usage and per-company limits. Mobile: tables become labeled cards; filters collapse.

## Next phases
 Phase 4 (billing — Stripe BLOCKED; sources; AI — key BLOCKED) · Phase 5 (cases,
health, jobs, backups, privacy, incidents) · Phase 6 (full mobile E2E, security review, pen test — owner).
