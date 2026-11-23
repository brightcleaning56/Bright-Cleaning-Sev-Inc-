# Owner action list

Items that need the owner before the system can move forward. Everything else is built and tested locally and listed in git history.
Last updated: 2026-11-15.

## Needs your decision or access (new, from the software plan)

1. **Operator console: create the Render service.** Use New > Blueprint with `render-operator.yaml`, then enter its secrets (`OPS_ADMIN_EMAIL`, `OPS_PASSWORD_HASH`, `OPS_TOTP_SECRET`, `OPS_ALERT_EMAIL`, `FROM_EMAIL`, `POSTMARK_TOKEN`). Send the address back so it can be checked. Until then the operator console is not running.
2. **Test company copy (Test Cleaning Co).** Create it with `render-staging.yaml` under a new service name, and enter its settings from its `env.txt`. The dry run passed locally; this is the first real check on a separate copy.
3. **Extra-visit price. APPROVED 2026-11-21 by the owner: "prices for extra visit is good".** Nothing is billed for extra visits until a price is set on a subscription; the default stays blank. **Original item:** Set the price per visit above a subscription's monthly allowance, or leave it blank so nothing is billed extra. The plan has no figure. Extra visits count every non-cancelled visit for the customer in the month.
4. **Counsel review.** Send `docs/TERMS_DRAFT_FOR_COUNSEL.md` to counsel. Every bracketed value needs a decision. Required before the first paying customer.
5. **Insurance and legal quotes.** Get quotes for general liability and a legal retainer. The software budget uses placeholders ($200 a month insurance, $300 a month legal, $4,000 one-time counsel) until these come in.
6. **Uptime monitor.** Create a free external monitor (for example UptimeRobot) that checks https://brightclean.net/api/health every five minutes. Point a second check at the operator console once it is running.
7. **Pricing per company. Approved 2026-11-15.** Each company enters its own pricebook, labor rates and margins. Bright Clean’s prices are never copied into another company. **Done 2026-11-19:** all 38 unpriced items on the live Cleaning scopes page now have prices (draft table approved by the owner; any can be changed on that page). Items marked as estimates with no market source should be checked first.
8. **Labor and margin starting values. Approved 2026-11-15.** The starting values (0 wage, 20% burden, 30% minimum margin) stay for Bright Clean until you change them. **Still to do:** confirm or change them on the live Labor assumptions page (you save the page; that also confirms it). New company copies stay blocked from quoting until they save their own.
9. **Crew phone test.** Run `docs/CREW_PHONE_TEST.md` on one real phone with a crew member before any pilot.
10. **Route ordering address service.** Plan: keep manual ordering until phase 2. Confirm, or pick a lookup service and its cost.

## Still open from earlier (unchanged)

- **AI lead triage is down.** The Anthropic credit balance is too low. Add credits in Anthropic billing.
- **GROK BOT lead key** sent five leads on 2026-11-13 and is still active. Confirm the leads are real, then keep or revoke the key.
- **QC-1001 and QC-1002 are overdue.** Approve the corrective-cleaning visits, and approve the customer reply for QC-1001. QC-1002 is linked to a ZZ TEST customer and needs the real customer.
- **Two customers left Active on purpose:** "Eric Moore" (info@compass.com) and "Cutler Construction". Set them Inactive?
- **Microsoft 365 inbox** needs an app registration on your Microsoft account.
- **Overdue follow-ups:** "Call back Danielle Kelly" (due Nov 11) is done (see below). "Call back TEST" (due Nov 5) was a test record and was closed on 2026-11-19 with the other test records.
- **Automated follow-up email to a customer.** On Nov 11 the system emailed josh.wallace@robinsmorton.com a follow-up on the Terrell proposal ($291,652.56). The proposal follow-up rule is on in Settings. Keep it on, or turn it off?
- **Danielle Kelly calls. DONE 2026-11-19 (owner approved).** The overdue "Call back Danielle Kelly" task (FUP-1012) is marked Resolved. The call-back request on lead #49 ("Daniel Sailee", number 515-778-5860) is cleared, so automatic callbacks to that number have stopped. Whether it is the same person as Danielle Kelly is still unconfirmed.
- **Blueprint upload limit.** The Goldfinch Lofts drawing set is 128 MB; uploads are capped at 30 MB. Split the PDF into sets, or approve raising the cap for drawings.
- **Window access.** Confirm with the architect whether exterior glass is done from ladders or a lift.
- **Onboarding gate (employees).** New employees added from 2026-11-16 and anyone whose checklist has started cannot be assigned until required items are done. Confirm the rule, and confirm with counsel which items the background check applies to.
- **ADP payroll file.** Send the company code, the file-number format, and whether you run RUN or Workforce Now.

