# BUILDINTEL production readiness: status against the remediation directive

**Overall status: NO-GO.** Nothing in this report is marked passed unless evidence is listed.
Legend: **Done** = built and tested here. **Partial** = built, but a required part is missing.
**Blocked** = needs a person or account outside this environment. **Not started** = not yet built.

## A. Tenant onboarding
| Requirement | Status | Evidence / gap | Owner |
|---|---|---|---|
| Bright Clean created and active | Blocked | Needs legal name, business email, street address. Template refuses placeholders. | Owner |
| Legal name and postal address validated | Done (format only) | `createOrg` validation; tests in `server.test.js`. Legal correctness is not verified. | Owner / counsel |
| Dry-run autopilot enabled | Partial | Autopilot works in dry run (`autopilot.test.js`). Not enabled on the live tenant because it doesn't exist yet. | Me, after tenant exists |
| Tenant-specific services, coverage, settings | Partial | Territories, project types, minimum size, services list exist. Services are not yet enforced in matching. | Me |
| Tenant data isolation verified | Done (store and HTTP) | `server.test.js` cross-tenant tests; `autopilot.test.js` store-scope test. Not an independent test. | Pen tester (independent) |
| Administrator and employee permissions | Not started | Only two access levels exist (owner admin key, tenant key). No employee accounts, no per-user roles. | Me, after identity decision |

## B. Commercial estimating
| Requirement | Status | Evidence / gap |
|---|---|---|
| Rate-card system | Partial | Production rate, labor, burden, supervision, overhead, margin, materials, equipment, travel, minimum bid are present and validated. |
| Service name, category, unit of measure | Not started | Not in the rate card schema. |
| Contingency | Not started | Not in the rate card schema. |
| Equipment cost, travel and mobilization as separate lines | Partial | Equipment per day and a flat travel fee exist. Mobilization is not separate. |
| Effective date and version | Not started | Not stored. Changing a rate card overwrites it with no history. |
| Owner approval of every rate | Blocked | Requires your approval of Bright Clean's actual rates. No rates have been entered, so no pricing is active. |

Next step: add the missing fields (service name and category, unit, contingency, mobilization, effective date, version, approval record) and keep history, so changes can be audited. I can do this now.

## C. Permit data authorization
| Requirement | Status | Evidence / gap |
|---|---|---|
| Three legitimate initial municipal sources | Blocked | Registry lists three entries. None is authorized: terms unreviewed, no contact, no confirmed commercial reuse. |
| Source terms and commercial reuse recorded | Partial | Fields exist in `data/sources.json`. Values are not filled in. |
| Licenses or agreements obtained | Blocked | Requires contact with each agency or your counsel. |
| Connected and synchronization tested | Partial | Sync and error handling are tested with synthetic data only (`sources-permits.test.js`). No real source has been connected. |
| Deduplication | Done | `permitDedupeKey` tests. |
| Source links and timestamps preserved | Done | `normalizePermit` tests. |
| Permit accuracy verified | Not started | No real data exists to verify. |
| Unauthorized collection disabled | Done | Scraping and bypass methods refused in code (`BLOCKED_METHODS`); no source runs without reviewed terms. |

## D. Email and bid distribution
| Requirement | Status | Evidence / gap |
|---|---|---|
| Production email provider connected | Partial | Postmark adapter built and tested with stubbed HTTP (`transport.test.js`). Not connected: needs your Postmark account and token. |
| Domain authentication (SPF, DKIM, DMARC) verified | Blocked | Needs DNS access to your sending domain. Not checkable from here. |
| Sending, delivery, bounce, reply processing | Partial | Sending path built. No delivery webhooks, bounce handling, or reply processing. |
| Unsubscribe and suppression enforced | Done | `unsubscribe` and `checkOutbound` tests. Marketing sends aren't built. |
| Live distribution disabled until approved | Done | Dry run is the default; live mode refuses to start without a provider and token. |
| Human approval for initial submissions | Partial | Bids above the limit or on unconfirmed permits need approval. No setting forces approval for every first bid. |
| Sent proposals and delivery evidence preserved | Partial | Receipts and history are stored. Delivery evidence needs webhooks. |

## E. Payments
| Requirement | Status |
|---|---|
| Processor connected, subscription plans, checkout, renewals, failed payments, cancellations, refunds, webhook signatures, permission updates | **Not started.** No payment code exists. Plans and prices are not approved. |

