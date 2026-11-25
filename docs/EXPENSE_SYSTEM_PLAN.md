# Company Expense & Cost Management: plan

Status: planning. Nothing in this document is built yet except the items marked **exists**.
Source: the owner's direction for a central expense system (crew receipts, company bills, payroll expenses,
reimbursements, job expenses, overhead), with AI preparing the bookkeeping and people approving before anything posts.

## 1. What already exists

| Area | Where | State |
|---|---|---|
| Vendor bills (Open, Approved, Paid, Void) | `expenses.js`, table `expense_bills` | **exists**: create, edit, approve, pay, void with a reason |
| Receipt file on a bill | `expenses.js` (`/api/admin/expenses/:id/receipt`) | **exists**: upload and download |
| Approval and receipt rules before payment | `expenses.js` `billRule` | **exists**, off until the owner turns them on |
| Labor cost per approved time entry, with overtime | `labor.js` | **exists**: cost fixed at approval |
| Labor burden (employer taxes, benefits) | `expenses.js` | **exists but off**: needs an owner-set rate |
| Posting bills, project costs and labor to the ledger | `expenses.js`, `ledger.js` | **exists**: each source posts once; a drift check reports gaps |
| Payroll totals for the payroll provider | `payrollsummary.js` | **exists**: gross pay only; ADP file not connected |
| Crew receipt upload from the crew phone | — | **missing** |
| AI reading of receipts and invoices | — | **missing** (no OCR or model call in the expense code) |
| Splitting one document across several jobs and categories | — | **missing**: a bill has one category and one project |
| Duplicate receipt and invoice detection | — | **missing** |
| Employee reimbursements | — | **missing** |
| Weekly company-wide close with one approval batch | — | **bills done (Expenses tab, Weekly close); crew labor not in the close yet** |
| Separate pending and posted views on every report | partial | Bills show status; project cost pending vs posted is not split everywhere |

## 2. Accounting rules to hold to (from the owner's direction)

1. A job expense raises the job's cost and lowers its margin. It never lowers the customer's contract or invoice.
2. Company overhead (rent, insurance, software, utilities) does not reduce any single job's profit. It is shown at company level.
3. A split allocation must total the original document amount to the cent.
4. Every posted journal entry must balance. Corrections keep the original record and add a reversal; nothing is edited in place.
5. Payroll cost is counted once. Gross wages, employer taxes and benefits are separate lines. Employee withholdings are payroll liabilities, not company expense.
6. Pending amounts (uploaded, not approved) never change the official Profit & Loss or Balance Sheet.
7. The weekly approval shows exactly what will be posted, and posts only what was approved.
8. Urgent payroll and due bills follow their own approval path; the weekly close reconciles them, it does not hold them.

## 3. Phased build

**Phase 1: no AI, uses what exists (first)**
- Split a bill or expense across jobs and categories; the splits must total the bill amount.
- Show pending (not approved) and posted amounts separately on job cost, project and Profit & Loss views.
- Duplicate check on save: same vendor, amount and date, or same receipt reference, warns before saving.
- Weekly close screen: lists the week's unposted bills, costs and labor, with a single approve-and-post step. Posts only the approved items.
- Corrections use reversal entries; the audit trail keeps who changed what.

**Phase 2: crew receipts**
- Upload from the crew phone while on a job. The job is pre-filled when the crew member has one active job; a supervisor picks the job when there are several.
- Each upload becomes a pending expense with its photo, employee and job.

**Phase 3: AI reading (needs decision A below)**
- Extract vendor, date, total, tax and line items from a photo or PDF.
- Suggest a category and job for each line. A person confirms every suggestion; nothing posts from the AI alone.
- Flag: duplicates, unusual amounts, missing receipts, purchases over job budget, recurring vendors and price changes.

**Phase 4: payroll into expenses (needs decisions C and D)**
- A finalized pay period produces a payroll cost allocation by job, with gross wages, employer taxes and benefits as separate lines.
- It enters the ledger once. The payroll module stays the source of hours and pay.

**Phase 5: reimbursements and recurring bills**
- Employee out-of-pocket purchases, repayment tracking, and recurring vendor bills with due dates.

## 4. Decisions needed from the owner or accountant

- **A. Receipt reading service.** Sending receipt photos to an AI service (Anthropic's Claude) means employee and vendor documents leave the system. Approve this, or choose a local reader only. Cost depends on volume (a rough estimate comes once the weekly receipt count is known).
- **B. Approvers.** Who approves crew receipts (supervisor?), who approves the weekly batch (owner only, or owner and manager)? Defaults proposed: supervisor for crew receipts, owner or manager for the weekly close.
- **C. Employer tax and benefit rates.** Burden is off until a rate is set. The accountant should confirm the rates and which benefits are company-paid.
- **D. Payroll source.** The ADP payroll file is not connected. Until it is, payroll cost comes from approved time entries only.
- **E. Overhead policy.** Confirm that overhead is shown at company level and never charged to a job. The current code charges burden to the job labor line when set; this needs a decision.
- **F. Reimbursements.** Confirm how the accountant classifies out-of-pocket purchases (expense, or a payable to the employee).

## 5. What "done" means for each phase

- Every receipt traces to its employee, job and source file.
- Every bill has a vendor, due date, category and approval status.
- Payroll cost reconciles to finalized pay with no double count.
- Project costs reconcile to the allocation records.
- Split totals equal the document; every posted entry balances.
- The weekly approval screen matches exactly what posts.
- All reports read from the same ledger.

## 6. Phase 1 progress and blockers (added after the first build)

**Done**
- Duplicate warning when a bill is entered: same vendor, amount and date, or the same receipt reference. Confirming saves it.

**Blocked: needs a decision first**
- **Bills post to the ledger when entered.** The weekly close in the plan needs bills to wait for approval before they post. Today a bill posts on entry, and the bill form says so. Choose: (a) keep posting on entry, and the weekly close becomes a review and sign-off; or (b) bills stay pending until the weekly approval, which moves when expenses reach Profit & Loss.
- **Job cost does not read bills.** A bill with a job attached posts to a general job-expense account, but the per-job cost view only reads recorded project costs. A bill split across jobs would therefore not change any job's cost. The fix is to record each bill split as a project cost (one source of truth), which needs the owner's sign-off because it changes job cost figures.
