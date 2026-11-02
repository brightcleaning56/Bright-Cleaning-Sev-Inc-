# Bright Cleaning Sev Inc Website — Audit & Verification Report

Audit date: 2026-11-01  
Scope: review and enhancement of the website starter package generated in this conversation.

## Summary
The prior package had the broad technical skeleton but insufficient commercial content and several workflow gaps. This revision expands the business explanation, service-level detail, customer-specific content, procurement information, and bid intake. It also corrects form and admin workflow defects identified during source review.

## Content gaps addressed
- Expanded the homepage to explain the commercial buyer journey and delivery process.
- Added a company capabilities page.
- Added detailed quality assurance and safety framework.
- Added a service delivery process from opportunity intake through billing/closeout.
- Added commercial bid preparation resources.
- Expanded all service pages with typical inclusions, exclusions, delivery sequence, quality review, quote inputs, and FAQs.
- Expanded six industry pages with sector-specific services, information needed to scope work, and expected proposal deliverables.
- Added regional opportunity pages for Iowa, Texas, Minnesota, North Dakota, and Kansas City with explicit availability qualifications.
- Expanded vendor/procurement content to cover W-9, COI, endorsements, safety, vendor setup, PO, billing, and mobilization.
- Added privacy, terms, and accessibility starter pages.
- Added a clearer commercial bid request with contact, project, schedule, scope, access, site logistics, insurance/vendor, billing/procurement, and file upload fields.

## Functional defects found and corrected
1. **Contact/career form request encoding:** The browser sent multipart FormData while the server endpoint expected URL-encoded fields. Updated the client submission to send URL-encoded data for contact and career forms.
2. **Career form required message:** The server requires a message; the career form allowed it to be empty. Made the experience/message field required.
3. **Commercial service selection:** Replaced the clumsy multi-select with a multi-checkbox service selector and client-side minimum selection validation. Server stores selected services as a combined service description.
4. **Bid details:** Added extended project fields and included them in the lead record's detail text without requiring a destructive database migration.
5. **Admin file download:** Protected bid files require bearer authentication. Admin dashboard uses authenticated fetch and downloads the file instead of opening a protected URL without credentials.
6. **Admin duplicate event handler:** Removed a duplicate file download event handler.
7. **Admin CSV export:** Added export of lead records.
8. **Admin setup:** Added a script to create an initial admin account configuration and random JWT secret.
9. **Email notifications:** Added optional SMTP notification and submitter acknowledgement. It only works after SMTP settings are configured.
10. **Rejected bid uploads:** Added cleanup of uploaded files when required-field or honeypot validation rejects a request.

## Source checks performed
- `node --check` passed for `server.js`, `public/assets/site.js`, `public/admin/admin.js`, and `scripts/create-admin.js`.
- Internal website-link scan found no missing local HTML links at the time of audit.
- Service pages and industry pages are present as individual HTML routes.
- Package contains a public website, server, SQLite persistence, upload handling, admin UI, setup script, and documentation.

## Not verified in this environment
- Dependencies have not been installed and the app has not been launched against a live Node process.
- Database migrations and real form submissions have not been exercised against an installed runtime.
- SMTP delivery has not been tested with real credentials.
- File uploads have not been malware-scanned.
- Production deployment, HTTPS, backups, CRM integration, analytics, payment, accounting, e-signature, and proposal generation are not connected.
- The actual business legal name, phone, mailing address, current operating territory, insurance limits, certifications, licenses, project references, client logos, and approved photographs require company confirmation.
- Regional pages describe markets for opportunity review; they do not guarantee local staffing or service availability.
- Restroom cleaning and floor care are presented as custom-scope services and must be confirmed as actual offerings before publication.

## Production acceptance checklist
- [ ] Confirm legal entity name and company contact details.
- [ ] Approve all service descriptions, exclusions, and operational claims.
- [ ] Confirm service areas and mobilization capability.
- [ ] Confirm whether restroom cleaning and floor care are offered.
- [ ] Replace stock imagery with licensed company/project photos.
- [ ] Approve client references, case studies, and project metrics.
- [ ] Confirm W-9, insurance certificate, endorsements, licenses, and safety documents.
- [ ] Complete legal review of privacy, terms, and employment content.
- [ ] Install dependencies and run app in staging.
- [ ] Create admin credentials and verify sign-in/expiry/logout.
- [ ] Submit test bid with multiple services and multiple files.
- [ ] Verify record persistence and all submitted fields in admin.
- [ ] Verify protected document download with and without authentication.
- [ ] Verify status updates and CSV export.
- [ ] Verify contact and career form submissions.
- [ ] Configure SMTP and verify internal notification and submitter acknowledgement.
- [ ] Test invalid fields, large files, unsupported file types, spam/rate limiting.
- [ ] Test responsive layouts on iOS, Android, desktop, and major browsers.
- [ ] Complete accessibility and security review.
- [ ] Configure production hosting, HTTPS, database/storage persistence, backups, monitoring, and incident response.
- [ ] Run a full end-to-end acceptance test before public launch.

