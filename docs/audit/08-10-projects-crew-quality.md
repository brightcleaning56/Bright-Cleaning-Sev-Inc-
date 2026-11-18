# Audit 08-10: Projects and scheduling, Crew portal, Quality and inspections

Scope: repo-fresh at HEAD 644b506 (branch claude/bright-cleaning-rebuild-nt1y6e). Read-only audit: no tracked file was changed, nothing was committed or pushed, no live site write, no email/SMS/call/webhook sent. Runtime checks ran against a temporary local server (temp DATA dir, no SMTP/Twilio/Postmark configured, scheduler disabled, `.env` not loaded).

Main files read: `sched.js` (dispatch, crew, time, crew portal, client tracking), `public/assets/crew-page.js` (crew phone page), `pm.js` (projects, work orders, sign-off, billing handoff), `server.js` (proposal approval hand-off, generic register routes, rate limit), `portal.js` (proposal approve, customer visit list), `qc.js` (inspections), `complaints.js` and `issues.js` (corrective visits), `roles.js` (role gates), `filecheck.js` (upload checks), `ops.js` (auto_handoff default).

Classification key: VERIFIED WORKING, INCOMPLETE OR UNRELIABLE, MUST FIX BEFORE LAUNCH, INSUFFICIENT EVIDENCE.

Evidence tags: "exercised" = reproduced on the temp server; "test" = existing suite in tests/run-tests.js passed; "code" = read only.

## Summary of counts

| Classification | Count |
|---|---|
| VERIFIED WORKING | 12 |
| INCOMPLETE OR UNRELIABLE | 13 |
| MUST FIX BEFORE LAUNCH | 9 |
| INSUFFICIENT EVIDENCE | 6 |

## Area table

| Area | Item | Classification | Finding ref |
|---|---|---|---|
| 08 Projects and scheduling | Job creation from an accepted proposal | INCOMPLETE OR UNRELIABLE (contract and project are created; no jobs are created) | I-1 |
| 08 | Dispatch (gates on Tentative and unapproved projects) | VERIFIED WORKING for the stated gates; bypassed by status (see M-6) | V-5, M-6 |
| 08 | Crew assignment: overlap, time off, overtime | VERIFIED WORKING at assignment | V-2, V-3, V-4 |
| 08 | Crew availability and calendar conflicts after assignment | MUST FIX (dispatch does not re-check) | M-5, I-4 |
| 08 | Double-booking via reschedule (move) | INCOMPLETE OR UNRELIABLE (no notice to crew or client; name-based removal) | I-2 |
| 08 | Who may schedule, skip, move, edit pay rates | MUST FIX (pay rate editable by any office staff); scheduling actions open to all staff | M-7, I-13 |
| 08 | Revoking dispatch approval | INCOMPLETE OR UNRELIABLE | I-3 |
| 09 Crew portal | Login with phone or email plus PIN | MUST FIX (lockout bypass by phone format; weak PIN floor) | M-2 |
| 09 | Sessions after PIN reset, link reset or sign-out | MUST FIX (90-day token not revoked) | M-3 |
| 09 | Assignments visible to the right crew | VERIFIED WORKING | V-1 |
| 09 | Check-in and check-out timestamps | MUST FIX (offline actions are stamped at sync time) | M-1 |
| 09 | Actions on cancelled or done jobs | MUST FIX | M-4 |
| 09 | GPS check-in and distance rule | INCOMPLETE OR UNRELIABLE (location recorded only; no distance rule exists) | I-6 |
| 09 | Photos and offline queue | VERIFIED WORKING for upload checks and queue replay; INCOMPLETE for capture time; phone behaviour INSUFFICIENT | V-6, V-7, I-7, E-2 |
| 09 | Incidents | VERIFIED WORKING | V-8 |
| 09 | Time tracking and break buttons | INCOMPLETE OR UNRELIABLE (breaks never close; not deducted from pay) | I-5, I-9 |
| 09 | On my way | INCOMPLETE OR UNRELIABLE (state verified; client email delivery not verified) | E-4 |
| 10 Quality | Checklists, weighted scoring, sign-off lock | VERIFIED WORKING | V-9 |
| 10 | Deficiencies and corrective work orders | VERIFIED WORKING for creation and dedupe; INCOMPLETE for closure links | V-10, I-11 |
| 10 | Reinspection | INCOMPLETE OR UNRELIABLE (allowed before the original is signed) | I-10 |
| 10 | Customer acceptance | MUST FIX (typed by any staff; "with exceptions" counts as passed for completion) | M-8, M-9 |
| 10 | Customer sign-off that unlocks completion and billing | MUST FIX | M-8 |
| 10 | Inspection PDF and customer PDFs | INSUFFICIENT EVIDENCE (company name on PDFs) | E-3 |

