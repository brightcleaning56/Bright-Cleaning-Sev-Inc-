# Audit 01: Website and intake, CRM and lead management, tasks and automation

Branch: claude/bright-cleaning-rebuild-nt1y6e, HEAD 644b506 (clean clone at repo-fresh).
Scope: Area 01 (website and customer intake, including the API intake), Area 02 (CRM and lead management),
Area 05 (tasks and automation). Read-only review of the code plus runtime checks against a local temporary server.

## How this was checked

- Code read: `server.js`, `intake.js`, `integrations.js`, `dupreview.js`, `leadlog.js`, `leadstage.js`,
  `workqueue.js`, `issues.js`, `followups.js`, `crm.js`, `ops.js`, `suite.js`, `lead-notify.js`, `filecheck.js`,
  `public/assets/quote.js`, `public/assets/site.js`, `public/admin/admin.js` (lead history and work queue sections).
- `tests/run-tests.js` on Node 22: 267 of 267 checks passed. Intake, quote, repeat-bid, API intake, CRM, lead workspace,
  issues, follow-up and work queue checks all passed. Those tests do not cover the specific gaps listed below.
- `tests/ui-tests.js` on Node 22: the run stopped after 55 of 73 checks with an uncaught TypeError (see C10).
  Checks 56 to 73 did not run.
- Temporary-server probe (synthetic data only, temp data directory, no mailer or SMS configured so nothing was sent,
  server stopped and temp directory removed). It signed in through the repo's own MFA helper, created an API key,
  and exercised the public routes, the repeat-bid review, the quote double-submit guard, the tasks and lead
  assignment routes, the issue reminder sweep, follow-ups and the lead history.
- Lead history append-only triggers checked on a scratch in-memory SQLite database.
- No live site requests. No commits, pushes, or tracked-file changes. Test runs refreshed untracked result files
  (`tests/results.json`, `tests/ui-results.json`, `tests/ai-results.json`, `tests/postmark-results.json`).

## Summary table