## Commercial quote and operations modules added in this revision
- Added SQLite tables for estimates, contracts, projects, invoices and audit events.
- Added cost-based estimate calculation using production rates, labor, supplies, equipment, other direct costs, overhead, gross margin and tax assumption.
- Added proposal persistence, unique customer proposal link, public proposal view, proposal view status, customer approve/decline response, and optional SMTP sending.
- Added contract, project and invoice admin registers plus financial summary and selected activity logging.
- Added customer-facing proposal print / save-to-PDF action.

## Additional checks still required before production
- Install dependencies and execute real HTTP/API integration tests against a fresh database and an upgraded existing database.
- Verify all estimate arithmetic with approved company estimating standards and real production data.
- Test duplicate invoice numbers, invalid foreign references, malformed percentages, concurrent submissions and email failure/retry behavior.
- Add and test proposal revocation/expiry management, customer identity verification, approval audit metadata and legally reviewed acceptance language.
- Implement provider-backed electronic signatures before describing agreements as signed.
- Implement complete PO and change-order lifecycle, renewal alerts, project work orders, crew assignments, schedule conflict controls, mobile checklists, inspections, photo evidence, completion reports, customer project status portal, invoice delivery and payment reconciliation.
- Add accounting/payment integration and contract/project cost allocation before reporting true profitability.
- Perform penetration testing, CSRF/session review, data retention review, privacy/legal review and backup/restore testing.

## Runtime verification (second pass)
Verified by running the server (Node 22) and exercising it, not only by reading source.

Automated end-to-end API checks: 39 of 39 pass. They cover public contact, career and bid submission (multi-service, file upload, consent and honeypot rejection, disallowed file types), admin login, auth-protected leads and bid-file download, lead status updates, estimate math (labor hours, labor cost, cost, margin-based proposal total), send without SMTP (clear 503), public proposal view (Sent → Viewed), customer approve/decline, contract/project/invoice registers, financial summary, and audit log.

Browser checks: homepage renders at 390px with no horizontal overflow; admin login works and the dashboard loads live counts.

Defects found and corrected in this pass:
1. `scripts/create-admin.js` wrote a literal `\n` instead of a line break into `.env`, so no setting was parsed and the server listened on a garbage port. Fixed.
2. Unknown URLs returned HTTP 200 with the homepage (soft 404). Now return 404 with a site-styled `404.html`.
3. The global `/api/` rate limit (100 requests per 15 minutes) would lock out an admin working through the dashboard. Raised to 600. The login endpoint keeps its own stricter limit.
4. `nodemailer` had published high-severity advisories (`npm audit`). Upgraded to 10.3.1; `npm audit` now reports 0 vulnerabilities.
5. Hero text lost contrast when the background photo failed to load. Added a solid fallback color.

Still open before production (not verified here):
- Domain and mailbox: `brightclean.net` and `info@brightclean.net` confirmed by the owner (Eric Moore) on 2026-11-01.
- Hero and project imagery is hotlinked from Unsplash. Replace with approved company photography and host it locally.
- Live SMTP delivery, HTTPS hosting, backups, and the operational gaps listed in README.md (e-signature, crew scheduling, customer portal, payments).


## V5 integration and verification (2026-11-02)
The V5 package supplied documentation only (runbook, automation register, QA notes). The V5 features were implemented
on top of the live system rather than replacing it, keeping the upgraded admin portal and all existing data.

Implemented: customer-decision lock on proposals; view/decision timestamps, view count and decision IP/browser;
admin preview not counted as a customer view; server-side email validation on all forms, estimates, customers and
invoices; expanded estimating model with templates and crew days; persistent customer directory with automatic sync;
automation settings with opt-in proposal and invoice reminders (sent once per stage, logged); approval handoff as a
setting; `/health` with database check; daily database backups (14 kept) with manual backup and download; production
runbook, automation register; PUBLIC_BASE_URL for emailed links; safer admin setup script.

Verified by running the application (not by reading code): `tests/run-tests.js` 58/58 and `tests/ui-tests.js` 24/24,
each run repeatedly, plus the earlier regression suite. Results are in `tests/results.json` and `tests/ui-results.json`.

Still not verified: real mailbox delivery (needs SMTP_PASS), off-site backup storage, real-device mobile testing beyond
the live check, penetration testing, load testing and legal review. Payments, e-signature, accounting, SMS, crew
scheduling and a customer portal are not built (see AUTOMATION_GAP_REGISTER.md).