## Findings

Finding ids: V = verified working, I = incomplete or unreliable, M = must fix, E = insufficient evidence.

### Verified working

**V-1 Crew see only their own jobs, and Tentative and cancelled jobs are hidden.** `sched.js:334-346` (crewGet filters `visit_crew` by employee and excludes Cancelled, Skipped, Tentative). Exercised: employee A saw only job 1 (assigned), employee B saw only job 3. Test "Crew link: sees only own dispatched jobs, no prices" passes.

**V-2 Overlapping timed jobs are blocked at assignment.** `sched.js:50-56` and `sched.js:207-208`. Exercised: assigning employee A to an overlapping 10:00-11:00 job while on 09:00-12:00 returned 409 "already on ... 09:00-12:00". Untimed same-day jobs only warn (`sched.js:54`); test "Untimed jobs on the same day warn instead of block" passes.

**V-3 Time off blocks assignment.** `sched.js:49-50`. Test "overlapping shift and time off are blocked" passes. Time off added after assignment is reported as `needs_reassignment` (`sched.js:172-175`), but nothing blocks it (see M-5).

**V-4 Overtime needs an owner or manager and a reason.** `sched.js:209-213`. Test "overtime needs a manager reason; staff cannot approve overtime" passes.

**V-5 Dispatch gates.** `sched.js:251-253`: needs crew, refuses Tentative visits, and refuses a Planning project without dispatch approval. Test "Dispatch needs crew + manager, respects project planning holds" passes. The gate reads the stored status, so it can be bypassed (M-6).

**V-6 Offline queue replay is idempotent.** `sched.js:391-396` records each `client_id` after a successful response; a repeat returns `{ok:true, duplicate:true}`. Exercised: the same client_id sent twice returned `duplicate: true`. Test "Crew offline: a queued check-in and check-out sent twice are applied once" passes.

**V-7 Photo upload: assignment check and content check.** `sched.js:645` (assigned-job check before upload), `filecheck.js` (magic bytes, executable refusal, PDF script refusal), and only image MIME types accepted (`sched.js:644`). Exercised: Before and After photos uploaded (201). Submit then required both (`sched.js:428-429`) and returned 200.

**V-8 Incidents reach Issues.** `sched.js:461-468` inserts a `customer_issues` row (type incident, reported by the crew member) and emails the office. Test "Crew link ... incident reaches Issues" passes. Offline incidents are refused with a clear message (`crew-page.js:296`).

**V-9 Inspection scoring and sign-off lock.** `qc.js:36-41` (weighted score; any Fail of weight 4 or 5 fails the inspection), `qc.js:112-124` (every item needs a result; a failed item needs a comment), `qc.js:95-97` (signed inspections are locked). Exercised: one failed item (first item of the Commercial janitorial template, weight below 4) gave score 83.3, passed 0, status "Corrective action". Test "weighted scoring; failed item needs a comment; sign-off ... locks the inspection" passes.

**V-10 Corrective work orders.** `qc.js:126-145`: only after signing, one task per failed item, deduplicated by inspection and item. Exercised: corrective before signing returned 409; after signing it created 1 task. Test "Failed items create corrective work orders (no duplicates)" passes.

**V-11 Proposal approval creates a draft contract and a Planning project.** `server.js:138` (public approve, hand-off when `auto_handoff` is on; `ops.js` default '1'), `server.js:225-236` (afterDecision, used by the portal approve at `portal.js:243`). Test "Customer approval: recorded with time and IP, creates draft contract + planning project" and "Admin cannot approve a proposal; only the client's online approval creates the contract + project (once)" pass.

**V-12 Complaint corrective loop.** `complaints.js:97-107` (completion of a corrective visit moves the case to Reinspection) and `complaints.js:176` (corrective visit created). Tests "Corrective loop" and "Complaint -> Quality case end to end" pass.

### Incomplete or unreliable

**I-1 Accepted proposals do not create jobs.** `server.js:138` and `server.js:225-236` create only the contract and the Planning project. Visits come from a manual work plan and manual work-order generation (`pm.js:193-223`). Reasonable if intended, but "job creation from an accepted proposal" is not automatic. The office must generate work orders, and dispatch stays blocked until contract execution and approval (`pm.js:54-64`, `pm.js:178-191`).

