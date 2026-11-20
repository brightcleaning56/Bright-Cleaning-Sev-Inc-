# Bright Clean Accounting: Integration Technical Specification

Status: working spec, written from the code as it stands on the branch `claude/bright-cleaning-rebuild-nt1y6e`.
Owner decisions still open are listed in section 7. This spec does not approve the accounting system for production use. Acceptance is in section 8.

## 1. What is built

Bright Clean keeps its own double-entry ledger. The operations modules stay the source of their own records; the ledger reads from them and posts once per source record.

| Area | Module | Status |
| --- | --- | --- |
| Chart of accounts (starter, cleaning-business codes) | `ledger.js` | Built. 1000 Cash through 6100 Payroll not assigned to a job |
| Balanced journal entries, integer cents, one side per line | `ledger.js` `postEntry` | Built |
| Reversing entries (once per entry, never of a reversal) | `ledger.js` `reverseEntry` | Built |
| Posted entries and lines cannot be edited or deleted | database triggers in `ledger.js` | Built |
| Accounting periods (closed books refuse posting) | `ledger.js`, `periods.js` | Built |
| Trial balance (as of a date) | `ledger.js` `trialBalance` | Built |
| Contract value with amendments and renewals counted once | `contract-value.js` | Built. Amendment rule is an assumption (see 7) |
| Job costing: projected vs actual, cost by ledger account | `job-cost.js` | Built |
| Invoices post receivable and revenue; voids reverse; payments post cash | `invoice-ledger.js` | Built |
| Sales tax per invoice (tax payable, revenue excludes tax) | `invoice-ledger.js` | Built, optional, zero by default |
| Receivables tie-out (invoices owed vs ledger receivable) | `invoice-ledger.js` `tieOut` | Built |
| Vendor bills, payment of bills | `expenses.js` | Built |
| Recorded project costs post to expense accounts (labor to accrued payroll) | `expenses.js` `syncRecorded` | Built |
| Approved time not on a job posts to payroll | `expenses.js` | Built |
| Labor burden (optional rate, zero by default) | `expenses.js` `syncBurden` | Built, off |
| Pay rate in force at approval kept on each time entry | `sched.js` (approve), `expenses.js`, `job-cost.js` | Built |
| Drift check: a recorded cost changed or deleted after posting | `expenses.js` `costDrift` | Built, flags only |
| Profit and loss, balance sheet, cash movements | `ledger-reports.js` | Built |
| Bank reconciliation (statement vs ledger cash, recorded) | `periods.js` | Built. No bank statement import |
| Journal, trial balance, sales tax CSV exports | `exports.js` | Built |
| Document trace from estimate to subscription | `trace.js` | Built, read only |
| Owner/manager gate on every financial route | `server.js` ROLE_RULES | Built. Sync and close are owner only |
| Accounting page in admin | `public/admin/admin.js` | Built |

Tests: `tests/ledger-test.js`, `invoice-ledger-test.js`, `expenses-test.js`, `ledger-reports-test.js`, `periods-test.js`, `exports-test.js`, `tax-burden-test.js`, `job-cost-test.js`, `contract-value-test.js`, `trace-test.js`, `spam-screen-test.js`, and the HTTP checks in `tests/run-tests.js`.

## 2. Gaps against the audit (status after the step-by-step pass)

Status key: BUILT = in code and tested. BUILT-OFF = in code, switched off until the owner decides. DECISION = needs the owner. DEFERRED = not built now, with the reason. ACCESS = needs a connection or details only the owner has.

