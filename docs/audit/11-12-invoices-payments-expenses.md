# Audit 11-12: Invoices and payments, expenses and profitability, financial reports

Scope: invoice totals, line items, balances, payment recording, partial and over-payment, refunds, Stripe integration, invoice-from-proposal path, expenses and labor cost, project profitability, and the finance reports (AR aging, P&L, monthly, Reports screen, Command Center revenue).

Commit reviewed: 644b506 (branch claude/bright-cleaning-rebuild-nt1y6e).

Method: read the server routes (invoices2.js, payments.js, admin-ext.js, pm.js, sched.js, reports2.js, suite.js, command.js, ops.js, roles.js, server.js) and the admin UI (public/admin/admin.js). Ran the existing suites (tests/run-tests.js and tests/ui-tests.js) under Node 22. Ran two local probes against the real server on a temp data directory with synthetic records only, no email configured, and no calls to Stripe. Probe scripts and output are in the session scratchpad (probe.js, probe2.js), not in the repo.

Classification key: VERIFIED WORKING, INCOMPLETE OR UNRELIABLE, MUST FIX BEFORE LAUNCH, INSUFFICIENT EVIDENCE.

## Summary

| Area | Item | Classification | Evidence |
|---|---|---|---|
| 11 | Payment recording: validation, partial, full, status, ledger row | VERIFIED WORKING | probe; existing test "Partial then full payment updates balance and status" |
| 11 | Overpayment (manual) | MUST FIX BEFORE LAUNCH | MF-4 |
| 11 | Refund: reason required, capped at amount received, owner/manager only | VERIFIED WORKING | probe (staff refund 403) |
| 11 | Refund moves money at the processor | INCOMPLETE OR UNRELIABLE | IC-1 |
| 11 | Stripe webhook: signature, staleness, duplicate, over-payment hold | VERIFIED WORKING | probe with self-signed synthetic events |
| 11 | Stripe over-payment and draft-invoice holds visible to staff | MUST FIX BEFORE LAUNCH | MF-5 |
| 11 | Stripe live checkout and real webhook delivery | INSUFFICIENT EVIDENCE | IE-2 |
| 11 | Async payment methods (ACH etc.) | INSUFFICIENT EVIDENCE | IE-3 |
| 11 | Send gate: unsigned contract, due date, billing email, over-contract | VERIFIED WORKING on the send route | probe (409); existing test "Workflow G" |
| 11 | Send gate bypassed by setting status directly | MUST FIX BEFORE LAUNCH | MF-2 |
| 11 | Line items vs invoice amount | INCOMPLETE OR UNRELIABLE | IC-2 |
| 11 | Printed invoice matches server PDF | INCOMPLETE OR UNRELIABLE | IC-3 |
| 11 | Tax on invoices | INSUFFICIENT EVIDENCE | IE-1 |
| 11 | Invoice from accepted proposal | INCOMPLETE OR UNRELIABLE | IC-4 |
| 11 | Payment updates invoice balance and status | VERIFIED WORKING | probe |
| 11 | Payment updates job (project) status | INCOMPLETE OR UNRELIABLE (not linked) | IC-5 |
| 11 | Payment ledger ties to invoices (integrity check) | VERIFIED WORKING | probe: ledger 150 = invoice paid 150; integrity.js:37,41; existing test |
| 12 | Expense entry: category, amount, date | INCOMPLETE OR UNRELIABLE | IC-11, MF-3 |
| 12 | Expense correction or removal | MUST FIX BEFORE LAUNCH | MF-3 |
| 12 | Expense date validation | MUST FIX BEFORE LAUNCH (part of MF-3) | MF-3 |
| 12 | Receipts (capture, attachment) | INCOMPLETE OR UNRELIABLE (not built) | IC-11 |
| 12 | Labor cost amount (hours x hourly rate, on approval) | VERIFIED WORKING | probe: 4.00 h x $20 = $80 posted |
| 12 | Labor cost cut-off date | MUST FIX BEFORE LAUNCH | MF-6 |
| 12 | Labor counted twice (manual Labor entry + approved time) | INCOMPLETE OR UNRELIABLE | IC-6 |
| 12 | Job profitability calculation (invoiced minus costs) | VERIFIED WORKING on the arithmetic | probe |
| 12 | Job profit compared to the quote | INCOMPLETE OR UNRELIABLE | IC-9 |
| 12 | Two different "gross profit" figures | INCOMPLETE OR UNRELIABLE | IC-8 |
| Reports | AR aging buckets and total | VERIFIED WORKING | probe: total 300 = 270 current + 30 in 31-60; drafts excluded |
| Reports | Reports screen receivables, Executive figures, financial-summary | MUST FIX BEFORE LAUNCH (drafts counted) | MF-1 |
| Reports | P&L (invoiced, collected, costs, gross profit) | VERIFIED WORKING | probe: 450 / 150 / 80 / 370; drafts excluded |
| Reports | Monthly chart ties to period totals | VERIFIED WORKING | probe: 450 and 80 both match |
| Reports | Stale "not tracked yet" text on Reports | INCOMPLETE OR UNRELIABLE | IC-10 |
| Reports | "Collected" means two different things | INCOMPLETE OR UNRELIABLE | IC-12 |
| Command Center | Revenue (collected) comes from the payments ledger | VERIFIED WORKING | existing tests PASS; tile numbers not probed directly (IE-4) |

