# Audit 06 and 07: Estimates and proposals, Contracts

## Scope

- Repository: `C:\Users\Eric Moore\AppData\Local\Temp\bc-work\repo-fresh`, branch `claude/bright-cleaning-rebuild-nt1y6e`, HEAD `644b506`.
- Area 06: line-item calculation, labor model including overtime, pricing, margin and minimum-margin rules, approval holds, proposal PDF, sending, customer approval, and the quote gate for new company copies.
- Area 07: contract versions, signatures, amendments, permissions, execution, and what happens when a customer signs.
- Read: `estimating.js`, `pricebook.js`, `approvals.js`, `pdf.js`, `contracts2.js`, `bids.js`, `admin-ext.js`, `setup-gate.js`, `server.js` (estimate, send, proposal and respond routes), `public/admin/admin.js` (estimator and approval UI), `public/assets/proposal-page.js`, `scripts/new-company-copy.js`.
- No tracked file was changed. No commit or push. No live-site request. No email, SMS or webhook.

## How this was checked

1. Static read of the code paths above, with line references below.
2. Existing tests:
   - `tests/overtime-quote-test.js`: 4 of 4 pass.
   - `tests/windows-math-test.js`: 4 of 4 pass.
   - `tests/quote-gate-test.js`: 5 of 5 pass.
   - `tests/run-tests.js` (end-to-end, temp database, local SMTP): clean rerun 267 of 267 pass. Its Estimating, Proposals, Workflow and Contracts sections pass. The first run was garbled by a concurrent run, so its log was discarded; `tests/results.json` (untracked) was rewritten by the clean run.
   - `tests/ui-tests.js`: crashed after 60 checks with a jsdom error at `public/admin/admin.js:1208` (labor history save button, outside this area). The estimator UI checks were not reached in a usable way.
3. Probes against the real modules, using in-memory SQLite and a fake Express app that captures the real route handlers. Synthetic data only. Scripts are in the session scratchpad, not in the repo:
   - `probe-estimating.js`: price math on synthetic inputs.
   - `probe-approvals.js`: approval gate, owner and staff roles, fingerprint invalidation.
   - `probe-flows.js`: `admin-ext.js` PUT on a sent proposal; `contracts2.js` countersign, amendment and PDF.
4. No server was started against the production database. No HTTP server was run for this audit.

## Summary of counts

| Classification | Count |
|---|---|
| VERIFIED WORKING | 8 |
| INCOMPLETE OR UNRELIABLE | 7 |
| MUST FIX BEFORE LAUNCH | 12 |
| INSUFFICIENT EVIDENCE | 2 |

## Area table

| Area | Classification | Notes |
|---|---|---|
| 06 Core cost-to-price math (direct, insurance, contingency, overhead, margin, tax, minimum charge, line-item price) | VERIFIED WORKING | Tests and probes agree. See V1. |
| 06 Labor model: overtime | MUST FIX | Overtime is computed on total job man-hours, not per person per week. See M3. |
| 06 Labor model: crew and visits inputs | MUST FIX | Reopening an estimate pins the labor-hours override. See M6. |
| 06 Unit condition add-on | MUST FIX | Not priced when the estimate is cost-priced. See M5. |
| 06 Windows pricing | INCOMPLETE OR UNRELIABLE | Pane fee is added on top of a cost that is already marked up. See I1. |
| 06 Margin and minimum-margin approval rules | VERIFIED WORKING (with gap) | Below-minimum, total-zero, owner-only rules, staff 403, fingerprint re-approval all work. Zero-cost bypass is a MUST FIX. See V2, M7. |
| 06 Default margin versus approval minimum | INCOMPLETE OR UNRELIABLE | Default 25% is below the 30% approval minimum, so every default proposal needs owner approval. See I2. |
| 06 Approval holds on send | VERIFIED WORKING | Send and PATCH-to-Sent are gated. See V2. |
| 06 Editing a proposal after it is sent | MUST FIX | Line items and expiry date stay editable after send. See M2. |
| 06 Proposal PDF generation | VERIFIED WORKING (with gaps) | Renders and test passes. Assumptions and exclusions only appear in the PDF. Identity is hard-coded. See V4, M9, M12. |
| 06 Sending to customers | VERIFIED WORKING (with gap) | Email send path works and is gated. Status can be set to Sent without emailing. See V3, I6. |
| 06 Customer approval (online) | VERIFIED WORKING (with gaps) | Name, authorization, IP, locks, auto hand-off to contract all verified. Revise can overwrite an accepted proposal. See V3, M10. |
| 06 Quote gate for new companies | MUST FIX | The gate is satisfied by saving a page that does not feed pricing. See M11. |
| 07 Create, send, view, sign, decline, countersign, execute | VERIFIED WORKING | Covered by passing end-to-end tests and probe C1. See V5. |
| 07 Amendments | MUST FIX | Countersigning a superseded original revives it. See M1. |
| 07 Renewals | VERIFIED WORKING | End-to-end test passes. Not probed directly. See V5. |
| 07 Execution side effects (project, visits) | VERIFIED WORKING | End-to-end tests pass. See V5. |
| 07 Executed-contract PDF signature block | MUST FIX | Says "Customer: not signed" for proposal-approved contracts. See M8. |
| 07 Signature evidence | INCOMPLETE OR UNRELIABLE | No snapshot of the signed terms. See I3. |
| 07 Permissions | INCOMPLETE OR UNRELIABLE | Staff can edit, send, amend and renew contracts. See I4. |
| 07 Proposal-approved contract countersign checks | INCOMPLETE OR UNRELIABLE | Only the value is checked against the approved proposal. See I4. |
| 06 and 07 Bright Clean identity and prices in new copies | MUST FIX | Identity is hard-coded in every customer-facing document. See M12. Price book import is gated (V8). |

