# BUILDINTEL: verification, architecture cross-check, and what is needed from the owner

Status as of the latest commit on `claude/buildintel-launch-requirements-i9bmnu`.

**Bottom line:** the software core is built and checked. It is **not** 100% of the blueprint. Launch
stays NO-GO until the owner inputs in section 3 are provided and the gaps in section 4 are either built or
explicitly accepted.

---

## 1. Verification performed

| Check | Result |
|---|---|
| Syntax check of every JavaScript file | 27 of 27 pass (run twice, once before and once after the final edits) |
| Every JSON file parses | Pass |
| Full test suite, five consecutive runs | 57 of 57 pass, every run |
| Browser test, owner console on one origin | Sign-in, tenant creation, rate-card refusal and save, GC verification, dashboard cycle, queue approval: pass, no page errors |
| Browser test, console and API on separate origins | Sign-in and dashboard over CORS: pass, no CSP or CORS errors |
| Production-like run of the Docker image layout | Health, readiness, console, config, CORS preflight: pass |
| Dockerfile copy paths | All exist |
| Render disk mount matches the paths the Dockerfile sets | Yes (`/var/data`) |
| Environment-variable names: code, Dockerfile, render.yaml | Consistent |
| README route table against the routes the server registers | 22 of 22 documented |
| Stale test counts in docs | Found and fixed |

**Defects found by this check and fixed:**

1. `/api/admin/queue` returned 500. It read tenant bids with no org scope, which the store correctly refuses.
   Now uses the explicit cross-tenant read. Regression test added.
2. One failing bid dispatch aborted the whole autopilot cycle, skipping other permits and tenants. Now each
   permit is isolated, the error is stored on the opportunity, and the cycle finishes. Test added.
3. Owner actions were recorded in the audit log as the tenant. They now record `owner`. Tenant actions record
   `user:<id>`. Test added. (A bad edit briefly broke the tenant branch; the test caught the regression once
   a test was written against the real pipeline.)
4. Two admin routes were missing from the README. Added.
5. README and launch doc had stale test counts. Replaced with a pointer to `npm test`.

## 2. Control-by-control evidence

