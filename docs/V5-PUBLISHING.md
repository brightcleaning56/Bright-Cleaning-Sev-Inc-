# BUILDINTEL v5 — Project Publishing & Subscription System

Business model: a two-sided construction marketplace with an intelligence layer. **Publishers** (owners, developers,
GCs, construction managers, public agencies, authorized design teams) publish projects, trade packages and plans —
basic publishing is free so real projects come onto the network. **Subscribers** (trades, suppliers, service companies)
pay for discovery, authorized plan access, takeoff, estimating and bid tools. BUILDINTEL verifies, distributes and tracks.

**Core rule:** a discovered permit, a publication and a bid package are separate records. Bidding opens only when a
**verified publisher** releases a package. Every project shows a market status and a plain "Can I bid?" answer.

## Built in this release (tested)

| Area | What exists | Evidence |
|---|---|---|
| Publisher types | General contractor, construction manager, developer, owner, property manager, architect/engineer, public agency | `BUYER_KINDS` |
| Publisher verification | Company requests verification (website or license #); BUILDINTEL staff approve/reject **with a note on how it was checked**; a confirmed email is not authority | publishing tests; HTTP signup test; Publisher Review screen |
| Authority per project | Relationship recorded on every publication (owner, developer, GC of record, property manager, CM, architect for owner, other agent); CM/architect/agent must attach authorization evidence; the form preselects the company's own relationship | publishing tests; browser flow |
| Permissions | publish, upload, invite, award, billing, users; owners have all; members default to upload + invite; enforced on publish, upload and award | HTTP permissions test |
| Publications | draft → published → closed → (reopen) → archived; status history; nothing visible to bidders while draft | lifecycle test |
| Trade packages | Several per project (they are bid requests): scope, inclusions, exclusions, instructions, due date, trades, documents (plan room per package), **eligible-subscriber or invite-only** distribution, publisher bidder list | lifecycle test; browser flow |
| Publish checklist | Verified company · authority recorded · ≥1 package · each package: future due date, 20+ character scope, invitees if invite-only, documents or explicit "no documents" · plan allows another active project | checklist tests; browser flow (publish blocked until documents handled) |
| Distribution | Eligible packages invite every matching subscriber (trade + territory) plus the list; invite-only invites only the list; late joiners invited hourly (eligible only) | lifecycle test |
| Market status | Discovered · Planning · Pre-bid (only the publisher sees its draft) · Open for bids (invited / not invited, with the reason) · Bidding closed · Awarded — on search results, the Command Center and profiles | market-status tests |
| Coverage dashboard | Per package: documents, invited, opened plans, will bid, won't bid, bids, awarded; project totals | lifecycle test; browser flow |
| Bidder directory | Publishers search subscriber companies by trade, state and name (names and trades only) and invite them | browser flow |
| One-step post | Single-package posting still exists and follows the same rules (verified, permission, checklist, publication record) | marketplace + publishing tests |
| Unified entitlements | One catalog, two lines: subscriber Free / Local / Professional / Growth / Enterprise; publisher Basic / Pro / Business; legacy plans mapped (regional→Professional, national→Growth, starter→Local, business→Growth) | entitlement tests |
| Enforcement | Seats (adding/enabling users), markets, AI credits per day (never above the platform cap), export rows per month, active publications per publisher plan | HTTP seats test; AI test; publication-limit test |
| Subscription Center / Team | Plan, included limits, usage (seats, AI today, exports this month, active projects); team list with per-user permissions | browser flow |

Proposed prices (from the business-model review) live in `src/entitlements.js` and are labeled **proposed — confirm
before charging**. Document access remains a separate check: a paid plan never opens restricted plans by itself.

## Open (next v5 releases)

| Item | Acceptance |
|---|---|
| Stripe for the new catalog (price IDs per plan, webhook → entitlements, grace period, cancel at period end, billing history) | Test-mode checkout per plan; webhook activates entitlements; failed payment → grace → restricted |
| Notifications (Postmark): invitations, addenda, deadline changes, award/regret | Delivered test messages; bounce/complaint handling |
| Project Q&A / RFIs per package (questions, answers to all invited bidders, clarification log) | Bidder asks → publisher answers → every invited bidder notified; answers part of the bid record |
| Scheduled publication, document visibility per package/document, watermarking, virus scanning | Tests per rule |
| Company invitations by email (instead of owner-set passwords) | Invite link → user sets own password |
| Publisher onboarding in the new app shell (the publisher page still uses the older layout) | Same dead-control and browser checks as subscriber screens |
| Commercial launch metrics (MRR, conversion, retention, invitations/bids/awards per project) | Owner dashboard from real data |
