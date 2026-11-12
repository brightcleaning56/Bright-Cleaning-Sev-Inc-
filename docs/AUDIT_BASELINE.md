# Bright Clean Operations Platform: Audit Baseline (Day 1 of 5)

Status: first pass. Feature development is paused until the team reviews this baseline.
Build reviewed: live `249b021fc274`; repository branch `claude/bright-cleaning-rebuild-nt1y6e` at `1cf23bb` (+ later push).

## 1. Inventory (counted from the code)
- Server modules: 45 JavaScript files.
- API routes: about 336 route definitions.
- Database tables: 62 (SQLite). Includes customers, leads, estimates, contracts, projects, invoices, payments, calls, employees, time entries, visits, inspections, quality complaints, portal messages, email log, audit log, automation log.
- Scheduled jobs (setInterval): 9 modules. Include the callback sweep (every 5 minutes), automation and backups (hourly), inbox sync, reports, and complaint checks.
- Test files: 8 (run-tests, ui-tests, portal-test, payments-test, ai-test, postmark-test, plus helpers).

## 2. Verified this session (evidence, not screens)
| Area | Evidence | Result |
|---|---|---|
| Server functional suite | `tests/run-tests.js` on Node 22, re-run on `eaff103` (2026-11-11) | 224/224 pass |
| Test environment | SQLite native module restored for Node 22 after a stray `npm` install removed it | Fixed |
| Admin UI suite | `tests/ui-tests.js` | 83/83 pass |
| Client portal backend | `tests/portal-test.js` | 78/78 pass |
| Payments | `tests/payments-test.js` (no real charges) | 10/10 pass |
| AI layer | `tests/ai-test.js` (fake API) | 17/17 pass |
| Automatic callbacks | Live test call to a flagged lead, call placed and answered, transfer confirmed by owner | Verified once (2026-11-10) |
| Off-site backup | Live backup uploaded to Backblaze; size matches; encrypted header confirmed | Verified (2026-11-11) |
| Owner alerts on backup failure | Code written and tested locally; not triggered live | Not verified live |
| Recording notice for browser calls | Automated test checks the notice is in the call flow; not heard on a live call | Partly verified |
| No-answer follow-up task | Automated test checks the response; a task is created in code; no live call yet | Partly verified |
| Restore drill | 2026-11-12: `brightclean-20261111-131507.db.enc` decrypted on the Render server with the production key; `integrity_check` = ok; 134 leads, 45 calls, 80 customers | Passed |

## 3. Known defects and blockers
| ID | Severity | Item | Owner | Status |
|---|---|---|---|---|
| D1 | High | AI lead triage fails: Anthropic credit balance too low | Owner (billing) | Open |
| D2 | High | Restore drill (decrypt and check data) | Owner + dev | Closed 2026-11-12: passed on the server |
| D3 | High | Live checks for recording notice and no-answer task not done | Owner (phone) | Open |
| D4 | Medium | Owner alert emails not triggered live | Dev | Open |
| D5 | Medium | Secrets exposed in screenshots during the Backblaze key work (old keys deleted; clipboard cleared) | Owner | Closed for keys; confirm no other exposure |
| D6 | Medium | GitHub sign-in on the dev machine expired; pushes needed owner sign-in | Owner | Resolved for this push |
| D7 | Low | Uncommitted and untracked files in the working tree (package-lock.json changed; test result files, tools/ folder, BUILD_MANIFEST.json) | Dev | Open |
| D8 | Low | Docs out of date (PRODUCTION_RUNBOOK.md, AUTOMATION_GAP_REGISTER.md still describe earlier builds) | Dev | Open |
| D9 | Medium | Settings "Automatic callbacks" card only appears on Phone & Communication tab (noted, not a bug) | Dev | Documented |

## 4. Module status (provisional)
Status key: **Verified** = tested with real data and a real action; **Partial** = works in part or only in tests; **Unverified** = present in code, not tested this session; **Not built** = no implementation found.

| Module (from directive) | Status | Notes |
|---|---|---|
| Command Center | Unverified | Present; renders |
| Today's Work | Partial | Server work-queue tests pass; behaviour for reschedule/recurrence not re-verified |
| Leads and CRM | Partial | Leads list and drawer work; "callback requested" flag must be set by hand |
| Customers and Properties | Unverified | Tables present |
| Issues and Tasks | Partial | Follow-up tasks are created into this list by code; not seen live |
| Calls and AI Receptionist | Partial | Outbound and automatic callbacks verified once; AI reception not re-tested |
| Email Center | Partial | Email configured; delivery not re-tested this session |
| Client Messages | Unverified | Portal messages tables present |
| Estimates and Proposals | Unverified | Estimating tests not re-run against real records |
| Drawings and Documents | Unverified | |
| Takeoffs | Unverified | |
| Contracts | Unverified | Contract workspace not reviewed this session |
| Projects | Unverified | |
| Subscriptions | Unverified | |
| Scheduling | Unverified | |
| Employees and Workforce | Partial | Time entries and visits tables exist; no end-to-end test |
| Quality and Inspections | Unverified | Inspection and complaint tables exist |
| Invoices and Payments | Partial | Payments suite passes with fake gateway; real payment processor not connected |
| Reports and Analytics | Unverified | |
| Customer Portal | Partial | Backend suite passes (78/78); full proposal and contract viewing not verified in browser |
| Account Settings and MFA | Partial | Owner/manager two-step sign-in works |
| AI Assistant and Automation | Partial | Suite passes with fake API; live AI blocked by credits (D1) |
| Website and Customer Intake | Partial | Forms covered by tests; live submissions not re-run this session |

## 5. Integration status (provisional)
| Integration | Status |
|---|---|
| Phone service (Twilio) | Live and verified (calls, callbacks, transfer) |
| Email delivery (Microsoft 365 SMTP) | Configured; delivery not re-verified this session |
| AI receptionist and AI assistant (Anthropic) | Configured; blocked by credits |
| File storage (Render disk) | Live |
| Database backup (local) | Live and verified |
| Off-site backup (Backblaze B2) | Live and verified (upload); restore not yet verified |
| Monitoring and alerts | Health endpoint live; owner alert code added, not yet triggered |
| Payment processor | Mock/test only (no real processor connected) |
| Electronic signatures | Not implemented |
| Accounting | Not implemented |
| SMS | Not implemented |
| Microsoft 365 inbound mail | Configured; not re-verified this session |

## 6. Readiness (provisional)
Not scored yet. The directive requires a full audit before a score is meaningful. Based on what is verified above, the core intake, call, backup and test foundation is in place. Payments, e-signature, accounting, workforce and most module workflows are not yet verified end to end.

## 7. Required before the Day-5 report
1. Run the full business workflow (website inquiry to payment to reporting) with staging records and record the evidence.
2. Complete the restore drill (D2) and the live checks (D3).
3. Fix the AI credits (D1), or record the outage as accepted for launch.
4. Clean the working tree and update the runbook (D7, D8).
5. Score each module against the status key above with test evidence.
