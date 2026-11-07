# Automated test inventory

**174 tests.** Generated from the test files. Run: `npm test` (set TEST_DATABASE_URL for the Postgres tests).

## admin-phase3.test.js (5)
- phase 3 permission matrix: every new route × every platform role; company users always denied
- workflow 7: likely duplicates found; merge preview; merge needs step-up; package and bid untouched; old id resolves
- workflow 8: corrections keep the original value and never touch source permits; status changes need a reason
- workflow 9: bid oversight shows originals (amount, time, receipt) and has no way to change them
- workflow 10: revoking access kills a link issued earlier; restore works; quarantine blocks everyone

## admin-phase4.test.js (5)
- phase 4 permission matrix: every new route × every platform role; company users denied
- workflow 11: manual plan changes grant access but never a payment state; revenue stays unavailable
- data sources: unreviewed terms cannot run; resume → retry pulls real records → import history → resync archives
- workflow 13 (partial): AI limits can only lower the plan allowance, and the analyzer enforces them; cost/accuracy stay unavailable
- MFA: enroll with a real code; sign-in and step-up need it; wrong and reused codes refused; reset signs the user out

## admin.test.js (8)
- permission matrix: every admin route × every platform role, plus company users; deny by default, denials audited
- workflow 1: role grants need step-up; reviewers cannot grant roles; only an owner grants platform owner
- workflow 2: request more information → company resubmits → approve; status and audit history persist
- workflows 3 + 5: suspension revokes sessions and blocks the company; reactivation restores it; session revocation works
- workflow 6: project-specific authority is approved separately from company verification
- workflow 15 + redaction: auditors search but cannot change the audit log; no password ever lands in it
- pagination and dashboard: limit capped, sort allow-listed, numbers match records, unavailable metrics say why
- audit search runs in PostgreSQL: filters by action, actor, target, request id; paginates; newest first

## ai.test.js (6)
- coordinates: negative longitudes are kept (regression: every US longitude was dropped)
- command center: real counts only, territory-scoped; map returns one point per located site
- AI analyzer: off without a key, says exactly what to do
- AI analyzer: only printed areas survive, every item keeps its sheet, starts unverified, can be confirmed
- AI analyzer: no access to plan rooms you are not invited to; daily limit; bad model output handled
- accuracy scoring: recall, exact printed areas, and invented areas counted against the model

## autopilot.test.js (8)
- full cycle in dry-run: collect → qualify → estimate → draft → approve → preview, never marked sent
- auto-approve rule approves only within owner limits
- live sending: sent only with a provider MessageID; webhooks drive delivery, bounce and suppression
- live sending: provider error marks bid failed, not sent; missing postal address blocks sending
- source failures are recorded, not swallowed
- SAM.gov adapter maps federal solicitations with deadlines and source links
- backup: encrypted, restorable with matching checksum; tampering detected
- readiness: fresh deployment is NO-GO and every gate carries evidence + an owner

## backup-docs.test.js (6)
- document vault: encrypted at rest, incremental, detects corrupted and missing files
- vault verification: every record needs its file; files must decrypt to a PDF with the recorded fingerprint
- disaster drill: lose the server disk, restore database + drawings, every drawing byte-identical
- off-site signing matches the AWS published Signature V4 example
- off-site sync: uploads the newest database backup and new document blobs only, signed
- database TLS: verified by default over the internet; opt-out is explicit; private network has no TLS

## core-reads.test.js (8)
- switch off: unchanged (permit ids, address grouping); switch on: same projects, permanent ids, anchor permits
- profile by project id: permits of the project (not just the address), core phases, anchor; old permit links still work
- parity detects splits; still OK because no permit is lost
- anchor permit is stable: a larger permit joining later does not move tracking or estimates
- planning-only project: profile from the core record; following needs a permit (clear message)
- map and command center count projects when on, sites when off
- GC picks the project: confirmed link even when the address differs; state and existence checked
- anchor order does not depend on the clock: links made in the same millisecond keep creation order

## core.test.js (8)
- tenant isolation: tenant collections require orgId and block cross-org access
- permits: normalize never invents values; residential skipped; dedupe updates
- estimating: hand-checked numbers, minimum price, refusal without quantity or approval
- rate cards: members cannot approve; new approval retires prior version
- bid state machine rejects illegal transitions and records history
- contacts: no invented recipients; unverified and suppressed are excluded; personal data refused
- sources: nothing collects until terms are reviewed; scraping refused
- csv parser handles quotes, commas and CRLF