| Area | Item | Classification | Primary reference |
|---|---|---|---|
| 01 Intake | Bid, quote, inquiry and careers forms create leads and customers | VERIFIED WORKING | server.js:87-101, intake.js:184-225 |
| 01 Intake | Quote validation, honeypot and 10-minute double-submit guard | VERIFIED WORKING | intake.js:113-146, 187, 201 |
| 01 Intake | API keys stored as hashes, shown once, revocable, bad key refused | VERIFIED WORKING | integrations.js:12-45 |
| 01 Intake | API repeat-lead merge: second project's name and service not updated | INCOMPLETE OR UNRELIABLE | integrations.js:56-62 |
| 01 Intake | Website inquiry and careers: no honeypot, no duplicate check, acknowledgement sent to any address | MUST FIX BEFORE LAUNCH | server.js:98, 101 |
| 01 Intake | Notifications fail silently when no mailer or NOTIFY_EMAIL | INCOMPLETE OR UNRELIABLE | server.js:52-55 |
| 01 Intake | Mobile layout of quote and request forms | INSUFFICIENT EVIDENCE | public/quote.html:1, public/request-a-quote.html:1 |
| 01 Intake | Quote draft (contact details) kept in browser storage | INCOMPLETE OR UNRELIABLE | public/assets/quote.js:10-12 |
| 01 Intake | Manual lead entry has no duplicate check | INCOMPLETE OR UNRELIABLE | suite.js:57-75 |
| 02 CRM | Lead history is append-only (update and delete blocked) | VERIFIED WORKING | leadlog.js:18-19 |
| 02 CRM | Notes, briefing, follow-up and activity timeline | VERIFIED WORKING | leadlog.js:99-123, leadstage.js:63-72, 118-129 |
| 02 CRM | Repeat bid goes to review; lead unchanged until decided | VERIFIED WORKING | server.js:90, dupreview.js:14-49 |
| 02 CRM | Repeat-bid merge and new-lead paths drop service, project type and intake answers | MUST FIX BEFORE LAUNCH | dupreview.js:34, 42-45 |
| 02 CRM | Lead assignment accepts any text and notifies nobody | INCOMPLETE OR UNRELIABLE | workqueue.js:344-353 |
| 02 CRM | Customer matching by company name can merge distinct contacts or sites | INCOMPLETE OR UNRELIABLE | ops.js:73-80 |
| 02 CRM | Customer notes: author or owner may edit; edits audited | VERIFIED WORKING | crm.js:182-200 |
| 02 CRM | Owner check fails open when ADMIN_EMAIL is unset | INCOMPLETE OR UNRELIABLE | crm.js:29 |
| 02 CRM | Converting a lead sets status to Won without an accepted proposal | INCOMPLETE OR UNRELIABLE | leadstage.js:101-115 |
| 02 CRM | UI lead-history save: unscoped lookup throws after the drawer is replaced | INCOMPLETE OR UNRELIABLE | admin.js:1189-1211 |
| 05 Tasks | Automatic SMS follow-ups to proposal customers with no opt-in or opt-out | MUST FIX BEFORE LAUNCH | followups.js:40-52, 61-93 |
| 05 Tasks | Email follow-ups honor suppression and cancel when the proposal is decided | VERIFIED WORKING | followups.js:83-88 |
| 05 Tasks | Follow-up sweep has no claim step; double-send possible with two instances | INCOMPLETE OR UNRELIABLE | followups.js:95-99 |
| 05 Tasks | Task assignment via tasks route accepts any text, no user check, no notice | MUST FIX BEFORE LAUNCH | workqueue.js:356-368; issues.js:59 |
| 05 Tasks | Issue reminders marked sent even when the email was not delivered | MUST FIX BEFORE LAUNCH | issues.js:42-47, 283-289 |
| 05 Tasks | Issue escalation emails owners and managers; reassignment notifies | VERIFIED WORKING | issues.js:120-129 |
| 05 Tasks | Missed-call escalation is a display flag only; nobody is notified | INCOMPLETE OR UNRELIABLE | workqueue.js:83-85, 134, 412-418 |
| 05 Tasks | Work-queue buckets (today, overdue, scheduled) and tests | VERIFIED WORKING | workqueue.js:23-30, 90-94 |
| 05 Tasks | Work-queue list capped at 500 while counts use the full list | INCOMPLETE OR UNRELIABLE | workqueue.js:184, 188-197 |
| 05 Tasks | Overdue tasks are not pushed to anyone; visible only in the queue | INCOMPLETE OR UNRELIABLE | workqueue.js:23-30 |

Counts: VERIFIED WORKING 11. INCOMPLETE OR UNRELIABLE 13. MUST FIX BEFORE LAUNCH 5. INSUFFICIENT EVIDENCE 1.

## Findings

### Area 01: Website and customer intake

**VERIFIED WORKING: public forms create leads and customer records.** Bids (`/api/bids`), quote requests (`/api/quotes`),
inquiries (`/api/inquiries`) and careers (`/api/careers`) store leads and call `upsertCustomer` (server.js:87-101,
intake.js:184-225). Evidence: tests "Forms", "Quote forms" and "Customers" passed; probe inquiry POST returned 201.

**VERIFIED WORKING: quote intake validation and double-submit guard.** Required fields, option lists and visible-only
follow-ups are enforced server-side (intake.js:113-146). A repeat submission for the same email and service inside 10
minutes returns 200 with `duplicate: true` and creates no lead (intake.js:201-203). Probe: first 201, second 200 duplicate.
Honeypot field `website_url` rejects bots (server.js:87; intake.js:187).

**VERIFIED WORKING: API intake key lifecycle.** Keys are generated with 24 random bytes, stored only as SHA-256 hashes
(integrations.js:15, 22-30), returned once, and revocable (integrations.js:33-40). Probe: an unknown key returned 401.
The suite test that checks the key is not shown again passed.

**INCOMPLETE OR UNRELIABLE: API repeat-lead merge keeps the old project.** When an open lead has the same email, the
new request is appended to `details` and the lead's `project_name`, `service` and address are not updated
(integrations.js:56-62). Probe: first request (project "Office A", service "Janitorial"), then second request
(project "Office B", service "Windows") with a different-case email. Result: same lead, `duplicate: true`, project
and service still "Office A" and "Janitorial"; the second project appears only as text. Staff can miss that a second
project was requested.

