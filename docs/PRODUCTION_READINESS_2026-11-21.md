# Bright Clean production readiness, 2026-11-21

Build reviewed: commit `1f29ce4` (code identical to `f0c76f3`; the last commit touched docs only). Live site `brightclean.net`, build `b0cbce1d05f9`, which matches this code.
This follows the first pass in `PRODUCTION_READINESS_AUDIT_2026-11-18.md`. That pass listed 42 must-fix findings. This pass checks which are closed.

## Verdict

**NOT READY for real customers.** The system works in testing and on the live site, but these blockers remain: the restore drill, texting approval, malware scanning for uploads, the external uptime monitor, and two money/labor defects. Launch gates 1 to 6 below must pass before the first paying customer.

## Evidence in this pass

| Check | Result |
|---|---|
| Server suite `tests/run-tests.js` (on `f0c76f3`, same code) | 313/313 |
| Admin UI suite `tests/ui-tests.js` | 94/94 |
| Live `/api/health` | ok, database ok, 0 errors in the last hour, backup 12.1 hours old |
| Live build matches code | yes (`b0cbce1d05f9`) |
| Admin API without sign-in (invoices, customers, employees, rates, backups) | 401 on all five |
| Security headers | HSTS, Content-Security-Policy (enforced), nosniff, frame policy, no-referrer |
| Dependency scan (`npm audit --omit=dev`) | 0 vulnerabilities |
| Staff-account probe (local scratch server; see below) | 6 of 7 checks behave correctly; 1 open defect |

## Must-fix items from 2026-11-18: status

**Closed and checked this pass (probe on a staff account, local server):**
- Staff changing a crew pay rate: refused, 403 (was open).
- Staff recording a customer sign-off: refused, 403 (was open).
- Setting a draft invoice to Paid without a payment: refused, 409 (was open).
- Recording a payment larger than the balance: refused, 400 (was open).
- Draft invoices counted as receivables: not in the A/R aging (was open).
- Staff reading labor and tax rates: refused, 403.
- Overtime across total man-hours: now counted per person (`estimating.js`, `overtimeManHours`).

**Still open, confirmed this pass:**
- **Expenses cannot be corrected or deleted.** PATCH, PUT and DELETE on `/api/admin/expenses/:id` all return 404. Bills must be reversed by a new entry or left as they are. Must fix.
- **Labor posted on the UTC date.** Time entries are dated from the stored UTC timestamp (`labor.js:38`, `expenses.js:125` and `:164`). A shift worked after 6 p.m. Central lands on the next day, which can move cost into the next month. Must fix: use the business date, as payments already do (`bizdate.js`).

**Not re-verified this pass** (the test suite has related checks, but I did not probe them against a live-style case): contract revival by countersigning an older contract; crew PIN lockout; offline check-ins stamped at sync time instead of when they happened; automatic text follow-ups and opt-out; cross-customer isolation for proposals, contracts, invoices and files (the portal refuses sign-in when an email matches more than one customer, which closes the shared-email case as of 2026-11-19).

## Owner-blocked items (from the owner list, status as last recorded)

| Item | Status | What is needed |
|---|---|---|
| Restore drill (backup into a separate instance) | Not done. Newest backup `brightclean-20261121-055610.db.enc` is downloaded and not yet decrypted. | The `BACKUP_KEY` from the password manager, entered on the owner's machine |
| Texting (Twilio A2P 10DLC) | In review, registered as Marketing; it should be Customer Care. Ticket #30436964 open. | Twilio approval after the use case changes |
| Malware scanning for uploads | Not set up. Public and portal uploads are closed by default. | A real scanner (ClamAV) or keep uploads closed |
| Microsoft 365 inbox | Not connected | App registration on the owner's Microsoft account |
| External uptime monitor | Not created | Owner account (for example UptimeRobot) pointed at `/api/health`, alerting on `backup_age_h` over 26 and any non-200 |
| AI triage | Off (provider credit balance) | Add credits in Anthropic billing, or accept that it stays off |
| Price book | Conflicting records: the 2026-11-21 owner note says prices are set; the 2026-11-19 release note says 38 of 86 scopes are unpriced | Owner to confirm the live Cleaning scopes page |
| Render deploy-failure behaviour | Dashboard checked; Auto-Deploy On Commit; health path `/api/health`; no failed deploy seen in the events log. Failure behaviour itself is from Render's documentation. | None |
| Labor and margin starting values | Not confirmed on the live Labor assumptions page | Owner saves the page |
| Counsel review of terms | Not done (`docs/TERMS_DRAFT_FOR_COUNSEL.md`) | Attorney |
| Insurance quotes | Not obtained; budget uses placeholders | Broker quotes |
| Crew phone test | Not done (`docs/CREW_PHONE_TEST.md`) | One real phone with a crew member |

## Launch gates

1. Restore a current backup into a separate instance and record the result in `docs/RESTORE_RUNBOOK.md`.
2. Fix expense correction and deletion (reversal or edit with an audit trail).
3. Fix labor posting to use the business date.
4. Malware scanning in place, or public uploads kept closed.
5. External uptime monitor created and tested.
6. Run the connected workflow end to end on test records: intake, estimate, proposal, signature, project, crew, completion, invoice, payment, reconciliation.
7. Owner-blocked items above that affect the pilot: texting approval (if texts are part of the pilot), counsel review, and the crew phone test.

## Method and limits

- Tests and live checks are on code `1f29ce4`. The staff-account probe ran on the local scratch server (`scratchpad/probe.js`, `probe2.js`), not on production.
- The probe covers 7 of the 42 Nov 18 findings. The rest were not re-tested here. Test-file coverage is not treated as proof of a fix.
- Tests use fake or local stand-ins for Twilio, Postmark, Microsoft 365 and Backblaze. Real-provider behaviour is not proven.
- The Nov 18 module reports (`docs/audit/`) list further findings, including the Nov 18 must-fix list, that were not re-audited here.

## Fixed after this report (same day)

- **Expenses cannot be corrected or deleted (launch gate 2): fixed.** Open bills can be edited (`PATCH /api/admin/expenses/:id`); the old ledger entry is reversed and the new one posted. Bills are voided, not deleted (`POST /api/admin/expenses/:id/void`, reason required); voiding a paid bill also reverses its payment. Both are in the accounting audit trail. Tested in `tests/expense-edit-test.js`.
- **Labor posted on the UTC date (launch gate 3): fixed.** Time entries, burden, overtime weeks and reversals now use the business date (`bizdate.js`). Entries posted before this fix keep their old dates; review them before the first close.
- **Screens without actions:** the Activity log had no buttons. It now has Refresh and Export CSV. A walk of every admin view (`tests/walk-screens.js`) lists the buttons on each view and in each record panel with seeded records.
- Server suite 313/313, admin UI suite 94/94.
- Still open: restore drill (needs the owner's key), malware scanning decision, uptime monitor, end-to-end workflow test, owner-blocked items.
