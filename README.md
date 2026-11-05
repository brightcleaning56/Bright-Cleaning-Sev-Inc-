# Bright Cleaning Sev Inc — Professional Commercial Website

## Brand and positioning
Legal name: Bright Cleaning Sev Inc. (owner-confirmed).

Bright Cleaning Sev Inc is presented as a commercial cleaning, construction final cleaning, and property-services provider, with the primary audience being general contractors, construction managers, commercial property owners, facility managers, and multifamily operators.

## Public website pages
- Home / company positioning
- Company capabilities
- About the company
- All services directory
- 12 individual service pages:
  - Commercial janitorial
  - Post-construction final cleaning
  - Rough / progress construction cleaning
  - Punch-list / final touch-up cleaning
  - Interior / exterior window cleaning
  - Apartment common-area cleaning
  - Unit turnover cleaning
  - Power washing
  - Parking lot pickup / maintenance
  - Valet trash services
  - Commercial restroom cleaning (custom-scope offering; confirm operational availability)
  - Commercial floor care (custom-scope offering; confirm operational availability)
- Industries directory and six detailed industry pages
- Projects / portfolio framework
- Regional project opportunity pages for Iowa, Texas, Minnesota, North Dakota, and Kansas City
- Service areas
- Quality assurance and safety framework
- Service delivery process
- Commercial resources / bid preparation
- Vendor and procurement information
- Commercial bid request
- Contact
- Careers
- FAQs
- Privacy, website terms, and accessibility starter pages
- QA audit report with corrected defects and production acceptance checklist

## What the system includes (current, Nov 2026)
The code is the source of truth; this section maps it.

| Area | Files | What it does |
|---|---|---|
| Website + intake | `public/`, `intake.js`, `server.js` | Public site; bid/quote/contact/career forms with service-specific questionnaires, uploads, duplicate merge |
| Admin app | `public/admin/`, `admin-ext.js`, `command.js` | 19-page operations admin, Command Center, global search |
| Customers + CRM | `ops.js`, `crm.js` | Customer matching, profiles, contacts, history |
| Leads + bids | `bids.js`, `autobid.js` | Bid pipeline, GC due dates, deadline alerts, AI-drafted estimates from the price book |
| Estimating + proposals | `estimating.js`, `scopes.js`, `pricebook.js`, `engine.js`, `approvals.js` | Price book, takeoffs-to-pricing, approval gate, sanity blocks, customer proposal links (client-only approval) |
| AI | `ai.js` | Lead triage, call analysis, drawing reading, draft takeoffs (drafts only; humans approve and send) |
| Contracts | `contracts2.js` (authoritative) | Send for signature, client signs, owner/manager countersigns, amendments, renewals, PDF. The older `/api/admin/contracts` register routes are restricted: they cannot create or activate a contract without a signature. |
| Projects | `pm.js` | Readiness checks, dispatch authorization, work plans/tasks, costs, sign-off, billing hand-off |
| Scheduling + crew | `sched.js` | Employees, time off, conflicts, dispatch board, crew field links, time entries |
| Quality | `qc.js` | Inspection templates, signed inspections, corrective work, reinspection, customer acceptance |
| Documents + takeoffs | `docs2.js`, `suite.js`, `engine.js` | Drawing sets, revisions/addenda (stale-takeoff flags), proposal attachments |
| Issues | `issues.js` | Complaints/tasks, escalation, customer updates, corrective visits |
| Calls + phone | `calls2.js` | Twilio capture, click-to-call, browser phone, live transcription, voicemail playback, save caller as customer |
| Invoices | `invoices2.js`, `admin-ext.js` | Send by email with PDF, contract-value check, payments (only path to Paid), reminders |
| Reports | `reports2.js` | P&L, A/R aging, labor, profitability, PDF, scheduled emails |
| Permissions | `server.js` (central gate) | Owner / manager / staff rules enforced on the server; denials logged |

Automated tests: `tests/run-tests.js` (server/API, end-to-end workflows A-G), `tests/ui-tests.js` (admin in a browser engine), `tests/ai-test.js`, `tests/button-audit.js` (clicks every admin button). Test timestamps are recorded in UTC.