## Done since the last list (2026-11-15)

- Insurance directory with expiry badges and 30-day expiry emails to the owner.
- Overtime (1.5x past 40 hours a week) in the quote labor model.
- Extra-visit billing in the monthly bill run, blank price by default.
- Price book import from Bright Clean's prices is off unless explicitly enabled.
- Quote gate for new company copies until labor and margins are saved.
- Operator console (read-only) with a registry, health and build checks, and alerts.
- Company setup script: settings, checklist, and an optional registry entry.
- Public status page at /status.html.
- Decisions recorded in the software plan: pilot path, pilot offer, value prices, support budget, route ordering manual until phase 2, consolidated billing in phase 2.

## Verify after the next deploy

- Insurance page: add a test certificate, see the badge, then remove it (use a test record first).
- Extra-visit billing: leave the price blank and confirm nothing extra is billed.
- Status page at /status.html shows "All systems running".

## Competitive gaps (from the business plan)

1. **Direct QuickBooks Online sync.** Needs an Intuit developer account and an app review. Until then, import the CSV files into QuickBooks and test with the bookkeeper first.
2. **Payroll provider.** Choose the payroll provider the first customers use.
3. **Reviews and references.** Ask each pilot company for a reference and a review after its first month. Approve the wording first.

## From the 2026-11-18 audit

Source: `docs/audit/13-15-portal-security-infra.md`. Items 1 to 4 need your access or a decision. Items 5 and 6 are known risks that are accepted for now.

