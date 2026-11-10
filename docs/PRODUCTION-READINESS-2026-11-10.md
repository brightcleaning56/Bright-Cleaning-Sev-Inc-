# Production readiness, 2026-11-10 (commit 2c90e9e)

Status key: **PASS** = evidence in the repo or the release log. **FAIL** = a gap we can fix with the code we have. **BLOCKED** = needs an owner decision, an external account, or a professional review we cannot do here.

## Build and release
| Item | Status | Evidence |
|---|---|---|
| Clean install from lockfile | PASS | `release-evidence/Clean_install_(npm_ci,_lockfile).log` |
| Full automated tests, no skips | PASS | 230/230, `release-evidence/All_automated_tests_(no_failures,_no_skips).log` |
| Browser QA, core reads off and on | PASS | 16/16 each, `release-evidence/Browser_QA,_CORE_READS=*.log` |
| Dependency audit (production) | PASS | 0 vulnerabilities, `release-evidence/Dependency_security_audit.log` |
| Release evidence matches the source | PASS | `docs/RELEASE-VERIFICATION.md` (commit 2c90e9e) |
| Old evidence (Nov 5, 174 tests, from a zip) | Superseded | replaced by the evidence above |

The PDF plan-room tests that the reviewer saw failing pass here (`pdfjs-dist` and `pg` are complete in the lockfile install). The reviewer's environment was incomplete; this is recorded as an environment issue, not an application defect.

## Security (findings from the November 8 review, checked against the code)
| Finding | Status now |
|---|---|
| CSP allows `unsafe-inline` | **Partly fixed.** Pages and the app use `style-src 'self'` with no inline styles or scripts. The only exception is bid documents (`sendDocument`), which allow inline styles and no scripts, frames or forms. Tests fail if this regresses. |
| Postmark webhook secret in the URL | **Fixed.** Basic-auth header only (`webhookAuthorized`). |
| Email verification activates on GET | **Fixed.** GET shows a confirmation page; POST activates. |
| Independent penetration test | BLOCKED: needs an external firm and the owner's approval. |

## Architecture
| Item | Status | Notes |
|---|---|---|
| Database-backed reads for all screens | FAIL | Search is in PostgreSQL. About 25 readers (map, Command Center, profiles) still load records in memory. |
| Background job queue and transactional outbox | FAIL | Not built. Notifications are sent from request handlers. |
| Multi-instance scaling | BLOCKED until the two items above | `render.yaml` deliberately runs one instance. |
| Database size | FAIL (config) | `render.yaml` provisions `basic-256mb`; the production spec calls for 1 GB. Choose one and align them. |

## Workflows
| Workflow | Status | Evidence / gap |
|---|---|---|
| Discovery and permanent project records | PASS (for the covered sources) | Browser and unit tests. Coverage is per source; see the data-source row. |
| Publisher verification and owner authority | PASS | Staff review screens checked in the browser; decisions tested by API. |
| Trade packages, invitations, plan room access | PASS | QA plan-room and invitation flows. |
| Bid without sign-in (signed link) | PASS | `test/bidlink.test.js`, browser check. |
| Bid revisions with preserved receipts | PASS | Each revision creates a new submission record with a revision number. |
| Package Q&A / requests for information | PASS | Invited companies ask; the GC answers; every invited company sees the answer, not the asker (`test/rfi.test.js`, browser check). Questions close with the package. |
| Scheduled publication | PASS | A draft can be scheduled for a future time (within a year) from the publisher screen and publishes from the periodic job as the person who scheduled it; a publish that cannot happen is cleared and the reason shown on the draft (`test/scheduled.test.js`). |
| Bid due-date changes | PASS | A published package's deadline is changed as a numbered addendum with the old and new date and a required reason; every invited bidder is emailed and must acknowledge it before bidding (`test/deadline.test.js`). The publisher-screen control has no browser check yet. |
| Award and regret notifications | PASS | The winner is emailed to countersign; each other bidder is told it was not selected. A failed email never undoes the award (`test/notices.test.js`). |
| Award to contract lifecycle | PARTIAL | The award generates the contract from the winning bid (proposal, hash, buyer's signature). The provider now countersigns the same proposal with its own consent; the contract is 'fully signed' when both have signed (`test/countersign.test.js`). Amendments are not built. |
| Plan room storage, scanning, document-level permissions | FAIL / BLOCKED | Local encrypted vault only. Cloudflare R2, malware scanning and per-document permissions are not built. R2 needs an account (BLOCKED). |
| Takeoff accuracy on real sheets | BLOCKED | Needs real construction sheets and an AI provider key to test against 100 sheets. |

## Money and external services
| Item | Status | Owner action |
|---|---|---|
| Stripe subscriptions | BLOCKED | Create test account, prices and webhook. |
| Postmark email | BLOCKED | Verify the sending domain; set live mode and bounce/complaint webhooks. Dry-run until then. |
| Cloudflare R2 | BLOCKED | Create a private bucket and keys. |
| AI provider | BLOCKED | Supply a key. |
| Data-source authorization | BLOCKED | Review each source's terms and approve it. Coverage claims must stay per source. |
| Rate cards (cleaning costs) | BLOCKED | Enter real costs and approve. |
| Legal, insurance, security contact | BLOCKED | Attorney review, insurance, security contact. |

## What I would do next, in order
1. Keep the evidence current: regenerate the release evidence after every change that is going to be deployed.
2. Build the package Q&A/RFI, scheduled publication and award-notice features, which are product gaps we can close now.
3. Add contract amendments, and browser tests for award to fully signed and for answering questions as the GC.
4. Move the remaining in-memory readers to the database, then add the job queue and outbox. Only then consider more than one instance.
5. Decide the database size, then align `render.yaml` with it.

The BLOCKED items need the owner. The FAIL items are work we can do in this repo.