## Findings

### MUST FIX BEFORE LAUNCH

**M1. A superseded contract can be countersigned again and becomes Active again (rebuilds two live versions).**
- `contracts2.js:99-113`. The countersign route only blocks archived contracts and contracts with no customer signature. For a proposal-approved root contract (`approvedOnline`, line 104) it skips the customer-signature check and does not check `status === 'Superseded'`. Line 113 then sets `status='Active'` and overwrites `countersigned_by`/`countersigned_at`.
- Probe `probe-flows.js` (C1 to C7): root countersigned, amendment drafted, customer-signed and countersigned. Root became `Superseded`. A second countersign of the root returned 200 and set root back to `Active` with the countersigner name changed. Both the root and the amendment are now Active and Signed.
- Fix: reject countersign when `status` is `Superseded`, `Closed` or `Void`, and do not overwrite an existing countersignature.

**M2. A proposal already sent to the customer can still change its line items and expiry date.**
- `admin-ext.js:57-83`. The FROZEN check (line 63 onward) compares only the fields in the `locked` list (line 65). `line_items` (set at line 53) and `expires_on` (line 54) are not in that list. The UPDATE at line 79 writes both.
- Probe P1 and P2: on a `Sent` proposal, a changed line item returned 200 and was stored; `expires_on` was extended from 2026-12-31 to 2027-12-31 with 200. Changing `labor_rate` on the same proposal correctly returned 409 (P3).
- Impact: the customer's proposal page shows the changed line items (`server.js:136` returns them), and the customer accepts content that differs from what was emailed. The approval fingerprint (`approvals.js:13-15`) includes line items, but the customer accept path does not re-check approval.
- Fix: lock `line_items`, `expires_on`, `email` and the other customer-facing fields once the status is in FROZEN, or create a new version.

**M3. Overtime is charged on total job man-hours as if they all fell in one week.**
- `estimating.js:64-67`. `weeklyHours = num(b.weekly_hours) || hours`, so with no weekly input the whole job's man-hours count toward the 40-hour overtime threshold.
- Synthetic results (`probe-estimating.js`, and checked again): a 3-person crew at 8 hours per visit for 5 visits (24 man-hours a visit, 120 total) gets 80 overtime hours and labor of 3,200. Each person works 40 hours, so the correct labor is 2,400. The price is overstated by about 1,143 before margin.
- Six weekly visits of 10 hours each: model 1,400 labor, correct 1,200.
- `weekly_hours` is not in `EXTRA_COLUMNS` (`estimating.js:19-31`), so it is not stored, and no admin UI field sends it (grep finds no `weekly_hours` in `public/`). The OT premium therefore always uses the whole-job total for saved estimates.
- Tests `tests/overtime-quote-test.js` pass because they only cover single-person and same-week inputs.
- Fix: compute overtime per person per week from crew size and visit dates, store the inputs, and expose them in the form.