Counts (34 rows in the table): VERIFIED WORKING 12, INCOMPLETE OR UNRELIABLE 12, MUST FIX BEFORE LAUNCH 7 (MF-3 accounts for two rows), INSUFFICIENT EVIDENCE 3. The findings below are numbered MF-1 to MF-6, IC-1 to IC-12 and IE-1 to IE-4; IE-4 (Command Center tile values) is a VERIFIED WORKING row whose values were not probed directly.

## Findings

### MUST FIX BEFORE LAUNCH

**MF-1. Draft invoices are counted as receivables and billings on the Reports screen and in the Executive figures.**
- suite.js:263-264: the `recv` query uses `status<>'Void'`, so Draft invoices count in Reports outstanding, overdue and billed. The Reports screen displays these at admin.js:4455 and 4460.
- suite.js:293: Executive "invoiced" counts drafts (`status<>'Void' AND created_at>=?`). suite.js:301: Executive "outstanding" counts drafts.
- suite.js:244 (billed by month) and suite.js:259 ("Invoices issued") also include drafts. suite.js:239 (top customers) has no status filter at all, so it includes drafts and voids.
- server.js:146: `/api/admin/financial-summary` uses `status<>'Void'`, so drafts count as billed and outstanding. The UI does not call this route, but its API is wrong and the route is open to owners and managers.
- Probe: with a 380.00 draft and 450.00 open invoices, Reports receivables outstanding was 830.00 (expected 450.00). Executive invoiced was 830.00. financial-summary outstanding was 830.00.
- Contrast: the dashboard (admin-ext.js:18), the P&L (reports2.js:28) and aging (reports2.js:60) all exclude drafts correctly. So the same owner sees different receivables on different screens.
- Fix: change suite.js:239, 244, 259, 263-264, 293, 301 and server.js:146 to `status NOT IN ('Draft','Void')`, and add a probe-style test to the suite.

**MF-2. The send gate can be skipped by setting the invoice status directly.**
- invoices2.js:55-70 holds the real gates for sending: not void, not already paid, amount above zero, due date set, contract signed (line 61), billing email (line 63), over-contract reason (lines 64-70), then email, then the status change to Sent.
- server.js:143 (POST) and server.js:144 (PATCH) for the invoices register only block Paid and Partially Paid. Any other status, including Sent, is accepted. The register form exposes Status as a select (admin.js:2187).
- Probe: an invoice linked to an unsigned contract was refused by the send route (409 "not signed"), then accepted by `PATCH {status:"Sent"}` (200). It became Sent with no sent_at and no email. Creating an invoice directly with status Sent is also accepted.
- Probe2: an office staff account could do the same PATCH (200).
- Probe2: a Sent invoice with no payments could be moved back to Draft (200), and then it dropped out of the aging report.
- Consequences: a customer can be billed for work under an unsigned contract with no email, no send record and no audit of the send. Invoices in Sent status with a billing email become open items for the automatic reminder job (ops.js:301-318, opt-in via `auto_invoice_reminders`, default '0' at ops.js:11), so a customer could get "past due" emails for an invoice they never received. Moving an invoice back to Draft hides an amount the customer still owes from aging.
- Fix: make Draft-to-Sent, Sent-to-Draft and any change to Sent a server-side transition that only the send route can perform, and refuse those statuses from the register routes.

