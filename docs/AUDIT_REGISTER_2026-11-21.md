# Audit register, 2026-11-21 (response to the end-to-end system audit of the 71d1b91 archive)

Status: **fixed** (changed and tested in this build), **partly fixed**, **open** (needs a decision or more work), **verified not a defect**.
Evidence is in the tests named. The owner and accountant decisions are listed at the end.

| ID | Finding | Status | What was done or what remains |
|---|---|---|---|
| F-01 | Job profit labelled "actual" but is contract value less cost | Partly fixed | The figures are renamed `contract_basis_*`. Invoiced and collected totals are added. Earned revenue is not calculated: it needs an approved revenue-recognition policy (owner and accountant). `tests/job-cost-test.js` |
| F-02 | Job-cost gap text was out of date | Fixed | Gap text now says overtime is included, task budgets are on the task costs report, and burden is added only when a burden rate is set. `job-cost.js` |
| F-03 | Ledger P&L note said overtime is not costed | Fixed | Note corrected. Overtime is costed at 1.5x above the weekly threshold (`labor.js`). `ledger-reports.js` |
| F-04 | Operational, task and ledger cost are separate views | Open | A reconciliation view by project and period is not built yet. |
| F-05 | Contract amendment value model not chosen | Open | Decision needed: revised full value or incremental change. Owner and accountant. |
| F-06 | No frozen signed evidence | Partly fixed | At countersignature the contract's signed content is stored as a canonical snapshot with its SHA-256 (`executed_snapshot`, `executed_hash`). Countersigning twice is refused. The PDF still renders from the live row; it should render from the snapshot next. `contracts2.js`, `tests/workflow-chain-test.js` |
| F-07 | Revenue and cash labels in every report | Open | Labels need a pass across reports. |
| F-08 | Sales tax not jurisdiction-complete | Open | Needs the accountant's tax configuration (service location, local rates, exemptions). Not a code-only fix. |
| F-09 | Payroll cash is manual; no payroll integration | Verified; accepted for now | Manual controlled posting is in place (`expenses.js`). ADP is owner-blocked. |
| F-10 | No shared metric dictionary | Open | Planned: a metric registry used by Command Center, Reports and exports. |
| F-11 | Runtime suites not run in the audit environment | Addressed for this build | Dependencies are installed here. Server suite 313/313, admin UI 94/94, workflow chain 15/15, job-cost, expense-edit, edit probe and browser edit checks pass. Staging run still to do. |
| F-12 | Finding register not reconciled | Addressed | This file. Older 2026-11-18 findings are tracked in `docs/PRODUCTION_READINESS_2026-11-21.md`. |

## Owner and accountant decisions needed
1. Revenue recognition for job profit: percent complete, milestone, or invoiced (F-01).
2. Amendment model: revised full contract value, or incremental change amount (F-05).
3. Sales tax: service-location rules, local tax, and exemption handling (F-08).
4. Payroll: stay manual until an approved provider is connected (F-09).
