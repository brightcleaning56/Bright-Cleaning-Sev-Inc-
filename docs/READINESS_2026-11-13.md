# Bright Clean Operations: production readiness, 2026-11-13

Build reviewed: origin `c6014fa`; live build `e4c07da95ae9` (the insights release is live; the test-only commits after it do not change the app).

## 1. Verdict

**Not ready for unattended production. Ready for a controlled pilot** with the owner and a small trusted team, once the owner items below are done.

Estimated time:
- **Controlled pilot:** about 1 to 2 weeks (owner items plus about 3 days of development).
- **Full production:** about 4 to 6 weeks. Most of the time is external: legal review and an outside penetration test, which can run in parallel with development.

## 2. Automated tests (run today)

| Suite | Checks | Result |
|---|---|---|
| Main server suite (`tests/run-tests.js`) | 227 | all pass |
| Admin UI (`tests/ui-tests.js`) | 83 | all pass |
| Client portal (`tests/portal-test.js`) | 78 | all pass |
| Payments, fake gateway (`tests/payments-test.js`) | 10 | all pass |
| AI layer, fake API (`tests/ai-test.js`) | 17 | all pass |
| Off-site backup, fake B2 (`tests/b2-test.js`) | 5 | all pass |
| Email suppression (`tests/suppress-test.js`, `suppress-routes-test.js`) | 14 | all pass |
| Lead classification (`tests/leadclass-test.js`) | 10 | all pass |
| Insights (`tests/insights-test.js`) | 6 | all pass |
| Windows pricing, archive, complaint history, lead alerts | 4, 9, 2, 7 | all pass |
| Workflow chain and modules | 15, 10 | all pass |

Total: 497 checks across 15 suites, all passing.

Fixed during this review: two suites were out of date with rules added earlier (the start-date rule and the new payment form). Their checks were updated; the app behaviour was correct. The main suite also had an intermittent failure caused by a background drafter racing the test; it is fixed.

**These tests use temporary databases and fake outside services. They do not prove the live integrations work.**

## 3. Security (checked in code and against the live site)

| Check | Result |
|---|---|
| Every admin API route requires sign-in, except the login (rate-limited to 8 tries per 15 minutes), the two-step code step (12 per 15 minutes), and the live event stream (one-time ticket). | Pass |
| Live: admin backups without sign-in | 401 |
| Test-only routes (`/api/test/*`) | 404 on the live site |
| Phone webhooks without a valid Twilio signature | 403 (live) |
| Public lead intake without an API key | 401 (live) |
| Payment webhook | 503 on the live site: not configured, so no online payments are possible yet |
| Secrets in tracked files | none found |
| Production dependencies (`npm audit`) | 0 vulnerabilities |
| Upload checks | file contents must match the extension; executables and PDFs with scripts are refused |
| Headers | helmet and a content security policy are in place |
| Admin session | token expires after 8 hours; two-step sign-in for owners and managers |

**Limits:** the admin token is kept in the browser's local storage. That is a common trade-off, and the page escapes user text, but it is a risk worth knowing about. No outside penetration test has been done.

## 4. Operations

| Area | Status |
|---|---|
| Hosting (Render blueprint) | Configured: Node 22, health check on `/api/health`, auto-deploy on push. Live health is OK. |
| Daily local backup | On by default |
| Off-site backup (Backblaze B2, encrypted) | Working; restore drill passed on 2026-11-12 |
| Owner alert when a backup fails | Code exists; not yet tested live |
| Error monitoring | Code exists; no outside uptime alert confirmed |
| Deploy history | Every commit on the branch is on origin and deployed |

## 5. Owner items before a pilot

1. **Connect the Microsoft 365 inbox.** Until then, customer replies never reach the system.
2. **Add Anthropic credits.** AI triage and drafts are off.
3. **Clean the live data.** Test records are in the live system: the ZZ TEST customers and proposals (including the $6,000 counted as Won), the $1,792,683.69 "house" contract marked Closed, and the Terrell contract ($291,652.56) marked Closed while its proposal is unsigned. Decide what to archive.
4. **Price or archive the 40 unpriced scope items.** Estimates that use them can be wrong.
5. **Decide the payment provider and whether proposals need a formal e-signature.** Today a customer approves by typing their name; that may be enough, but a lawyer should say so.
6. **Clear the test invoice on the ZZ TEST customer.** It is partly paid and cannot be voided, so it needs a refund or a payment to close.

## 6. Development work before a pilot (about 1 to 2 weeks)

| Item | Estimate |
|---|---|
| Server-side check that an invoice's total matches its service lines (today the app sets it, but the server trusts what it receives) | 0.5 day |
| Walk estimate to contract to project to invoice to payment on a staging copy with dummy data | 2 to 3 days |
| Browser walk-through of the customer portal and the crew page (only the back end is tested) | 1 to 2 days |
| Test the owner alert on a failed backup, and set up an outside uptime alert | 1 day |
| Email Center check on screen, then the unsubscribe link once counsel says what it must say | 1 day |

## 7. External work (can run in parallel)

| Item | Estimate |
|---|---|
| Legal review: privacy, terms, proposal and e-signature wording, consent for calls and texts, email rules, data retention | 2 to 4 weeks |
| Outside penetration test, with fixes | 2 to 4 weeks, including scheduling |
| Staff acceptance testing with real jobs | 1 to 2 weeks |

## 8. What is needed for full production

- Everything in sections 5 and 6.
- Legal review and a penetration test, with any findings fixed.
- Payment provider and e-signature decisions, implemented if chosen.
- Staff acceptance testing on real jobs with no open blocking bugs.
- A written owner runbook for backups, restores and rollbacks. The existing `PRODUCTION_RUNBOOK.md` covers the basics and should be checked against the current system.

## 9. Known product limits

- Insights need decided proposals before they say anything. Until about five per group, they show "not enough data".
- Online payments through a processor are not connected. Payments are recorded by hand.
- Phone and AI features depend on the Twilio and Anthropic accounts being funded and connected.