**MUST FIX BEFORE LAUNCH: website inquiry and careers forms have no spam control and send mail to any address.**
`/api/inquiries` and `/api/careers` have no honeypot, no consent field, and no duplicate check (server.js:98, 101).
Each valid post sends an acknowledgement to the address typed in (`notify` at server.js:98 and 101) and creates a new
lead. The only control is the global `/api/` limit of 600 requests per 15 minutes per IP (server.js:14). Probe: two
identical posts both returned 201, creating two leads. Impact: the public endpoint can be used to send mail to third
parties from the company address, and it fills the lead list with duplicates. Bids and quotes already have the
honeypot, so the gap is specific to these two routes. Fix: add the same honeypot (and a captcha or a
challenge if abuse appears), and a duplicate check on email plus message within a short window.

**INCOMPLETE OR UNRELIABLE: notifications fail silently.** `notify` returns without logging when there is no mailer or
no recipient (server.js:52-55). A lead is saved but the owner is not alerted, and nothing records the failure.
`render.yaml` declares `NOTIFY_EMAIL` (render.yaml:27), so the setting exists in config. Live delivery was not tested.
Fix: log or count skipped notifications, and show them in the admin attention list.

**INSUFFICIENT EVIDENCE: mobile layout.** Both pages declare a viewport meta tag (public/quote.html:1,
public/request-a-quote.html:1), and quote.html has one media rule at 640px (summary grid only). I did not render the
pages at phone width because the Chrome tools are excluded and no built-in browser check was run. Settle by
rendering quote.html and request-a-quote.html at 375px wide, checking for horizontal scroll, that the service
buttons and the file input are usable, and the step buttons at the bottom.

**INCOMPLETE OR UNRELIABLE: quote draft stored in browser storage.** The quote form saves answers, including name,
email, phone and address, to localStorage until submitted or cleared (public/assets/quote.js:10-12). On a shared
device the next visitor can see a previous customer's details. Consider sessionStorage, or saving only the answers
without contact fields.

**INCOMPLETE OR UNRELIABLE: manual lead entry has no duplicate check.** `POST /api/admin/leads` inserts without looking
for an existing lead with the same email or phone (suite.js:57-75). Website, API and repeat-bid paths do check, so the
result depends on the entry route. Staff entering a lead twice create two records.

### Area 02: CRM and lead management

**VERIFIED WORKING: lead history is append-only.** `lead_activity` has BEFORE UPDATE and BEFORE DELETE triggers that
abort (leadlog.js:18-19). On a scratch database, `UPDATE` and `DELETE` were both blocked with the intended messages.

**VERIFIED WORKING: notes, briefing, follow-up and activity timeline.** Note and conversation entries are recorded with
the signed-in user's email and time (leadlog.js:110-123). Probe: a note POST returned 200 and the timeline showed the
note, the follow-up entry, the received entry, and the "viewed" entry. The briefing reported the next follow-up date
and the note count. A follow-up sets the lead to the follow-up stage and creates one follow-up task, and closes any
earlier follow-up task (leadstage.js:63-72, 118-129). The probe checked the status code and the history entry; the
created task row itself was not queried.

**VERIFIED WORKING: repeat bids wait for review.** A second bid with the same email, project and address within 30 days
goes to `duplicate_reviews` and leaves the lead unchanged (server.js:90-94; dupreview.js:14-24). The suite test and the
probe (review found, lead untouched) agree. Merge and new-lead buttons are single-use (dupreview.js:25-49).

**MUST FIX BEFORE LAUNCH: repeat-bid decisions drop intake data.** The review payload stores every submitted field
(server.js:90), but `open()` maps only name, company, email, phone, project, address, service and details
(dupreview.js:9-13). The merge path appends only `p.details` and the files (dupreview.js:34). The new-lead path
inserts name, company, email, phone, project name, address and details, and omits `service`, `project_type` and the
structured answers (dupreview.js:44-45). Probe: after "new lead" on a repeat bid, the lead's `service` and
`project_type` were null. Access notes, floors and billing or insurance requirements submitted with the bid are
kept only in the review row's payload, which the screen does not show after the decision. Impact: crew and pricing
staff can lose the scope a customer asked for. Fix: copy the service, project type and the `details` built from
the full intake (as in server.js:87 `details` assembly), and append the extra fields in the merge path.

