# BUILDINTEL public website — multi-page specification

## Experience model
The public website is a multi-page corporate/product site. The homepage introduces the platform and routes users into dedicated pages. It is not intended to carry the full product story in one long scrolling page.

## Shared shell
- Persistent BUILDINTEL brand header and responsive navigation.
- Dedicated page title, description and breadcrumb on each inner page.
- Cross-links between related workflows and a consistent footer.
- Clear workspace sign-in entry at `/app`; separate Super Admin entry at `/admin`.
- Responsive navigation and keyboard-accessible native links.

## Public routes
- `/` — homepage and page directory
- `/platform` — connected product overview
- `/project-intelligence` — project records, permits, planning, relationships and source coverage
- `/marketplace` — publisher verification, authority, packages and bidder distribution
- `/plan-room` — document access, revisions, addenda and planholder controls
- `/takeoff-estimating` — scale calibration, takeoff, AI review and cost build-up
- `/bid-management` — invitation, intent, submission, revisions, bid leveling and award
- `/service-contractors` — cleaning and facility-service qualification, capacity and pricing controls
- `/data-trust` — source provenance, authority, tenant boundaries, roles, audit and AI governance
- `/solutions` — role-specific workflows
- `/pricing` — subscriber and publisher plan families and billing caveats
- `/about`, `/contact`, `/faq` — company, inquiry and explanatory pages

## Product accuracy
- A project record or permit is not represented as an open bid.
- Restricted drawing access is publisher- and package-controlled, not automatically granted by subscription.
- Coverage is jurisdiction- and source-specific; no unsupported national coverage claims.
- AI extracted quantities remain unverified until a human confirms them; unprinted areas are not invented.
- Commercial data integrations, payment processing and outbound email are not represented as live unless deployment configuration and tests prove that status.
- Pricing is proposed until commercial terms and live billing are confirmed.

## Existing product preservation
The public website does not replace the subscriber/publisher app or the Super Admin portal. `/app` and `/login` continue to serve the existing application. `/admin` continues to serve the protected administration UI and APIs remain server-authorized.