## F. Legal and compliance
| Requirement | Status | Owner |
|---|---|---|
| Attorney review of all policies | Blocked | Attorney |
| Public-records and commercial reuse review | Blocked | Attorney, after you pick sources |
| Privacy and data processing requirements | Not started | Attorney |
| Privacy rights requests (access, deletion, correction) | Not started | Me, after counsel's requirements |
| Commercial email compliance | Partial | Built in code; counsel must confirm |
| Retention and deletion rules | Not started | Counsel; I can implement once set |
| Incident response procedures | Not started | Owner and counsel |
| Insurance bound | Blocked | Broker |

## G. Security and reliability
| Requirement | Status | Evidence / gap |
|---|---|---|
| Independent penetration test | Blocked | An independent vendor must do this. I can't count my own tests as independent. |
| Critical and high findings fixed | Not started | No independent findings yet. |
| Tenant isolation tested | Done (own tests) | Same as A. |
| Administrator permissions tested | Not started | Depends on A. |
| File access controls tested | Not started | No file upload feature exists yet, so there is nothing to test. |
| Encrypted backups | Not started | Backups are not automated and not encrypted. The data file lives on a Render disk. |
| Successful restoration test | Partial | Done on test data: file restore with matching SHA-256 (see below). Not yet done on the live Render disk. |
| Recovery procedures tested | Partial | Restore procedure is documented in `docs/OWNER_CHECKLIST.md`. |
| Production error and failed-job monitoring | Not started | No monitoring service connected. Failed autopilot jobs are stored, not alerted. |

### Restore test evidence
Run on seeded test data, 2026-11-01:
- Primary store digest: `d2e68e91c3519bc1004bc716cff465dc8f5680d3e31773d327d30f82bdd2914d`
- Restored store digest: `d2e68e91c3519bc1004bc716cff465dc8f5680d3e31773d327d30f82bdd2914d`
- Match: yes. Counts restored: orgs 1, contacts 1, audit 2.

This shows that copying the data file and loading it back gives identical data. It does not show that the live Render disk is backed up, and it doesn't test encryption.

## Required developer reports
| Report | Status |
|---|---|
| Production readiness report | This document (status only; not a sign-off) |
| Page-by-page QA report | Not started. Browser checks cover the main flows only. |
| API and integration test report | Partial. Test suite: 70 passing, all local with stubs. No live integration test. |
| Permit source authorization report | Blocked (see C) |
| Permit data accuracy report | Not started (no real data) |
| Contractor verification report | Not started |
| Estimating calculation report | Partial. Hand-checked calculation test only. |
| Bid submission verification report | Partial. Dry run only. |
| Security and penetration testing report | Blocked (independent vendor) |
| Tenant isolation report | Partial (own tests) |
| Backup restoration report | Partial (see evidence above) |
| Legal and compliance checklist | Blocked (attorney) |
| Final launch authorization report | Blocked. Requires a signed approval; not something I can sign. |

## Release restrictions, as they apply now
- Live autopilot sending: **off**. Send mode is `dry_run`.
- Sample permits in production: **off**. `BUILDINTEL_ALLOW_SAMPLE` is 0.
- Unapproved pricing: **none active**. No rate cards have been entered.
- Bid submission claims: none made. Sent status requires a provider receipt.
- Backup restoration: described as tested on test data only.
- Legal approval: **not claimed**.
- Penetration testing: **not claimed**.

## Remaining blockers (owner or outside party)
1. Attorney review and written approval of the policy library.
2. Authorized sources: three agency contacts, reviewed terms, written commercial-reuse permission.
3. Bright Clean legal name, email, address, rates, and auto-approval limit, approved by you.
4. Postmark account and token, plus DNS records (SPF, DKIM, DMARC) for your sending domain.
5. Payment processor account and approved subscription prices.
6. Insurance broker: bound policy dates.
7. Independent penetration test vendor and report.
8. Named security and privacy contact.

## Work I can do without those inputs (next)
- Extend the rate card with the missing fields, including version history and an approval record.
- Build the subscription data model and permission checks (not payment processing).
- Build retention and deletion jobs with a configurable retention window.
- Build privacy-request endpoints (access, export, deletion) for tenant contacts.
- Add automated, encrypted backups of the data file, with a restore test that runs on a schedule.
- Add an admin-visible failed-jobs view.

The platform stays NO-GO until every mandatory gate passes with evidence.