**I-2 Reschedule (move) has no notice and removes crew by name.** `sched.js:228-240`. Moving a dispatched job does not notify crew or the client (no `reachCrew` or `clientNote` call). Conflicting crew are removed with `DELETE ... employee_id=(SELECT id FROM employees WHERE name=?)` (`sched.js:236`), so two employees with the same name would both be affected, and the removed crew are not told.

**I-3 Revoking dispatch approval does not revert work orders.** `pm.js:174`: un-confirming a readiness item clears `dispatch_approved_by`, but visits already set to Scheduled (`pm.js:187`, `pm.js:214`) and crew already dispatched stay as they are.

**I-4 Availability ignores company holidays; late-start alert is weak.** `sched.js:79` and `sched.js:277` compute availability from work days and time off only. The late sweep (`sched.js:657-670`) emails only `adminEmail`, sets `late_alert_at` before the email is attempted (`sched.js:667`, so a failed send is never retried), and does not run when `DISABLE_SCHEDULER` is set (`sched.js:672`).

**I-5 Break timer never closes at checkout and breaks are not deducted from pay.** `sched.js:448-452` (break toggles; no link to check-out). `sched.js:601-607`: an open break counts up to "now" even after the job is departed, so on-site time shrinks while the break stays open. Exercised: checkout while on break returned 200 and the job still showed `on_break: true`. Labour cost (`sched.js:610-617`) uses clock-in to clock-out only, so breaks are paid while on-site time and labour cost disagree. Policy question for the owner; the current result is internally inconsistent.

**I-6 GPS check-in records location only; there is no distance rule.** `sched.js:403-404` stores lat, lng and accuracy on the first check-in, with no distance check against the job address and no range validation (any finite number is stored). `crew-page.js:163-165` requests location with a 6-second timeout and continues without it. No distance rule exists in code, docs or tests; `docs/BUSINESS_PLAN.md:255` says GPS job verification "needs a privacy review". If the owner expects a distance rule, it is not built.

**I-7 Photo timestamps are upload time.** `sched.js:649-650` stamps `created_at` with the server time at upload. A photo taken offline and sent later shows the later time. Relevant to disputes.

**I-8 Refused queued changes are dropped silently after one message.** `crew-page.js:136-143`: a queued action the server refuses is removed from the queue and the crew member sees only a one-line message, which may be gone by the next refresh.

**I-9 Manual time entries and approval.** `sched.js:301-310` accepts a manual entry with no overlap check against existing entries or the future. `sched.js:319` posts labour cost to the project only when `project_id` is set, and dates the cost by the UTC date of clock-in (`t.clock_in.slice(0,10)`), not the business date.

**I-10 Reinspection is allowed before the original is signed, and is not gated on corrective closure.** `qc.js:147-157`. Exercised: reinspection on an unsigned inspection returned 201. The reinspect button can be used repeatedly, and nothing ties passing corrective work to the reinspection.

**I-11 Corrective work orders are tasks, not visits, and do not update the inspection.** `qc.js:126-145` creates `customer_issues` tasks. Nothing sets the inspection to closed or reinspected when those tasks are resolved; the original inspection status changes only by the manual reinspect action.

**I-12 An all-N/A inspection signs as a FAIL.** `qc.js:36-41` gives a null score and passed=0 when no item is rated, and sign-off (`qc.js:112-124`) allows all-N/A. The dashboard counts it as failed (`qc.js:204`). Code reading only.

**I-13 Scheduling actions are open to all office staff.** `sched.js:197-265` (assign, move, skip) carries no role check except overtime and dispatch. Exercised: staff skip returned 200. The central gate in `roles.js` does not restrict them. Acceptable if intended, but it means staff can skip or move any job. The stronger issue is pay rates (M-7).

### Must fix before launch

**M-1 Offline check-in and check-out are stamped at sync time, which corrupts labour hours and payroll.** `sched.js:397-399` (check-in uses `t = now()`), `sched.js:407-413` (check-out uses `closeEntry(open, t)` with server time), `sched.js:440` (complete closes entries with server time). The phone queues the action with only `client_id` and location; no time is sent (`crew-page.js:149-151`). Exercised: a check-in carrying a 2020 client time was stored with the server time (2026-11-18T01:43Z). Any shift started offline will be paid from the time the phone regains signal. Fix: send the device time with each queued action, store it as the action time, and reject or flag skew beyond a few minutes.