## enrichment.test.js (10)
- license sync: looks up only names on permits, in one batched query, prefers the active license, records misses
- license shows on project contacts and contractor pages; phone only with contact access
- Legistar: keeps land-use items only, links to the official record
- stage changes: alert wording shows from → to; tracked projects notify once per change
- freshness: every result carries when it was last checked against the city record
- license matching: short names, punctuation and suffixes match; two different active companies do not; blanket permits ignored
- pulls: one at a time; run-now answers immediately; a stuck pull is overridden by the watchdog
- council filter: real Seattle appointments and citywide code changes are excluded; site-specific items kept; stale items removed
- land-use applications feed: rolling window, address required, links to the record
- attribution: Chicago carries its required disclaimer; only enabled sources are listed publicly

## http.test.js (11)
- auth, roles and tenant scoping over HTTP
- login is rate limited
- unsubscribe link suppresses across all tenants; forged links rejected
- stripe webhook: valid signature updates subscription, invalid rejected
- privacy requests: opt-out suppresses immediately; deletion removes contact records
- contacts API refuses invented or personal data
- run-now answers immediately and reports status
- links: javascript: URLs are refused for directory entries and contacts
- test email: explains exactly what is missing, sends when live
- sign-in brute-force limit: 10 attempts per 15 minutes by default
- release identifier (owner only) and honest coverage

## itb.test.js (6)
- GC request for any trade: validation no longer cleaning-only; square footage optional; links must be http(s)
- invitations go only to matching trades in matching territory; late joiners are invited by the hourly pull
- subcontractor: will bid → manual bid (escaped) → revise → GC compares and awards with signature
- cleaning instant pricing still works, and only for requests that ask for it
- subscriber → GC outreach: needs legal identity, a verified contact tied to the project, and is logged; no duplicates
- platform company gets cleaning trades once at startup (and keeps any trades it already set)

## leads.test.js (28)
- plans: trial works until it ends; territory list limited by plan; national sees every state
- stage tracking: status changes are recorded with timestamps
- timeline: labeled estimate, larger jobs run longer, final cleaning comes last
- search: territory gate, filters, sorting; nothing outside paid states leaks
- project detail: verified contacts with evidence, suppressed people hidden, other territories 404
- saved searches: plan limit, alerts only for new or changed projects, one email per day
- export: blocked on trial, limited and correctly escaped on paid plans
- tracking: stage + notes, only for projects in territory
- HTTP: subscriber signup → verify → search; buyers and unverified accounts blocked; probe flags bad field maps
- timeline: interior jobs skip site work and structure; new builds keep them
- Chicago-style contacts: roles picked by type, never by position
- probe reads the official schema, license and freshness; array fields checked per column
- catalog corrections reach disabled sources only; live sources are left alone
- ArcGIS adapter: commercial filter at the source, epoch dates converted, per-record source link, incremental since
- sources with no field map can never be switched on
- internal company plan sees every state (regression: plan limit overwrote the state list)
- occupancy classification: code groups case-sensitive, words case-insensitive, single-family excluded
- default search hides completed/expired; includeClosed or an explicit stage shows them; detail always opens
- Socrata sync: oldest change first, pages forward, source filter applied, backfill window on first run
- value/sqft take the first filled column; zeros skipped
- houses are filtered by Seattle wording, and stored records that turn out residential are downgraded
- resync archives a source\
- probe can list a column\
- window sync: re-pulls recently issued/applied permits, ignores portal-wide rewrites, no cursor
- placeholder values ($0/$1) are treated as unknown, real values kept
- Minneapolis occupancy codes: MFD and 3to4 are multifamily; generic "Comm" falls back to the description
- grouping: permits at one site become one lead; detail lists the others; unit numbers and street spellings normalize
- work-type tags from real city wording; filter and saved searches use them

## marketplace.test.js (10)
- request validation: real quantities and future due dates required; janitorial needs frequency
- recurring janitorial: monthly price = per-visit price × visits
- marketplace end to end: buyer request → autopilot proposal → delivered to inbox → award; buyer never sees costs
- unverified buyers cannot post; outside service area is not bid
- inbound reply attaches to the bid, flags it, and "remove me" suppresses the sender
- follow-up: exactly one, only after the delay, never after a reply
- directory: bulk import validates rows, gaps rank blocked value, adding a contact requeues bids
- retention: expired sessions and old previews removed; stale contacts marked outdated
- HTTP: buyer signup → email verification link → post request; buyers blocked from seller data
- permit bids never include recurring janitorial lines