**MF-3. Expenses cannot be corrected or removed, and the cost date is not validated.**
- pm.js:266-273 is the only costs route (POST). There is no PATCH or DELETE for `project_costs`. Probe: `DELETE` and `PATCH` on a cost row both return 404.
- Negative amounts are refused (pm.js:268-270), so there is no reversal entry either. A mistaken or duplicated cost stays in project actual cost, job profit and the P&L permanently.
- pm.js:271 stores `clean(b.cost_date, 10)` with no date check. Probe: a cost stored with cost_date "not-a-date" was accepted.
- reports2.js:30 and 95 filter costs by `cost_date BETWEEN`, so a bad date drops that cost from every period P&L and monthly chart, but reports2.js:41 still counts it in the project's total cost. The period report and the project report then disagree.
- Fix: add an owner/manager correction (void with a reason, or an offsetting entry) and validate cost_date as YYYY-MM-DD.

**MF-4. A customer overpayment cannot be recorded, and the error message points to a feature that does not exist.**
- admin-ext.js:150 refuses any payment above the balance and tells the user to "record the extra as a separate credit". No credit feature exists (grep for credit across the code finds only the message and a complaint note).
- A sent invoice's amount cannot be changed (server.js:144). An invoice with payments cannot be voided (server.js:144). So the only way to record the extra money is to refuse it.
- Probe: a 500.00 payment on a 150.00 balance was refused with 400. Confirmed.
- Fix: either build the credit (a negative balance or a customer credit record that applies to the next invoice) or change the message and the workflow, and decide how a customer overpayment is recorded.

**MF-5. Online payments that need a refund are not visible on any money screen.**
- payments.js:87-92 routes a Stripe payment that exceeds the balance, or that targets a Void or Draft invoice, to `online_payments.status='Needs refund'`. The money is received and not applied, and the owner has to refund it in Stripe.
- The only trace is an audit_log row ("online payment needs refund"). Probe: two audit rows were written. There is no list, badge or table in the admin UI that shows `online_payments` (grep for `online_payments` and "Needs refund" in public/ finds nothing).
- Result: a customer can pay more than they owe, or pay a Draft, and the business keeps the money with nothing prompting a refund.
- Fix: show Needs-refund items on the invoices and Reports screens, with a count on the Command Center.

**MF-6. Labor cost is posted on the UTC date, so evening shifts near month-end fall into the next month.**
- sched.js:319 sets the project cost date to `t.clock_in.slice(0,10)`, which is the UTC calendar day. Every other report uses the business day (bizdate.js:14 and 16).
- Probe: a shift from 01:30 UTC to 05:30 UTC on 2026-11-30 (7:30 p.m. to 11:30 p.m. Central on 11-29) was posted with cost_date 2026-11-30. Its cost lands in the December monthly P&L.
- Fix: use `bizdate.today(new Date(t.clock_in))` for cost_date.

### INCOMPLETE OR UNRELIABLE

**IC-1. A refund is a ledger entry only.** admin-ext.js:168-188 records a negative payment and lowers paid_amount. It does not call Stripe. For a card payment the owner has to refund in Stripe separately, and nothing links the two. The Stripe refund path is not built. Fix: either call the refund API for online payments, or make the route say "ledger only, refund at Stripe" and record the Stripe refund id.

**IC-2. Service lines are not reconciled to the invoice amount on the API.** invoices2.js:25 and 34 show the lines on the PDF. invoices2.js:35 and the balance use `amount`. server.js:144 checks lines only when the invoice was sent, and does not check that the lines add up to amount. The admin UI sets amount from the lines on save (admin.js:2560), so UI saves are consistent. Direct API saves are not.

**IC-3. The printed invoice differs from the emailed PDF.** admin.js:2628-2650 prints `notes` as the single description line, with no service lines, no contract and no payments row. invoices2.js:26-38 (the PDF used for email and download) prints the service lines, the contract, and a "Payments received" row. The customer can receive two different documents.