**M-2 Crew PIN lockout is bypassed by changing the spelling of the phone number, and PINs can be 4 digits.** `sched.js:359-371`: the failure counter is keyed on the raw login string, so each spelling gets its own 5-try lockout. Exercised: five wrong PINs on "515-555-0101" then a 429; the same wrong PIN on "(515) 555-0101", "+15155550101" and "5155550101" each returned 401 (not locked). The counter is in memory and resets on restart. The global `/api/` limit of 600 requests per 15 minutes per IP (`server.js:14`) is the only other brake. PIN length floor is 4 (`sched.js:380`). Impact: a crew PIN can be guessed over time; the session then gives job addresses, site access notes for jobs today and tomorrow (`sched.js:341-345`) and a 90-day token. Fix: key the lockout on the normalized phone or email and per employee, persist it, and use a 6-digit minimum.

**M-3 Crew sessions cannot be revoked by a PIN reset, a link reset or sign-out.** `sched.js:351-358` (JWT valid 90 days, `sched.js:373`; checked only for `active=1`). A PIN reset (`sched.js:376-384`) and a link reset (`sched.js:109`) do not invalidate tokens already issued. Sign-out is client-side only (`crew-page.js:62`). A lost or stolen phone stays signed in for up to 90 days unless the employee is deactivated. Fix: store a per-employee session version, bump it on PIN reset or link reset, and check it in `crewBearer`.

**M-4 Check-in, photos, incidents and complete accept cancelled or finished jobs.** `sched.js:385-388` checks only that the job is assigned, not its status. Exercised: check-in to a Cancelled job returned 200 and created a time entry. Completion repeated on a finished job returned 200 again (`sched.js:435-446`), which re-stamps `completed_at`, writes another audit entry and calls `onVisitDone` again. Fix: refuse actions for Cancelled, Skipped and Done (except repeats handled explicitly).

**M-5 Dispatch and crew assignment do not re-check conflicts, so a crew member on time off can be dispatched.** `sched.js:248-265` never calls `check()`. Exercised: employee B was assigned to a job, then given time off covering the job date (the system returned `needs_reassignment` for that job), then the job was dispatched and returned 200 with `crew: 1`. The board flags the conflict (`sched.js:275`) but nothing blocks dispatch. Fix: run `check()` for each crew member in dispatch and refuse, or require an override reason.

**M-6 A project's status can be set on creation to a live status, and work orders then go out as Scheduled.** `server.js:143` (generic register POST: the only status refused is Completed) and `server.js:144` (generic PATCH with the same field list). Exercised: POST /api/admin/projects with status "In Progress" returned 201; work-order generation then created a visit with status "Scheduled" on a project with no contract and no dispatch approval (`pm.js:214` reads the stored status, `pm.js:205-223`). The status sweep (`pm.js:91` syncStatus, run every 60 seconds by `pm.js:104`) and read-time sync (`pm.js:105`) reset the project to Planning shortly after, but the visit stays Scheduled. Scheduled visits for a customer's project appear in the customer portal (`portal.js:92-95`) and crew can be assigned and dispatched until the sweep runs. Fix: remove `status` from the generic project create and patch fields (use the project status route only), and make work-order generation use the derived status.

**M-7 Any office staff member can change a crew member's pay rate.** `sched.js:106-114` (PATCH employee; `hourly_rate` is validated but no role check). `roles.js` STAFF_DENY does not list employees, and `server.js:66-95` ROLE_RULES does not restrict them. Exercised: a staff login PATCH of hourly_rate returned 200. Hourly rate drives approved labour cost (`sched.js:318`), payroll exports and job labour cost (`sched.js:610-617`). Fix: restrict hourly_rate, payroll_id and max_week_hours to owner and manager, and audit changes.

**M-8 Customer sign-off on a project can be recorded by any staff with a typed name, and it unlocks completion and the billing draft.** `pm.js:305-310` (no role check; any name of two or more characters), `pm.js:70` (completion requires a sign-off name or a waiver), `pm.js:312-332` (billing handoff needs Completed; creates a draft invoice). Exercised: a staff login recorded sign-off and got 200. Compare: the contract waiver is limited to owner (`pm.js:160`) and the sign-off waiver to owner or manager (`pm.js:161`), but the sign-off itself is not. Fix: restrict to owner and manager, and require evidence (a signed document or a link from the client).

