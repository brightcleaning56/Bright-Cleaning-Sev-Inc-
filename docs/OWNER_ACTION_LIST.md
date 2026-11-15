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
7. **Pricing per company. Approved 2026-11-15.** Each company enters its own pricebook, labor rates and margins. Bright Clean’s prices are never copied into another company. **Still to do for Bright Clean:** price or archive the unpriced items on the live Cleaning scopes page. This needs you to sign in to the live site; I can’t do it without your sign-in.
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