**INCOMPLETE OR UNRELIABLE: lead assignment accepts any text and notifies nobody.** `POST /api/admin/leads/:id/assign`
writes `assigned_to` without checking it against users (workqueue.js:344-353). The owner UI offers a list of users, but
the API does not enforce it. Probe: assigning to "Just A Name" returned 200. Nothing notifies the assignee.

**INCOMPLETE OR UNRELIABLE: customer matching by company name.** `upsertCustomer` falls back to matching on the company
name, case-insensitively, when no email or key matches (ops.js:73-80). A management company with several properties
or several contacts is merged into one customer, and the later contact's phone or address is kept only when the
field is empty (COALESCE). The test "same company without an email" passed, which confirms the intended behavior. It
does not show what happens with two different sites under one company. Consider a property or contact check before
merging on company name alone.

**VERIFIED WORKING: customer notes rules.** Only the author or an owner can edit a note, and each edit records the old
text in the audit log (crm.js:182-200). Suite test "Notes carry author and time; only the author or an owner can edit"
passed.

**INCOMPLETE OR UNRELIABLE: owner check fails open when ADMIN_EMAIL is unset.** `roleOf` in crm.js returns `'owner'` for
every user when `adminEmail` is empty (crm.js:29). `render.yaml` declares `ADMIN_EMAIL` (render.yaml:21), so the
production configuration probably sets it, but the failure mode is "everyone is owner" rather than "nobody". Consider
failing closed. The live value was not checked (no secrets read).

**INCOMPLETE OR UNRELIABLE: converting a lead marks it Won.** `POST /api/admin/leads/:id/convert` writes the customer,
then sets status to Won for leads in New, In Review, Site Walkthrough, Proposal in Progress or Proposal Sent
(leadstage.js:101-115, status update at line 110). A lead can be converted before any proposal is accepted, which
inflates win counts in reporting. The two writes are also not in one transaction. Decide whether conversion should
set Won only when a contract exists.

**INCOMPLETE OR UNRELIABLE: UI lead history can throw after the drawer is replaced.** `loadLeadHistory` captures the
history box, awaits the API, then looks up `#lhSave` with the document-wide selector (admin.js:1189-1211, `$` defined at
admin.js:6). If the user has moved to another lead or to "Build estimate" before the response returns, the save button
is not in the document and the handler throws `TypeError: Cannot set properties of null (setting 'onclick')`.
In `tests/ui-tests.js`, the test at lines 447-462 does exactly that and the whole UI run exits, so checks 56 to 73
did not run. Data is not affected, but the UI test run is incomplete. Likely fix: query inside the captured box, and
ignore late results when the box is no longer attached. Not confirmed in a real browser.

### Area 05: Tasks and automation

**MUST FIX BEFORE LAUNCH: automatic SMS follow-ups to customers without opt-in or opt-out.** When a proposal is sent and
the customer has no valid email but has a phone, `scheduleAuto` schedules an SMS follow-up two days later
(followups.js:61-76). `runDue` runs every 15 minutes (followups.js:95-99) and calls `sendFollowup`, whose SMS branch
sends through Twilio with no suppression check (followups.js:78-93). The email branch does check suppression
(followups.js:86). A search of the code for STOP or opt-out handling found nothing. The only inbound Twilio routes
are voice webhooks (calls2.js:67-146). Impact: automatic texts to people who have not agreed to them, with no way for
them to stop, which is a compliance and complaint risk. Fix before sending any automatic SMS: consent capture,
an opt-out keyword handler, and the suppression check in the SMS branch. Until then, disable the automatic SMS
channel. Legal review of the messaging rules is outside this audit.

**VERIFIED WORKING: email follow-ups honor suppression and stop when a decision is made.** `sendFollowup` cancels when the
proposal is approved, declined, withdrawn or expired (followups.js:83), and checks `isSuppressed` before sending email
(followups.js:86). Suite tests "Proposal reminders stop once the customer decides" and "Client portal opt-out" passed.