| # | Gap | Status | What exists now / what is left |
| --- | --- | --- | --- |
| G1 | Ledger posting is run by the owner, not automatic | DECISION | `POST /ledger/sync` (owner). Choose automatic or owner-run. |
| G2 | Payroll payments | BUILT (interim) + ACCESS | Owner records net pay and payroll taxes (`POST /ledger/payroll-payment`). ADP link needs company code, file-number format, RUN or Workforce Now. |
| G3 | Refunds, credit notes, payment allocation | BUILT | `receivables.js`: refund (cannot exceed paid), credit note (cannot exceed owed), tie-out includes both. Payments stay one per invoice (allocation is the invoice id). |
| G4 | AR and AP aging on the ledger | BUILT | `aging.js`: receivables by days past due; payables by bill age, by vendor. |
| G5 | Amendments and renewals; change orders | DECISION | Contract value follows the reports rule. Amendment value is listed, not added. Owner to confirm the rule. Change-order approval flow not built. |
| G6 | Task budgets and task-level cost | BUILT | `task-costs.js`: budgets on tasks, time and costs assigned to tasks, report that adds back to project cost. Budget entry is by API; a screen is not built yet. |
| G7 | Overhead allocation | BUILT | Job cost allocates overhead at the estimate's rate on actual cost, shown beside cost (not posted). |
| G8 | Labor burden and overtime | BUILT-OFF (burden) / DECISION (overtime) | Burden rate setting `ledger_burden_pct` (zero). Overtime not in cost. Owner to set the rate and decide overtime. |
| G9 | Sales tax on invoices | BUILT-OFF (default) / DECISION | Tax per invoice posts to tax payable; zero by default. Owner to decide default and whether invoice amounts include tax. |
| G10 | Revenue recognition policy | DECISION | Revenue posts on invoice issue. Milestone or other policy not chosen. |
| G11 | Expense receipts and approvals | BUILT-OFF | Receipt reference and approval on bills; settings `bill_receipt_required` and `bill_approval_required` (both off). Receipt file upload not built. |
| G12 | Vendors | BUILT | Vendors table; bills link to vendors by name (found or created). |
| G13 | Multiple accounting entities | DEFERRED | Bright Clean is one company. Add when a second company uses the system. |
| G14 | Bank statement import and matching | BUILT | `bank.js`: import CSV, safe re-import, automatic and manual matching, outstanding items. Bank feed (live) not built. |
| G15 | Accounting audit trail | BUILT | `audit.js`: sync, reversals, closes, reconciliations, tax changes, bill approvals, task budgets and assignments, statement imports. Postings carry who and when. |
| G16 | Reports on the ledger | BUILT (comparison) / DECISION (switch) | `compare.js` shows each Reports figure beside the ledger with the reason for any difference. Switching the Reports page is the owner's choice of basis. |
| G17 | Incremental sync | DEFERRED | The sync is safe to repeat and runs over all records. Revisit if slow. |
| G18 | Database (SQLite or PostgreSQL) | DECISION | Stays on SQLite. Not changed. |
| G19 | Pay rate used for labor cost | BUILT | Rate in force at approval is kept on each time entry; ledger, job cost, timesheet and reports use it. Entries approved before this change use the current rate. |
| G20 | Customer and employee portals | BUILT (balance) / DEFERRED (rest) | Customer portal balance includes tax, refunds and credits. Employee portal time and expense submission through the ledger not built. |
| G21 | Other account reconciliations (cards, loans, equity) | DEFERRED | Accounts exist in the chart; no feeds. |

Open decisions, in order of impact: G5 (amendments), G9 (sales tax default), G10 (revenue timing), G8 (burden rate and overtime), G1 (sync timing), G18 (database). Access needed: G2 (ADP details).

## 3. Posting rules (as built)

| Event | Entry | Source key |
| --- | --- | --- |
| Invoice issued (not draft, amount > 0) | Dr 1100 receivable (amount + tax) / Cr 4000 revenue (amount) / Cr 2100 sales tax payable (tax, if set) | `invoice:<id>` |
| Invoice voided after posting | Reversing entry of the invoice entry | reversal of the entry |
| Payment received | Dr 1000 cash / Cr 1100 receivable | `payment:<id>` |
| Vendor bill entered | Dr expense account (from category) / Cr 2000 accounts payable | `bill:<id>` |
| Bill paid | Dr 2000 / Cr 1000 | `bill-payment:<id>` |
| Project cost recorded, labor | Dr 5000 job labor / Cr 2300 accrued payroll | `project-cost:<id>` |
| Project cost recorded, other | Dr expense (from category) / Cr 2000 | `project-cost:<id>` |
| Approved time not on a job | Dr 6100 / Cr 2300, at the rate in force at approval | `payroll:time:<id>` |
| Labor burden (only when the rate is set) | Dr 5000 or 6100 / Cr 2300, rate x base | `burden:project-cost:<id>` or `burden:time:<id>` |

Rules that hold in code: each source posts once (the source key is checked before posting); a closed period refuses postings dated on or before its close; an entry must balance; amounts are integer cents.

## 4. API (all under `/api/admin`, all require sign-in)

| Method and path | Who | What |
| --- | --- | --- |
| GET `/ledger/accounts` | owner, manager | Chart of accounts |
| GET `/ledger/trial-balance?as_of=` | owner, manager | Trial balance |
| GET `/ledger/entries` | owner, manager | Latest 200 entries with lines |
| GET `/ledger/pnl?from=&to=` | owner, manager | Profit and loss |
| GET `/ledger/balance-sheet?as_of=` | owner, manager | Balance sheet and balance check |
| GET `/ledger/cash?from=&to=` | owner, manager | Cash movements by source |
| GET `/ledger/cost-drift` | owner, manager | Costs changed after posting |
| GET `/ledger/periods`, POST `/ledger/periods/close` | read: owner, manager; close: owner | Periods |
| GET `/ledger/reconciliations`, POST `/ledger/reconciliations` | owner, manager | Bank reconciliation |
| GET `/ledger/export/journal.csv`, `/ledger/export/trial-balance.csv`, `/ledger/sales-tax` | owner, manager | Exports |
| POST `/ledger/sync` | owner | Post invoices, payments, bills, job costs, payroll, burden |
| GET `/receivables/tie-out` | owner, manager | Tie-out and unposted invoices |
| POST `/invoices/:id/tax` | owner, manager | Set sales tax before posting |
| GET/POST `/expenses`, POST `/expenses/:id/pay` | owner, manager | Bills |
| GET `/contract-value` | owner, manager | Contract value parts |
| GET `/projects/:id/job-cost` | owner, manager | Job cost |
| GET `/accounting/trace?kind=&id=` | owner, manager | Document trace |
| GET `/blocked-intake` | owner, manager | Intake messages blocked by the spam screen |

