# Bright Clean: end-to-end workflow test (local, synthetic data)

Date: 2026-11-17. Branch: claude/bright-cleaning-rebuild-nt1y6e. Node 22 (the bundled node.exe).

## Method

- A fresh local server was started from `server.js` with a temp `DATA_DIR`, a temp `UPLOAD_DIR`, a free local `PORT`, `DISABLE_SCHEDULER=1`, and a synthetic `JWT_SECRET` and admin hash.
- No SMTP, SMS, Twilio, Postmark, Stripe, Anthropic or other provider settings were passed to the process. The environment was built from scratch, so no host variables were inherited.
- The owner signed in through the real `/api/admin/login` and two-step sign-in flow. Staff users (sales role) and a crew employee were created through the admin routes.
- Every step used the record produced by the step before it: lead #1 became estimate #1, which became contract #1, project #1, visit #1, inspection #1 and invoice #1.
- Synthetic data only: "Test Customer One", example.test addresses, 555-01xx phone numbers, a 1x1 PNG for photos.
- The only external contact was none. brightclean.net was not contacted, and no real email, SMS or call was attempted.
- The server was stopped at the end of the run.
- The harness lives outside the repo, in the session scratchpad (`wf-e2e.js` and `wf-e2e-part2.js`). Nothing was committed or pushed, and no tracked file was edited.

## Step table

Status key: PASS, FAIL, or BLOCKED (cannot proceed past this point without an app change or a configured provider). Row "5b" is a fallback path, not the requested public path, and is not counted toward the chain.

| Step | Routes called (HTTP status) | Linked IDs carried through | Result | Reason |
|---|---|---|---|---|
| 1. Public intake creates lead | `GET /api/quote-schema` (200), `POST /api/quotes` multipart (201), `GET /api/admin/leads` (200) | Lead #1, kind "bid", status "New", listed in CRM | PASS | Service `construction_final`. Required answers filled from the schema. |
| 2. Assign to staff user | `POST /api/admin/leads/1/assign` (200), `GET /api/admin/leads/1` (200) | Lead #1 assigned_to = sales test user | PASS | |
| 3. Call note and follow-up on lead | `POST /api/admin/calls` with lead_id 1 (201), `POST /api/admin/leads/1/activity` (200), `POST /api/admin/leads/1/follow-up` (200), `GET /api/admin/leads/1` | Call #1 linked to lead 1; lead follow_up_date 2027-01-17 | PASS | |
| 4. Estimate for lead; approval hold | `POST /api/admin/estimates` with lead_id 1 (201), `GET /api/admin/estimates/1/approval` (200), `POST /api/admin/estimates/1/send` before approval (409), `POST /api/admin/estimates/1/approve` as owner (200) | Estimate #1 has lead_id 1 | PASS | Approval hold applied: the intake carried a "needed before pricing" flag. Send was refused with 409 until the owner approved. Price was calculated, not the typed one (see Gap 3). |
| 5. Proposal sent, customer approves (public route, typed signature) | `POST /api/admin/estimates/1/send` after owner approval (503), `GET /api/proposal/{token}` (200), `POST /api/proposal/{token}/respond` (423) | Estimate #1 still Draft | BLOCKED | Email not configured. Send returns 503 "Email is not configured" and does not change status. Public approval refuses a Draft proposal with 423. Nothing was emailed. |
| 5b. Owner-recorded approval (fallback, not the public path) | `POST /api/admin/estimates/1/record-approval` (200) | Estimate #1 status "Approved", signer name blank | PASS (fallback) | Used only to let the chain continue. Signer name passed in the request was not stored (Gap 2). |
| 6a. Contract from accepted proposal | `POST /api/admin/estimates/1/create-contract` (201) | Contract #1 with estimate_id 1 | PASS | |
| 6. Contract sent, customer signs, owner countersigns | `PATCH /api/admin/contracts2/1` (200), `POST /api/admin/contracts2/1/send` (200, emailed=false, link returned), `POST /api/contract/{token}/sign` (200), `POST /api/admin/contracts2/1/countersign` (200) | Contract #1 status Active, signature "Signed" | PASS (caveat) | Send with no email returns the signing link to staff in the API response instead of refusing. The customer signed through that link. Caveat: the customer never receives an email (Gap 4). |
| 7. Project; site visit; crew assigned and dispatched | `GET /api/admin/pm/projects` (200), six `POST /api/admin/pm/projects/1/readiness` (200 each), `PATCH /api/admin/pm/projects/1` start date (200), `POST /api/admin/pm/projects/1/approve-dispatch` (200), `POST /api/admin/pm/projects/1/work-orders` (201), `POST /api/admin/dispatch/visits/1/crew` (409, onboarding), `PATCH /api/admin/employees/1` payroll ID (200), `POST /api/admin/dispatch/visits/1/crew` (200), `POST /api/admin/dispatch/visits/1/dispatch` (200) | Project #1 (contract 1), visit #1, employee #1 | PASS | Crew assignment refused until onboarding items and a payroll file number existed. The test marked them done for the synthetic employee (Gap 5). |
| 8. Crew signs in, sees job, checks in, photo, checks out | `POST /api/crew/login` (200), `GET /api/crew/me` (200, assignment visible), `POST /api/crew/me/jobs/1/checkin` (200), `POST /api/crew/me/jobs/1/photos` stage Before (201), same stage After (201), `POST /api/crew/me/jobs/1/checkout` (200) | Visit #1, employee #1 | PASS | |
| 9. Submitted for inspection; checklist passed; acceptance | `POST /api/crew/me/jobs/1/submit` (200), `POST /api/admin/visits/1/review` approve (200), `POST /api/crew/me/jobs/1/complete` (200), `POST /api/admin/qc/inspections` (201), `PATCH` items Pass (200), `POST /api/admin/qc/inspections/1/sign` (200), `POST /api/admin/pm/projects/1/signoff` (200) | Inspection #1 on project 1; project status became "Completed" | PASS | Customer acceptance is recorded as sign-off (name, title, time, waiver). See Gap 6: sign-off is also accepted before any work. |
| 10. Invoice from project; send | `POST /api/admin/pm/projects/1/billing-handoff` (201), `POST /api/admin/invoices/1/send` (503) | Invoice #1, amount 751.38, status Draft | BLOCKED | Send returns 503 "Email is not set up, so the invoice was not sent." Invoice stays Draft. Held as the spec allowed. |
| 11. Payment recorded (manual) | `POST /api/admin/invoices/1/payment` amount 751.38 (409) | Invoice #1 | BLOCKED | 409 "Send this invoice before recording a payment on it." A draft invoice cannot take a payment, so with email unavailable no payment can be recorded (Gap 7). Not paid with Stripe. |
| 12. Reconciliation | `GET /api/admin/invoices` (200), `GET /api/admin/reports/aging` (200), `GET /api/admin/reports/finance` (200), `GET /api/admin/reports/labor` (200), `GET /api/admin/pm/projects/1` (200) | Invoice #1, project #1 | BLOCKED | Invoice balance 751.38 (not zero). Aging lists nothing (drafts excluded). Finance shows invoiced 0 (drafts excluded). Labor report shows the employee at 0.00 hours. Project actual_cost 0. Labor cost was not exercised by real hours (Gap 8). |