**M4. The estimator's live preview does not match the saved price for jobs over 40 hours.**
- `public/admin/admin.js:2056-2079` (`estimateMath`, "Mirrors estimating.js on the server") computes `labor = hours * labor_rate` (line 2062) with no overtime, and no unit-condition add-on. The server (`estimating.js:64-67`) adds overtime.
- Probe F: 50 hours at 20 per hour. Preview labor 1,000. Saved labor 1,100 (price 1,571.43 at 30% margin, 0 overhead).
- The save path shows a notice only when a typed total differs (`server.js:117` notice logic), and the UI deletes a blank total before sending (`admin.js` submit handler), so the estimator is not warned.
- Fix: one shared calculation (send the server result back to the preview), or mirror the server rules exactly and show the overtime line.

**M5. The unit-condition add-on is not priced for cost-priced estimates.**
- `estimating.js:47-50` adds the add-on line (Light 40, Moderate 60, Heavy 80) to `lineItemsOf`. It is counted in `itemsTotal` (line 79), but `price` only uses items when `use_line_items` is on (lines 80-81). With cost pricing it has no effect.
- Probe B: a deep-clean line with a Heavy condition, cost-priced, gives the same price (285.71) as with no condition. With line-item pricing it adds 80 (230).
- The UI says the add-on is added to any deep clean line (`public/admin/index.html:810`). The live preview (`admin.js:2056-2079`) does not add it in either mode.
- Fix: add the condition charge to `direct` (or to `price`) in cost mode, and mirror it in the preview.

**M6. Reopening a scope-priced estimate pins its labor hours, so later scope-line changes are ignored.**
- `public/admin/admin.js:1955`. For an estimate with no area and no production rate (`derived` = 0), the form sets `labor_hours` to the saved total (`est.labor_hours`). Lines 1961-1962 do the same for multi-visit estimates.
- The server uses an explicit `labor_hours` override ahead of scope-line hours (`estimating.js:62`). So after reopening, adding, removing or changing a library line leaves the labor fixed at the old value.
- Probe D: override 12 with a 4-hour library line gives labor 240. Without the override the same line gives 80. Reading the UI path, the override is set on reopen.
- Fix: reopen should set the override to 0 unless the user typed a value, or store the override separately from the derived total.

**M7. A proposal with no cost entered skips the margin rule, so it can be sent without approval.**
- `approvals.js:23-25`. The margin check runs only when `total_cost > 0`. A proposal with price and no costs gets no margin check, so `gate()` returns null.
- Probe 8: total 1,000, cost 0, owner minimum 30%, gate returns null (no approval needed).
- The drawer shows "No costs entered, so margin can't be calculated" (`admin.js`, estimate drawer), but the send is not blocked.
- Fix: treat unknown cost as a reason for approval, or block send when cost is zero.

**M8. The executed contract PDF says "Customer: not signed" when the customer approved by proposal.**
- `contracts2.js:164` prints the customer signature line only when `contracts.signed_at` is set. The proposal-approved countersign path (lines 104-113) never copies the proposal's `signer_name` and `signed_at` into the contract. The auto hand-off (`server.js:138`) also does not.
- Probe C2: executed PDF contains "Customer: not signed" after a successful countersign (C1 returned 200).
- Impact: the executed document contradicts its own status and the customer's acceptance.
- Fix: copy the proposal's signer, title, time and IP into the contract when it is created or countersigned by the approved-proposal path.

**M9. The customer's web proposal does not show assumptions or exclusions.**
- Staff can enter assumptions and exclusions (`bids.js` PATCH, the `assumptions` and `exclusions` fields). They appear in the PDF (`bids.js:145-175`).
- The customer's proposal API returns a fixed list of columns that does not include them (`server.js:136`). The customer page renders only `p.terms` (`public/assets/proposal-page.js`, "Terms, assumptions & exclusions" section), but its own text says the proposal is "subject to the scope, assumptions, exclusions and terms below". The page has no PDF link.
- Impact: the customer can accept a proposal without seeing its exclusions, which is a scope and dispute risk.
- Fix: return and render assumptions and exclusions on the web page, or add a clearly linked PDF.

**M10. Revising an accepted proposal with no contract overwrites the acceptance status.**
- `bids.js:119-132` (revise). The guard at about line 124 blocks an approved proposal only when a contract exists. Without a contract, line 130 sets the original's status to `Superseded`, which erases its `Approved` status. The customer's acceptance remains only in `decision_ip` and `decided_at`.
- Read from code; not run. A probe needs the full estimates and contracts schema.
- Fix: block revising an `Approved` proposal, or keep its status and record the new version as a separate decision.

