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

## 2. Gaps against the audit

Priority: P0 blocks a production financial sign-off. P1 needed before reports are relied on. P2 later.

| # | Gap | Priority | Why it matters |
| --- | --- | --- | --- |
| G1 | The ledger is not posted to automatically. The owner runs the sync. | P1 | Books are empty until the owner runs it. Decide when posting happens. |
| G2 | Payroll cash payments are not recorded (no ADP or payroll-run link). | P0 | Wages accrue to accrued payroll and are never paid out. Payroll payable stays wrong. |
| G3 | No refunds, credit notes or payment-to-invoice allocation records. Payments post to cash and receivable as one line. | P0 | Audit rule: refunds and credits must reach cash and receivables. |
| G4 | No accounts payable aging; no receivables aging on the ledger (the existing A/R aging report is not on the ledger). | P1 | Accountants expect both. |
| G5 | Amendments and renewals: contract value follows the reports rule (signed originals plus signed renewals). Amendments are listed, not added. | P0 | Owner must confirm the rule. Change order history and approved-amendment lineage are not modelled as a ledger event. |
| G6 | Task-level costing: tasks have no budget fields, so task cost and task variance are not reported. | P1 | Audit requires task budgets and task actual cost. |
| G7 | Overhead allocation is not built. | P1 | Audit requires allocated overhead in estimates and job cost. |
| G8 | Labor burden and overtime: burden is an optional rate; overtime is not in cost. | P0 | Job costs can be understated while burden is off. Owner must set the rate. |
| G9 | Sales tax: optional per invoice. Invoices without tax set post the full amount as revenue. | P0 | Audit rule 1. Owner must decide the default and check invoices. |
| G10 | Revenue recognition policy is not chosen. Revenue posts when an invoice is issued. | P0 | Audit requires a written policy (completed milestones or another measure). |
| G11 | Expense receipts and approvals: bills have no receipt upload or approval step. | P1 | Audit requires receipt, approval and supporting document for each expense. |
| G12 | Vendors are not a table; bills carry a vendor name only. | P2 | Needed for AP aging. |
| G13 | Single company only. No accounting entities table. | P2 | Needed only if Bright Clean adds companies on the same system. |
| G14 | Bank statement import. Reconciliation is manual (enter the statement balance). | P1 | Audit requires matching statement lines. |
| G15 | Audit events: financial changes are logged to the existing activity log, not a separate accounting audit table. | P2 | Audit requires who, when and why on each change; partly met. |
| G16 | Reports on the existing Reports page (P&L by job, A/R aging) still read operational figures, not the ledger. | P1 | Two sets of numbers until they are switched. |
| G17 | The ledger sync is a full run over all records each time. It is safe to repeat, but not incremental. | P2 | Fine at current volume; revisit if the sync gets slow. |
| G18 | Database: the app runs on SQLite (one file). The ledger uses the same database. | P0 decision | Audit asks whether to keep SQLite or move to PostgreSQL. Not decided. Do not assume. |
| G19 | Payroll cost on reports2 and time sheets still reads the current employee rate for display and unposted labor. | P1 | Rule 6. Ledger and job cost use the snapshot; the two display paths do not yet. |
| G20 | Customer portal and employee portal do not show ledger balances or time/expense submissions through the ledger. | P2 | Audit integration table. |
| G21 | No bank reconciliation for credit cards, loans or equity accounts. | P2 | Chart includes accounts that have no feed. |

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
| 7 project with tasks and budgets | Not built (G6) |
| 8 employees record time | Existing time tests |
| 9 pay rate change keeps history | `expenses-test.js` (pay-rate snapshot) |
| 10 material purchases to tasks | Not built (G6) |
| 11 expense with receipt and approval | Not built (G11) |
| 12 task cost to date | Not built (G6) |
| 13 partial invoice, receivable | `invoice-ledger-test.js` |
| 14 partial payment, balance | `invoice-ledger-test.js` |
| 15 final payment closes invoice | `invoice-ledger-test.js` (invoice status is not set by the ledger) |
| 16 replayed payment, no duplicate | `invoice-ledger-test.js` (source key) |
| 17 refund, cash and receivable | Not built (G3) |
| 18 sales tax not revenue | `tax-burden-test.js` (when tax is set) |
| 19 operating expenses in P&L | `ledger-reports-test.js` (with bills) |
| 20 every entry balances | `ledger-test.js`, every test that posts |
| 21 bank reconciliation | `periods-test.js` (recorded, manual) |
| 22 period close restricts posting | `periods-test.js` |
| 23 unauthorised users refused | Suite gate test |
| 24 dashboards match | Not automated |
| 25 audit history | Activity log (G15) |

## 9. Recommended order from here

1. Owner decides section 7 items 1 to 4 (amendments, tax, burden, revenue recognition).
2. Build G3 (refunds and credit notes) and G14 (bank statement import), because the audit's P0 list depends on them.
3. Build G6 and G7 (task budgets, overhead allocation).
4. Switch the Reports page to the ledger (G16).
5. Staging run of the 25 QA items with synthetic records, then the first live sync with the owner present.
