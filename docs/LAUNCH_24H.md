# BUILDINTEL — 24-hour launch runbook

Goal for hour 24: the system is deployed, Bright Clean is tenant #1, the autopilot runs every hour
on real public data, prices every qualified project with Bright Clean's approved rates, writes the
proposal, and puts it in front of Eric for one-click approval. Email goes live the moment the
sending domain verifies. Everything below is owner work; the code is done.

## Hours 0–2 · Deploy
1. Push this folder to a new private GitHub repo.
2. Render → New → Blueprint → select the repo (render.yaml provisions Postgres, the web service and a
   backup disk; CI in GitHub runs all tests against Postgres on every push).
3. Set env vars: OWNER_EMAIL, OWNER_PASSWORD, BACKUP_KEY (`openssl rand -hex 32`, save a copy in
   your password manager), BASE_URL (Render URL for now).
4. Open BASE_URL, sign in. Dashboard shows NO-GO. Click "Back up and verify restore" → backup gates pass.

## Hours 2–6 · Data sources (the real bottleneck)
| Source | Path | Time to live |
|---|---|---|
| SAM.gov federal solicitations (IA, TX; janitorial NAICS 561720) | Free API key at sam.gov → Account Details. Set SAM_API_KEY. | Same day |
| Dallas Open Data permits (Socrata) | Dataset e7gq-4sah. Dallas moved permitting to DallasNow (Accela) in May 2025 — this feed may be stale. The freshness gate will tell you on the first sync. If stale, file a records request with Dallas Planning & Development for a recurring commercial permit export. | Same day to verify |
| West Des Moines | Publishes monthly permit reports (PDF). Convert commercial rows to CSV → import. | Same day |
| Des Moines, Ankeny | Email each city's permit office requesting a recurring commercial permit export (CSV). Import via API. | Days |

For each source, read its terms page and record your decision:
```
curl -XPATCH $BASE/api/sources/<id> -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"enabled":true,"authorization":{"commercialReuse":true,"redistribution":true,"reviewedBy":"Eric","reviewedAt":"2026-11-02","evidence":"terms snapshot saved to Drive: <link>"}}'
```
Your attorney confirms these within the first two weeks. Bright Clean using the data for its own
bids is the low-risk case; reselling it to other subscribers is what needs counsel sign-off.

CSV import format (header row, BUILDINTEL field names):
`permitId,address,city,state,zip,permitType,workClass,description,status,issuedDate,valuation,squareFeet,contractor,owner,sourceUrl`
```
curl -XPOST $BASE/api/sources/<id>/import -H "authorization: Bearer $T" -H 'content-type: text/csv' --data-binary @wdm-oct-2026.csv
```

## Hours 6–10 · Bright Clean pricing and insurance
0. Dashboard → Insurance & licenses → add Bright Clean's general liability certificate. Bidding stays
   paused until a current one is on file. To show it as verified on proposals, call the agent and
   record it: `POST /api/orgs/<orgId>/credentials/<id>/verify {"method":"called agent","evidence":"..."}`
1. Fill every null in `scripts/bright-clean-rates.json` with real numbers (production rate in SF per
   labor hour, wage, burden, supplies per SF, mobilization, overhead, contingency, margin, minimum).
2. Run `scripts/onboard-bright-clean.sh` (sets legal name, postal address, sender, coverage, activates).
3. Dashboard → Pricing → Approve. Nothing is estimated until you approve.

## Fastest path to real revenue: the buyer portal (live the day you deploy)
GCs and property managers sign up at your URL ("Request cleaning bids"), post a project with square
footage, services and a due date, and Bright Clean's autopilot prices it and submits a proposal into
their inbox within the hour. They asked for bids, so there is no cold email and no DNS wait. Property
managers get recurring janitorial priced per visit × visits per month. They click Award; Bright
Clean's bid moves to won automatically.
Until platform email is live, verify new buyers yourself: `POST /api/orgs/<id>/verify`.
Send your existing GC and property-manager relationships the link today.

## Hours 10–14 · GC directory (what makes it autonomous)
Permits name contractors, not estimators' emails. The autopilot only emails contacts with evidence.
Enter the 25–40 GCs that build commercial in DSM metro and Dallas once: company + the bid/estimating
address they publish on their own site (subcontractor or prequalification page), with that page as
evidenceUrl. One afternoon, then it compounds.
```
POST /api/companies {"name":"Weitz Company","website":"https://...","evidenceUrl":"https://..."}
POST /api/contacts  {"companyId":"...","name":"Estimating","role":"Estimating","email":"bids@...","status":"source_confirmed","evidenceUrl":"https://.../subcontractors"}
```
Faster: bulk import a spreadsheet (bad rows are reported, never half-saved):
```
company,website,companyEvidenceUrl,contactName,role,email,phone,status,evidenceUrl
curl -XPOST $BASE/api/directory/import -H "authorization: Bearer $T" -H 'content-type: text/csv' --data-binary @gcs.csv
```
Dashboard → "Add GCs next" ranks contractors on qualified permits that have no contact yet, by the bid
value waiting on them. Adding a contact automatically puts those projects back in the queue.

## Hours 10–24 · Email (runs in parallel; DNS is the wait)
1. Postmark account → add sender domain → add the DKIM and Return-Path DNS records it gives you.
2. Add DMARC: TXT `_dmarc` → `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com`
3. When Postmark shows the domain verified: set POSTMARK_TOKEN, POSTMARK_WEBHOOK_SECRET,
   EMAIL_DOMAIN_VERIFIED=true, EMAIL_MODE=live. Add webhook BASE_URL/webhooks/postmark?token=…
   for Delivery, Bounce, Spam Complaint, Subscription Change.
4. PATCH /api/org {"settings":{"liveSending":true}}. Approved bids now send on the next cycle.
5. Replies: in Postmark, create an inbound stream, set INBOUND_REPLY_ADDRESS to its address and the
   inbound webhook to BASE_URL/webhooks/postmark-inbound?token=…  GC replies attach to the right bid,
   show on the Bids tab, and stop the follow-up. "Remove me" replies suppress the sender.
6. Follow-up: one polite follow-up goes out 5 days after a bid with no reply (settings.followUpDays).

## Hour 24 state
Autopilot hourly: collect → dedupe → classify → score → estimate → proposal → you approve → send →
delivery tracking → suppression. Daily encrypted backup with automatic restore verification.

## Going hands-off (after ~10 bids you've reviewed)
PATCH /api/org {"settings":{"autoApprove":{"enabled":true,"maxTotal":5000,"minScore":90}}}
Bids under $5,000 scoring 90+ then go out without you. Raise the ceiling as win data comes in.

## Not 24-hour items (gates stay OWNER until done, and that is correct)
Attorney review · cyber + tech E&O insurance · independent pen test (before selling to other
subscribers) · Stripe (only needed once a second company pays) · named security contact.
Set the ATTEST_* env vars only with real evidence.