**M11. The new-company quote gate is satisfied by saving a page that does not feed pricing.**
- `setup-gate.js:9-23` blocks estimate inserts until `labor_confirmed` is set. `admin-ext.js:245-265` sets it when the labor page is saved (owner or manager). The labor values are stored in `settings` only; the comment at `admin-ext.js:245-246` says the estimator does not use them.
- The estimator uses per-estimate `labor_rate` and `margin_pct`, with defaults in `public/admin/admin.js:1914` (25% margin, 10% overhead, labor 0). `scripts/new-company-copy.js:93` tells the owner to replace the starting values (wage 20, burden 20%, minimum margin 30%), but nothing enforces it.
- Result: a new company can unlock quoting without its labor rates or margins affecting any price. The gate test (`tests/quote-gate-test.js`) passes because it checks only the flag.
- Fix: derive the estimator defaults from the saved labor settings, or require company-specific values before the gate lifts.

**M12. Customer documents and the email carry Bright Clean's identity for every company.**
- Hard-coded "Bright Cleaning Sev Inc.", office phone, owner name and phone, and email address in: `contracts2.js:7-14` (default terms), `contracts2.js:95`, `contracts2.js:157` and `:166` (contract PDF header and footer), `bids.js:173` (proposal PDF footer and header line), `public/assets/proposal-page.js` (header, contact block and footer), `server.js:135` (proposal email text), and `server.js:137` (decline and accept messages, office phone).
- The price book import is gated by an environment flag (`scopes.js:131-132`, `PRICEBOOK_IMPORT`), so Bright Clean prices are not copied by default. The identity is not gated.
- Impact: a new company's customers receive documents and emails naming another company and its owner.
- Fix: read company name, address, phone, email and owner contact from settings, and use them in all PDFs, the proposal page and emails.

### INCOMPLETE OR UNRELIABLE

**I1. Window pricing adds the pane fee on top of a cost that is already marked up.**
- `estimating.js:82` adds `windowsTotal` after the margin is applied, and `windows_cost` (line 69-71) is a direct cost, so the price includes `windows_cost / (1 - margin)` plus the pane fee.
- Probe C: windows cost 100 raises the price by 142.86 (100 / 0.7), and the pane fee of 50 adds on top. The windows test asserts this behavior ("window labor and supplies cost counts against margin"), so it is a design choice, but it may charge windows labor twice.
- Needs the owner's intent: is the pane fee all-in revenue, or on top of labor?

**I2. The default margin (25%) is below the approval minimum (30%), so every default-priced proposal needs owner approval.**
- `public/admin/admin.js:1914` sets `margin_pct: 25`. `approvals.js:6` sets `min_margin_pct: 30`. Probe 1 of `probe-approvals.js` shows the approval reason at 20%; at the default 25% the same rule fires.
- Not wrong, but it makes the approval queue the normal path. Decide the intended default.

**I3. The contract signature does not record what was signed.**
- `contracts2.js:188-200` records name, title, time and IP, and the status changes. It does not store a snapshot or hash of the scope, terms, value or dates. The PDF (`contracts2.js:155-168`) is rendered from the live row.
- Edits to a sent contract void the link (`contracts2.js:80`), so this is a gap in evidence rather than an open edit path. But the executed contract cannot prove what the customer saw.

**I4. Staff can edit, send, amend and renew contracts, and countersign only checks value for proposal-approved contracts.**
- No role check on PATCH (`contracts2.js:66`), send (`:85`), amend (`:123`) or renew (`:143`). Only countersign (`:102`) and archive are owner or manager only.
- For proposal-approved contracts, the countersign check (`:106-111`) compares only the value to the approved proposal. Scope, terms, dates and payment terms can differ from what the customer accepted, and the owner countersigns without a diff.
- Decide whether staff may edit contract terms. If not, add role checks; if yes, show a diff at countersign.

**I5. Online approval accepts any truthy `agree`.**
- `server.js:137` checks `!req.body.agree`, so the string "false" passes. The contract sign route requires `=== true` (`contracts2.js:194`). Small, but inconsistent.

**I6. Setting a proposal to "Sent" from the admin dropdown does not email it.**
- The status PATCH (`server.js:128-134`) passes the approval gate and sets status `Sent`, but nothing is emailed. The customer link is not delivered and the proposal shows as sent. The "Email to customer" button is the only send path that emails.