Probe run inside step 9 (not part of the chain): a customer sign-off attempted before any crew work returned 200 and the project stayed "Ready to mobilize". This is the acceptance-before-work gap.

## First point where the chain breaks

Step 5. Without an email provider, a proposal cannot be sent, so it stays Draft and the public approval route refuses it. Everything after step 5 in this run depended on the owner-recorded approval fallback (5b). The money path breaks at step 10 and 11: an invoice cannot be emailed, and a manual payment is refused on a draft invoice.

## Gaps

1. **Proposal send has no fallback.** Contract send returns the signing link when no email is configured (emailed=false), but proposal send returns 503 and leaves the estimate in Draft. The two behave differently, and a proposal cannot be approved by the customer without email.
2. **Owner-recorded approval loses the signer name.** `record-approval` sets the estimate to Approved, but the signer name passed in the request is not saved (signer blank). The approval record has no customer name attached.
3. **Typed price is replaced by a calculated price.** The estimate was entered at $3,200.00. The app returned a notice that the proposal uses $751.38, calculated from labor and cost inputs, and the invoice was billed at $751.38. A typed price cannot be used unless the inputs are changed.
4. **No email, so no customer contact.** The contract signing link is returned only to the staff user in the API response. Nothing reaches the customer. Expected without email, but no alternative delivery (print/share instructions) is built in.
5. **Crew assignment gates.** A new employee must complete onboarding items (contact and emergency contact, work eligibility, tax withholding, payroll file number, and more) before assignment. This is intended, but the run shows it is a hard block on the first crew dispatch.
6. **Customer sign-off accepted before work.** `POST /api/admin/pm/projects/:id/signoff` returned 200 on a project still "Ready to mobilize", with no visit done. Acceptance should require completed work.
7. **Manual payment needs a sent invoice.** `POST /api/admin/invoices/:id/payment` refuses Draft invoices. With email unavailable, an invoice cannot reach Sent, so a check or cash payment cannot be recorded. There is no mark-sent or manual-send route in this run.
8. **Labor and profitability not exercised with real time.** Check-in and checkout happened seconds apart, so labor reported 0.00 hours and project actual_cost stayed 0. The report endpoints respond (200) and list the employee and project, but the cost path with real hours was not tested.
9. **Countersign can execute on an owner-recorded approval.** The countersign route allows execution when the proposal was approved online or recorded (the `approvedOnline` branch), so a contract could be executed without a customer signature on the contract itself. In this run the customer also signed through the link, so this was not exercised on its own.

## Not tested

- Real email, SMS, voice calls and Twilio webhooks. None were configured or sent, by design.
- The public customer portal (`/api/portal/*`) and its login and MFA. Only the public proposal and contract links were used.
- Stripe and any live payment. The manual payment route was used but was refused before recording.
- PDF output for proposals, contracts and invoices.
- Refunds, invoice void, credit memos, insurance certificates, and the approval-rules screen beyond the single pricing hold.
- Overtime, time-entry approval, and multi-visit or recurring schedules. One visit only.
- Photo file-type and size limits beyond one valid PNG per stage.
- Dispatch conflicts and rescheduling (`move`, `skip`).
- Live-data behavior on brightclean.net. Not contacted.

## Artifacts

- Harness (outside the repo, not committed): `C:/Users/ERICMO~1/AppData/Local/Temp/claude/ad404082a23ddc2e/363886f5-fd1e-4fd0-905c-6cc346377808/scratchpad/wf-e2e.js` and `wf-e2e-part2.js`.
- Raw step results: `C:/Users/ERICMO~1/AppData/Local/Temp/claude/ad404082a23ddc2e/363886f5-fd1e-4fd0-905c-6cc346377808/scratchpad/steps.json`.
- Temporary server data (synthetic): under the Windows temp directory, folder prefix `bc-e2e-`.
