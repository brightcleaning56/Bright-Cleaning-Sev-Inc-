# Bright Clean production readiness audit (first pass)

Date: 2026-11-18. Build under review: commit `7ad8069` (code identical to `ab8bf88` plus two test-only dev dependencies). Live site: brightclean.net, build `cd2a938935f4` at the time of checking, updating to the `7ad8069` build after the push.

**Production approval: NOT ESTABLISHED.** This first pass covers the critical launch blockers and the test evidence. Most of the 15 modules have not yet been exercised end to end, so they are marked "Insufficient evidence", not "working".

## Evidence collected

| Check | Result |
|---|---|
| API test suite (`tests/run-tests.js`) on a clean clone of 7ad8069 | 267/267 passed |
| UI test suite (`tests/ui-tests.js`) on the same clone | 93/93 passed, including "No JavaScript errors on any screen" |
| Live health (`/api/health`) | `ok: true`, database ok, 0 server errors in the last hour |
| Live Command Center (admin, signed in) | Loads; alert rows sum to the total (119) |
| Clean clone reproducibility | Failed before this pass: `smtp-server` and `jsdom` were used by tests but not declared. Fixed in 7ad8069. |

Tests use fake or local stand-ins. They do not prove behavior against real providers (Twilio, Postmark, Microsoft 365, payments, Backblaze).

## Classification of the historical critical items

| Item | Classification | Evidence and gap |
|---|---|---|
| Offsite backup | **Insufficient evidence. Must verify before launch.** | Code exists: `backupb2.js` (Backblaze B2 upload), `backupcrypto.js`, daily local backup in `ops.js`. `tests/b2-test.js` runs against a fake B2 only. No evidence a real backup reached B2. Owner must confirm `BACKUP_*` settings are present in Render and a file is visible in the bucket. |
| Restore verification | **Incomplete. Must fix before launch.** | `scripts/decrypt-backup.js` and archive tests exist, but no restore drill has been run against a real backup. A backup that has never been restored is not a backup. |
| Production monitoring and error alerts | **Partially verified.** | `monitoring.js` records 5xx responses and crashes, emails the owner once per problem per hour, and shows counts on `/api/health`. Health reports 0 errors in the last hour. The external uptime monitor (owner action 6) is not created yet. |
| Upload security and malware scanning | **Incomplete. Must fix before launch.** | `filecheck.js` checks that file bytes match the extension and blocks PDFs with embedded scripts. Its own header says it is **not a virus scanner**. No malware scanning is in place. Acceptable for a controlled pilot only if uploads are limited to known customers. |
| Customer portal isolation | **Partially verified.** | Test "Portal Messages: a customer sees their own emails, not other customers'" passes. Proposals, contracts, invoices and files have not been tested for cross-customer access. |
| Payment processing and accounting | **Insufficient evidence.** | Not audited in this pass. |
| Phone provider and AI receptionist | **Incomplete.** | Owner's open items: AI triage is down because the Anthropic credit balance is too low. Real phone and AI call flows have not been tested. |
| Microsoft 365 inbox | **Not connected.** | Owner's open item: app registration not done. The code refuses cleanly when the inbox is not connected (tested). |
| SMS registration and delivery | **Incomplete.** | Twilio A2P approval was pending in earlier notes. No live delivery test. |

## Module status (15 areas)

| # | Module | Status | Note |
|---|---|---|---|
| 01 | Website and customer intake | Partially verified | API intake repeat-merge tested; mobile and confirmations not tested live. |
| 02 | CRM and lead management | Partially verified | Duplicate-lead cleanup done; the GROK BOT key is still active. |
| 03 | AI and call center | Incomplete | AI triage down (credits). |
| 04 | Email center | Insufficient evidence | Send-failure and reply handling not tested live. |
| 05 | Tasks and automation | Partially verified | Work-queue tests pass (escalation, due dates). |
| 06 | Estimates and proposals | Insufficient evidence | Calculations and PDF generation not audited in this pass. |
| 07 | Contracts | Insufficient evidence | Signatures and amendments not audited. |
| 08 | Projects and scheduling | Insufficient evidence | Crew-conflict logic not audited. |
| 09 | Crew Portal | Incomplete | Phone tests (offline photos, GPS check-in, breaks) still owner-run. |
| 10 | Quality and inspections | Insufficient evidence | Not audited in this pass. |
| 11 | Invoices and payments | Insufficient evidence | Not audited; no payment processor test. |
| 12 | Expenses and profitability | Insufficient evidence | Not audited. |
| 13 | Customer portal | Partially verified | Message isolation tested; other data not tested. |
| 14 | Security and permissions | Partially verified | Route-level role policy table (`roles.js`) present; bcrypt and MFA helper in use; suites pass. No penetration test. |
| 15 | Infrastructure and recovery | Incomplete | Repo recovered and verified from origin. Backup restore unproven (see above). Deploy-on-push confirmed by build change. |

## Must fix before any real customer

1. Prove an offsite backup exists and restore it to a separate copy.
2. Decide the malware-scanning approach for customer uploads, or restrict uploads to known users until it exists.
3. Create the external uptime monitor (owner action 6).
4. Test the customer-to-payment workflow end to end on the live site with test records.
5. Test cross-customer data isolation for proposals, contracts, invoices and files.
6. Restore AI triage credits or accept that it is off.

## Not yet done (needed for a full audit)

- The full connected workflow: intake, lead assignment, estimate and proposal, signature, project scheduling, Crew Portal assignment, completion, inspection, invoice, payment, and reconciliation.
- Modules 04, 06, 07, 08, 10, 11, 12 need their own tests.
- Staging environment: none was identified in this pass. Owner decision needed on whether staging exists.
- The audit did not use the owner's Chrome admin tab, which has been unresponsive since it was opened.

## Go / No-Go

**No-Go for onboarding real customers across the platform.**

A controlled pilot should wait until items 1 to 5 above pass and the full connected workflow runs end to end. Do not start with a pilot on the basis of this report alone.
