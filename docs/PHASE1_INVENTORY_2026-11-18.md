# Phase One: application inventory (2026-11-18)

Scope: read-only inventory from the source code on `claude/bright-cleaning-rebuild-nt1y6e` (HEAD at the time of writing) and the live site. No production changes were made for this inventory.

Status labels follow the master directive: WORKING (verified end to end), PARTIALLY WORKING, BROKEN, NOT IMPLEMENTED, NOT CONNECTED, UNVERIFIED. Items marked UNVERIFIED have been read in code only.

## Deployment

- Live site: https://brightclean.net, build `8d05e74d6e67` at last check (health OK, 0 errors in the last hour).
- Source: GitHub `brightcleaning56/Bright-Cleaning-Sev-Inc-`, branch `claude/bright-cleaning-rebuild-nt1y6e`. Render deploys on push.
- Staging environment: NOT IMPLEMENTED. `render-staging.yaml` exists but the staging service has not been created (owner action).
- Backend: Node.js / Express. Database: SQLite (better-sqlite3), one file.
- Application size: 64 server-side JavaScript modules, 421 API routes (counted from `app.get/post/put/patch/delete`), 81 tables (`CREATE TABLE`), 15 modules with scheduled loops (`setInterval`).

## Integrations (code present; live connection UNVERIFIED unless noted)

| Integration | Used for | Status |
|---|---|---|
| Postmark | Outbound email (invoice PDFs, proposals, reminders) | PARTIALLY WORKING: sends and now passes attachments; sender domain not authenticated (no DKIM, SPF lacks Postmark), so Microsoft 365 shows the external-sender caution banner |
| Microsoft 365 (Graph) | Inbox sync | NOT CONNECTED (owner app registration not done) |
| Twilio | Calls, SMS, AI receptionist | UNVERIFIED live; code present |
| Anthropic | AI lead triage, reply drafts, call notes, takeoffs | NOT CONNECTED (credit balance was too low per owner list) |
| Stripe | Online payments and webhooks | UNVERIFIED live; webhook signature verified with synthetic events |
| Backblaze B2 | Encrypted offsite backups | PARTIALLY WORKING: upload recorded as verified in `docs/AUDIT_BASELINE.md`; restore drill decrypted on the server only |
| QuickBooks, ADP | Exports | Files only; no live sync (NOT IMPLEMENTED as a sync) |

## Portals

### Administrative portal (`public/admin/`)
- Command Center, Today's Work, Leads, Customers, Issues & Tasks, Calls, Email Center, Client messages, Estimates & Proposals, Contracts, Projects, Invoices, Subscriptions, Schedule, Quality & Inspections, Drawings & Documents, Takeoffs, Cleaning scopes, Website photos & video, Activity log, Insurance, Reports & Analytics, Settings.
- Recent work: Command Center, Leads, Invoices, Projects, Contracts and the other listed screens restyled to the mockup. Reports tables verified on live with data.
- Status: most screens PARTIALLY WORKING. Workflow tests passed for intake, lead assignment, estimate approval hold, projects and dispatch, Crew Portal check-in, and closeout. Money path blocked in the local end-to-end test when no email provider is configured (see `docs/audit/workflow-end-to-end.md`).

### Customer portal (`public/portal.html`, `public/assets/portal.js`, `portal.js`)
- Sign-in by email link or password; one customer record per session after the shared-email fix.
- Modules present in code: contracts, invoices, projects, visits, inspections, messages, documents, account.
- Status: PARTIALLY WORKING. Message isolation tested. Other modules UNVERIFIED for cross-customer access.

### Crew portal (`public/crew.html`, `public/assets/crew-page.js`, `sched.js`)
- Sign-in by phone or email with PIN; sessions 7 days; revoked on PIN reset or deactivation.
- Check-in and check-out with device time within a sane window; break buttons; photos with offline queue; incidents.
- Status: PARTIALLY WORKING. Field actions refused on cancelled or done jobs. Phone tests (offline photos, GPS check-in, breaks, On my way) still owner-run.

## Messaging (critical, from the directive)

Four separate stores carry messages today. They are not one conversation system.

| Store | Written by | Read by | Who sees it |
|---|---|---|---|
| `portal_messages`, `portal_message_replies` | `portal.js` | `portal.js`, `clientmsgs.js` | Customer portal and office Client messages |
| `crew_messages` | `sched.js` (crew and office messages) | `sched.js` only | Crew portal and the office crew-messages screen (`/api/admin/crew-messages`) |
| `sms_messages` | `clientmsgs.js`, `followups.js` | `clientmsgs.js`, `comms.js`, `followups.js` | Office |
| `inbox_messages`, `email_log` | Mail sync and send paths | Many modules | Email Center |

Finding (verified in code): a crew-to-office message is stored in `crew_messages`, which is not part of the customer conversation system. A customer message is stored in `portal_messages`. There is no shared conversation record with participants, customer, property, project and employee links, so the directive's requirement for one authoritative messaging record is NOT IMPLEMENTED. Status: NOT IMPLEMENTED as a shared system; each path PARTIALLY WORKING on its own.

## Scheduled and background work

- 15 modules run timers (`setInterval`): `ai.js`, `autobid.js`, `calls2.js`, `command.js`, `complaints.js`, `followups.js`, `insurance.js`, `issues.js`, `leadclass.js`, `m365.js`, `ops.js`, `pm.js`, `reports2.js`, `sched.js`.
- No event queue, dead-letter handling or idempotency keys exist for cross-portal events (NOT IMPLEMENTED per the directive's Phase Five D).
- Automated customer-facing actions (follow-up texts, callbacks, AI information requests) are off by default as of this audit.

## Security (summary, from `docs/audit/13-15-portal-security-infra.md`)

- Role policy table in `roles.js`; owner, manager, sales, supervisor, staff and inspector roles exist.
- Upload checks are content-signature only; no malware scanning (NOT IMPLEMENTED).
- Content Security Policy for scripts is report-only in production.
- Admin token stored in browser `localStorage` (known risk).
- Sign-out now stops API calls (`c0a43b2`), confirmed on live with a real sign-out.

## Infrastructure and recovery

- Monitoring: in-app error recording with owner email; `/api/health` for uptime. External uptime monitor NOT created (owner action).
- Backups: daily local backup; encrypted; offsite to B2 recorded as verified. Restore into a separate instance NOT DONE (owner-run drill).
- Rollback: NOT DOCUMENTED beyond Render's previous-deploy option (owner to confirm).

## What this inventory does not establish

- Live behaviour of Twilio, Postmark (beyond the header problem), Microsoft 365, Stripe, Anthropic and B2 under real traffic.
- Cross-portal workflow tests on live data (not run; they would create records on the live system).
- Mobile behaviour of customer and crew portals beyond the screens already checked.

## Decisions still needed before Phase Two repairs

1. Create the staging environment (owner action; `render-staging.yaml`).
2. Approve the shared messaging design (one conversation record across customer, crew and office) as the first repair.
3. Approve test-data creation in staging only.
