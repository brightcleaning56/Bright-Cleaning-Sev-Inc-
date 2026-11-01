# BUILDINTEL: Can it go live in 24 hours?

## Short answer

- **Public live (real customers, real bids sent, real money): No.** Several gates have lead times
  measured in days or weeks: attorney review, source terms review, email domain setup, payment
  processor onboarding, insurance binding, and an independent penetration test. None of these can be
  compressed into 24 hours without skipping the controls the platform exists to enforce.
- **Live internal pilot for Bright Clean in 24 hours: Yes**, in **dry-run send mode**. The platform
  runs, the autopilot matches and prices permits from authorized sources, drafts proposals, queues
  bids for owner approval, and writes exact previews of every bid. Nothing is sent and no bid is
  ever marked sent without a provider receipt.

This document is the honest version of "go live." The software gates in `src/readiness.js` report
GO only when all twelve gates pass. Today it reports NO-GO, and that is the correct result.

## What "no employees" can and cannot mean

The goal is a system that runs without staff. Most of the work can be automated:

| Work | Automated by | Human needed? |
|---|---|---|
| Pulling permits from authorized sources on a schedule | `syncAllSources` in `src/autopilot.js` | No |
| Rejecting incomplete or invalid permit records | `validatePermitRecord` | No |
| Matching permits to each tenant's territory and project types | `matchPermit` | No |
| Pricing from the tenant's own rate cards (never invented rates) | `estimate`, `selectRateCard` | Owner enters rates once |
| Drafting proposals with disclaimers and escaped content | `renderProposal` | No |
| Auto-approving low-value, verified, unambiguous bids under a limit | `runCycle` policy | Owner sets the limit |
| Blocking sends to opted-out, unverified or probable contacts | `checkOutbound` | No |
| Honouring unsubscribes immediately, across tenants | `unsubscribe` | No |
| Keeping a full audit trail | `audit` | No |

Some decisions cannot be automated, and the software should not pretend they can:

- Approving the legal policy library (requires an attorney).
- Verifying that a GC contact is real (requires a source or the owner's confirmation).
- Approving bids above the auto-approval limit, on unconfirmed permits, or on new GC relationships.
- Setting prices and minimum margins.
- Responding to privacy requests, disputes and awards.

The design therefore has **one owner queue** (`GET /api/admin/queue`) rather than staff. The owner
(you) is the only human in the loop, and the time you spend should be small once the rules are set.

## Gate status (run `npm run readiness` or `GET /api/readiness`)

| Gate | Status today | Lead time to close |
|---|---|---|
| Attorney-reviewed policy library approved | Owner action | 1 to 4 weeks |
| At least one authorized data source with reviewed terms | Owner action (none authorized) | 1 to 4 weeks, one per source |
| Sample/demo permits disabled | Pass | None |
| Admin key set (24+ characters) | Fail until set | 5 minutes |
| Unsubscribe signing secret set (24+ characters) | Fail until set | 5 minutes |
| Bright Clean tenant created with a real address | Fail until created | 30 minutes (fill the template) |
| Bright Clean rate cards entered | Owner action | 1 to 2 hours |
| Live email provider connected and send mode live | Owner action (no adapter built) | Provider signup and DNS: 1 to 3 days |
| Payment processor connected | Owner action | Processor review: days |
| Insurance bound | Owner action | Days to weeks via a broker |
| Backup restore tested | Fail until run | 2 hours (see runbook) |
| Independent penetration test | Owner action | 1 to 3 weeks |

## Legal and compliance notes (verified against public sources)

These are starting points for counsel, not legal advice.

- **CAN-SPAM.** The FTC guide says senders must honour an opt-out within **10 business days** and keep
  the opt-out mechanism working for at least **30 days** after the message is sent. Every commercial
  message must include a valid **physical postal address**. The platform builds these in. Opt-outs are
  processed immediately, which is safer than the 10-day allowance. Sources:
  [FTC CAN-SPAM Compliance Guide](https://webarchive.library.unt.edu/web/20130214054537/http://business.ftc.gov/documents/bus61-can-spam-act-compliance-guide-business),
  [FTC node 41978](https://www.ftc.gov/node/41978).
- **Iowa Consumer Data Protection Act (Chapter 715D).** Effective January 1, 2025. Applicability depends
  on consumer-count thresholds, and the sources I checked disagree on whether a revenue test also
  applies. **Counsel must read the statute at legis.iowa.gov and decide applicability.** Do not assume
  either reading. Sources:
  [Revision Legal](https://revisionlegal.com/internet-law/iowa-consumer-data-protection-act-part-2-business-duties/),
  [Baker Donelson Iowa guide](https://bakerdonelson.com/consumer-data-privacy-law-guide-iowa).
- **SAM.gov.** Federal registration is needed only if BUILDINTEL or Bright Clean bids directly on federal
  awards. Third-party guides put activation at roughly 3 to 10 business days after submission, with
  delays when the legal name or address does not match IRS records. The official
  entity checklist is the authority. Sources:
  [SAM.gov registration walkthrough](https://grantedai.com/learn/guides/sam-gov-registration-complete-walkthrough),
  [Crowell on SAM UEI delays](https://www.crowell.com/NewsEvents/AlertsNewsletters/all/SAM-Transition-to-UEI-Plagued-with-Registration-Processing-Delays).
- **Source licensing.** Public records are not automatically licensed for resale. The registry blocks any
  source whose terms are unreviewed or that does not confirm commercial reuse. Scraping, login bypass,
  CAPTCHA bypass and paywall bypass are refused in code (`BLOCKED_METHODS`).
- **Electronic signatures and records.** Not built yet. Proposal acceptance needs ESIGN-compliant
  consent and an audit trail before it is offered.

## Operating from the web console

The owner console at the server's root URL covers the full runbook without the command line:
sign in with the admin key, create the tenant on **New tenant**, enter rate cards and contacts on the
tenant page, run the cycle from the **Dashboard**, and approve bids in the **Approval queue**. The
readiness gates are on the dashboard. The CLI and API still work for scripting.

## 24-hour runbook

**Hours 0 to 2: Configure the host.**
1. Set `BUILDINTEL_ADMIN_KEY` and `BUILDINTEL_UNSUBSCRIBE_SECRET` (both 24+ random characters).
2. Set `BUILDINTEL_PUBLIC_URL` to the real HTTPS address and `BUILDINTEL_DATA_FILE` to a persistent,
   backed-up path. Keep `BUILDINTEL_SEND_MODE` at `dry_run`.
3. Run `npm install` (no dependencies) and `npm test`. Expect 45 passing tests.

**Hours 2 to 4: Create the Bright Clean tenant.**
1. Copy `data/examples/brightclean.org.example.json` and replace every `REPLACE` value with real details.
   The platform refuses to create a tenant while any placeholder remains.
2. Run `node src/cli.js create-org <file>`. **Save the API key shown once.**
3. Using the key, `PUT /api/me/pricing` with your rate cards (labor rate, production rate per labor hour,
   burden, supervision, overhead, margin, materials, equipment, minimum bid). Estimates are validated on save.
4. Using the key, `POST /api/contacts` for each real GC contact, then have the owner verify each one
   with `POST /api/contacts/:id/verify` (admin key), recording the source.
5. Using the key, `POST /api/me/autopilot` with `{"enabled": true, "autoApproveMaxTotal": <your limit>}`.
   Start with a low limit, such as 1000.

**Hours 4 to 6: Test the system with real data paths.**
1. `npm run readiness` should report exactly the owner-action gates you expect and no unexpected failures.
2. Run `node src/cli.js cycle` and review the report. Demo permits will not appear unless
   `BUILDINTEL_ALLOW_SAMPLE=1` is set, which is for demos only.
3. Read the previews in `data/outbox/`. Check the addresses, the total against a hand calculation,
   the disclaimer and the sender's postal address.

**Hours 6 to 8: Restore test.** Copy `data/state.json` to a new path, set
`BUILDINTEL_DATA_FILE` to the copy, start the server and confirm
`GET /api/bids` returns the same records. Record the date in `data/readiness.json` as
`backupRestoreTestedAt`.

**Hours 8 to 24: Start the internal pilot.**
1. Start the server with `BUILDINTEL_AUTOPILOT=on` and `BUILDINTEL_AUTOPILOT_INTERVAL_MIN=60`.
2. Check the owner queue (`GET /api/admin/queue`) and the audit log at least twice a day.
3. Keep the pilot in dry-run. Record approve-or-reject decisions for a week. Those decisions tell you
   whether the thresholds and rate cards are right before any real bid is sent.

**Not in the 24 hours:** enabling live sending, connecting payments, opening self-service sign-up to
other companies, or contacting real GCs by email. Each one waits for its gate.

## Known gaps (what the code does NOT do yet)

Being explicit here so nobody mistakes the pilot for the finished product:

1. **No production permit adapters.** Only the offline demo fixture runs. Each city or agency needs an
   authorized adapter built against its official API or bulk file, after terms review.
2. **No live email provider.** `createTransport` refuses live mode. Add a provider adapter (for example
   SES, Postmark or SendGrid) that returns a real acceptance id, plus SPF, DKIM and DMARC on the sending
   domain.
3. **No delivery webhooks.** Bids reach `sent` on provider acceptance, but `delivered` and `opened`
   states need webhook handling.
4. **No user accounts, MFA or sessions.** Access uses one API key per tenant and one admin key. A
   pilot with one owner is fine. Multi-user access needs real identity and MFA.
5. **File-based storage.** `data/state.json` with atomic writes suits a pilot. Production should move
   to PostgreSQL with row-level tenant isolation. The store's orgId-scoped interface is designed for that
   swap.
6. **Proposals are HTML, not PDF.** A server-side PDF engine is needed before proposals go to GCs as
   attachments.
7. **No e-signature, payments, billing or subscription management.** The $99/$249/$499 tiers from the
   blueprint are not implemented.
8. **Permit values are labelled as reported.** There is no independent validation of estimated values.
9. **No contact enrichment.** By design the system never invents a GC or an email address. The owner
   supplies verified contacts.
10. **No penetration test, no load test, no SOC 2 work.**

## Architecture and file map

```
src/
  index.js              entry point; starts the HTTP API and optional autopilot schedule
  cli.js                readiness | create-org <file> | cycle
  server.js             HTTP routes; admin key vs organisation key; error mapping
  service.js            tenant operations: orgs, profile, pricing, contacts, unsubscribe, bid dispatch
  autopilot.js          the autonomous cycle: sync -> match -> price -> draft -> approve/queue -> dispatch
  readiness.js          go-live gates computed from config and owner inputs
  transport.js          dry-run preview writer; live mode refuses until a provider adapter exists
  store.js              file-backed store; tenant collections require orgId
  config.js             environment-variable configuration
  util.js               ids, hashing, HMAC, escaping, money rounding, errors
  ingest/sources.js     source compliance gate and sync (blocks scraping and bypass methods)
  domain/
    permits.js          permit validation, dedupe key, normalisation
    estimating.js       deterministic cost-plus estimate with minimum bid
    matching.js         territory, project type, size, confidence rules
    bids.js             bid state machine (sent needs receipt; delivered needs receipt)
    compliance.js       transactional vs marketing; contact status; CAN-SPAM checks
    proposal.js         HTML proposal with escaping and no-guarantee disclaimer
data/
  sources.json          source registry (none authorised for production)
  readiness.json        owner-entered go-live facts (set only when a step is truly done)
  fixtures/             synthetic demo permits (flagged sample, demo only)
  examples/             tenant template with REPLACE placeholders
test/                   45 tests: estimating, sources and permits, bids and compliance,
                        autopilot integration, and HTTP-level tenant isolation
```

## Owner decisions still needed

1. Confirm the legal entity that will own BUILDINTEL, and whether Bright Clean's cleaning operations
   stay separate (recommended).
2. Brand, domain and trademark search before launch.
3. Rate cards, minimum margin and the auto-approval limit.
4. Which cities and sources to authorise first, after terms review (recommended first: one city,
   with the owner confirming its terms and whether bulk reuse is allowed).
5. Attorney engagement for the policy library in the blueprint, and for Iowa Chapter 715D applicability.
6. Email provider, payment processor and insurance broker selection.
7. Who is the named security and privacy contact (required by the owner checklist).