**IC-4. Invoice from an accepted proposal is a multi-step path, not a single action.**
- Customer approval creates a draft contract with signature_status "Not sent" and a planning project, only if `auto_handoff` is on (server.js:138; ops.js:12 default '1').
- The invoice send gate needs a signed contract (invoices2.js:61). An online approval does not sign the contract, so a signed copy must be recorded first.
- Billing then comes from the project: the billing handoff makes one draft for the unbilled contract value (pm.js:312-335), or milestone billing makes a draft per milestone (pm.js:337-365, 362-375).
- No direct "invoice this proposal" action exists. The handoff and milestone paths were exercised by the existing end-to-end tests, which passed.

**IC-5. Payment does not change job (project) status.** Grep finds no code path where a payment writes to projects. Project status is driven only by the work and tasks (pm.js syncStatus, pm.js:91-103). If the owner expects a job to show "paid" or close on payment, this is missing.

**IC-6. Labor can be counted twice.** pm.js:18 includes 'Labor' in COST_CATS, so a manual Labor cost can be entered (pm.js:266-273). Approving time also posts a Labor cost (sched.js:318-319). Nothing prevents both for the same hours.

**IC-7. Labor cost uses the current hourly rate for unposted time.** reports2.js:34, 73 and 96 price unposted approved time with `employees.hourly_rate` as it is today. A rate change restates past periods. Posted time (sched.js:319) is frozen at approval, so the two behave differently.

**IC-8. Two different "gross profit" figures.** pm.js:132-133 (contract value minus actual cost, signed contracts only). reports2.js:54 (invoiced minus recorded costs, by period). admin.js:4664 labels the first "Gross profit". The P&L screen (admin.js:3551) labels the second "Gross profit". They can differ by a lot.

**IC-9. Job profit is not compared to the quote.** Project budget is typed in by hand (pm.js:158). The estimate's cost (estimates.total_cost) is not copied to the project. Estimate margin exists only at company level (suite.js:304) and in the proposal view (admin.js:1739). There is no project-level "quoted cost vs actual cost" line.

**IC-10. Reports text is out of date.** suite.js:305 (`actual_gross_profit.note`) says "No job costs are recorded yet", and suite.js:322 says supplies and expenses are "not tracked yet". Both are wrong now that project costs exist. suite.js:322 is shown to the owner on the Reports screen (admin.js:4450). admin.js:3553 ("operating expenses are not recorded") is accurate and should stay.

**IC-11. No receipts, and no approval for expenses.** Cost entries are category, description, amount and date only (pm.js:266-273). There is no receipt upload, vendor or reference. Any role that is not supervisor or sales can enter costs (roles.js:25-26 and 31 deny only those two roles), and entries go straight into profit with no approval. Probe2 did not run the staff cost post (its project lookup ran against an empty database), so this rests on the role rules alone.

**IC-12. "Collected" has two meanings.** Command Center collected is cash by payment date (command.js:30-33). Finance "collected" is the paid amount on invoices issued in the period (reports2.js:29). The P&L basis text states its rule, but the same word means different things across screens.

### VERIFIED WORKING

**VW-1. Payment recording.** Probe: zero, negative and over-balance payments refused (400); Draft and Paid invoices refused (409); 50.00 gave Partially Paid; a further 100.00 gave Paid; a payment on a Paid invoice refused (409). The existing test "Partial then full payment updates balance and status" passed.

**VW-2. Refunds.** Probe: refund needs a reason (400); refund capped at amount received (409); staff refused (403); owner refund recorded as a negative ledger row and paid_amount reduced (120 of 150).

**VW-3. Guards on balance fields.** Probe: PATCH paid_amount refused (409); PATCH to Void on an invoice with payments refused (409); both as intended (server.js:144). The `roleOf` used in the refund route is defined in the same function scope (admin-ext.js:349), so the refund route is not broken.

**VW-4. Stripe webhook.** Probe, with a webhook secret generated for this probe only and self-signed synthetic events: a bad signature returned 400; a stale timestamp returned 400; a 30.00 payment was applied (paid 30, Partially Paid, ledger row added); a duplicate delivery returned "duplicate" and did not apply twice; a 400.00 payment against a 270.00 balance was held as "needs-refund" and the balance did not change; a payment to a Draft invoice was held as "needs-refund". Code: payments.js:70-78, 82-101. The unsigned-config path returns 503 (payments.js:43 and the existing payments test).

**VW-5. Send route gates.** Probe: an unsigned contract returned 409 on `/send`. The existing "Workflow G" test covers the emailed PDF, the recorded send, the resend block and the reminders.

