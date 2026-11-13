# Bright Clean Operations: readiness assessment, 2026-11-12

Scope: what was checked today, what the evidence shows, and what still blocks full production use.
Build reviewed: live `58a03a164bf9`; branch `claude/bright-cleaning-rebuild-nt1y6e` at `0ca8899` (in sync with origin).

## 1. Overall verdict

**Ready for a controlled pilot. Not ready for unattended production use.**

The core intake, phone, backup and email-control foundations are tested and running. Several business processes still depend on items only the owner can do (Microsoft 365 connection, AI billing, live call checks), and several modules have never been run end to end with real records. A readiness score is not given: the audit (baseline section 6) says a score is not meaningful until every module has been run against test evidence, and that work is not done.

## 2. Automated test results (run today, against the current code)

| Suite | Checks | Result |
|---|---|---|
| Server functional (`tests/run-tests.js`) | 224 | 224 pass |
| Admin UI (`tests/ui-tests.js`) | 83 | 83 pass |
| Client portal (`tests/portal-test.js`) | 78 | 78 pass |
| Payments, fake gateway (`tests/payments-test.js`) | 10 | 10 pass |
| AI layer, fake API (`tests/ai-test.js`) | 17 | 17 pass |
| Off-site backup, fake B2 (`tests/b2-test.js`) | 5 | 5 pass |
| Email suppression (`tests/suppress-test.js`) | 9 | 9 pass |
| Email suppression routes (`tests/suppress-routes-test.js`) | 5 | 5 pass |
| Lead classification (`tests/leadclass-test.js`) | 10 | 10 pass |
| **Total** | **441** | **441 pass, 0 fail** |

Notes:
- A first background run of the server suite failed because a leftover test server still held port 3996. That was an environment fault, not a code fault. After the leftover process was stopped, the suite passed 224/224.
- These suites use temporary databases and fake services. They do not prove live behaviour with real providers.

## 3. Live checks (read-only, today)

| Check | Result |
|---|---|
| `/api/health` | OK, database OK, 0 errors in the last hour, build `58a03a164bf9` |
| Public pages (`/`, `/services.html`, `/contact.html`, `/privacy.html`, `/terms.html`, `/careers.html`, `/portal.html`, `/admin/`) | All return 200 |
| Admin APIs without sign-in (AI status, backups, email suppression, lead classification) | All return 401 |
| Latest admin script is live (email block list and lead-type panel) | Confirmed |

Not checked live (would need owner sign-in or would create real records or real emails): sending a form, placing a call, sending an email, running a backup, viewing any customer data.

## 4. What is working and verified

| Area | Evidence |
|---|---|
| Automatic callbacks | Live call placed and answered; transfer confirmed by owner (2026-11-10). A no-answer follow-up test call was planned for 2026-11-12 and is not confirmed in this review. |
| Recording notice | Owner heard it before connect on a live call (2026-11-11). |
| Off-site backup to Backblaze B2 | Live upload, size and encrypted header confirmed (2026-11-11). Owner alert code exists but has not fired live. |
| Restore drill | Production backup decrypted on the server; `integrity_check` ok; 134 leads, 45 calls, 80 customers (2026-11-12). |
| Email suppression (new) | Opt-outs, declines, replies and bounces stop automated email. Tested in code. Not yet tested with a real inbox reply. |
| Lead classification (new) | Segment, intent, contact type and permitted action assigned by rules. Tested in code and shown in the lead drawer once deployed. |
| Email Center block list (new) | Card, add and remove built and tested in the UI suite. Not seen on screen yet. |

## 5. What is missing or blocking

| # | Item | Severity | Owner or dev | Status |
|---|---|---|---|---|
| 1 | Reply tracking needs the Microsoft 365 inbox connected (app registration and sign-in). Without it, replies never reach the system. | High | Owner (Azure, Render) | Open |
| 2 | AI lead triage and reply drafts need Anthropic credits. Last known status: balance too low. Current status not checked (needs sign-in). | High | Owner (billing) | Open |
| 3 | Manager accounts (including the reviewer's staging login) must set up two-step sign-in before most pages load. | Medium | Reviewer or owner | Open |
| 4 | Automatic info-request emails still reach staff-added company inboxes. Owner chose to keep this on (2026-11-12). Job inboxes are now blocked. | Medium | Owner decision made; monitor | Accepted |
| 5 | Owner alert on a failed backup has not fired in a live test. | Medium | Dev | Open |
| 6 | No-answer callback follow-up not confirmed on a live call. | Medium | Owner (call), dev (check) | Open |
| 7 | Email Center screen for the block list and lead drawer panel not seen on screen. | Low | Dev | Open |
| 8 | Staff emails are not blocked by suppression. A person writing by hand still gets through, by design. | Low | Dev | Accepted |
| 9 | No unsubscribe link in automated email. Needs legal review first. | Medium | Owner and counsel | Open |
| 10 | Real payment processor, e-signature, accounting and SMS are not connected. | High for those modules | Owner and dev | Not built |
| 11 | Most modules (estimates, contracts, projects, scheduling, invoices in live use, quality, reports) are not verified end to end with real records. | High | Dev with owner's staging go-ahead | Open |
| 12 | External: penetration test, legal review of the brief, accessibility and mobile device testing. | High before public launch | External | Open |
| 13 | Working tree has untracked test-output files and `BUILD_MANIFEST.json`. | Low | Dev | Open |

## 6. Module status (updated)

Status key: **Verified** = tested with real data and a real action; **Partial** = works in part, or only in tests; **Unverified** = present in code, not tested this round; **Not built** = no implementation found.

| Module | Status | Change since baseline |
|---|---|---|
| Phone and automatic callbacks | Partial | Live call verified once; no-answer check pending |
| Backups and restore | Verified | Restore drill passed |
| Email control (suppression, reply stop) | Partial | New; tested in code; no live reply yet |
| Leads and lead classification | Partial | New classification; tested in code |
| Email Center | Partial | Block list added; not seen on screen |
| Inbox replies (Microsoft 365) | Not connected | Waiting on owner setup |
| AI triage and drafts | Blocked | Credits (item 2) |
| Command Center, customers, estimates, contracts, projects, subscriptions, scheduling, quality, takeoffs, drawings, reports | Unverified | No change |
| Invoices and payments | Partial | Tests pass with fake gateway; no real processor |
| Customer portal | Partial | Backend 78/78; no browser walk-through |
| Two-step sign-in | Partial | Works; needs setup for each manager |
| Website forms and intake | Partial | Tests pass; no live submission this round |

## 7. Recommended order to finish

1. Owner: connect the Microsoft 365 inbox (item 1) and add Anthropic credits (item 2).
2. Owner: complete the no-answer callback call and tell me the result (item 6).
3. Dev: run a real reply through the inbox to confirm suppression end to end, then finish the Email Center check (items 1, 7).
4. Dev with owner's go-ahead: run module-by-module workflow tests on a staging copy with dummy data (item 11).
5. External: penetration test and legal review before public launch (items 9, 12).