1. **External uptime monitor (F-15.5, must fix before launch).** Create a free external monitor (for example UptimeRobot) that checks `https://brightclean.net/api/health` every five minutes, and alerts you by text or a second email address that is not the one the app sends from. The app's own alerts are email-only and go silent if SMTP fails. The health endpoint returns 503 when the database check fails, but it does not report a stale backup, so the monitor will not notice a missed backup. Add a check on the backup age in the monitor if the provider allows it, or check the `backup-offsite` rows in System health each morning until then.
2. **Test one alert end to end (F-15.5).** Force a failure you can see (for example, pause the monitor's target in a test copy, or let the monitor fire once on a test URL), confirm the alert reaches your phone or second inbox, and write the date in the notes of this item. Do not send test email to customers.
3. **Confirm the Render restart and deploy settings (F-15.7, F-15.9).** In the Render dashboard, confirm what Render does when the health check fails on a running instance, and whether `autoDeploy` should stay on. Note the answers here. Do not change the blueprint without a rollback test on a staging service.
   - **Answer from Render's public docs (checked 2026-11-19, not yet confirmed in the dashboard):** a running instance that fails checks for 15 seconds stops receiving traffic while other healthy instances keep serving; after 60 consecutive seconds of failure Render restarts it. Health check passes on a 2xx or 3xx response within 5 seconds. For a new deploy that keeps failing for 15 minutes, Render cancels the deploy, keeps the old version running, and marks the deploy failed. Sources: https://render.com/docs/health-checks and https://render.com/articles/how-render-handles-deploy-failures.md. One Render community thread and one Render article report that a failing deploy still went live, so check the service's Events log after the next deploy before relying on this.
   - **Rollback:** https://render.com/docs/rollbacks says rollback reuses the target deploy's build, start command, health check path and environment variables, and does not revert the database or disk data. A third-party guide says rollback turns auto-deploy off, which is not confirmed here; check the dashboard before any rollback.
   - **autoDeploy:** leave on. Changing the blueprint needs a rollback test on a staging service first.
   - **Read in the Render dashboard on 2026-11-21:** Auto-Deploy is "On Commit" (left on). Health check path is `/api/health`. The Events log shows every deploy from 2026-11-20 14:31 to 2026-11-21 01:37 as "started" then "live"; none failed. The live build is `257d109` at that point. Render's own docs (above) still describe the failed-deploy behaviour; no failed deploy has been seen to confirm it.
4. **Owner-run restore drill (F-15.3, must fix before launch).** Follow `docs/RESTORE_RUNBOOK.md` on a separate instance with a recent real B2 backup, then fill in the results log in that file. The decrypt and integrity checks in older notes do not count as a drill. The drill is not passed until the results log says so.
5. **Customers that share one email (F-13.4). CLOSED 2026-11-19.** Checked on the live system: 111 customers and every contact, no email belongs to more than one customer record, and the duplicate-review queue is empty. Nothing to merge. The portal rule (refuse sign-in when an email matches more than one customer record) stays in place for any future duplicate.
6. **Known risk, not fixed: the admin sign-in token is kept in the browser's `localStorage` (F-14, `public/admin/admin.js`).** Any script injected into the admin page could read it. Mitigations in place: an 8-hour token with a revocation list, two-step sign-in required for owners and managers, and a script policy that reports violations (enforcement is still off, item 7). **Review of every `innerHTML` assignment in the admin page (F-14.12) is done (2026-11-19).** All 287 `innerHTML` / `insertAdjacentHTML` / `document.write` lines in `public/admin/admin.js` were checked. Values from the server or from users were already escaped, or come from a helper that escapes, or are numbers, money amounts or fixed labels. One line was changed: the staff initials on the issue list (`renderIssues`, `public/admin/admin.js` line 4619) now go through `esc()`. No server, styling or script-policy changes. Your part: sign out on shared computers and use a private browser profile for admin work. Moving the token to an HTTP-only cookie is a larger change and is not part of this item.
7. **Script content security policy stays report-only (F-14.7a).** Enforcement is not on, because nothing in this environment can load the pages in a real browser to prove no page breaks. Check on 2026-11-19 (read-only, from `/api/admin/system-health`): the browser reported 4 inline-script blocks on the home page (last 2026-11-17), 1 on the admin page (2026-11-05), and 3 wasm-eval blocks on the admin page (last 2026-11-19). The server HTML has no executable inline script, and the public JavaScript creates no inline scripts (the only dynamic script is the Twilio phone SDK, loaded from an external URL with an integrity check). So the source of these reports is not yet known; browser extensions are a likely cause but unproven. The source of the wasm-eval reports is also not traced. Enforcement must stay off until these are traced in a clean browser profile with the developer console open. Static checks found no executable inline script or inline event handler in the public or admin pages. The only inline `<script>` elements are JSON-LD data blocks, which browsers do not run. Turn enforcement on (`CSP_ENFORCE_SCRIPTS=1` in Render) only after you open the admin, the portal, a proposal link, the crew page and a service page in a browser with the developer console open and see no "Refused to execute" messages, then check `/api/admin/system-health` for reports.

## From the 2026-11-22 work-queue review

1. **Maintenance records (decision needed).** Equipment and facility upkeep (vans, vacuums, machines with service dates) can join the work queue once records exist. Reply "build" or "leave out". Nothing is built until you choose.
2. **Test records on the live site (decided: keep).** The "Eric Moore test" conversation stays. Nothing is deleted. The "TEST - Waco Place final clean (options)" proposal is still open for a decision: keep it or remove it yourself.
3. **Proposal visibility (decision needed).** Proposals show on the queue to everyone who can open it, with names and projects but no prices. Invoices are owner and manager only. Reply "keep" or "restrict proposals too".
4. **Live AI call-extract error (open).** `/api/admin/ai/calls/extract` returned HTTP 502 on the live site. It predates this work and has not been diagnosed. Check the Render logs for that route, or ask for it to be looked at.
5. **Staff and inspector sign-in checks (done 2026-11-22, local).** Role refusals pass on the local test server. An inspector could not finish two-step sign-in; fixed in `ddf4215` (roles.js). Live was checked for build fingerprint only. Create one real inspector test account on live yourself, sign in once, and confirm it works.

## Recheck, 2026-11-22 (after the last deploy, build 419607acf14a)

1. **New proposal price options (deployed in c329e5b).** A new proposal now shows Price options and saves them with the proposal. Check on live: open New proposal, add an option with two lines, save, reopen the proposal and confirm the breakdown. The save path is checked on the server only, not clicked through in a browser yet.
2. **Inspector account (not created).** Create ericd567@icloud.com with role Inspector in Settings → Users & Access. You type the password. Then tell me so I can confirm sign-in.
3. **Still open decisions:** maintenance records (build or leave out), proposal visibility (keep or restrict), and whether to remove the "TEST - Waco Place" proposal on live.
4. **Not clicked through in a browser yet:** estimate assign and follow-up buttons on the work queue, and conversation actions. Their rules are covered by the test suite, but not the buttons.

## Status, 2026-11-22 (build f248a79be125 live)

1. **Inspector account (created by owner).** ericd567@icloud.com, role Inspector, is on the live list. Owner to sign in once and confirm quality opens and invoices are refused.
2. **AI extract error: cause found.** The Anthropic account has no credit left ("credit balance is too low"). Add credits under Plans & Billing in Anthropic. The app code is fine.
3. **TEST - Waco Place proposal removed from live (id 17).** Hard delete, owner request.
4. **Proposals on the work queue are owner and manager only**, like invoices. Sales staff no longer see the proposal queue. Say if sales should keep it.
5. **Maintenance records built.** Add the first vans, vacuums and machines under Maintenance on the work queue (Add equipment). Mark each one serviced when done; the next due date moves on by its interval.
6. **Decision for you:** a customer text that still needs a reply stays under "Needs reply" even after someone clicks Waiting. The follow-up date is kept. Say if Waiting should move it out of "Needs reply".
7. **Browser-checked on the local test site:** proposal assign, follow-up date and waiting; conversation assign, follow-up date, waiting, close and reopen; maintenance add and mark serviced.

## Update, 2026-11-22 (build 000715d0b2b7 live)

- **Waiting on a customer text (decided: yes).** Waiting moves the conversation out of Needs reply, into Waiting. A new message from the customer after the wait was set brings it back to Needs reply.
- **New estimate price options.** The Price options box now sits above "What the customer sees", so it is easy to find on a new proposal. If the page looks old, do a hard refresh (Ctrl+Shift+R).

## Production readiness list, 2026-11-22 (build a2fb7f11c5ed live)

Checked: full server test chain (passes), admin UI tests 94/94, undefined-name check on all backend and front-end scripts (clean), every admin screen loads on live with no script errors, live health shows no errors in the last hour, no TODO or FIXME markers in the code. Test calls (9) and test sent emails (26) are closed on live.

Owner decisions and actions still needed:
1. Inspector sign-in: sign in once with ericd567@icloud.com and confirm quality opens and invoices are refused.
2. Anthropic credits: add credits under Plans & Billing. This clears the AI extract error and the "Bright Clean error: http 502" alert emails.
3. Maintenance: send the real vans, vacuums and machines with service intervals, and they go on the list.
4. Open real work (not closed, needs your decision): 168 overdue leads, 52 calls, 353 sent emails awaiting a reply (19 days old at most). Say which to close, and whether closing leads should mark them lost.
5. Twilio support ticket #30436964 is open in the browser. Check whether it is still needed.
6. From the security audit (see items above): the uptime monitor, the restore drill and the script policy stay as listed in this file.

## Money and access fixes, 2026-11-23 (build 95f69a3761dd live)

Fixed and live: card payments include sales tax; sales and supervisor no longer see invoice, payment, collected or outstanding figures, or project costs; only owner and manager can hand a project to billing; invoices with payments cannot be voided; one balance rule (tax and credit notes) across Command Center, reminders, overdue list and AI summary; drafts no longer block each other's send; a project bills only what is left on its contract; monthly repeats keep the day; a failed issue follow-up no longer hangs; a waiver is saved only after the email goes out; a bad invoice amount is refused. The admin page shows a Reload banner when a newer version is live (reload each open tab once after this update).

Owner actions:
1. Sign in as owner once, then try to save an invoice amount of "abc" or a negative number. It should be refused with a clear message.
2. Confirm which account ericd567@icloud.com is. The owner list above names it as the inspector account, but it signs in with the sales role now. Say which role it should have.
3. The sales test account (ericd567@icloud.com, sales role) stays as it is for now. Say when you want it removed.

## Decisions taken (best option), 2026-11-23

- Major dependency upgrades (Express 5, multer 2, better-sqlite3 13, jsdom 31, dotenv 18, bcryptjs 3, express-rate-limit 8): stay on current versions for now. Planned separately with a full test pass.
- Overdue leads, calls and sent emails awaiting a reply: left open. Nothing closed without the owner.
- Twilio support ticket #30436964: kept open.
- Account ericd567@icloud.com: recommended role is Inspector. Waiting for the owner to confirm before the live role is changed.
