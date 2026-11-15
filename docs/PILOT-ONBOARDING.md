# Pilot onboarding: two or three general contractors and their subcontractors

Purpose: learn whether a real GC and its subcontractors use the bid flow end to end, and record every point of friction.
No payment is taken. Each company is set up by hand. Do not invite anyone outside the pilot.

## Before the first company (owner)
- [ ] Postmark connected and the sending domain verified. Without it, confirmation and invitation emails only get logged.
- [ ] Render variables set: `OWNER_EMAIL`, `OWNER_PASSWORD`, `BACKUP_KEY`, `BASE_URL`. A second copy of `BACKUP_KEY` is kept outside Render.
- [ ] Restore drill run on a copy of a real backup (`scripts/restore-drill.mjs`).
- [ ] Pricing shown on the website is marked "proposed until confirmed"; no pilot company is quoted a price.
- [ ] Choose the pilot: two or three GCs with real projects in the next 60 days, and their subcontractors (at least four per trade).

## Per general contractor (day 1)
1. Sign up as a general contractor. Confirm the email.
2. Staff verify the company: request, documents (licence, registration, insurance certificate) and a decision with a note. Verification is recorded in the review history.
3. Build the first project in the three-step wizard. Set the bid dates, trade packages and insurance minimums.
4. Publish. Confirm the bid breadth panel shows invited companies, and the command center shows the project.

## Per subcontractor (day 1–2)
1. Sign up, confirm, and set trades and service area. The company is invited automatically when a matching package opens.
2. Add certificates (general liability, workers comp) on the Insurance screen or from the bid form.
3. Open the invitation, acknowledge addenda, mark intent, and send a bid. Revise once to check the revision history.
4. Countersign the award contract when one is issued.

## Each week of the pilot
- Read the portfolio view: open packages, bids received, awards, and anything under "Needs attention".
- Read Super Admin: audit log, failed emails in the outbox, and any support request.
- Ask each company one question per screen: where did you stop, what did you expect, what did you do instead.

## Record for every friction point
| Date | Company | Screen | What happened | Expected | Severity (blocks / slows / cosmetic) |
|---|---|---|---|---|---|

## Stop conditions (pause the pilot if any happens)
- A bid, award or signature is lost or shows the wrong amount.
- A subcontractor receives another company's data or document.
- Emails stop arriving for more than a day.
- A company asks to pay before the pricing is confirmed.

## Exit criteria (after four weeks)
- Every pilot GC has published at least one project and awarded at least one package through the platform.
- Every subcontractor that was invited has seen the invitation, and at least half have bid.
- No stop condition has happened, or each one was fixed and re-tested.
- The friction log is reviewed and each blocking item has a ticket or a decision.
