# Contract-to-project chain, 2026-11-12

Run on a temporary database with dummy data. Mail went to a local test mailbox that keeps messages in memory; nothing left the machine. No payment was taken. Owner-approved as "yes, run the chain" on 2026-11-12.

## Results (`tests/workflow-chain-test.js`, 10/10 pass)

| Step | What was checked | Result |
|---|---|---|
| 1 Proposal | Priced proposal created ($6,200, with cost inputs) | Pass |
| 2 Send | Proposal emailed to the customer; status becomes Sent | Pass |
| 3 Approval checks | Approval refused without signer name or agreement (400) | Pass |
| 4 Approval | Proposal approved online; draft contract and planning project created | Pass |
| 5 Double approval | Second approval refused (409); still one contract | Pass |
| 6 Contract send | Refused without start date (400); sent once dates are added | Pass |
| 7 Countersign | Sales refused (403); owner countersigns; contract Active; project Contracted | Pass |
| 8 Dispatch early | Refused (409) until all six readiness items are confirmed | Pass |
| 9 Dispatch | Six readiness items confirmed; dispatch approved | Pass |
| 10 Billing and roles | Sales refused dispatch (403); billing handoff refused (409) until the project is completed | Pass |

## Behaviour observed (working as designed)

- **Margin gate.** A first attempt with no cost inputs showed a 0.0% margin, and the send was held for owner approval. The gate worked, and the test now supplies costs.
- **Email gate.** Sending is refused (503) when no mail server is configured. The test supplies a local one.

## Not run

- **Completion and billing.** The billing handoff creates a draft invoice only after the project is completed, which needs work orders, the quality review and customer sign-off. Those were not exercised here.
- **Amendments and renewals** on the executed contract.
- **Customer signature** through the signing page (the test used the approved-proposal path, which the system treats as signed for the original contract).
- **Browser screens.** API checks only.

## Defects found

None in this chain.
