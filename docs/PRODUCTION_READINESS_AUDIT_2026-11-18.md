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
| Offsite backup | **Partially verified (correction: the baseline records a live B2 upload).** `docs/AUDIT_BASELINE.md:79` says "Live and verified (upload)". I have not re-checked that live, and the Render `BACKUP_*` variables are not in `render.yaml`. | Code exists: `backupb2.js` (Backblaze B2 upload), `backupcrypto.js`, daily local backup in `ops.js`. `tests/b2-test.js` runs against a fake B2 only. No evidence a real backup reached B2. Owner must confirm `BACKUP_*` settings are present in Render and a file is visible in the bucket. |
| Restore verification | **Partially verified (correction).** `docs/AUDIT_BASELINE.md:27` records a drill on 2026-11-12 that decrypted an encrypted backup on the Render server with the production key, and the integrity check passed. A full restore into a separate instance is still not documented. | `scripts/decrypt-backup.js` and archive tests exist, but no restore drill has been run against a real backup. A backup that has never been restored is not a backup. |
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
| 15 | Infrastructure and recovery | Incomplete | Repo recovered and verified from origin. Backup restore unproven (see above). Deploy-on-push confirmed by build change. During the 7ad8069 deploy, the live site returned intermittent 502 errors for several minutes (about 2 of 3 samples) before settling on build 61fde0e508f6. Zero-downtime deploys are not verified. |

## Must fix before any real customer

1. Restore a current backup from B2 into a separate instance, and document it. The 2026-11-12 drill decrypted a file on the server only.
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

## Module audit results (six parallel audits, 2026-11-18)

Each module report is in `docs/audit/`. Counts are per each auditor's own checklist, so they are not directly additive. The must-fix total is 42 findings.

| Report | Verified working | Incomplete | Must fix | Insufficient evidence |
|---|---|---|---|---|
| `01-intake-crm-tasks.md` | 11 | 13 | 5 | 1 |
| `03-calls-email-sms.md` | 13 | 22 | 5 | 8 |
| `06-07-estimates-contracts.md` | 8 | 7 | 12 | 2 |
| `08-10-projects-crew-quality.md` | 12 | 13 | 9 | 6 |
| `11-12-invoices-payments-expenses.md` | 12 | 12 | 6 | 4 |
| `13-15-portal-security-infra.md` | 21 | 8 | 5 | 5 |

### Highest-impact must-fix items

- **Customer data:** the customer portal matches customers by email, so two customers who share an address see each other's records (portal, verified by reading the SQL). Repeat-bid decisions drop intake data (service and project type are lost).
- **Money:** draft invoices are counted as receivables in reports (a probe showed 830 reported against 450 actually open). The send gate can be bypassed by setting an invoice's status directly. Expenses cannot be corrected or deleted. A manual overpayment cannot be recorded. Labor cost is posted on the UTC date, so evening shifts land in the next month. Overtime is calculated on total man-hours, so a 3-person crew is overstated (3,200 instead of 2,400). Contracts: a superseded contract can be revived by countersigning the original.
- **Crew and staff:** staff can change crew pay rates (no role check; reproduced). Staff can record a customer sign-off with a typed name, which unlocks completion and billing. Crew PIN lockout is bypassed by changing the phone format. Offline check-ins are stamped at sync time, not when they happened.
- **Customer messages:** automatic SMS follow-ups go out with no opt-out handling. Automatic callbacks have no end point. The AI sends an information-request email to leads by default, which contradicts the rule in `ai.js:2`. Postmark sends no attachments, so invoice PDFs don't reach customers through Postmark.
- **Security:** the script Content Security Policy is report-only in production. The admin keeps its bearer token in `localStorage`. Sales and supervisor roles can edit invoice notes and issue dates.

### Corrections to the earlier sections of this report

- Offsite backup: `docs/AUDIT_BASELINE.md:79` records a live B2 upload as verified. I have not re-checked it.
- Restore: `docs/AUDIT_BASELINE.md:27` records a drill on 2026-11-12 that decrypted a backup on the server with the production key, and the integrity check passed. A full restore into a separate instance is not documented.

### Open test issues

- `tests/ui-tests.js` crashes at `public/admin/admin.js:1208` (`$('#lhSave').onclick`) when the lead-history panel's element is null. Four of the six audits hit this. It may be a harness problem or a real bug in the lead-history panel. Either way, the UI suite does not finish, so the admin screens are not fully covered.
- The `tests/*.json` results and workflow files are untracked output from test runs. They are not part of the change.

## Verdict

**No-Go.** Production approval is not established. The 42 must-fix findings must be cleared before real customers use the affected modules. A controlled pilot should wait until at least the customer-data, money, crew-security and messaging items are fixed and the end-to-end workflow test passes.

## End-to-end workflow test (local, synthetic data)

Full report: `docs/audit/workflow-end-to-end.md`. Result: 8 of 12 steps passed, 0 failed, 4 blocked. No email or SMS was sent, and brightclean.net was not used.

- **Passed:** intake, lead assignment and notes, estimate with approval hold, project and dispatch, Crew Portal check-in and photo, closeout.
- **Blocked:** proposal send returns 503 with no email provider, so the estimate stays Draft and the customer cannot approve it through the normal route. The invoice send also returns 503, so the invoice stays Draft and a payment is refused (409). The money path could not be completed.
- **Money defect:** the estimate was entered at $3,200.00. The proposal and invoice used $751.38, calculated from labor and cost inputs. A typed price cannot override the calculated one, and the customer would be billed the calculated figure.
- **Sign-off before work:** a customer sign-off on a project still "Ready to mobilize" returned 200. Acceptance should require completed work.
- **Inconsistent send behavior:** contract send returns the signing link when email is missing, but proposal send returns 503.
