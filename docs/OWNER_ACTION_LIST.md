# Owner action list

Items that need the owner before the system can move forward. Everything else is built and tested locally and listed in git history.
Last updated: 2026-11-15.

## Needs your decision or access (new, from the software plan)

1. **Operator console: create the Render service.** Use New > Blueprint with `render-operator.yaml`, then enter its secrets (`OPS_ADMIN_EMAIL`, `OPS_PASSWORD_HASH`, `OPS_TOTP_SECRET`, `OPS_ALERT_EMAIL`, `FROM_EMAIL`, `POSTMARK_TOKEN`). Send the address back so it can be checked. Until then the operator console is not running.
2. **Test company copy (Test Cleaning Co).** Create it with `render-staging.yaml` under a new service name, and enter its settings from its `env.txt`. The dry run passed locally; this is the first real check on a separate copy.
3. **Extra-visit price.** Set the price per visit above a subscription's monthly allowance, or leave it blank so nothing is billed extra. The plan has no figure. Extra visits count every non-cancelled visit for the customer in the month.
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
- **Overdue follow-ups:** "Call back Danielle Kelly" (due Nov 11) and "Call back TEST" (due Nov 5). Mark done, or tell me what to do.
- **Automated follow-up email to a customer.** On Nov 11 the system emailed josh.wallace@robinsmorton.com a follow-up on the Terrell proposal ($291,652.56). The proposal follow-up rule is on in Settings. Keep it on, or turn it off?
- **Danielle Kelly calls.** About 10 outbound "missed call, call back" attempts since Nov 4, plus an overdue callback task. Her number (515-778-5860) is also listed under "Daniel Sailee". Confirm whether these are the same person, and whether the automatic callbacks should stop.
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
   - **Still to confirm:** the dashboard's Events log on the next deploy, and the health check path set to `/api/health` (already read on 2026-11-19).
4. **Owner-run restore drill (F-15.3, must fix before launch).** Follow `docs/RESTORE_RUNBOOK.md` on a separate instance with a recent real B2 backup, then fill in the results log in that file. The decrypt and integrity checks in older notes do not count as a drill. The drill is not passed until the results log says so.
5. **Customers that share one email (F-13.4). CLOSED 2026-11-19.** Checked on the live system: 111 customers and every contact, no email belongs to more than one customer record, and the duplicate-review queue is empty. Nothing to merge. The portal rule (refuse sign-in when an email matches more than one customer record) stays in place for any future duplicate.
6. **Known risk, not fixed: the admin sign-in token is kept in the browser's `localStorage` (F-14, `public/admin/admin.js`).** Any script injected into the admin page could read it. Mitigations in place: an 8-hour token with a revocation list, two-step sign-in required for owners and managers, and a script policy that reports violations (enforcement is still off, item 7). **Review of every `innerHTML` assignment in the admin page (F-14.12) is done (2026-11-19).** All 287 `innerHTML` / `insertAdjacentHTML` / `document.write` lines in `public/admin/admin.js` were checked. Values from the server or from users were already escaped, or come from a helper that escapes, or are numbers, money amounts or fixed labels. One line was changed: the staff initials on the issue list (`renderIssues`, `public/admin/admin.js` line 4619) now go through `esc()`. No server, styling or script-policy changes. Your part: sign out on shared computers and use a private browser profile for admin work. Moving the token to an HTTP-only cookie is a larger change and is not part of this item.
7. **Script content security policy stays report-only (F-14.7a).** Enforcement is not on, because nothing in this environment can load the pages in a real browser to prove no page breaks. Check on 2026-11-19 (read-only, from `/api/admin/system-health`): the browser reported 4 inline-script blocks on the home page (last 2026-11-17), 1 on the admin page (2026-11-05), and 3 wasm-eval blocks on the admin page (last 2026-11-19). The server HTML has no executable inline script, and the public JavaScript creates no inline scripts (the only dynamic script is the Twilio phone SDK, loaded from an external URL with an integrity check). So the source of these reports is not yet known; browser extensions are a likely cause but unproven. The source of the wasm-eval reports is also not traced. Enforcement must stay off until these are traced in a clean browser profile with the developer console open. Static checks found no executable inline script or inline event handler in the public or admin pages. The only inline `<script>` elements are JSON-LD data blocks, which browsers do not run. Turn enforcement on (`CSP_ENFORCE_SCRIPTS=1` in Render) only after you open the admin, the portal, a proposal link, the crew page and a service page in a browser with the developer console open and see no "Refused to execute" messages, then check `/api/admin/system-health` for reports.