## Run locally
1. Install Node.js 20+.
2. Copy `.env.example` to `.env`, or create admin credentials with `npm run create-admin -- admin@yourcompany.com "Use-a-strong-password-at-least-14"`.
3. Configure optional SMTP values in `.env` for notifications.
4. Install dependencies: `npm install`.
5. Start: `npm start`.
6. Open `http://localhost:3000`.
7. Admin: `http://localhost:3000/admin/`.

The admin creation script creates a random JWT secret and a bcrypt password hash in a new `.env` file. If `.env` already exists, it will not overwrite it.

## Production requirements — not yet completed
- Deploy behind HTTPS on a managed Node host.
- Use managed persistent storage or migrate SQLite to managed PostgreSQL and uploads to private object storage.
- Configure automated backups, restore tests, retention/deletion policies, and access logging.
- Configure and test SMTP delivery and reply handling.
- Add malware scanning and content inspection for uploaded files.
- Add CAPTCHA / bot protection and monitor abuse.
- Review rate limits, authentication, session handling, file access, and audit logs.
- Use a managed secrets store; never commit `.env`.
- Complete legal review of privacy, terms, accessibility, employment, and contract language.
- Confirm the mailing address, phone number, service locations, insurance, W-9, certifications, licenses, safety programs, project references, and approved photos.
- Remove or confirm custom-scope services (restroom cleaning and floor care) before claiming them as active offerings.
- Connect CRM, proposal/estimate software, accounting, e-signature, and project scheduling if those workflows are required.
- Perform accessibility, mobile, browser, load, penetration, upload-security, backup/restore, and end-to-end acceptance testing.

## Accuracy and claims
The website intentionally does not invent a phone number, street address, certifications, insurance limits, project metrics, awards, or client endorsements. Replace sample project imagery with approved company photography. Confirm active operating areas before advertising them as guaranteed service locations.

## Important
This is a runnable application starter, not a deployed production service. Email notifications are optional and require SMTP credentials. No external CRM, payment, accounting, proposal, e-signature, or scheduling provider is connected.

## Commercial estimating and customer proposals (added)
The admin portal now includes an estimate builder and customer proposal workflow:
- Estimate inputs: customer/contact, project/site, scope, measured square footage, production rate, optional labor-hour override, loaded labor rate, supplies, equipment, other direct cost, overhead, gross margin, tax assumption, validity date, line-item breakdown, and commercial terms.
- Labor hours are calculated as square feet ÷ production rate unless a labor-hour override is entered.
- Labor cost = labor hours × loaded labor rate.
- Direct cost = labor + supplies + equipment + other direct costs.
- Estimated cost = direct cost + overhead allocation.
- Proposal subtotal = estimated cost ÷ (1 − gross margin rate). Tax is then applied as a separate percentage assumption.
- The system saves a proposal and creates a unique customer review link. The customer can review scope, pricing, terms, print/save as PDF, and approve or decline.
- The admin can send the proposal by email when SMTP is configured, copy the customer link, and see Draft / Sent / Viewed / Approved / Declined status.
- A proposal approval is an approval record, not a qualified electronic signature or a substitute for a signed service agreement / PO.

## Quote and proposal setup
1. Create the admin account with `npm run create-admin -- admin@yourcompany.com "Use-a-long-unique-password-14+"`.
2. Install dependencies with `npm install` and start with `npm start`.
3. Configure SMTP in `.env` before using **Email customer** on a proposal.
4. Open `/admin/`, review a bid request or create an estimate, and save the proposal.
5. Review the generated customer link before sending it. The link is a bearer link: anyone who has it can view and respond. Treat it as confidential and do not post it publicly.
6. Confirm the estimate inputs, tax treatment, terms, exclusions and pricing with an authorized estimator before sending a binding commercial offer.

## Approval handoff (added)
When a customer approves a proposal online (staff cannot approve on the customer's behalf), the system automatically creates:
- one **draft contract** linked to the proposal, with the proposal total as its value and signature status "Not sent"; and
- one **Planning project** linked to that contract, using the project name and site address.

Approval does not create an invoice. Invoices are created by the project billing hand-off (or manually) and become Paid only through recorded payments. A proposal can only create one contract, even if approved again. Every automatic creation is recorded in the audit log under the "customer" actor.