**VW-6. AR aging.** Probe: aging total 300.00 = 270.00 current + 30.00 in the 31-60 bucket. Drafts and paid invoices excluded. reports2.js:60-65.

**VW-7. P&L arithmetic and tie-out.** Probe, Sept-Dec window: invoiced 450.00 (excludes the 380.00 draft); collected 150.00, which equals the payments ledger (+50, +100, -30 refund, +30 webhook) and the sum of paid amounts on those invoices; costs 80.00 (labor); gross profit 370.00. Monthly chart totals 450.00 revenue and 80.00 costs, matching the period. reports2.js:25-56, 88-99.

**VW-8. Labor amount.** Probe: a 4.00-hour approved entry at $20/hour was posted as a Labor cost of $80.00 with the project and a link to the time entry (sched.js:318-320).

**VW-9. Reconciliation check.** integrity.js:37 counts invoices where paid_amount differs from the ledger, and integrity.js:41 counts overpaid invoices. The existing "Data integrity report" test passed.

**VW-10. Roles on money routes.** Probe2: an office staff account got 403 on recording a payment and 403 on a refund (only owners and managers may do these). Staff are not refused on invoice PATCH (see MF-2).

**VW-11. Existing suites.** tests/run-tests.js: 267 of 267 PASS, 0 FAIL (output saved in the scratchpad as run-tests.log). Money-related PASS lines include the invoice payment, reminder, refund, partial-payment, report, executive-figure and "one payment updates every view" checks. The suite does not test Draft invoices in reports, the status bypass, or the UTC cost date (see MF-1, MF-2, MF-6).

### INSUFFICIENT EVIDENCE

**IE-1. Tax on invoices.** Invoices have no tax field. Proposal totals include tax (estimating.js:86; bids.js:166 "tax included"). Contract value and the invoice are taken from the proposal total (server.js:138), so tax is in the billed amount but not shown on the invoice PDF (invoices2.js:26-38). Whether sales tax applies to these services, and whether it must be shown separately, depends on the owner's state rules and needs an accountant's confirmation.

**IE-2. Live Stripe.** No Stripe keys were available, and calls to Stripe are not allowed for this audit. Checkout creation, the live webhook, and the refund path were not exercised. The webhook logic was exercised with synthetic signed events only.

**IE-3. Delayed payment methods.** payments.js:76-78 applies only `checkout.session.completed` with `payment_status:'paid'`. If the Stripe account offers delayed methods (bank debit), the `checkout.session.async_payment_succeeded` event is not handled and the payment would never be recorded. Whether this applies depends on the Stripe dashboard configuration, which was not visible.

**IE-4. Command Center tile numbers.** The Command Center "collected" tile was covered by existing tests that passed (payment dates, back-dated payments, one payment updating every view). The tile values were not probed directly.

## Not tested, and why

- Live Stripe checkout and webhook delivery: no keys, and no calls to Stripe are permitted in this audit. See IE-2.
- Real email delivery of the invoice PDF: no SMTP was configured in the probes, so no email was sent. The existing Workflow G test covers the local SMTP path.
- Tax treatment: needs the owner or an accountant. See IE-1.
- Stripe refund path: not built, so nothing to test. See IC-1.
- Staff posting a project cost: not run (probe2 posted against an empty project list). Rests on the role rules, see IC-11.
- Browser UI for the Needs-refund state and the printed invoice: not run. Code reading only (MF-5, IC-3).
- tests/ui-tests.js did not finish. It exited with an uncaught TypeError at public/admin/admin.js:1208 (`$('#lhSave').onclick` on a null element in the lead-history view), after the "Quote form UI" section. That is outside this audit's areas, and it stopped the remaining UI tests from running. The "Invoices UI", "Admin UI" section-render and "Reports" section-render checks had run and passed before the crash.
- Concurrency under load: payment and webhook handlers are synchronous in Node (no awaits between the balance check and the write), so they cannot interleave inside one process. Multi-process deployment was not tested.

## Repository state

- No tracked file was changed. The only new file is this report.
- tests/run-tests.js and tests/ui-tests.js overwrite untracked result files (tests/results.json, tests/ui-results.json, docs/ACTION_MAP.md, tests/action-map.json). These were restored from copies taken before the run.
- Other audit files are being written into docs/audit/ by other agents in this clone. They were not touched.