**M-9 Customer acceptance is typed by staff, and an "accepted with exceptions" walkthrough counts as passed for completion.** `qc.js:159-170` (only a name is required; `with_exceptions` lets failed items through), `pm.js:73` (completion accepts status 'Accepted with exceptions' whatever the score). Exercised: acceptance without exceptions returned 409; with exceptions returned 200 and recorded status "Accepted with exceptions". The project then passes the inspection gate in `completeBlock`. Fix: restrict acceptance to owner and manager, store evidence, and do not count an exceptions acceptance as passing for project completion without a recorded waiver.

### Insufficient evidence

**E-1 Dispatch and reach messages: delivery.** Email and text delivery were not exercised (no mail or SMS configured; the rules forbid sending). `sched.js:221-225`, `sched.js:248-265`. Settle by a staging test with a test mailbox and a test phone, owner-approved.

**E-2 Phone behaviour.** GPS permission prompts, photo capture and the offline photo queue in IndexedDB (`crew-page.js:69-115`), service-worker caching (`public/crew-sw.js`), and the incident category select (`crew-page.js:214`, `298`) were not run in a browser or on a phone. The owner's `docs/CREW_PHONE_TEST.md` and the readiness audit both list these as owner-run. Settle with a real phone in airplane mode.

**E-3 Company name on customer PDFs.** Quality, contract, invoice, proposal and completion PDFs print "BRIGHT CLEANING SEV INC." (`qc.js:181`, `pm.js:381`, `bids.js:147`, `invoices2.js:28`, `contracts2.js:157`). The public brand is "Bright Clean". Settle with the owner: confirm the legal name, or change the header.

**E-4 On my way and tracking emails.** The state changes and the client note are written (`sched.js:454-458`, `sched.js:563-566`), and the client tracking page shows the state (test "Client tracking" passes). Whether the email is delivered was not verified.

**E-5 Late-start alert delivery.** Depends on `adminEmail` and a configured mailer (`sched.js:657-670`). Not exercised.

**E-6 Labour cost posting on approval.** Approval posts a cost to the project (`sched.js:312-322`). Covered by test "approved time posts labor cost to the project" (passes); not exercised here.

## Test results

- `tests/run-tests.js` (Node 22): `tests/results.json` written by this run has 267 results, 267 PASS, 0 non-PASS, including the schedule, crew, quality, project, employee and workflow checks listed above. The captured console file (`scratchpad/run-tests.out`) also contains many "fetch failed" FAIL lines that do not match `results.json`; I relied on `results.json`. Those lines should be explained before anyone quotes the console output.
- `tests/ui-tests.js` (Node 22): two runs in this session both crashed partway. Run 1 stopped at `public/admin/admin.js:1208` (`loadLeadHistory`: `$('#lhSave')` is null, unhandled) after 23 PASS lines; run 2 stopped at `public/admin/admin.js:1777` (`loadEstFiles`: `$('#estFileIn')` is null) after 45 PASS lines and 0 FAIL. Both crashes are in loaders that run after a section opens, in proposal and lead code, outside my areas. Whether this is a jsdom timing artifact or a real race in the admin page is INSUFFICIENT EVIDENCE; a real race would throw in a browser too. The previous `tests/ui-results.json` (dated 19:15, not from these runs) shows 93 of 93 PASS, including the schedule, quality and projects UI sections; I did not rely on it for this audit.
- Local exercise of the findings above: a script run against a temp server with a temp data dir (scratchpad exercise folder). Its outputs are quoted inline in each finding.

## What I could not test, and why

- Live site: not touched (no writes; only read-only public GETs were allowed and none were needed).
- Email, SMS and phone calls: not sent (hard rule). Delivery is in E-1, E-4, E-5.
- Real phones and browsers: not run. The Chrome tools were not used (hard rule for this task), and no device was available. See E-2.
- GPS distance rule: none exists in code, so it cannot be tested. See I-6.
- Concurrency and offline timing on a real network (two devices, the sync sweep under load): not tested.
- The UI test suite could not be completed in this session (two crashes in admin loaders, see above). Admin UI for schedule and quality was therefore not verified in this run.
- Process hygiene: my test servers exited with their runs. A `run-tests.js` process started at 19:47 that I did not start was running in the same environment when I checked; I did not touch it.
- Secrets: none read or printed. The repo has no `.env`; the local server was run from a scratch directory with no environment file loaded.

## Housekeeping notes for the owner

- Running the test suites rewrote untracked files `tests/results.json`, `tests/ai-results.json` and `tests/postmark-results.json` (and possibly `tests/ui-results.json`). No tracked file changed. `git status` lists them as untracked, as before.
- This report is the only file added under `docs/audit/`.