| Control (blueprint requirement) | Where it is enforced | Test that proves it |
|---|---|---|
| Scraping, login, CAPTCHA and paywall bypass refused | `src/ingest/sources.js` `BLOCKED_METHODS`, `sourceCollectable` | `sources-permits.test.js`: "scraping and bypass methods are always refused" |
| Source runs only with reviewed terms and commercial reuse | `src/ingest/sources.js` `sourceCollectable` | "a source without reviewed terms or commercial reuse is blocked" |
| No production source is authorised yet | `data/sources.json` | "the shipped registry authorises no production source yet" |
| Sample data is demo-only | `src/config.js` `allowSampleData`, `src/ingest/sources.js` | "sample data is blocked outside demo mode" |
| Invalid permits never enter the store | `src/domain/permits.js` `validatePermitRecord` | "syncing the demo fixture stores valid records and rejects broken ones" |
| Every permit keeps its source link and confidence | `src/domain/permits.js` `normalizePermit` | "normalised permits keep their source link, confidence and sample flag" |
| Estimates are deterministic and hand-checked | `src/domain/estimating.js` `estimate` | "hand-calculated estimate matches exactly" (1,413.87) |
| Missing or invalid rates are refused, not assumed | `src/domain/estimating.js`, `src/service.js` `setPricing` | "a missing rate is refused rather than assumed"; API test for invalid inputs |
| No rate card, no price | `src/autopilot.js` `processOpportunity` | "without rate cards nothing is priced" |
| Tenant data scoped by org | `src/store.js` `_requireScope`, `list` | "the store refuses cross-tenant reads"; HTTP cross-tenant test |
| Cross-tenant write and read returns 404 | `src/server.js` `requireOrg`, `src/service.js` | "an organisation key only sees its own data" |
| API keys hashed; shown once | `src/service.js` `createOrg`, `findOrgByApiKey` | "the API key is shown once and only its hash is stored" |
| Template placeholders cannot become a tenant | `src/service.js` `createOrg` | "an organisation built from the unfilled template is refused" |
| Bid state machine; no skipped states | `src/domain/bids.js` `transitionBid` | Bid state tests (approval needs a proposal; no skipping; terminal states) |
| "Sent" needs a provider receipt | `src/domain/bids.js`, `src/service.js` `dispatchBid` | "live mode fails the bid when the provider returns no receipt" |
| Approved bid cannot jump to failed | `src/domain/bids.js` `TRANSITIONS` | "a bid cannot skip approval, and approved cannot jump to failed" |
| Only verified or source-confirmed GCs receive bids | `src/domain/compliance.js` `checkOutbound`, `src/autopilot.js` `pickRecipient` | "suppressed, opted-out, unverified and probable recipients are all blocked" |
| No invented GC or contact | `src/autopilot.js` `pickRecipient` | "without a verified GC contact no recipient is invented" |
| CAN-SPAM: postal address, unsubscribe, no fake reply subjects | `src/domain/compliance.js` | "marketing email without an unsubscribe link is blocked, and fake reply subjects are refused" |
| Opt-out honoured platform-wide, immediately | `src/service.js` `unsubscribe` | "an unsubscribe immediately blocks bids to that address across tenants"; HTTP unsubscribe test |
| Unsubscribe links need a valid HMAC token | `src/server.js` `/api/unsubscribe` | "unsubscribe requires a valid HMAC token and then blocks the address" |
| Proposal content escaped; no-award disclaimer | `src/domain/proposal.js` | "proposal HTML escapes project names and carries the no-guarantee disclaimer" |
| Bids above the limit, unconfirmed permits, and new GCs need the owner | `src/autopilot.js` `processOpportunity` | "a bid above the auto-approval limit waits for the owner" |
| Dry run never marks anything sent | `src/service.js` `dispatchBid` | "full cycle ... never claims a send" |
| Live mode refuses to start without a provider | `src/transport.js` `createTransport` | "live send mode with no provider adapter refuses to start" |
| Autopilot isolates failures per permit | `src/autopilot.js` `runCycle` | "a failing bid dispatch is isolated" |
| Re-running a cycle creates no duplicates | `src/autopilot.js` `runCycle` | "re-running the cycle does not duplicate opportunities or bids" |
| Audit trail names the real actor | `src/server.js` `req.actor` | "audit entries name the real actor" |
| Go-live gates computed, not assumed | `src/readiness.js` `evaluateReadiness` | "the go-live gate reports NO-GO until every owner input is provided" |
| Owner-entered facts persist across redeploys | `src/config.js` `BUILDINTEL_READINESS_FILE` | "owner readiness inputs can live on the persistent disk" |
| CORS limited to the configured console origin | `src/server.js` `applyCors` | "CORS allows only the configured console origin and answers preflight" |
| Console cannot run inline scripts | `src/server.js` `STATIC_FILES`, `public/` | "the owner console is served with a strict content security policy" |
| Static files are whitelisted | `src/server.js` `STATIC_FILES` | "only whitelisted static files are served" (includes traversal attempts) |
| Netlify build refuses an empty or non-https API address | `scripts/netlify-build.js` | Checked by hand: empty and http both exit 1 |

## 3. What is needed from you

Each item says what it unblocks. Items marked **Launch** are required before any real bid is sent.

### A. Company and legal (Launch)
- [ ] Legal entity name for BUILDINTEL and its state of formation.
- [ ] Confirmation that BUILDINTEL stays separate from Bright Clean's cleaning operations (I assumed yes).
- [ ] Attorney engaged. Written approval of the policy library in the blueprint, with the approver's name and date.
      → fills `policiesApprovedBy` and `policiesApprovedAt` in `data/readiness.json` (or the disk copy).
- [ ] Counsel's decision on whether Iowa Chapter 715D applies. The sources I checked disagree on the threshold.
- [ ] Trademark search on the BUILDINTEL name and domain.
- [ ] Insurance: broker engaged, and the date cyber and professional liability are bound.
      → `insuranceBoundAt`.
- [ ] Named security and privacy contact (required by your owner checklist).
- [ ] Decision on pricing tiers ($99 / $249 / $499). Not implemented in software yet.

### B. Bright Clean tenant (needed for the pilot)
- [ ] Legal name, business email, and street address (street, city, state, ZIP). Used on bids and CAN-SPAM footers.
- [ ] Service territories: which states and cities. Blueprint suggests Des Moines, West Des Moines, Ankeny (IA) and Dallas (TX).
- [ ] Project types you want (blueprint: office, retail, warehouse, multifamily, school, institutional).
- [ ] Minimum square footage per bid.
- [ ] Services offered and the rate card for each, with these fields:
      `productionRate` (sq ft per labor hour), `laborRate`, `burdenPct`, `supervisionPct`, `overheadPct`,
      `marginPct`, `materialsPerSqFt`, `equipmentPerDay`, `days`, `travelFee`, `minimumBid`, and optional `projectTypes`.
