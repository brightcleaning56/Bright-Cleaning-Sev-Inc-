# Internal security review and number walkthrough, 2026-11-13

## 1. Internal security review (not a penetration test)

What was checked, on the code at commit 48198ee:

| Check | Result |
|---|---|
| Every `/api/admin/*` route names an auth middleware, except the login routes (rate-limited) and the live event stream (one-time ticket, expires) | Pass |
| Secrets scan of tracked files for API keys, private keys and tokens | No matches |
| `npm audit --omit=dev` (high and above) | 0 vulnerabilities |
| Role gating (owner, manager, staff) on sensitive reads, for example financial summary | Covered by the test suite (224/224) |
| Outbound email gate (suppressed addresses, job inboxes) | Covered by suppression tests (14/14) |

What this does **not** cover:
- An external penetration test: active attacks against the live site, authentication bypass attempts, injection and file upload testing. This needs an outside firm with written authorization.
- Legal review: privacy policy, terms of the proposal and e-signature, consent for texts and automated calls, CAN-SPAM for email, and data retention. This needs a lawyer.

Suggested scope for the outside firm: admin login with two-step codes; portal links and their tokens; public bid and contact forms (file uploads); proposal and contract signing pages; the email reply intake; and the call and AI routes.

## 2. Number walkthrough (live data, read-only)

Pages checked, in order: Command Center, Calls, Estimates & proposals, Contracts, Projects, Invoices, Leads, Reports.

**Adds up (checked by hand):**
- Command Center "Needs attention" 60 = 44 leads not contacted + 4 overdue tasks + 2 open complaints + 2 overdue complaints + 2 autopilot decisions + 6 callbacks due.
- Proposals: drafts $45,726.84 (P-1010 $2,340 + P-1003 $43,386.84); pending $291,652.56; approved $6,000. Command Center "Estimates in progress" and "Proposals awaiting" match.
- Contracts: active $93,383.00 = $2,000 + $91,383.00; total contracted $95,383.00 = active + $2,000 draft.
- Reports: unsigned contract value $2,086,336.25 = $291,652.56 + $1,792,683.69 + $2,000.
- Leads: 169 total includes archived, as the page states.
- Calls: 54 in the last 30 days, 10 missed, matches Reports.

**Did not add up, and what was done:**
1. **Active projects showed 5 (Command Center) and 5 / 0 (Reports) while the Projects page showed 0 active and 1 open.** The count included archived projects. **Fixed** in commit `48198ee` (on origin, deploy pending).

**Needs your decision (live data, not changed):**
2. **The $6,000 "Won" and $6,000 "Approved" are all ZZ TEST records** (P-2026-1007, 1008, 1009). They inflate Won value, win rate and contracted value. Recommend archiving them.
3. **A contract titled "house" for $1,792,683.69 is marked Closed** with "Not sent" signature status. It looks like the leftover from the earlier $1.79M test error. It inflates the unsigned value on Reports ($2,086,336.25 total, of which $1,792,683.69 is this one). Recommend archiving it. I have not deleted anything.
4. **Terrell State Hospital contract ($291,652.56) is marked Closed**, while its proposal is still "Viewed" and not signed. Closed contracts should only be closed once signed; please confirm the status.
5. **Scope library:** 40 of 86 items have no price, so estimates using them will be incomplete.

**Labels that could mislead (not math errors):**
- Command Center "Today's work" column numbers (Emails 0, Sent 1, Calls 45, Leads 4, Tasks 2 = 52 total) are a different queue from the "Needs attention" tile (60). They are both labeled attention and can look like they should match.
- Leads "Contact messages (78 new)" versus the pipeline "New 1" count: the pipeline counts bid leads only. Labeling should say so.

**Not walked through in this pass:** Customers, Issues & tasks, Schedule, Quality inspections, Takeoffs and Drawings, Email Center, Subscriptions. These should be checked next.