**I7. Customer-visible line items may not add up to the total.**
- With cost pricing, line items are a breakdown only. The admin UI warns that "the customer will see both" (`admin.js`, the `cWarn` line-item check), and the customer page and PDF show them. The customer can see a list that does not sum to the price. Confirm this is intended.

### VERIFIED WORKING

**V1. Core cost-to-price math.** `estimating.js:58-95`. Tests `tests/overtime-quote-test.js` (4 of 4), `tests/windows-math-test.js` (4 of 4) and the end-to-end "Estimating" checks (full model, minimum charge, line-item override) all pass. Probes confirm price = cost / (1 - margin), minimum charge applied, line-item override, margin capped at 90.

**V2. Approval holds.** `approvals.js` and `server.js`. Probes: margin below minimum is blocked; zero total is blocked (`total $0`); staff approve returns 403, owner approves; approval becomes invalid on a scope edit and on a line-item edit (fingerprint); restoring the original content makes it valid again; owner-only rule changes. Send is gated (`server.js:135`), and status PATCH to Sent/Approved is gated for Draft and Ready (`server.js:128-134`). Approved is only settable by the client (`server.js:128-134`).

**V3. Sending and customer decision.** End-to-end tests pass: proposal email sent with the review link; first and repeat views recorded; customer approval records name, title, IP and user agent, moves the proposal to Approved, and creates a draft contract and planning project when the hand-off setting is on (`server.js:137-138`); a decision is locked once made; decline creates no contract; expired proposals cannot be approved; Draft proposals return 423 to the customer.

**V4. Proposal PDF.** `bids.js:145-175` (`proposalPdf`). The end-to-end "taxed line-item proposal" check (PDF and page show every line and the total, no internal costs) passes. The PDF hides labor rates and hours.

**V5. Contract lifecycle.** End-to-end tests pass: send requires email, value, scope and start date; customer view then sign (full name and authorization, IP and time); owner countersign executes; staff cannot countersign; a signed contract with no project gets one; visits move from Tentative to Scheduled at countersign; amendment and renewal of a proposal-approved contract need the customer signature; decline with reason; editing a sent contract voids the link; renewal shifts dates and price. Probe C1 shows the proposal-approved countersign works; probes C3-C5 show an amendment executes and supersedes the original (the revive bug is M1).

**V6. Amendments supersede the original on countersign.** Probe C5: after amendment countersign the original is `Superseded` and the amendment is `Active`. The revive bug is M1.

**V7. Quote gate mechanics.** `tests/quote-gate-test.js` (5 of 5): an existing copy is never blocked; a new copy is blocked until labor is saved; every insert path is covered by the trigger; saving removes it. The gate's content is M11.

**V8. Price book import is gated.** `scopes.js:131-132` returns 403 unless `PRICEBOOK_IMPORT` is `on`, with a clear message. New copies do not get Bright Clean's prices by default.

### INSUFFICIENT EVIDENCE

**E1. The estimator's on-screen behavior (M4 and M6).** The preview mismatch and the reopen override are read from `public/admin/admin.js` and confirmed on the server side. The UI run (`tests/ui-tests.js`) crashed at `admin.js:1208` before the estimator checks, so the on-screen behavior is not confirmed. To settle it: fix the `lhSave` null reference or skip that section, then run the estimator UI in jsdom and compare the preview total with the saved total for a 50-hour estimate and a scope-priced estimate reopened after a line change.

**E2. Revising an accepted proposal (M10).** Read from `bids.js:119-132`, not run. To settle it: mount `bids.js` with a full estimates schema, approve a proposal with no contract, call revise, and check the status and `decision_ip`.

## What I could not test, and why

- Customer email delivery to a real mail provider. Tests used a local SMTP capture only.
- The estimator and proposal screens on a phone or in a real browser. The Chrome tools were not used, per the brief.
- Overtime rules for a real crew schedule. The fix needs the business's own week definition.
- Insurance-certificate gating beyond the end-to-end pass; it is outside this area's scope.
- Live-site behavior. Only the code and local temp runs were used.
- The windows pricing intent (I1) and the default margin decision (I2) need the owner, not a test.

## Notes on the run

- `tests/results.json` (untracked) was rewritten by the clean `tests/run-tests.js` run. `tests/ui-results.json` was not rewritten because that run crashed.
- No tracked file was modified. The probe scripts are in the session scratchpad, outside the repo.
