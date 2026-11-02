# Bright Clean — Automation Coverage & Remaining Build Register

## Available in this package

| Workflow | Current behavior | Automation state |
|---|---|---|
| Website bid intake | Stores bid request, documents, customer/contact details | Automated |
| Bid acknowledgement | Sends acknowledgement when SMTP is configured | Automated after configuration |
| Internal bid notification | Notifies configured inbox | Automated after configuration |
| Customer directory | Upserts customer records from bids, inquiries and estimates | Automated |
| Quote creation | Uses cost inputs, service templates, production assumptions and customer line items | Assisted; estimator must verify site and assumptions |
| Proposal generation | Creates a secure proposal URL and customer-facing review page | Automated |
| Proposal delivery | Emails the proposal from admin | One-click; SMTP required |
| Proposal view/decision | Records customer view, approval or decline | Automated |
| Proposal follow-up | Sends 3- and 7-day reminders | Opt-in scheduled automation; SMTP required |
| Invoice reminders | Sends 3-days-before, 1-day-overdue and 7-days-overdue reminders | Opt-in scheduled automation; customer email required |
| Approved proposal handoff | Creates draft contract and planning project | Opt-in automation; manager approval still required |
| Activity history | Records key admin and proposal actions | Automated |
| Health check | `/health` checks service and database connectivity | Automated endpoint |
| Local database backups | Attempts daily backup and retains 14 newest local files | Automated; off-site backup still required |

## Build next — required for a low-touch operating business

### A. Contract-to-cash
- Generate agreement and scope exhibits from approved proposal.
- Add purchase order capture, insurance/vendor document checklist and change-order workflow.
- Connect an e-signature provider and verify signed-document webhooks.
- Generate invoice schedules from contract milestones or recurring service cycles.
- Connect payment processor and verify payment webhooks, refunds, disputes and deposits.
- Integrate accounting and reconcile every invoice/payment to the accounting ledger.

### B. Workforce and project delivery
- Employee/contractor onboarding, identity and work eligibility workflows as applicable.
- Availability, skills, certifications, background-check and training records.
- Labor scheduling, crew assignment, shift confirmation and time capture.
- Mobile work orders, site access instructions, safety briefings and job hazard controls.
- Task checklists by service type, timestamped photos, deficiency/rework assignment and inspection scorecards.
- Customer completion sign-off and automatic closeout package.

### C. Customer self-service
- Secure customer login and organization-level access control.
- Request service, submit additional scope, upload site documents and view proposals.
- Approve quotes, review contract documents and purchase orders.
- Track project status, schedule changes, completion reports and invoices.
- View payment history and submit service issues.

### D. Revenue and service automation
- Recurring service schedules, renewal notices and planned price reviews.
- Automatic draft estimates for repeat scopes using customer-approved rates and prior actual job costs.
- Margin alerts when actual labor, materials or travel exceed estimate.
- Customer satisfaction follow-up after closeout.
- Lead source, conversion, win/loss and contract profitability reporting.

## Guardrails that should not be removed

- Never auto-send a binding price when required measurements, access, site condition or service scope are missing.
- Never mobilize a crew solely because a proposal was approved. Check signed agreement, PO, insurance, site readiness, staffing, safety and schedule.
- Never claim an invoice is paid based only on a customer message; reconcile processor/bank evidence.
- Never auto-assign unqualified or unavailable workers to safety-sensitive work.
- Keep an audit trail for every automated email, approval, price change, assignment, payment and document action.

## Go-live rule

Automation is only as reliable as the configured business data and the external providers. Bright Clean must approve the production-rate library, loaded labor costs, margin floors, minimum charges, service territories, insurance/vendor documents, contract terms and safety/quality standards before enabling customer-facing automation.
