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

## Functional application features
- Responsive navigation and page layouts
- Commercial bid intake with multiple service selections and document uploads
- Bid details include company/contact, project type, address, square footage, floors/units, occupancy, due date, walkthrough date, start/completion dates, frequency, site access, site logistics, insurance/vendor requirements, procurement/billing notes, and detailed scope
- Contact and career interest forms
- SQLite storage for incoming inquiries
- Admin sign-in scaffold with bcrypt password verification and expiring JWT
- Admin lead list, lead detail view, status updates, CSV export
- Protected bid document download from admin dashboard
- Optional SMTP notifications to company and acknowledgement to submitter
- SEO sitemap and robots file

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

## Contract, project and finance registers (initial operating modules)
- Contract register: customer, title, scope summary, dates, value, status, linked estimate reference and signature status field.
- Project register: customer, site, manager, contract reference, dates, status and progress.
- Invoice register: customer, invoice number, project reference, due date, amount, paid-to-date and status; summary totals billed, collected and outstanding.
- Activity log records selected administrative create/update/send actions.

These are initial operational registers, not yet a full enterprise field-service or accounting platform. E-signature, PO document workflows, change-order approvals, automated renewals, crew dispatch, shift scheduling, mobile site checklists, inspection/photo evidence, customer project dashboards, completion report distribution, invoice delivery, ACH/card processing, tax determination, accounting sync and contract-level profitability allocation require further integration and acceptance testing.

## Quote and proposal setup
1. Create the admin account with `npm run create-admin -- admin@yourcompany.com "Use-a-long-unique-password-14+"`.
2. Install dependencies with `npm install` and start with `npm start`.
3. Configure SMTP in `.env` before using **Email customer** on a proposal.
4. Open `/admin/`, review a bid request or create an estimate, and save the proposal.
5. Review the generated customer link before sending it. The link is a bearer link: anyone who has it can view and respond. Treat it as confidential and do not post it publicly.
6. Confirm the estimate inputs, tax treatment, terms, exclusions and pricing with an authorized estimator before sending a binding commercial offer.
