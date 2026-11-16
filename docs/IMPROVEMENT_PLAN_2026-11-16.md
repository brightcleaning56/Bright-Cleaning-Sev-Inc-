# Diagnostics and improvement plan — 2026-11-16

Scope: a full read-only audit of the backend (routes, auth, money, dates, deletes) and the front end (admin SPA, customer portal, crew and contract pages, public website), plus live checks of brightclean.net. Each finding was verified against the code before any change.

## 1. Fixed and deployed (commit 30c08da, plus the admin guard follow-up)

Backend
- Portal and payment-link tokens no longer fall back to a public key when `JWT_SECRET` is missing. A random per-process key is used instead. (`portal.js`, `payments.js`)
- Stripe webhook: a payment that arrives for a Void or Draft invoice is recorded as "Needs refund" and is not applied. (`payments.js`)
- Superseded contracts can no longer be countersigned or declined from an old link (410). (`contracts2.js`)
- Marking a proposal "Sent" by hand (the status dropdown, or a direct PATCH) now runs the same insurance, late-bid and blocking-flag checks as the Send button. Before, it skipped them. (`server.js`)
- Delete guards: a contract that a project is linked to cannot be deleted; a project with tasks, costs, updates, milestones, visits, inspections or complaints cannot be deleted. (`admin-ext.js`)
- Invoice issue date is locked once the invoice is sent. Saving the same date still works. (`admin-ext.js`)
- Proposal expiry uses the company's business date (`bizdate.js`), not UTC. Expiry dates must be YYYY-MM-DD. (`server.js`, `portal.js`)
- Withdrawn and superseded proposals are no longer served as public PDFs. (`bids.js`)
- Duplicate public bid submissions no longer return the internal lead id. (`server.js`)
- Signature IP comes from `req.ip`, which respects the trust-proxy setting, instead of a raw forwarded header. (`contracts2.js`)
- Portal sign-in replies before the email is sent, so response timing no longer shows whether an address is on file. (`portal.js`)
- The extra-fields route uses an allow-list lookup, so unknown tables return 404 instead of a server error. (`admin-ext.js`)

Front end
- The five service pages whose quote links did not preselect their service now do. (`assets/site.js`)
- Public forms, the proposal approve/decline buttons, the staff reply to a client message, and the contract action buttons are disabled while they run, so a double tap cannot send twice. (`assets/site.js`, `assets/proposal-page.js`, `admin/admin.js`)
- Crew app: when the server refuses a check-in or job change, the refusal message stays on screen. It used to be replaced by "Checked in." (`assets/crew-page.js`)
- Contract page shows a clear message when the link cannot be loaded. (`assets/contract-page.js`)
- Portal tables scroll inside their own box on phones instead of pushing the page wider. (`assets/portal.js`)
- Labels are tied to their inputs on the contact, careers and AI-estimate forms; form results are announced to screen readers; the menu button reports whether the menu is open. (`contact.html`, `careers.html`, `admin/index.html`, `assets/site.js`)
- Page titles use the company name consistently ("Bright Cleaning Sev Inc."). The "(review)" suffix is removed. A dead settings block was deleted. (several pages, `admin/admin.js`)

Tests: 248/248 API checks and 87/87 admin UI checks pass. New regression checks cover the Sent gate, the 404 on unknown extra tables, and the invoice date lock.

Live: `https://brightclean.net/api/health` reports build `d036183f73da`, the first commit deployed in this round.

## 2. Found and verified, not changed (needs an owner decision or more work)

| # | Item | Why not changed | Suggested fix |
|---|------|-----------------|---------------|
| A | Plans page (Home, Apartment, Office) links to the commercial-only bid form. | Business decision: a residential intake or wording change. | Add a residential request path, or reword the plans page to say commercial only. |
| B | `request-a-quote-new.html` and `quote.html` are not linked from any page. | Looks like review or spare copies; deleting is your call. | Delete both, or keep one and link it. |
| C | Public duplicate-bid merge writes new text into an existing lead when email, project name and address match. | A design choice; the merge is still open to anyone who knows those three details. | Send matches to a review queue instead of appending to the lead. |
| D | ~~`GET /api/admin/events` (live event feed) has no role check.~~ **Fixed:** the ticket is now refused (403) for a role the role table denies on the feed. | — | — |
| E | Admin contract view: pressing Back with unsaved edits leaves the address bar showing the other contract. | Needs a careful change to the router. | Restore the previous hash when the user cancels the unsaved-changes prompt. |
| F | Crew app photo buttons are not keyboard-reachable (the file input is `display:none`). | Needs a CSS change on the crew page. | Visually hide the input rather than hiding it. |
| G | Homepage has two "Recent work" headings. | Cosmetic. | Rename the second kicker, e.g. "Photos". |
| H | Async route handlers were not each checked for unhandled rejections. | Time. Express 4 does not catch them. | Wrap async routes or add an error middleware, then test. |

## 3. Improvements for customers (consistency and clarity)

1. One source for contact details. The phone number and email are typed into many pages and emails. Move them to one config value used by pages, proposals, invoices and emails.
2. One list of services. The service names on the quote form, service pages, sitemap and proposals should come from the same list, so a name cannot drift.
3. Tell the customer what happens next. After a proposal is approved, the portal and the confirmation email should show: contract to sign, project date pending, insurance certificate needed (if required), and the office contact.
4. Show insurance on the proposal page when a certificate is attached, so a GC sees it before approving.
5. Explain refusals in the admin. When "Sent" is refused by a check, name the missing item and link to where it is fixed (the banner now names the item; a link would finish it).
6. Portal: a single status timeline per proposal, contract and invoice (Sent, Viewed, Approved, Signed, Scheduled, Invoiced, Paid).
7. Public site: add an explicit "Who this is for" line to each service page and link the matching industry page, so a visitor finds the right service in one step.

## 4. Improvements for the system

1. Uptime and error alerts. `/api/health` already reports `errors_1h`. Point an external monitor at it and alert the owner on failure (owner item).
2. Browser tests on a phone-width viewport for the public site and the portal. The current UI tests run in jsdom and cannot see layout problems.
3. Add the double-submit and superseded-contract cases to the automated suite so they stay fixed.
4. Clear test records. The "ZZ TEST" proposals, contracts and projects in the live data are test records. Delete them after you confirm (owner item).
5. Keep one Node version for tests (Node 22). Node 24 cannot build the database driver here.

## 5. Owner items

- Decide items A and B above (plans routing and the orphan pages).
- Approve deleting the "ZZ TEST" live records.
- Confirm that `JWT_SECRET` is set in Render (it is generated by `render.yaml`).
- Set up the uptime monitor (item 4.1).
- Send one real test email after deploy to confirm the sender name appears on it (sent-by check).
