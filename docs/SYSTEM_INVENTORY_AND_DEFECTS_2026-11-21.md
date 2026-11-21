# System inventory and defect register (step 1 and 2), 2026-11-21

Baseline: current `prod-security-merge` (pushed to `claude/bright-cleaning-rebuild-nt1y6e`). The live site was verified to match this build's fingerprint before deployment.

## Step 1: inventory
- Admin screens: 25 views (`public/admin/index.html`, `id="v-*"`).
- API routes: 472 route registrations across 85 server modules.
- Automated test files: 67 in `tests/` (plus the three suites: server 313/313, admin UI 94/94, money chain 27/27).

### The nine existing findings from the supplied audit

| # | Finding | Status | Evidence |
|---|---|---|---|
| 1 | Draft invoices counted in some reports | Fixed | `reports2.js`, `command.js`, `ledger-reports.js` exclude Draft and Void consistently; money-chain test |
| 2 | Invoice status bypass (direct status changes) | Guard present in source; live probe pending | `server.js` generic PATCH refuses `status: 'Sent'` unless the invoice is already Sent; a probe against a running server is still to run |
| 3 | Expense correction and removal incomplete | Fixed | Bill edit, void with reason, audit trail; `tests/expense-edit-test.js` |
| 4 | Labor cutoff and duplication | Fixed | Business-date posting; each approved time entry posts once (`postedEntry`); `tests/expense-edit-test.js`, `tests/expenses-test.js` |
| 5 | Profitability calculations differ | Partly fixed | Job cost reports contract basis separately, with invoiced and collected; one authoritative calculation and a reconciliation view still open (`AUDIT_REGISTER_2026-11-21.md`) |
| 6 | Shared-mailbox identity exposure | Closed on 2026-11-19; isolation test pending | Portal refuses sign-in when an email matches more than one customer; no duplicate emails in the live data |
| 7 | Admin token and script security | Partly fixed | Session is an HttpOnly cookie; the page removes any old token from `localStorage`; script CSP still report-only |
| 8 | Backup restore not proven | Open | Needs the owner's BACKUP_KEY; restore drill paused |
| 9 | External uptime monitoring | Open | Owner account needed |

## Step 2: task lifecycle against the spec

The spec asks for one work engine. The code has separate queues instead:
- **Email work queue** (`workqueue.js`, `inbox_state`): states open, waiting, completed. "Handle" completes an item with no note or evidence required. There is no cancel action. Reopen takes no reason. Reassign updates only `assigned_to`.
- **Calls** (`calls/:id/work`), **leads** (follow-up dates), **project tasks** (`tasks/:id/work`), **issues** and **QC corrective work** each have their own states and rules.

Checks against the spec's rules:

| Rule | Status |
|---|---|
| Opening a task does not complete it | Holds for email (no state change on open) |
| Starting work sets In Progress | Not present in the email queue; project tasks have their own statuses |
| Completing needs the required notes or evidence for the task type | Not enforced (email "handle" has no requirement) |
| Completed tasks leave the active queue | Holds for email (completed is excluded from the open view) |
| Reopen returns to the queue with a recorded reason | Reason not required |
| Waiting keeps its dependency and next follow-up date | Waiting exists; no dependency or follow-up date required |
| Overdue stays visible until resolved | Not verified in this pass |
| Cancel needs a reason and stays in history | No cancel action in the email queue |
| Reassign updates both employees' queues | Not verified in this pass |
| Every important action records who and when | Email state records `updated_by` and `updated_at`; not verified for the other queues |

## Decision needed before step 3
A single work engine (one task table with the states above, used by every queue) touches email, calls, leads, project tasks, issues and QC. It is a multi-module change, so it needs your approval before I start. The smallest first repair inside the current code would be to require a reason on reopen and add a cancel action with a reason to the email queue. That needs a button on the screen as well.

## Step 3 (in progress): unified work engine

Built: `work-engine.js`. One lifecycle and one history for every kind of work (email, call, lead, project task, issue, inspection, estimate, invoice, maintenance, other).
- Start, wait (with what it waits on and a follow-up date), complete (note required), cancel (reason required), reopen (reason required), reassign (both queues updated), edit (saved and recorded).
- One active item per record: creating it again returns the same item.
- Completed and cancelled items leave the queue and stay in history with who and when.
- Overdue is flagged until the item is resolved.
- API: `GET/POST /api/admin/work-items`, `GET /api/admin/work-items/:id`, `POST /api/admin/work-items/:id/:action`.
- Tests: `tests/work-engine-test.js` (10 groups), `tests/work-api-test.js` (10 checks on a live server). Server suite 313/313, admin UI 94/94.

Not yet done:
- The existing queues (email, calls, leads, project tasks, issues, QC) still use their own states. Each must be moved onto the engine, one module at a time, with existing data carried over.
- No screen buttons yet for the new actions. The Today's Work screen must show the engine's queue and the actions.
- Other kinds of work (estimate approvals, invoice follow-up, maintenance requests) have no creators yet.