- [ ] Auto-approval limit in dollars. Suggested starting value: 1,000.
- [ ] GC contacts you already work with, each with the source you verified them from.
      The system will not add contacts itself.

### C. Data sources (Launch, one at a time)
- [ ] First city or agency to authorise. Recommendation: one city.
- [ ] Its terms of use, reviewed by you or counsel, including whether commercial reuse and resale are allowed.
      → set `termsReviewedBy`, `commercialReusePermitted`, `termsUrl`, `contact`, `retentionDays` in `data/sources.json`.
- [ ] Any credentials the source requires. Share through your secret store only, never in chat or in git.
- [ ] Adapter for that source. **Not built yet.** I will build it once the access method is confirmed as an official API or bulk file.
- [ ] SAM.gov (optional, only if you bid federal work): entity registration and UEI.

### D. Accounts and hosting
- [ ] Netlify site created from this repo and branch, with `BUILDINTEL_API_URL` set. Send me the site URL.
- [ ] Render service created from `render.yaml`. Send me the service URL.
      Keep the generated admin key from Render's Environment tab. It is your sign-in.
- [ ] Set `BUILDINTEL_CORS_ORIGINS` on Render to the Netlify URL, then redeploy.
- [ ] Optional: custom domains. A custom API domain also needs the Netlify CSP updated (`netlify.toml`).
- [ ] Backup restore test: copy the data file, start a second instance on the copy, check `GET /api/bids`.
      Then record the date as `backupRestoreTestedAt`.
- [ ] Penetration test: vendor and date → `penetrationTestAt`. Required before launch.

### E. Email (Launch)
- [ ] Email provider chosen (for example SES, Postmark, or SendGrid) and an account.
- [ ] Sending domain with SPF, DKIM, and DMARC records you control.
      → I then build the provider adapter and you set `BUILDINTEL_SEND_MODE=live` and `emailProviderConnected: true`.
      Until then, bids stay in dry-run previews, which is safe.

### F. Payments (Launch, for subscriptions only)
- [ ] Payment processor account (Stripe or equivalent) and its onboarding status. Billing is not built.

## 4. Gaps against the blueprint (not built)

| Blueprint requirement | Status | What closes it |
|---|---|---|
| Permit collectors for real municipal and county sources | **Not built.** Only the synthetic demo runs. | Per-source adapter after terms review (section 3C) |
| SAM.gov opportunities | **Not built** | Official API adapter after registration |
| Live email send | **Not built.** Refuses to start in live mode. | Provider adapter (section 3E) |
| Delivered and opened states | **Not built.** Need provider webhooks. | Webhook endpoint plus signature check |
| Bid portals for GCs | **Not built** | Per-portal integration, only where the portal permits it |
| PDF proposals and attachments | **Not built.** Proposals are HTML. | Server-side PDF engine |
| E-signature and ESIGN consent records | **Not built** | E-signature provider, consent capture |
| Subscriptions, billing, and tiers | **Not built** | Payment processor (section 3F) and pricing decisions |
| User accounts, roles (RBAC), MFA | **Partial.** Two access levels only: owner admin key and per-tenant key. No per-user roles and no MFA. | Identity provider with MFA, then per-user roles |
| API rate limits (blueprint section 10) | **Not built** | Add per-key rate limiting before opening access beyond the owner |
| Privacy request center (access, deletion, correction, export) | **Not built** | Workflow in the owner console and API |
| Policy library published and accepted in-app | **Documented, not in-app.** The policy list is in the launch doc. Documents not yet written. | Attorney drafts, then publish with acceptance records |
| Marketing campaigns | **Not built.** The compliance rules for them are built and tested. | Only after counsel signs off on marketing |
| Database (PostgreSQL) with row-level isolation | **Not built.** JSON file store, isolation enforced in code. | Migration behind the same store interface |
| Error monitoring, uptime monitoring, automated backups | **Not built.** Render health check only. | Monitoring service, scheduled backups |
| Independent penetration test, SOC 2 readiness | **Not done** | Vendor engagement (section 3D) |

## 5. How to re-check this yourself

```bash
npm test                 # full suite; should show 0 failures
node src/cli.js readiness   # go-live gates; exit code 2 means NO-GO
```

The owner console, once deployed, shows the same gates on its dashboard.
