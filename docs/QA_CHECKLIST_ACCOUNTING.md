# Accounting QA run: 25 items

Run this on a copy of the data, not on live records. Put the owner at the screen so every result is seen before it is written down.

Each item records: the action, the expected value, the actual value, the transaction or record IDs, the API result, and PASS or FAIL. Automated coverage for each item is in `docs/ACCOUNTING_SPEC.md` section 8. Items marked **manual** have no automated test and must be run by hand.

## Sample data (use these exact figures so the expected values below hold)

- Customer: **QA Customer Co**, one project: **QA Riverside Office**.
- Estimate and proposal total: **$12,345.67**.
- Contract: countersigned at **$12,345.67**.
- Tasks on the project: **Strip floors** (budget $2,000) and **Final clean** (budget $1,500).
- Employee: **QA Crew 1**, hourly rate **$20.00**.
- Time: one week of **45 hours** (Monday 30 h, Wednesday 15 h), approved.
- Invoice 1: **$5,000.00** issued, sales tax **6%** set (expected tax $300.00).
- Payment 1: **$2,000.00** against invoice 1.
- Materials: **$84.50** for stripper and glass cleaner, Vendor **Glass Supply**, allocated to **Strip floors**.
- Bill: **Glass Supply** $150.00 for mops (operating expense, not a job cost).

## Items

| # | Item | Steps | Expected | Automated |
|---|---|---|---|---|
| 1 | Estimate cost, markup, margin, tax, total | Create the estimate from the sample data | Total $12,345.67; margin and tax as shown on the estimate | Existing estimate tests |
| 2 | Proposal version preserved | Approve the proposal, then edit the estimate | The approved version is unchanged; the edit creates a new version | Existing proposal tests |
| 3 | Contract amount matches to the cent | Generate the contract | Contract value $12,345.67 | `contract-value-test.js` |
| 4 | One-cent mismatch blocked | Change the contract value to $12,345.66 and countersign | Refused: "no longer matches the proposal" | `contract-cent-test.js` |
| 5 | Change order updates contract | Add an amendment of $1,000.00 and countersign it | Contract value $13,345.67 | `contract-value-test.js` |
| 6 | Renewal, no duplicate value | Renew the contract | Contract value counted once | `contract-value-test.js` |
| 7 | Project with tasks and budgets | Add the two tasks with budgets | Budgets $2,000 and $1,500 shown on the tasks | `task-costs-test.js` |
| 8 | Employee records time | Clock QA Crew 1 for 45 h, approve | 45 h on the timesheet | Existing time tests |
| 9 | Pay-rate change keeps history | Change QA Crew 1's rate to $22.00 | Approved entries keep $20.00; new entries use $22.00 | `expenses-test.js`, `overtime-test.js` |
| 10 | Materials bought and allocated to a task | Open the project, Costs tab, record $84.50, Vendor Glass Supply, Task Strip floors | Task Strip floors shows $84.50 of cost; the project total includes it | `material-task-test.js` (**manual** on screen) |
| 11 | Expense with receipt and approval | Create bill $150, attach a PDF receipt, approve | Receipt downloads with its original name; approval recorded with who and when | `receipt-test.js`, `expenses-test.js` |
| 12 | Task cost to date | Look at task cost after items 8 and 10 | Strip floors $84.50; labor on tasks from approved time only | `task-costs-test.js` |
| 13 | Partial invoice, receivable | Issue invoice 1 for $5,000 + 6% tax | Receivable $5,300.00 (tax on top); revenue $5,000.00 | `invoice-ledger-test.js` |
| 14 | Partial payment, balance | Record payment 1 for $2,000 | Balance $3,300.00; status Partially Paid | `invoice-ledger-test.js` |
| 15 | Final payment closes invoice | Record the remaining $3,300.00 | Balance $0; status Paid | `invoice-ledger-test.js` |
| 16 | Replayed payment, no duplicate | Send payment 1 again through the webhook or sync | No second posting; balance unchanged | `invoice-ledger-test.js` |
| 17 | Refund: cash and receivable | Refund $500 on invoice 1 | Cash down $500; receivable up $500; refund in the trail | `receivables-test.js` |
| 18 | Sales tax not revenue | Read the P&L after invoice 1 | Revenue $5,000 (tax of $300 excluded) | `tax-burden-test.js` |
| 19 | Operating expenses in the P&L | Read Reports after the bill | Bill $150 under operating expenses; net profit reduced by $150 | `ledger-reports-test.js` |
| 20 | Every entry balances | Run the journal and trial balance | Debits equal credits; balance sheet check is zero | `ledger-test.js` |
| 21 | Bank reconciliation | Import a statement that includes payment 1 | Payment 1 matches; outstanding items listed | `bank-test.js`, `periods-test.js` |
| 22 | Period close restricts posting | Close the period through the last day of the month; try to post an entry dated in it | Refused; the owner can still post in an open period | `periods-test.js` |
| 23 | Unauthorized users cannot view or alter | Sign in as a staff user; call the ledger, payroll-payment and rates routes | 403 for every financial route | Suite gate test; `rates-test.js` (route rules) |
| 24 | Dashboards match | Compare Command Center collected and outstanding, Reports finance, customer profile | The same figures for the same period | `run-tests.js` consistency check; **manual** on screen |
| 25 | Audit history for each financial change | Make a rate change, a reversal, a payment removal | Each appears with who, when, what changed | `audit-test.js`, `rates-test.js` |

## Recording results

For each item, write one line in this form:

`#<n> | expected: <value> | actual: <value> | IDs: <ids> | API: <status> | PASS/FAIL`

Any FAIL stops the run for that item. Write down what happened before going on.

## After the run

- Every PASS on a copy means the first live sync can go ahead with the owner watching.
- Any FAIL becomes a fix and a re-run of that item and its neighbours.
