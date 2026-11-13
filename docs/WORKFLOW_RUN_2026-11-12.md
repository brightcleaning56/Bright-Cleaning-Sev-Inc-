# Module workflow run, 2026-11-12

Run on a temporary database with dummy data (no live data, no real email, no real payments). Owner-approved as "start them" on 2026-11-12.

## Results

| Module | Workflow | Where it runs | Result |
|---|---|---|---|
| Website leads and customers | Bid request creates a lead; duplicate is caught; one customer record | `tests/run-tests.js` (Workflow A) | Pass |
| General contractor bid | Request captured; due-date alerts sent once; drawings attached | Workflow B | Pass |
| Construction questionnaire | Required questions enforced; missing information listed | Workflows C/D/E | Pass |
| Complaints | Call logged; issue created without retyping; no duplicate issue; owner alerted | Workflow F | Pass |
| Invoices | Draft invoice; send by email; no payment on draft; PDF downloads | Workflow G | Pass |
| Subscriptions | Valid plan created; bad price, bad dates and too many visits refused; sales refused | `tests/workflow-modules-test.js` | Pass |
| Billing runs | One draft invoice per active subscription; repeat run skips it; sales refused; bad period refused | same | Pass |
| Crew (employees) | Employee added; duplicate email refused; bad rate refused | same | Pass |
| Visits | Visit scheduled; end before start refused | same | Pass |
| Time and labor | Entry recorded; approval prices labor ($4 h × $22 = $88); second approval refused; sales refused; over-16-hour and backwards entries refused | same | Pass |
| Lists | Subscriptions, crew, visits and time entries appear in their lists | same | Pass |

Totals: the module test is 10/10. Earlier workflow checks are part of the 224-check server suite, which passed in full today.

## What this does not show

- **Labor posting to a project.** Approved time posts to a project's costs only when the entry is linked to a project. The test used no project, so it confirmed that nothing was posted. The posting path itself is not exercised here.
- **Live records.** Nothing ran against brightclean.net.
- **Browser screens.** These are API checks. The admin screens for these modules were not clicked through.
- **Modules not run this round:** estimates and proposal approval to contract handoff (covered in the server suite, not re-run as a workflow), contracts and signatures, projects and mobilization, quality inspections in depth, reports, takeoffs from drawings, customer portal in a browser, AI features (credits blocked).

## Defects found

None in the modules tested. The one failure during this run was in the test itself (the time list needed a date range) and was fixed in the test, not in the app.
