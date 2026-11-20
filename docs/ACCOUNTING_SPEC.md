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

## 2. Gaps against the audit (status after the decisions round)

Status key: BUILT = in code and tested. BUILT-OFF = in code, off until the owner sets a value. DECIDED = decision recorded here. ACCESS = needs details only the owner has. DEFERRED = not built, by design.

| # | Gap | Status | What exists now / what is left |
| --- | --- | --- | --- |
| G1 | Ledger posting | BUILT | Posts automatically every 15 minutes (`LEDGER_AUTO_SYNC_MS` to change, 0 to stop). Owner and manager can also run it now. Payments with no issued invoice are held with a reason, not posted. |
| G2 | Payroll payments | BUILT (interim) + ACCESS | Owner records net pay and payroll taxes by hand. ADP link waits for the ADP details (company code, file-number format, RUN or Workforce Now). Kept out for now, by the owner's choice. |
| G3 | Refunds, credit notes | BUILT | Refund cannot exceed payments; credit note cannot exceed what is owed; both in the tie-out. |
| G4 | AR and AP aging | BUILT | Receivables by days past due; payables by bill age, by vendor. |
| G5 | Amendments and renewals | BUILT | Signed amendments add to contract value (owner decision: not already in the original). Renewals add once signed. Superseded and archived rows do not count. |
| G6 | Task budgets and task cost | BUILT | Budgets on tasks; time and costs assigned to tasks; the parts add back to project cost. Screen on the Accounting page. |
| G7 | Overhead allocation | BUILT | Overhead at the estimate's rate on actual cost, shown beside cost (not posted). |
| G8 | Labor burden and overtime | BUILT (overtime) / BUILT-OFF (burden) | Overtime: weekly hours over 40 (setting `overtime_after_hours`) cost 1.5 times the rate, into the job the employee is working on (owner decision). Burden: rate setting `ledger_burden_pct`, zero. The owner has not given a burden rate yet. |
| G9 | Sales tax | DECIDED (amounts) / SET (Iowa rate) | Owner decision: invoice amounts are before tax; tax is added on top and posted to sales tax payable (2100). No tax is charged until an amount is set on the invoice. The Iowa state rate of 6% (Iowa Code 423.2) is suggested on the invoice; cleaning tied to new construction or remodeling, and residential cleaning paid by the occupant, are exempt and recorded with a reason. Local option taxes (city or county) are not included and need the accountant. |
| G10 | Revenue timing | DECIDED (policy) / BUILT | Policy: work done is revenue when invoiced (`arrears`, the default). Money taken ahead of work is a customer deposit (`advance`), earned into revenue as the work is done (earn entry, cannot exceed the deposit). |
| G11 | Receipts and approvals | BUILT (receipt upload; approval and receipt rules off by default) | Receipt file attached to the bill (guarded upload, owner and manager). Approval and receipt-before-payment rules are settings, off by default. |
| G12 | Vendors | BUILT | Vendors table; bills link to vendors by name. |
| G13 | Multiple accounting entities | DEFERRED | One company. Add when a second company uses the system. |
| G14 | Bank statements | BUILT | Import CSV, safe re-import, automatic and manual matching, outstanding items. Live bank feed not built. |
| G15 | Audit trail | BUILT | Append-only list of accounting actions with who, when and why. |
| G16 | Reports on the ledger | BUILT | `compare.js` shows the Reports figures beside the ledger, with the reason for each difference. The Reports P&L (all projects) now reads the ledger: revenue is invoices less credit notes, costs are 5xxx, operating expenses and net profit are shown, and the report posts anything pending first. Per-project profitability still uses the records. |
| G17 | Incremental sync | DEFERRED | The sync is safe to repeat and runs over all records. Revisit if it gets slow. |
| G18 | Database | DECIDED: stay on SQLite | See section 10. |
| G19 | Pay rate used for labor cost | BUILT | Labor cost is worked out at approval (with overtime) and stored on the entry. |
| G20 | Customer and employee portals | BUILT (customer balance) / DEFERRED (rest) | Customer portal balance includes tax, refunds, credits. Employee portal time and expense submission not built, by design. |
| G21 | Other account feeds (cards, loans, equity) | DEFERRED | Accounts exist; no feeds, by design. |

## 10. Database decision: stay on SQLite

Decision: keep SQLite for now. Move to PostgreSQL later, as a separate project, when one of the triggers below happens.

Reasons:
- The application reads and writes the database synchronously across most modules. Moving to PostgreSQL means rewriting data access across the whole application, with live customer, payroll and financial records in the middle. That is the largest risk in this work.
- Bright Clean runs as one server with a small office team. SQLite in write-ahead mode handles that load. The ledger uses integer cents and database triggers, which work the same way in SQLite.
- Backups already run daily with an off-site copy, and a restore drill is part of the owner list.

Triggers that would justify the move:
- More than one application server running at the same time (the single-file database cannot be shared across machines).
- Several staff writing heavily at the same moment, with lock waits showing in the logs.
- A need for point-in-time recovery that the daily backup cannot give.

When it is time: write the migration as a plan, run it on a copy of the live data, and check every financial report and tie-out matches before switching.

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

## 7. Decisions

| Decision | Answer | Where |
| --- | --- | --- |
| Amendments add to contract value once signed | Yes (not already inside the original) | G5, contract-value.js |
| Invoice amounts before tax; tax added on top | Yes. Rate per service still to confirm with the accountant | G9 |
| Revenue timing | Work done = revenue on issue (default); paid ahead = deposit, earned as work is done | G10 |
| Overtime goes into the job | Yes, at 1.5 times, weekly over 40 hours | G8, labor.js |
| Burden rate | Not given yet (off) | G8 |
| Ledger posts automatically | Yes. Owner and manager can adjust and reverse | G1 |
| Database | Stay on SQLite | section 10 |
| ADP details | Out for now | G2 |
| Multiple companies, incremental sync, card/loan/equity feeds, employee portal submission | Not built, by design | G13, G17, G21, G20 |

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

1. Confirm the sales-tax rate for each service with the accountant (G9).
2. Burden rate, when the owner gives one (G8).
3. ADP details, when ready (G2).
4. Switch the Reports page to the ledger (G16): done in ae0fb92.
5. Staging run of the 25 QA items with synthetic records (section 8), then the first live sync with the owner present.