## measure.test.js (3)
- scales and geometry, checked by hand
- saved measurements: server computes the value, needs a scale, only invited companies, private per company
- measurements → estimate (linked to the invitation) → bid that cites sheet, page and scale

## multi-instance.test.js (4)
- two servers edit the same record: the second write is rejected as a conflict, the first is kept, nothing is silent
- change notifications keep the other server current: create, update, delete
- one server saving the same record many times in a row never conflicts with itself; stale deletes are refused
- a large save (2,000 records with long ids) succeeds and every change reaches the other server

## planroom-national.test.js (7)
- text is extracted from real PDFs on the server
- drawing sets → sheets → revisions, linked to the project; addendum becomes the current revision
- search inside documents: all terms must match, best page and snippet, only entitled files
- revision comparison shows the changed text; same sheet only; access and indexing enforced
- rights model: licensed documents need an active entitlement, the territory, and an unexpired license
- one rule everywhere: viewing links follow the rights model
- line diff

## planroom.test.js (5)
- sheet index from file names: disciplines, sheet numbers, specs; never guesses beyond the name
- uploads: PDFs only, size limit, no duplicates, only the posting GC
- access: GC and invited bidders only; signed links expire; opening records a planholder
- addenda: numbered, bidders notified, bidding blocked until acknowledged, bid states the addenda
- HTTP: raw PDF upload, listing, signed viewing in the browser

## postgres.test.js (3)
- postgres: full cycle persists, reloads identically, deletes propagate, audit stored
- postgres: a failed write is retried, not lost
- two servers (deploy overlap): a scheduled job runs on only one; the lock frees afterwards

## prequal.test.js (3)
- prequalification profile: only what was filed; "verified" only when checked with the issuer; gaps flagged
- bid leveling: latest revision per bidder, spread vs low, median, addenda acknowledged; receipts fingerprint the exact bid
- addenda show in leveling; prequal decisions are private to the GC and limited to its own bidders

## project-core.test.js (9)
- incremental linking only touches changed records; a full re-scan finds nothing missed
- one permanent project per development: address variants and suites join; IDs are stable and readable
- lifecycle: land-use filing creates a planning project; bid request and permits move it forward with history
- company relationships carry source, method, verification and dates
- ambiguous matches go to review, never guessed; merge keeps the surviving ID and old IDs still resolve; split
- visibility: territory for permits; bid packages and drawings only for the GC and invited companies
- database-style search in memory: filters, order, territory
- postgres core: schema v2 tables, transactional dual-write, reconcile, SQL search matches, merge, re-sync
- linking scales linearly (regression: phase recompute was quadratic — 67 s at 10,000 permits)

## publishing.test.js (8)
- one catalog: legacy plans map onto it; publishers publish but do not get discovery; free gets invitations only; expired trial blocks
- publishing needs a verified company, permission, and evidence when acting for the owner
- full lifecycle: draft (invisible) → checklist → publish → invite-only vs eligible → can-bid answers → coverage → close/reopen/archive
- a discovered permit is never a bid opportunity; a draft is visible only to its publisher
- publisher plan limits active projects (Basic: 3); one-step post follows the same rules
- HTTP: seats are enforced; permissions control publish, upload and award
- AI credits come from the plan (never above the platform cap); Free has none
- coverage states the document situation explicitly: uploaded (with revision), intentionally none, or missing — plus blockers

## round3.test.js (5)
- credentials: expired insurance pauses all bidding; adding a current certificate resumes it
- credentials: proposals say "on file" until independently verified; verification needs evidence
- e-signature: award records signer, consent, IP and document hash; tampering is detected
- digest: approvals, gaps, expiring insurance; sent once per week; platform owner also sees gates
- store change tracking marks every write path, including cross-tenant suppression

## sql-reads.test.js (1)
- SQL search returns exactly the in-memory results: every filter, sort, page, both grouping modes

## takeoff.test.js (4)
- takeoff only from a confirmed analysis; printed areas become lines with their sheet and room
- estimate math checked by hand; quantity edits are flagged as adjusted; validation
- rate-card lines price from approved cleaning rates; unapproved cards cannot price
- submit as bid: amount = estimate total, bid lists quantities with sources; locked after submission

## workspace.test.js (3)
- a permit shows bid packages and drawings at the same site only to invited companies
- Build Estimate on a permit: prices permit square footage with approved rates; reuses the draft; proposal escapes text
- market activity and KPI trend are counted from real permits in the territory