Staff, supervisors, sales and inspectors get a refusal on these routes. The Accounting link is hidden for roles other than owner and manager.

## 5. Permissions

Central gate: `ROLE_RULES` in `server.js`. A route not listed there is open to any signed-in admin role that has the page, so every new financial route must be added to that list. The test `Accounting, job-cost and intake-screen records refuse a signed-in non-owner (staff) token` covers the current list (it uses an unknown user, so it proves refusal, not each role).

## 6. Migration

- No migration is needed for the current data: the ledger tables are created on start, the chart is seeded, and nothing is posted until the owner runs the sync.
- Adds columns on existing tables when first used: `invoices.tax_amount` (default 0), `time_entries.labor_rate` (set at approval; older entries fall back to the employee's current rate).
- Rollback: the ledger tables can be dropped without touching operations data. Nothing in the operations modules reads them.
- Before the first live sync: check the 2 payments on the ledger tie-out that have no invoice on the live system (see G1).

## 7. Decisions the owner must make

1. Amendments: is an amendment's value already inside the contract it changes (current assumption), or is it new work?
2. Sales tax: default for invoices (zero, or a tax rate applied to taxable services), and whether invoice amounts include tax.
3. Labor burden rate and whether overtime is added to job cost.
4. Revenue recognition: revenue on invoice (current), or on completed milestones, or another measure.
5. Database: keep SQLite, or move to PostgreSQL as a separate project.
6. When the ledger is posted: owner-run (current) or automatic.
7. Payroll: the ADP details (company code, file-number format, RUN or Workforce Now) to record payroll payments.

## 8. Acceptance

Automated tests cover items 1, 3 through 8, 11 through 14, 16, 18 and 20 of the QA list in the audit (partly; see the table below). The rest need a staging run with synthetic records and the owner present.

| Audit QA item | Covered by |
| --- | --- |
| 1 estimate cost, margin, tax, total | Existing estimate tests (not the ledger) |
| 2 proposal version preserved | Existing proposal tests |
| 3 contract amount to the cent | `contract-value-test.js`, existing contract tests |
| 4 one-cent mismatch blocked | Not automated |
| 5 change order updates contract | Not built (G5) |
| 6 renewal no duplicate value | `contract-value-test.js` |
| 7 project with tasks and budgets | `task-costs-test.js` |
| 8 employees record time | Existing time tests |
| 9 pay rate change keeps history | `expenses-test.js` (pay-rate snapshot) |
| 10 material purchases to tasks | `task-costs-test.js` (costs assigned to tasks; purchasing screen not built) |
| 11 expense with receipt and approval | `expenses-test.js` (receipt reference and approval rules; upload not built) |
| 12 task cost to date | `task-costs-test.js` |
| 13 partial invoice, receivable | `invoice-ledger-test.js` |
| 14 partial payment, balance | `invoice-ledger-test.js` |
| 15 final payment closes invoice | `invoice-ledger-test.js` (invoice status is not set by the ledger) |
| 16 replayed payment, no duplicate | `invoice-ledger-test.js` (source key) |
| 17 refund, cash and receivable | `receivables-test.js` |
| 18 sales tax not revenue | `tax-burden-test.js` (when tax is set) |
| 19 operating expenses in P&L | `ledger-reports-test.js` (with bills) |
| 20 every entry balances | `ledger-test.js`, every test that posts |
| 21 bank reconciliation | `periods-test.js` (recorded, manual) |
| 22 period close restricts posting | `periods-test.js` |
| 23 unauthorised users refused | Suite gate test |
| 24 dashboards match | Not automated |
| 25 audit history | Activity log (G15) |

## 9. Remaining work

1. Owner decisions in section 2: amendments (G5), sales tax default (G9), revenue timing (G10), burden and overtime (G8), sync timing (G1), database (G18).
2. ADP details for payroll (G2).
3. Screens not yet built: task budget entry, purchasing and receipt upload, bank statement upload (the API exists; the Accounting page has no upload yet).
4. Deferred by design: multiple entities (G13), incremental sync (G17), other account feeds (G21), employee portal time and expense submission (G20).
5. Staging run of the 25 QA items with synthetic records (section 8), then the first live sync with the owner present.