**INCOMPLETE OR UNRELIABLE: follow-up sweep has no claim step.** `runDue` selects scheduled rows due today and sends them
without first marking them in progress (followups.js:95-97). Inside one process this is fine. If two instances run
(for example, a scale-out or a deploy overlap), both can send the same follow-up. Confirm the deployment runs one
instance, or claim each row with an atomic update before sending.

**MUST FIX BEFORE LAUNCH: task assignment accepts any text and bypasses the issue rules.** The issue route checks the
assignee against users and rejects others (issues.js:59; probe: 400 for "Not A Real Person"). The tasks route
`POST /api/admin/tasks/:id/work` writes `assigned_to` directly, with no user check and no notification (workqueue.js:356-368).
Probe: the same input returned 200 and was stored. The task then appears under that name in no one's queue,
and as "assigned" rather than "unassigned" in the counts. Fix: apply the same user check and assignment notice,
ideally by calling the issue validator.

**MUST FIX BEFORE LAUNCH: issue reminders are marked sent even when nothing was delivered.** The reminder sweep calls
`notify`, which returns `false` when there is no mailer or no recipient or when sending fails (issues.js:42-47).
The sweep ignores that result, writes `reminded_at`, and writes a "sent reminder" audit line (issues.js:283-289).
Probe: with no mailer configured, a task with a past reminder time was marked reminded and logged as sent. The
reminder is never retried. Fix: write `reminded_at` only when `notify` returns true, and log failures.

**VERIFIED WORKING: issue escalation and reassignment notices.** Escalating an issue emails owners and managers
(issues.js:124-129), and reassignment emails the new assignee (issues.js:120-122). Suite tests "reassignment
notification, escalation to management" passed.

**INCOMPLETE OR UNRELIABLE: missed-call escalation is a display flag only.** A missed call not returned within
`MISSED_CALL_ESCALATE_MINUTES` (default 60) is marked escalated (workqueue.js:83-85, 134) and counted in the closeout
exceptions (workqueue.js:412-418). Nothing emails or texts anyone. The closeout is only returned by the API. If the
office does not open the queue, nobody is told. Consider a notification to the owner or the on-duty person.

**VERIFIED WORKING: work-queue buckets.** `dateBucket` gives overdue, today or scheduled from a due date
(workqueue.js:23-30). Tasks, leads and follow-ups use it (workqueue.js:90-94, 118-160). Suite test "Today's Work" passed.

**INCOMPLETE OR UNRELIABLE: work-queue list capped while counts are not.** `GET /api/admin/work-queue` returns at most
500 items (workqueue.js:184), but `summary()` counts the full list (workqueue.js:188-197). The counter can show more
than the list displays. Also the tasks query is limited to 1000 rows (workqueue.js around line 147). Show a "more"
notice or paginate.

**INCOMPLETE OR UNRELIABLE: overdue tasks are not pushed.** Overdue tasks appear in the queue and in the counts
(workqueue.js:23-30), but no notice goes to the assignee or owner. Only reminders (issues.js) and follow-up tasks are
pushed, and reminders are subject to T4 above.

## What I could not test, and why

- Mobile rendering (A8): not rendered. Needs a browser check at 375px.
- Live site behavior: not checked. Only GET was allowed and no live endpoint was needed. Live NOTIFY_EMAIL, ADMIN_EMAIL
  and Twilio configuration were not read, and secrets were not printed.
- Real email and SMS delivery: no provider was configured on the temporary server, so delivery and bounce handling
  were not exercised. The reminder finding (T4) is shown by the marked-sent flag, not by a provider failure.
- Twilio SMS path and opt-out: no inbound SMS webhook exists in the code, so the opt-out behavior could only be
  checked by reading. A real test needs a Twilio test account.
- Two-instance double-send (T-sweep): not reproduced. It needs two server processes sharing a database.
- Browser race in C10: reproduced only as the UI test crash. Not confirmed in a real browser.
- Multi-user assignment and role matrix: tested only for the owner account. Manager and staff permissions for
  lead assignment and task assignment were read, not run.
- The created follow-up task row (C2) and the customer-matching edge cases (C6) were checked by code reading and by
  the existing tests, not by new runtime probes.
- Complaint escalation (complaints.js:88-92, quality area) is outside this assignment and was not audited.
