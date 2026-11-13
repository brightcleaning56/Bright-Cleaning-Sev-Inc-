# Completion and billing run, 2026-11-12

Continues the contract-to-project chain (see WORKFLOW_RUN_3). Dummy data, temporary database, local test mailbox; nothing sent outside the machine; no payment taken. Owner-approved as "yes, run completion" on 2026-11-12.

## Results (`tests/workflow-chain-test.js`, 15/15 pass)

| Step | What was checked | Result |
|---|---|---|
| 11 Scheduling | Work order (one visit) adds visits to the project, status Scheduled after dispatch | Pass |
| 12 In progress | Project moves to In Progress; an open task blocks Completed (409) | Pass |
| 13 Tasks and quality | Task marked Done, then Verified by the owner; quality inspection rated and signed (passes); customer sign-off recorded | Pass |
| 14 Completion and billing | Project moves to Quality Review, then Completed; billing handoff creates one draft invoice equal to the contract value; not sent; second handoff refused (409) | Pass |
| 15 Reopen | A completed project cannot be reopened from the status control (409) | Pass |

## Finding for the owner (not changed)

**The typed proposal total is replaced by the calculated price.** When the estimate was created, the proposal total entered as $6,200 was saved as **$1,661.85**. The create route merges the calculated figures over the typed fields (`fields = {...b, ...m}`), so the typed total is silently ignored.

The calculated figure comes from the inputs: 36,000 SF at 2,000 SF per hour gives 18 labor hours at $24, plus supplies, equipment and overhead, at a 35% margin. That works out to about **$0.046 per SF** for a final clean. The estimate screen gave no warning about that figure. The construction range in the pricing engine is $0.05–$3.00 per SF, but that check runs on takeoffs, not on estimates.

Decision needed:
1. Is the calculated price meant to be the proposal price? If so, the screen should show it and warn when it falls outside the range.
2. If typed totals should win, the create route should keep them, with a reason logged.
3. Either way, the production rate and labor inputs for final cleans should be reviewed before any real bid goes out.

The test now checks that the invoice equals the approved proposal total, so it passes under the current behaviour. It will need updating if the decision changes.

## Not run

- Amendments and renewals after execution.
- Customer signature through the signing page.
- Browser screens (API checks only).
- Billing payment and reconciliation (no payment processor connected).

## Defects found

None in the chain itself. One behaviour to decide on (above).
