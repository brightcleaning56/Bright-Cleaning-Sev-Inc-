# Marketing & Growth — implementation status

Branch: `feature/marketing-module`, created from `0ba0471` (the commit live origin was at when this work started).
Not pushed. Live build (`claude/bright-cleaning-rebuild-nt1y6e`) is unchanged.

## Baseline finding
The handoff's `Integrated Source` ZIP and its `BASELINE_BRIGHTCLEAN_SOURCE.zip` are an older snapshot of the app.
They lack about 40 files that are live (expense review, receipt reading, crew receipts, recurring bills and their tests),
and `expenses.js` differs by about 785 lines. Do not build from them. Build from `0ba0471`.

## Status by gate (from `00_DEVELOPER_EXECUTION_ORDER.md`)

| Gate | Status | What is true now |
|---|---|---|
| 0 Baseline | Done | Branch from `0ba0471`. Full suite passes before and after. |
| 1 Data model | Done (additive) | `marketing-schema.sql` creates 7 `marketing_*` tables. No existing table is changed. `marketing_events.lead_id` is `ON DELETE SET NULL` so audit events survive a lead delete. |
| 2 Backend | Done for the MVP routes | Owner/manager/staff rules in `server.js` `ROLE_RULES`. Input validated server-side. Spend import is all-or-nothing and idempotent. Audit rows written. |
| 3 Intake attribution | Partial | Wired: public bid form (`/api/bids`) and contact form (`/api/inquiries`). First touch is kept, latest touch moves, every touch is appended. Declined consent records nothing. Duplicate-review path does not attach (by design). **Not wired:** phone intake (`calls2.js`), external lead webhook (`integrations.js`), customer portal request (`portal.js`). |
| 4 Lifecycle feedback | Partial | Wired: `contract_created` (create-contract route), `payment_received` (manual payment and Stripe). Joins resolve lead through estimate → contract → project → invoice. Unresolved chains are stored with no lead and shown only to the owner. **Not wired:** estimate created/sent/approved, proposal declined, lead lost/qualified, project completed, invoice issued, refund. |
| 5 UI | Partial | 12 screens in the nav. 6 are wired to the API (dashboard, campaigns, attribution, content, ROI spend and leads, settings). 6 say **Not built yet** and show no numbers (studio, keywords, publishing, Google Ads, Meta Ads, local SEO). The demo-data fallback is removed. Uses the cookie session and CSRF header. **Not done:** a nav link from the admin shell (the page is at `/admin/marketing`). |
| 6 Providers | Not started | No OAuth, no sync, no publishing, no webhooks. Needs owner-side app approvals first. |
| 7 Finance / ROI | Not started | Revenue, cash, direct cost and gross profit are not reconciled. The UI and API say so. Needs an Accounting definition sign-off. |
| 8 Release | Not started | No staging deploy, no user acceptance, no rollback drill for this module. |

## Verified (local, real server on a temporary database)
- `tests/marketing-test.js`: 22/22. Covers owner/manager/staff access, the status and budget rules, public-form attribution (first and latest touch, declined consent, malformed input), spend import (idempotent, refuses partial batches), lifecycle joins and duplicate delivery, lead-delete behaviour, and that the public events endpoint is gone.
- Full `npm test`: exit 0 (321/321 in `run-tests.js`, plus the chained suites, including the new marketing suite).
- `tests/ai-test.js` 22/22, `tests/ui-tests.js` 101/101.
- Browser, local only: all 12 screens render with no JavaScript errors, using fixture data injected in the page. The public contact form gets the attribution hidden field from a campaign URL.
- Not verified in a browser: a real signed-in admin session on the marketing page. Owner and manager accounts require MFA, and I did not enroll MFA on the test server.

## Decisions the owner or counsel must make
1. **Consent and tracking.** Attribution uses UTM parameters and a campaign ID from the page URL. No click IDs (gclid, fbclid) are read or stored. Visitors with Do Not Track are not tracked. Whether a consent banner is required, and what it covers, needs counsel. The server records `consent_state='unknown'` until a consent source exists.
2. **Retention.** Attribution and touchpoints are deleted with the lead (`ON DELETE CASCADE`). Lifecycle events are kept with no lead. A retention period for touchpoints has not been set.
3. **"Qualified lead".** Defined as a lead status of Site Walkthrough, Proposal in Progress, Proposal Sent or Won. Confirm before reporting it.
4. **Attribution model.** First touch is shown on reports; latest touch is kept alongside it. Attribution window is not yet set.
5. **Revenue and profit definitions.** Accounting owns these. Nothing is reported until they are signed off.
6. **Activation.** Activating a campaign changes only Bright Clean's internal status. No ad account is touched, because no provider is connected.

## Known limits in this build
- A visitor's first touch in an earlier session is kept only in that browser's session storage. A lead created in a later session gets the touch from the page it was submitted on, unless the first touch was in the same session.
- The marketing page is served only to signed-in admins. A signed-out visitor sees a plain 401 page, not a sign-in redirect.
- The owner-only spend import needs provider record IDs, so spend can only be entered from exports that include them.

## Deployment and rollback
- Deploy to staging first. Run the migration on a copy of the production database and check lead, estimate, contract, invoice and ledger counts are unchanged.
- The migration only creates new tables. Rollback: revert the commit and drop the `marketing_*` tables. No existing data is changed, and no existing table is altered.
- Per the notes in this repo, Render deploys from `claude/bright-cleaning-rebuild-nt1y6e`. Confirm the Render branch setting before pushing this branch.
