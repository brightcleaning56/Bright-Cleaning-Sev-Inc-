# Admin action → destination map

Generated from the code by `node tools/action-map.js` (2026-11-23). Do not edit by hand.

**338** button/form handlers that call the server or move the user somewhere · **463** server calls · **0** dangling (no matching route) · 437 admin API routes exist.

| Control (label) | Event | Server call(s) → module · permission | Goes to / result | Confirms | Observed in click audit |
|---|---|---|---|---|---|
| Save | act | PATCH `/api/admin/contracts2/:p` (via save) → contracts2.js · any signed-in user | opens: Contract |  |  |
| Re-send link / Send for signature | act | PATCH `/api/admin/contracts2/:p` (via save) → contracts2.js · any signed-in user<br>POST `/api/admin/contracts2/:p/send` → contracts2.js · any signed-in user | opens: Contract |  |  |
| Countersign | act | POST `/api/admin/contracts2/:p/countersign` → contracts2.js · module check (owner/manager) | opens: Contract |  |  |
| Amend | act | POST `/api/admin/contracts2/:p/amend` → contracts2.js · any signed-in user | opens: Contract |  |  |
| Renew | act | POST `/api/admin/contracts2/:p/renew` → contracts2.js · any signed-in user | opens: Contract |  |  |
| Restore / Archive | act | POST `/api/admin/contracts2/:p/archive` → contracts2.js · module check (owner/manager) | opens: Contract | yes |  |
| Open lead # | act | — | page: leads<br>opens: Lead |  |  |
| Save as customer | act | — | opens: SaveCaller |  |  |
| Create issue | act | POST `/api/admin/calls/:p/issue` → issues.js · any signed-in user | page: issues<br>opens: Issue |  |  |
| Mark follow-up done | act | POST `/api/admin/calls/:p/work` → workqueue.js · any signed-in user | opens: Form<br>refreshes list |  |  |
| Re-analyze / Analyze with AI | act | POST `/api/admin/ai/calls/:p/analyze` → ai.js · any signed-in user | opens: Call<br>refreshes list |  |  |
| Set as follow-up | act | POST `/api/admin/calls/:p/work` → workqueue.js · any signed-in user | opens: Call<br>refreshes list |  |  |
| Continue inspection | act | PATCH `/api/admin/qc/inspections/:p` (via inspectEditor) → qc.js · module check (owner/manager)<br>POST `/api/admin/qc/inspections/:p/sign` (via inspectEditor) → qc.js · any signed-in user | stays on page (message) |  |  |
| Add photos | act | GET `/api/admin/qc/inspections/:p` (via showInspection) → qc.js · any signed-in user<br>POST `/api/admin/documents` (via showInspection) → suite.js · any signed-in user<br>POST `/api/admin/ai/qc/:p/summary` (via showInspection) → ai.js · any signed-in user<br>POST `/api/admin/qc/inspections/:p/corrective` (via showInspection) → qc.js · any signed-in user<br>POST `/api/admin/qc/inspections/:p/reinspect` (via showInspection) → qc.js · any signed-in user<br>POST `/api/admin/qc/inspections/:p/accept` (via showInspection) → qc.js · any signed-in user | stays on page (message) |  |  |
| AI summary | act | GET `/api/admin/qc/inspections/:p` (via showInspection) → qc.js · any signed-in user<br>POST `/api/admin/documents` (via showInspection) → suite.js · any signed-in user<br>POST `/api/admin/ai/qc/:p/summary` (via showInspection) → ai.js · any signed-in user<br>POST `/api/admin/qc/inspections/:p/corrective` (via showInspection) → qc.js · any signed-in user<br>POST `/api/admin/qc/inspections/:p/reinspect` (via showInspection) → qc.js · any signed-in user<br>POST `/api/admin/qc/inspections/:p/accept` (via showInspection) → qc.js · any signed-in user | stays on page (message) |  |  |
| Create work orders | act | POST `/api/admin/qc/inspections/:p/corrective` → qc.js · any signed-in user | opens: Form<br>refreshes list |  |  |
| Start reinspection | act | PATCH `/api/admin/qc/inspections/:p` (via inspectEditor) → qc.js · module check (owner/manager)<br>POST `/api/admin/qc/inspections/:p/sign` (via inspectEditor) → qc.js · any signed-in user<br>POST `/api/admin/qc/inspections/:p/reinspect` → qc.js · any signed-in user | refreshes list |  |  |
| Record customer acceptance | act | POST `/api/admin/qc/inspections/:p/accept` → qc.js · any signed-in user | opens: Form<br>refreshes list |  |  |
| Preview | act | — | download/new tab |  |  |
| Upload new revision | act | POST `/api/admin/docs/:p/revision` → docs2.js · any signed-in user | opens: Form<br>refreshes list |  |  |
| Re-read with AI / Read blueprint with AI | act | POST `/api/admin/ai/documents/:p/blueprint` → ai.js · any signed-in user | refreshes list |  |  |
| Create takeoff | act | POST `/api/admin/docs/:p/takeoff` → docs2.js · any signed-in user | page: takeoffs |  |  |
| Archived / Restore / Archive | act | PATCH `/api/admin/docs/:p` → docs2.js · module check (owner/manager) | refreshes list |  |  |
| Edit | act | PUT `/api/admin/docs/:p/sheets` → docs2.js · any signed-in user | opens: Form<br>refreshes list |  |  |
| Approve dispatch | act | POST `/api/admin/pm/projects/:p/approve-dispatch` → pm.js · module check (owner/manager) | stays on page (message) |  |  |
| Record customer sign-off | act | POST `/api/admin/pm/projects/:p/signoff` → pm.js · module check (owner/manager) | opens: Form |  |  |
| Hand off to billing | act | POST `/api/admin/pm/projects/:p/billing-handoff` → pm.js · module check (owner/manager) | stays on page (message) |  |  |
| Form: Create work plan | act | POST `/api/admin/pm/projects/:p/plan` → pm.js · any signed-in user | stays on page (message) |  |  |
| Save customer | onclick | POST `/api/admin/calls/:p/customer` → calls2.js · any signed-in user | opens: Call<br>refreshes list |  |  |
| Add certificate | onclick | POST `/api/admin/insurance` → insurance.js · central gate: owner,manager | opens: Form<br>refreshes list |  |  |
| Add option | onclick | PUT `/api/admin/estimates/:p/options` (via draw) → proposal-options.js · any signed-in user | stays on page (message) |  |  |
| Save options | onclick | PUT `/api/admin/estimates/:p/options` (via draw) → proposal-options.js · any signed-in user | opens: Estimate |  |  |
| Save requirements | onclick | PUT `/api/admin/estimates/:p/insurance` → insurance.js · any signed-in user | stays on page (message) |  |  |
| Attach | onclick | POST `/api/admin/estimates/:p/insurance/:p` → insurance.js · any signed-in user | stays on page (message) |  |  |
| Refresh | onclick | — | refreshes list |  |  |
| Customize | onclick | PUT `/api/admin/prefs/:p` (via savePref) → command.js · any signed-in user | panel: Customize Live operations<br>refreshes list |  |  |
| Save | onclick | PUT `/api/admin/prefs/:p` (via savePref) → command.js · any signed-in user | refreshes list |  |  |
| + New | onclick | — | panel: New |  |  |
| Create draft invoices | onclick | POST `/api/admin/subscriptions/bill-run` → subscriptions.js · any signed-in user | refreshes list | yes |  |
| New subscription | onclick | POST `/api/admin/subscriptions` → subscriptions.js · any signed-in user | opens: Form<br>refreshes list |  |  |
| Open lead | onclick | — | opens: Lead |  |  |
| Save | onclick | POST `/api/admin/conversations/:p/state` (via saveState) → clientmsgs.js · any signed-in user | stays on page (message) |  |  |
| Mark read | onclick | POST `/api/admin/conversations/:p/state` (via saveState) → clientmsgs.js · any signed-in user | stays on page (message) |  |  |
| Flag for a person | onclick | POST `/api/admin/conversations/:p/state` (via saveState) → clientmsgs.js · any signed-in user | stays on page (message) |  |  |
| Follow-up tomorrow | onclick | POST `/api/admin/conversations/:p/state` (via saveState) → clientmsgs.js · any signed-in user | stays on page (message) |  |  |
| Save summary to history | onclick | POST `/api/admin/conversations/:p/note` → clientmsgs.js · any signed-in user | stays on page (message) | yes |  |
| Ask AI for a summary | onclick | POST `/api/admin/conversations/:p/assist` → clientmsgs.js · any signed-in user | stays on page (message) |  |  |
| input #cmFile | onchange | POST `/api/admin/documents` → suite.js · any signed-in user | stays on page (message) |  |  |
| ' + (cm.channel === 'portal' ? 'Send portal reply' : 'Send S | onclick | POST `/api/admin/conversations/:p/state` (via saveState) → clientmsgs.js · any signed-in user<br>POST `/api/admin/conversations/:p/note` → clientmsgs.js · any signed-in user<br>POST `/api/admin/messages/sms` → followups.js · any signed-in user<br>POST `/api/admin/portal-messages/:p/reply` → portal.js · any signed-in user | stays on page (message) | yes |  |
| Templates | onclick | — | panel: Approved templates |  |  |
| Automations | onclick | — | panel: Automations |  |  |
| New Message | onclick | GET `/api/admin/customers` → ops.js · any signed-in user<br>POST `/api/admin/messages/sms` → followups.js · any signed-in user | panel: New message<br>refreshes list | yes |  |
| Send SMS | onclick | POST `/api/admin/messages/sms` → followups.js · any signed-in user | refreshes list | yes |  |
| Edit details | onclick | PATCH `/api/admin/leads/:p` → server.js · any signed-in user | opens: Form<br>opens: Lead |  |  |
| Save | onclick | PATCH `/api/admin/leads/:p` → server.js · any signed-in user | stays on page (message) |  |  |
| Build estimate | onclick | — | opens: Estimator |  |  |
| Call back requested (automatic calls only go to leads marke | onchange | POST `/api/admin/leads/:p/callback-request` → calls2.js · any signed-in user | stays on page (message) |  |  |
| Convert to customer | onclick | GET `/api/admin/leads` (via refreshNewCount) → server.js · any signed-in user<br>POST `/api/admin/leads/:p/convert` → leadstage.js · module check (owner/manager) | page: customers<br>opens: CustomerPage | yes |  |
| Open customer | onclick | — | page: customers<br>opens: CustomerPage |  |  |
| Save follow-up | onclick | POST `/api/admin/leads/:p/follow-up` → leadstage.js · module check (owner/manager) | stays on page (message) |  |  |
| Clear | onclick | DELETE `/api/admin/leads/:p/follow-up` → leadstage.js · module check (owner/manager) | stays on page (message) |  |  |
| Delete | onclick | DELETE `/api/admin/leads/:p` → admin-ext.js · any signed-in user | stays on page (message) | yes |  |
| Start inspection | onclick | GET `/api/admin/qc/templates` (via newInspection) → qc.js · any signed-in user<br>GET `/api/admin/customers` (via newInspection) → ops.js · any signed-in user<br>GET `/api/admin/customers/:p/links` (via newInspection) → crm.js · any signed-in user<br>POST `/api/admin/qc/inspections` (via newInspection) → qc.js · any signed-in user | stays on page (message) |  |  |
| Form: Save contact | onsubmit | POST `/api/admin/customers/:p/contacts` → crm.js · any signed-in user | refreshes list |  |  |
| Form: Save property | onsubmit | POST `/api/admin/customers/:p/properties` → crm.js · any signed-in user | refreshes list |  |  |
| Form: Save note | onsubmit | POST `/api/admin/customers/:p/notes` → crm.js · any signed-in user | refreshes list |  |  |
| Log call | onclick | POST `/api/admin/customers/:p/email` (via custAction) → crm.js · any signed-in user<br>PATCH `/api/admin/customers/:p/account` (via custAction) → crm.js · any signed-in user<br>DELETE `/api/admin/customers/:p` (via custAction) → ops.js · module check (owner/manager) | stays on page (message) |  |  |
| Send email | onclick | POST `/api/admin/customers/:p/email` (via custAction) → crm.js · any signed-in user<br>PATCH `/api/admin/customers/:p/account` (via custAction) → crm.js · any signed-in user<br>DELETE `/api/admin/customers/:p` (via custAction) → ops.js · module check (owner/manager) | stays on page (message) |  |  |
| Create issue | onclick | POST `/api/admin/customers/:p/email` (via custAction) → crm.js · any signed-in user<br>PATCH `/api/admin/customers/:p/account` (via custAction) → crm.js · any signed-in user<br>DELETE `/api/admin/customers/:p` (via custAction) → ops.js · module check (owner/manager) | stays on page (message) |  |  |
| Create estimate / Create proposal | onclick | POST `/api/admin/customers/:p/email` (via custAction) → crm.js · any signed-in user<br>PATCH `/api/admin/customers/:p/account` (via custAction) → crm.js · any signed-in user<br>DELETE `/api/admin/customers/:p` (via custAction) → ops.js · module check (owner/manager) | stays on page (message) |  |  |
| New invoice | onclick | — | opens: Record |  |  |
| Upload files | onclick | POST `/api/admin/documents` (via uploadDocs) → suite.js · any signed-in user | stays on page (message) |  |  |
| Add customer / Save | onclick | POST `/api/admin/customers` → ops.js · any signed-in user<br>PATCH `/api/admin/customers/:p` → ops.js · any signed-in user<br>PATCH `/api/admin/customers/:p/account` → crm.js · any signed-in user | refreshes list |  |  |
| New estimate | onclick | — | opens: Estimator |  |  |
| Add | onclick | — | opens: Issue |  |  |
| Remove | onclick | DELETE `/api/admin/customers/:p` → ops.js · module check (owner/manager) | refreshes list | yes |  |
| Customer view | onclick | — | download/new tab |  |  |
| Edit | onclick | GET `/api/admin/estimates/:p` (via editEstimate) → server.js · any signed-in user | stays on page (message) |  |  |
| Sent / Viewed / Resend / actions / Send / approve… / Actions | onclick | — | opens: Estimate |  |  |
| Duplicate | onclick | POST `/api/admin/estimates/:p/duplicate` → admin-ext.js · any signed-in user | opens: Bid<br>refreshes list |  |  |
| Save | onclick | PATCH `/api/admin/bids/:p` → bids.js · any signed-in user | opens: Bid<br>refreshes list |  |  |
| Revise | onclick | POST `/api/admin/bids/:p/revise` → bids.js · any signed-in user | opens: Bid<br>refreshes list | yes |  |
| Withdraw | onclick | POST `/api/admin/bids/:p/withdraw` → bids.js · any signed-in user | opens: Bid<br>refreshes list |  |  |
| Schedule follow-up | onclick | POST `/api/admin/estimates/:p/followups` → followups.js · any signed-in user | stays on page (message) |  |  |
| Send text | onclick | POST `/api/admin/estimates/:p/sms` → followups.js · any signed-in user | stays on page (message) | yes |  |
| input #estFileIn | onchange | POST `/api/admin/documents` → suite.js · any signed-in user | refreshes list |  |  |
| Approve for sending | onclick | POST `/api/admin/estimates/:p/approve` → approvals.js · any signed-in user | opens: Estimate |  |  |
| ${options(STATUS.estimates.filter(x => x !== 'Approved' // e | onchange | GET `/api/admin/estimates/:p/approval` (via clearApproval) → approvals.js · module check (owner/manager)<br>POST `/api/admin/estimates/:p/approve` (via clearApproval) → approvals.js · any signed-in user<br>POST `/api/admin/estimates/:p/request-approval` (via clearApproval) → approvals.js · any signed-in user<br>PATCH `/api/admin/estimates/:p` → server.js · any signed-in user | opens: Estimate<br>refreshes list |  |  |
| Email to customer | onclick | GET `/api/admin/estimates/:p/approval` (via clearApproval) → approvals.js · module check (owner/manager)<br>POST `/api/admin/estimates/:p/approve` (via clearApproval) → approvals.js · any signed-in user<br>POST `/api/admin/estimates/:p/request-approval` (via clearApproval) → approvals.js · any signed-in user<br>POST `/api/admin/estimates/:p/send` → server.js · any signed-in user | refreshes list | yes |  |
| Edit | onclick | GET `/api/admin/estimates/:p` (via editEstimate) → server.js · any signed-in user | stays on page (message) |  |  |
| Duplicate | onclick | GET `/api/admin/estimates/:p` (via editEstimate) → server.js · any signed-in user<br>POST `/api/admin/estimates/:p/duplicate` → admin-ext.js · any signed-in user | stays on page (message) |  |  |
| Restore / Archive | onclick | POST `/api/admin/estimates/:p/archive` → estimate-archive.js · module check (owner/manager) | stays on page (message) | yes |  |
| Delete | onclick | DELETE `/api/admin/estimates/:p` → admin-ext.js · any signed-in user | stays on page (message) | yes |  |
| Trace | onclick | GET `/api/admin/accounting/trace` → trace.js · central gate: owner,manager | stays on page (message) |  |  |
| Import and match | onclick | POST `/api/admin/bank/import` → bank.js · central gate: owner,manager<br>POST `/api/admin/bank/auto-match` → bank.js · central gate: owner,manager<br>GET `/api/admin/bank/summary` → bank.js · central gate: owner,manager | stays on page (message) |  |  |
| Show tasks | onclick | GET `/api/admin/projects/:p/task-costs` → task-costs.js · central gate: owner,manager | stays on page (message) |  |  |
| Post adjustment | onclick | POST `/api/admin/ledger/adjustments` → ledger.js · central gate: owner,manager | refreshes list | yes |  |
| Reverse | onclick | POST `/api/admin/ledger/entries/:p/reverse` → ledger.js · central gate: owner,manager | refreshes list | yes |  |
| Earn | onclick | GET `/api/admin/invoices/:p/deposit` → invoice-ledger.js · central gate: owner,manager<br>POST `/api/admin/invoices/:p/earn` → invoice-ledger.js · central gate: owner,manager | refreshes list | yes |  |
| Run ledger sync | onclick | POST `/api/admin/ledger/sync` → invoice-ledger.js · central gate: owner,manager | refreshes list | yes |  |
| New bill | onclick | POST `/api/admin/expenses` → expenses.js · central gate: owner,manager | opens: Form<br>refreshes list |  |  |
| Close the books through a date | onclick | POST `/api/admin/ledger/periods/close` → periods.js · central gate: owner | opens: Form<br>refreshes list |  |  |
| Reconcile cash | onclick | POST `/api/admin/ledger/reconciliations` → periods.js · central gate: owner,manager | opens: Form<br>refreshes list |  |  |
| Save changes / Create  | onclick | PATCH `/api/admin/:p/:p` → bids.js · any signed-in user<br>POST `/api/admin/:p` → admin-ext.js · any signed-in user<br>PATCH `/api/admin/extra/:p/:p` → admin-ext.js · any signed-in user | stays on page (message) |  |  |
| Delete | onclick | DELETE `/api/admin/:p/:p` → admin-ext.js · any signed-in user | stays on page (message) | yes |  |
| Record payment | onclick | GET `/api/admin/invoices` (via recordPayment) → server.js · any signed-in user<br>POST `/api/admin/invoices/:p/payment` (via recordPayment) → admin-ext.js · central gate: owner,manager | stays on page (message) |  |  |
| Refund | onclick | POST `/api/admin/invoices/:p/refund` → admin-ext.js · central gate: owner,manager | opens: Form<br>refreshes list |  |  |
| Resend invoice / Send invoice | onclick | POST `/api/admin/invoices/:p/send` → invoices2.js · module check (owner/manager) | stays on page (message) |  |  |
| input #w9File | onchange | GET `/api/admin/company/w9` (via showW9) → invoices2.js · any signed-in user<br>POST `/api/admin/company/w9` → invoices2.js · module check (owner/manager) | stays on page (message) |  |  |
| Form: Save automatic callbacks | onsubmit | PUT `/api/admin/outbound-callbacks` → calls2.js · central gate: owner | refreshes list | yes |  |
| New API key | onclick | POST `/api/admin/api-keys` → integrations.js · central gate: owner | opens: Form<br>panel: Copy this key now<br>refreshes list |  |  |
| Form: Save | onsubmit | PUT `/api/admin/phone/callback-owner` → calls2.js · module check (owner/manager) | stays on page (message) |  |  |
| Run health check | onclick | GET `/api/admin/phone/health` → calls2.js · any signed-in user | stays on page (message) |  |  |
| Form: Send | onsubmit | POST `/api/admin/ai-receptionist/test` → calls2.js · any signed-in user | stays on page (message) |  |  |
| Form: Save AI receptionist | onsubmit | PUT `/api/admin/phone/settings` → calls2.js · module check (owner/manager) | stays on page (message) |  |  |
| Form: Save ring phones | onsubmit | PUT `/api/admin/phone/settings` → calls2.js · module check (owner/manager) | stays on page (message) |  |  |
| Review estimate | onclick | — | page: proposals<br>opens: Estimate |  |  |
| Draft estimate from this request | onclick | POST `/api/admin/leads/:p/draft-estimate` → autobid.js · any signed-in user | page: proposals<br>opens: Estimate |  |  |
| Send introduction email | onclick | POST `/api/admin/leads/:p/intro-email` → leadclass.js · any signed-in user | stays on page (message) | yes |  |
| ' + (ai && !ai.error ? 'Re-run AI' : 'Run AI triage') + ' | onclick | POST `/api/admin/ai/leads/:p/triage` → ai.js · any signed-in user | stays on page (message) |  |  |
| Send reply to | onclick | POST `/api/admin/leads/:p/reply` → ai.js · any signed-in user | stays on page (message) | yes |  |
| Text Messages | onclick | — | page: clientmsgs |  |  |
| Play recording | onclick | GET `/api/admin/calls/:p/recording` → calls2.js · any signed-in user | stays on page (message) |  |  |
| ${outcomes.map(o => ` | onchange | PATCH `/api/admin/calls/:p` → suite.js · any signed-in user | refreshes list |  |  |
| Send SMS | onclick | POST `/api/admin/messages/sms` → followups.js · any signed-in user | stays on page (message) | yes |  |
| Save note | onclick | POST `/api/admin/customers/:p/notes` → crm.js · any signed-in user<br>POST `/api/admin/leads/:p/activity` → leadlog.js · any signed-in user<br>PATCH `/api/admin/calls/:p` → suite.js · any signed-in user | refreshes list |  |  |
| Create task | onclick | POST `/api/admin/calls/:p/work` → workqueue.js · any signed-in user | refreshes list |  |  |
| New estimate | onclick | — | opens: Estimator |  |  |
| More | onclick | — | opens: Call |  |  |
| Create lead | onclick | POST `/api/admin/leads` → suite.js · any signed-in user<br>POST `/api/admin/calls/:p/lead` → callcenter.js · any signed-in user | refreshes list |  |  |
| Create customer | onclick | POST `/api/admin/calls/:p/customer` → calls2.js · any signed-in user | opens: Form<br>refreshes list |  |  |
| a #callCmp | onclick | — | page: quality<br>opens: Complaint |  |  |
| ▶ Play | onclick | GET `/api/admin/calls/:p/recording` → calls2.js · any signed-in user | download/new tab |  |  |
| Transcribe recording | onclick | POST `/api/admin/calls/:p/transcribe` → calls2.js · any signed-in user<br>GET `/api/admin/calls/:p/transcribe-status` → calls2.js · any signed-in user | opens: Call |  |  |
| Add holiday | onclick | GET `/api/admin/employees` (via drawDispTab) → sched.js · module check (owner/manager)<br>POST `/api/admin/employees/:p/onboarding/:p` (via drawDispTab) → sched.js · module check (owner/manager)<br>GET `/api/admin/employees/:p/onboarding` (via drawDispTab) → sched.js · module check (owner/manager)<br>POST `/api/admin/employees/:p/timeoff` (via drawDispTab) → sched.js · any signed-in user<br>POST `/api/admin/employees/:p/crew-pin` (via drawDispTab) → sched.js · module check (owner/manager)<br>GET `/api/admin/employees/:p/link` (via drawDispTab) → sched.js · module check (owner/manager)<br>POST `/api/admin/holidays` (via drawDispTab) → sched.js · any signed-in user<br>GET `/api/admin/time` (via drawDispTab) → sched.js · any signed-in user<br>POST `/api/admin/time/:p/approve` (via drawDispTab) → sched.js · module check (owner/manager)<br>POST `/api/admin/time` (via drawDispTab) → sched.js · any signed-in user | opens: Form |  |  |
| Add time entry | onclick | GET `/api/admin/employees` (via drawDispTab) → sched.js · module check (owner/manager)<br>POST `/api/admin/employees/:p/onboarding/:p` (via drawDispTab) → sched.js · module check (owner/manager)<br>GET `/api/admin/employees/:p/onboarding` (via drawDispTab) → sched.js · module check (owner/manager)<br>POST `/api/admin/employees/:p/timeoff` (via drawDispTab) → sched.js · any signed-in user<br>POST `/api/admin/employees/:p/crew-pin` (via drawDispTab) → sched.js · module check (owner/manager)<br>GET `/api/admin/employees/:p/link` (via drawDispTab) → sched.js · module check (owner/manager)<br>POST `/api/admin/holidays` (via drawDispTab) → sched.js · any signed-in user<br>GET `/api/admin/time` (via drawDispTab) → sched.js · any signed-in user<br>POST `/api/admin/time/:p/approve` (via drawDispTab) → sched.js · module check (owner/manager)<br>POST `/api/admin/time` (via drawDispTab) → sched.js · any signed-in user | opens: Form |  |  |
| All messages | onclick | — | opens: CrewMessages |  |  |
| ' + (cm.channel === 'portal' ? 'Send portal reply' : 'Send S | onclick | POST `/api/admin/crew-messages/:p` → sched.js · module check (owner/manager) | opens: CrewMessages |  |  |
| Email link to client | onclick | POST `/api/admin/visits/:p/send-tracking` → sched.js · any signed-in user | stays on page (message) |  |  |
| Approve | onclick | POST `/api/admin/visits/:p/review` (via rvDo) → sched.js · module check (owner/manager) | stays on page (message) |  |  |
| Send back | onclick | POST `/api/admin/visits/:p/review` (via rvDo) → sched.js · module check (owner/manager) | stays on page (message) |  |  |
| Save | onclick | PATCH `/api/admin/visits/:p` → suite.js · any signed-in user | stays on page (message) |  |  |
| Edit details | onclick | PATCH `/api/admin/visits/:p` (via scheduleVisit) → suite.js · any signed-in user<br>POST `/api/admin/visits` (via scheduleVisit) → suite.js · any signed-in user | stays on page (message) |  |  |
| Re-send to crew / Confirm dispatch | onclick | POST `/api/admin/dispatch/visits/:p/dispatch` → sched.js · module check (owner/manager) | stays on page (message) |  |  |
| Skip | onclick | POST `/api/admin/dispatch/visits/:p/skip` → sched.js · any signed-in user | refreshes list |  |  |
| Move | onclick | POST `/api/admin/dispatch/visits/:p/move` → sched.js · any signed-in user | opens: Form | yes |  |
| Form: Add schedule | onsubmit | GET `/api/admin/reports/finance` (via drawRep2) → reports2.js · central gate: owner,manager<br>GET `/api/admin/reports/monthly` (via drawRep2) → reports2.js · central gate: owner,manager<br>GET `/api/admin/reports/aging` (via drawRep2) → reports2.js · central gate: owner,manager<br>GET `/api/admin/reports/labor` (via drawRep2) → reports2.js · central gate: owner,manager<br>GET `/api/admin/reports/schedules` (via drawRep2) → reports2.js · central gate: owner,manager<br>POST `/api/admin/reports/schedules` (via drawRep2) → reports2.js · central gate: owner,manager<br>POST `/api/admin/reports/schedules/:p/send` (via drawRep2) → reports2.js · central gate: owner,manager<br>DELETE `/api/admin/reports/schedules/:p` (via drawRep2) → reports2.js · module check (owner/manager) | stays on page (message) |  |  |
| Call # | onclick | — | page: calls<br>opens: Call |  |  |
| Save note | onclick | POST `/api/admin/quality/complaints/:p/notes` → complaints.js · any signed-in user | stays on page (message) |  |  |
| Schedule corrective cleaning | onclick | POST `/api/admin/quality/complaints/:p/stage` → complaints.js · module check (owner/manager)<br>POST `/api/admin/quality/complaints/:p/corrective` → complaints.js · any signed-in user | stays on page (message) |  |  |
| Record reinspection | onclick | POST `/api/admin/quality/complaints/:p/reinspection` → complaints.js · any signed-in user | stays on page (message) |  |  |
| Save progress | onclick | PATCH `/api/admin/qc/inspections/:p` (via save) → qc.js · module check (owner/manager) | refreshes list |  |  |
| Sign inspection | onclick | PATCH `/api/admin/qc/inspections/:p` (via save) → qc.js · module check (owner/manager)<br>POST `/api/admin/qc/inspections/:p/sign` → qc.js · any signed-in user | refreshes list |  |  |
| ${['crew', 'inspector', 'customer', 'property', 'project', ' | onchange | GET `/api/admin/qc/report` (via drawQReports) → qc.js · any signed-in user | stays on page (message) |  |  |
| Apply to selected tasks | onclick | GET `/api/admin/work-queue` (via wqRender) → workqueue.js · any signed-in user<br>POST `/api/admin/tasks/:p/work` → workqueue.js · any signed-in user | stays on page (message) |  |  |
| + Add task | onclick | — | page: issues |  |  |
| Link | onclick | POST `/api/admin/inbox/:p/link` → workqueue.js · any signed-in user | refreshes list |  |  |
| Email Templates | onclick | GET `/api/admin/conversations` → clientmsgs.js · any signed-in user | panel: Email templates |  |  |
| Compose | onclick | — | opens: EmailCompose |  |  |
| Form: Block address | onsubmit | POST `/api/admin/email-suppression` → emailsuppress.js · any signed-in user | refreshes list |  |  |
| Connect Outlook | onclick | POST `/api/admin/m365/connect` → m365.js · module check (owner/manager) | stays on page (message) |  |  |
| Sync now | onclick | POST `/api/admin/m365/sync` → m365.js · any signed-in user | refreshes list |  |  |
| Disconnect | onclick | POST `/api/admin/m365/disconnect` → m365.js · module check (owner/manager) | refreshes list | yes |  |
| Save draft | onclick | POST `/api/admin/email-center/drafts/:p` → emailcenter.js · any signed-in user<br>GET `/api/admin/email-center` → emailcenter.js · any signed-in user | stays on page (message) |  |  |
| Send | onclick | POST `/api/admin/customers/:p/email` → crm.js · any signed-in user<br>DELETE `/api/admin/email-center/drafts/:p` → emailcenter.js · any signed-in user<br>GET `/api/admin/email-center` → emailcenter.js · any signed-in user | stays on page (message) | yes |  |
| Discard | onclick | DELETE `/api/admin/email-center/drafts/:p` → emailcenter.js · any signed-in user<br>GET `/api/admin/email-center` → emailcenter.js · any signed-in user | stays on page (message) | yes |  |
| Send | onclick | POST `/api/admin/customers/:p/email` → crm.js · any signed-in user<br>GET `/api/admin/email-center` → emailcenter.js · any signed-in user | stays on page (message) | yes |  |
| Send reply | onclick | POST `/api/admin/customers/:p/email` → crm.js · any signed-in user<br>GET `/api/admin/email-center` → emailcenter.js · any signed-in user | stays on page (message) | yes |  |
| Mark unread / Mark read | onclick | POST `/api/admin/email-center/:p/flags` (via flagAndRedraw) → emailcenter.js · any signed-in user<br>GET `/api/admin/email-center` (via flagAndRedraw) → emailcenter.js · any signed-in user | stays on page (message) |  |  |
| #emStar | onclick | POST `/api/admin/email-center/:p/flags` (via flagAndRedraw) → emailcenter.js · any signed-in user<br>GET `/api/admin/email-center` (via flagAndRedraw) → emailcenter.js · any signed-in user | stays on page (message) |  |  |
| Forward | onclick | — | opens: EmailCompose |  |  |
| Add note | onclick | POST `/api/admin/conversations/cust::p/note` → clientmsgs.js · any signed-in user<br>POST `/api/admin/conversations/lead::p/note` → clientmsgs.js · any signed-in user | stays on page (message) |  |  |
| Unarchive / Archive | onclick | POST `/api/admin/email-center/:p/archive` → emailcenter.js · any signed-in user<br>GET `/api/admin/email-center` → emailcenter.js · any signed-in user | stays on page (message) |  |  |
| Save as draft | onclick | POST `/api/admin/email-center/drafts` → emailcenter.js · any signed-in user<br>GET `/api/admin/email-center` → emailcenter.js · any signed-in user | stays on page (message) |  |  |
| Ask AI for a summary | onclick | POST `/api/admin/email-center/:p/assist` → emailcenter.js · any signed-in user | stays on page (message) |  |  |
| Create follow-up | onclick | POST `/api/admin/leads/:p/follow-up` → leadstage.js · module check (owner/manager) | stays on page (message) |  |  |
| Recalculate | onclick | PUT `/api/admin/takeoffs/:p/adjustments` (via save) → engine.js · any signed-in user | stays on page (message) |  |  |
| Update draft estimate / Create estimate | onclick | PUT `/api/admin/takeoffs/:p/adjustments` (via save) → engine.js · any signed-in user<br>POST `/api/admin/takeoffs/:p/estimate` → engine.js · any signed-in user | page: proposals<br>opens: Estimate | yes |  |
| Save takeoff | onclick | — | page: takeoffs<br>refreshes list |  |  |
| Create estimate from takeoff | onclick | POST `/api/admin/takeoffs/:p/estimate` → engine.js · any signed-in user | page: proposals<br>opens: Estimate | yes |  |
| Email customer update | onclick | POST `/api/admin/issues/:p/customer-update` → issues.js · any signed-in user | opens: Issue<br>refreshes list |  |  |
| Schedule corrective visit | onclick | POST `/api/admin/issues/:p/schedule-visit` → issues.js · any signed-in user | opens: Issue |  |  |
| select #i_cust | onchange | — | refreshes list |  |  |
| Delete note | onclick | DELETE `/api/admin/issues/:p` → issues.js · module check (owner/manager) | refreshes list | yes |  |
| Comment | onclick | POST `/api/admin/issues/:p/comments` → issues.js · any signed-in user | opens: Issue |  |  |
| Open project workspace | onclick | — | opens: Project |  |  |
| ← All projects | onclick | — | refreshes list |  |  |
| Link customer | onclick | POST `/api/admin/customers` → ops.js · any signed-in user<br>PATCH `/api/admin/pm/projects/:p` → pm.js · module check (owner/manager) | opens: Form<br>opens: Project |  |  |
| Edit project | onclick | PATCH `/api/admin/pm/projects/:p` → pm.js · module check (owner/manager) | opens: Form<br>opens: Project |  |  |
| Status &amp; next steps | onclick | POST `/api/admin/pm/projects/:p/status` → pm.js · any signed-in user | opens: Form<br>opens: Project |  |  |
| Form: Generate work orders | onsubmit | POST `/api/admin/pm/projects/:p/work-orders` → pm.js · any signed-in user | stays on page (message) |  |  |
| Form: Create work plan | onsubmit | POST `/api/admin/pm/projects/:p/plan` → pm.js · any signed-in user | stays on page (message) |  |  |
| Form: Add task | onsubmit | POST `/api/admin/pm/projects/:p/tasks` → pm.js · any signed-in user | stays on page (message) |  |  |
| Upload | onclick | POST `/api/admin/documents` (via uploadDocs) → suite.js · any signed-in user | stays on page (message) |  |  |
| Form: Save site information | onsubmit | PATCH `/api/admin/pm/projects/:p` → pm.js · module check (owner/manager) | stays on page (message) |  |  |
| All inspections | onclick | — | page: quality |  |  |
| New inspection | onclick | GET `/api/admin/qc/templates` → qc.js · any signed-in user<br>POST `/api/admin/qc/inspections` → qc.js · any signed-in user | opens: Form |  |  |
| Create issue | onclick | — | opens: Issue |  |  |
| Form: Record cost | onsubmit | POST `/api/admin/pm/projects/:p/costs` → pm.js · any signed-in user | stays on page (message) |  |  |
| Form: Log update | onsubmit | POST `/api/admin/pm/projects/:p/updates` → pm.js · any signed-in user | stays on page (message) |  |  |
| Add photo or video | onclick | — | opens: Form<br>refreshes list |  |  |
| Replace video / Upload a video | onclick | — | opens: Form<br>refreshes list |  |  |
| Use built-in video | onclick | DELETE `/api/admin/site-media/:p` → sitemedia.js · central gate: owner,manager,staff | refreshes list | yes |  |
| Add item / Save | onclick | POST `/api/admin/scopes` → scopes.js · any signed-in user<br>PATCH `/api/admin/scopes/:p` → scopes.js · any signed-in user | refreshes list |  |  |
| Archive | onclick | DELETE `/api/admin/scopes/:p` → scopes.js · any signed-in user | refreshes list | yes |  |
| Restore | onclick | PATCH `/api/admin/scopes/:p` → scopes.js · any signed-in user | refreshes list |  |  |
| Remove [data-insdel] | each-onclick | DELETE `/api/admin/insurance/:p` → insurance.js · central gate: owner,manager | refreshes list | yes |  |
| Collected-by-service bar [data-svc] | each-onclick | — | opens: Drill |  |  |
| #ccLive [data-cmpo] | each-onclick | — | page: quality<br>opens: Complaint |  |  |
| Live metric (drill-down) [data-drill] | each-onclick | — | opens: LeadList<br>opens: Drill |  |  |
| Live metric (drill-down) [data-drill] | each-onclick | — | opens: Drill |  |  |
| ' + esc(l) + ' [data-newk] | each-onclick | POST `/api/admin/leads` (via newLead) → suite.js · any signed-in user<br>GET `/api/admin/calls` (via logCall) → suite.js · any signed-in user<br>POST `/api/admin/calls` (via logCall) → suite.js · any signed-in user<br>POST `/api/admin/documents` (via uploadDocs) → suite.js · any signed-in user | page: customers<br>page: workqueue<br>opens: Estimator |  |  |
| Command Center KPI card | each-onclick | — | opens: Attention<br>opens: LeadList<br>opens: Drill |  |  |
| #cmKpis [data-cmk] | each-onclick | — | refreshes list |  |  |
| #cmBoxes [data-cmb] | each-onclick | — | refreshes list |  |  |
| ' + esc(l) + ' [data-cms] | each-onchange | — | refreshes list |  |  |
| Mark real [data-lb] | each-onclick | GET `/api/admin/leads` (via refreshNewCount) → server.js · any signed-in user<br>POST `/api/admin/leads/bulk` → admin-ext.js · module check (owner/manager) | stays on page (message) | yes |  |
| Active [data-cust] | each-onclick | — | opens: CustomerPage |  |  |
| · [data-insp] | each-onclick | GET `/api/admin/qc/inspections/:p` (via showInspection) → qc.js · any signed-in user<br>POST `/api/admin/documents` (via showInspection) → suite.js · any signed-in user<br>POST `/api/admin/ai/qc/:p/summary` (via showInspection) → ai.js · any signed-in user<br>POST `/api/admin/qc/inspections/:p/corrective` (via showInspection) → qc.js · any signed-in user<br>POST `/api/admin/qc/inspections/:p/reinspect` (via showInspection) → qc.js · any signed-in user<br>POST `/api/admin/qc/inspections/:p/accept` (via showInspection) → qc.js · any signed-in user | stays on page (message) |  |  |
| Edit customer [data-a] | each-onclick | POST `/api/admin/customers/:p/email` (via custAction) → crm.js · any signed-in user<br>PATCH `/api/admin/customers/:p/account` (via custAction) → crm.js · any signed-in user<br>DELETE `/api/admin/customers/:p` (via custAction) → ops.js · module check (owner/manager) | stays on page (message) |  |  |
| Edit customer [data-a] | each-onclick | POST `/api/admin/customers/:p/email` (via custAction) → crm.js · any signed-in user<br>PATCH `/api/admin/customers/:p/account` (via custAction) → crm.js · any signed-in user<br>DELETE `/api/admin/customers/:p` (via custAction) → ops.js · module check (owner/manager) | stays on page (message) |  |  |
| Edit [data-ctedit] | each-onclick | PATCH `/api/admin/customers/:p/contacts/:p` → crm.js · any signed-in user | opens: Form<br>refreshes list |  |  |
| Make primary [data-prim] | each-onclick | PATCH `/api/admin/customers/:p/contacts/:p` → crm.js · any signed-in user | refreshes list |  |  |
| Remove [data-rmct] | each-onclick | DELETE `/api/admin/customers/:p/contacts/:p` → crm.js · any signed-in user | refreshes list | yes |  |
| Active / Inactive [data-pst] | each-onclick | PATCH `/api/admin/customers/:p/properties/:p` → crm.js · any signed-in user | refreshes list |  |  |
| Unpin / Pin [data-pin] | each-onclick | PATCH `/api/admin/customers/:p/notes/:p` → crm.js · module check (owner/manager) | refreshes list |  |  |
| Issue row (open) [data-iss] | each-onclick | — | opens: Issue |  |  |
| Record payment [data-pay] | each-onclick | GET `/api/admin/invoices` (via recordPayment) → server.js · any signed-in user<br>POST `/api/admin/invoices/:p/payment` (via recordPayment) → admin-ext.js · central gate: owner,manager | stays on page (message) |  |  |
| Issue row (open) [data-iss] | each-onclick | — | opens: Issue |  |  |
| Tab buttons #propTabs | each-onclick | — | page: contracts<br>refreshes list |  |  |
| Not categorized [data-est] | each-onclick | — | opens: Estimate |  |  |
| Edit [data-edit] | each-onclick | GET `/api/admin/estimates/:p` (via editEstimate) → server.js · any signed-in user | stays on page (message) |  |  |
| Details [data-det] | each-onclick | — | opens: Bid |  |  |
| open [data-ver] | each-onclick | — | opens: Bid |  |  |
| Set budget [data-acctask] | each-onclick | POST `/api/admin/projects/:p/tasks/:p/budget` → task-costs.js · central gate: owner,manager | opens: Form |  |  |
| v [data-kv] | each-onclick | — | opens: Contract |  |  |
| Revoke [data-apirevoke] | each-onclick | POST `/api/admin/api-keys/:p/revoke` → integrations.js · central gate: owner | refreshes list | yes |  |
| Automation switch [data-auto] | each-onchange | PUT `/api/admin/settings` → ops.js · central gate: owner,manager | stays on page (message) |  |  |
| ${['owner', 'manager', 'supervisor', 'inspector', 'sales', ' [data-role] | each-onchange | PATCH `/api/admin/users/:p/role` → admin-ext.js · module check (owner/manager) | refreshes list | yes |  |
| Remove [data-deluser] | each-onclick | DELETE `/api/admin/users/:p` → admin-ext.js · central gate: owner | refreshes list | yes |  |
| Search result (open) [data-g] | each-onclick | — | page: leads<br>page: proposals<br>page: projects<br>page: invoices<br>page: issues<br>page: documents<br>page: calls<br>opens: Lead<br>opens: CustomerPage<br>opens: Estimate<br>opens: Record<br>opens: Issue |  |  |
| ' + esc(m.company // m.name // 'Lead') + ' [data-cc-lead] | each-onclick | — | opens: Lead |  |  |
| Done [data-visit] | each-onclick | — | opens: Job |  |  |
| Done [data-due] | each-onclick | — | page: projects<br>opens: Record |  |  |
| Tab buttons #schTabs | each-onclick | GET `/api/admin/employees` (via drawDispTab) → sched.js · module check (owner/manager)<br>POST `/api/admin/employees/:p/onboarding/:p` (via drawDispTab) → sched.js · module check (owner/manager)<br>GET `/api/admin/employees/:p/onboarding` (via drawDispTab) → sched.js · module check (owner/manager)<br>POST `/api/admin/employees/:p/timeoff` (via drawDispTab) → sched.js · any signed-in user<br>POST `/api/admin/employees/:p/crew-pin` (via drawDispTab) → sched.js · module check (owner/manager)<br>GET `/api/admin/employees/:p/link` (via drawDispTab) → sched.js · module check (owner/manager)<br>POST `/api/admin/holidays` (via drawDispTab) → sched.js · any signed-in user<br>GET `/api/admin/time` (via drawDispTab) → sched.js · any signed-in user<br>POST `/api/admin/time/:p/approve` (via drawDispTab) → sched.js · module check (owner/manager)<br>POST `/api/admin/time` (via drawDispTab) → sched.js · any signed-in user | stays on page (message) |  |  |
| Assign [data-job] | each-onclick | — | opens: Job |  |  |
| Assign [data-job] | each-onclick | — | opens: Job |  |  |
| Onboarding [data-ob] | each-onclick | POST `/api/admin/employees/:p/onboarding/:p` (via bind) → sched.js · module check (owner/manager)<br>GET `/api/admin/employees/:p/onboarding` → sched.js · module check (owner/manager) | panel: Onboarding: |  |  |
| #drawerRoot [data-obk] | each-onchange | POST `/api/admin/employees/:p/onboarding/:p` (via bind) → sched.js · module check (owner/manager) | stays on page (message) |  |  |
| Pause [data-to] | each-onclick | GET `/api/admin/employees` (via drawDispTab) → sched.js · module check (owner/manager)<br>POST `/api/admin/employees/:p/onboarding/:p` (via drawDispTab) → sched.js · module check (owner/manager)<br>GET `/api/admin/employees/:p/onboarding` (via drawDispTab) → sched.js · module check (owner/manager)<br>POST `/api/admin/employees/:p/timeoff` (via drawDispTab) → sched.js · any signed-in user<br>POST `/api/admin/employees/:p/crew-pin` (via drawDispTab) → sched.js · module check (owner/manager)<br>GET `/api/admin/employees/:p/link` (via drawDispTab) → sched.js · module check (owner/manager)<br>POST `/api/admin/holidays` (via drawDispTab) → sched.js · any signed-in user<br>GET `/api/admin/time` (via drawDispTab) → sched.js · any signed-in user<br>POST `/api/admin/time/:p/approve` (via drawDispTab) → sched.js · module check (owner/manager)<br>POST `/api/admin/time` (via drawDispTab) → sched.js · any signed-in user | opens: Form<br>refreshes list |  |  |
| Unpin / Pin [data-pin] | each-onclick | POST `/api/admin/employees/:p/crew-pin` → sched.js · module check (owner/manager) | stays on page (message) |  |  |
| Crew link [data-link] | each-onclick | GET `/api/admin/employees/:p/link` → sched.js · module check (owner/manager) | stays on page (message) |  |  |
| Approve [data-ap] | each-onclick | GET `/api/admin/employees` (via drawDispTab) → sched.js · module check (owner/manager)<br>POST `/api/admin/employees/:p/onboarding/:p` (via drawDispTab) → sched.js · module check (owner/manager)<br>GET `/api/admin/employees/:p/onboarding` (via drawDispTab) → sched.js · module check (owner/manager)<br>POST `/api/admin/employees/:p/timeoff` (via drawDispTab) → sched.js · any signed-in user<br>POST `/api/admin/employees/:p/crew-pin` (via drawDispTab) → sched.js · module check (owner/manager)<br>GET `/api/admin/employees/:p/link` (via drawDispTab) → sched.js · module check (owner/manager)<br>POST `/api/admin/holidays` (via drawDispTab) → sched.js · any signed-in user<br>GET `/api/admin/time` (via drawDispTab) → sched.js · any signed-in user<br>POST `/api/admin/time/:p/approve` (via drawDispTab) → sched.js · module check (owner/manager)<br>POST `/api/admin/time` (via drawDispTab) → sched.js · any signed-in user | stays on page (message) |  |  |
| #drawerRoot [data-cm] | each-onclick | — | opens: CrewMessages |  |  |
| #drawerRoot [data-open-photo] | each-onclick | — | download/new tab |  |  |
| /^overtime/.test(w)) ? 1 : 0}">Assign [data-as] | each-onclick | POST `/api/admin/dispatch/visits/:p/crew` → sched.js · module check (owner/manager) | stays on page (message) |  |  |
| Remove [data-un] | each-onclick | POST `/api/admin/dispatch/visits/:p/crew` → sched.js · module check (owner/manager) | stays on page (message) |  |  |
| Tab buttons #repTabs | each-onclick | GET `/api/admin/reports/finance` (via drawRep2) → reports2.js · central gate: owner,manager<br>GET `/api/admin/reports/monthly` (via drawRep2) → reports2.js · central gate: owner,manager<br>GET `/api/admin/reports/aging` (via drawRep2) → reports2.js · central gate: owner,manager<br>GET `/api/admin/reports/labor` (via drawRep2) → reports2.js · central gate: owner,manager<br>GET `/api/admin/reports/schedules` (via drawRep2) → reports2.js · central gate: owner,manager<br>POST `/api/admin/reports/schedules` (via drawRep2) → reports2.js · central gate: owner,manager<br>POST `/api/admin/reports/schedules/:p/send` (via drawRep2) → reports2.js · central gate: owner,manager<br>DELETE `/api/admin/reports/schedules/:p` (via drawRep2) → reports2.js · module check (owner/manager) | stays on page (message) |  |  |
| Send now [data-rs] | each-onclick | GET `/api/admin/reports/finance` (via drawRep2) → reports2.js · central gate: owner,manager<br>GET `/api/admin/reports/monthly` (via drawRep2) → reports2.js · central gate: owner,manager<br>GET `/api/admin/reports/aging` (via drawRep2) → reports2.js · central gate: owner,manager<br>GET `/api/admin/reports/labor` (via drawRep2) → reports2.js · central gate: owner,manager<br>GET `/api/admin/reports/schedules` (via drawRep2) → reports2.js · central gate: owner,manager<br>POST `/api/admin/reports/schedules` (via drawRep2) → reports2.js · central gate: owner,manager<br>POST `/api/admin/reports/schedules/:p/send` (via drawRep2) → reports2.js · central gate: owner,manager<br>DELETE `/api/admin/reports/schedules/:p` (via drawRep2) → reports2.js · module check (owner/manager) | stays on page (message) |  |  |
| Remove [data-rd] | each-onclick | GET `/api/admin/reports/finance` (via drawRep2) → reports2.js · central gate: owner,manager<br>GET `/api/admin/reports/monthly` (via drawRep2) → reports2.js · central gate: owner,manager<br>GET `/api/admin/reports/aging` (via drawRep2) → reports2.js · central gate: owner,manager<br>GET `/api/admin/reports/labor` (via drawRep2) → reports2.js · central gate: owner,manager<br>GET `/api/admin/reports/schedules` (via drawRep2) → reports2.js · central gate: owner,manager<br>POST `/api/admin/reports/schedules` (via drawRep2) → reports2.js · central gate: owner,manager<br>POST `/api/admin/reports/schedules/:p/send` (via drawRep2) → reports2.js · central gate: owner,manager<br>DELETE `/api/admin/reports/schedules/:p` (via drawRep2) → reports2.js · module check (owner/manager) | stays on page (message) | yes |  |
| #qcComplaints [data-cf] | each-onclick | — | refreshes list |  |  |
| ' + l + ' [data-cmp] | each-onclick | — | opens: Complaint |  |  |
| Log update [data-acc] | each-onclick | POST `/api/admin/quality/complaints/:p/customer-contact` → complaints.js · any signed-in user | stays on page (message) |  |  |
| Pause [data-to] | each-onclick | POST `/api/admin/quality/complaints/:p/stage` → complaints.js · module check (owner/manager) | stays on page (message) | yes |  |
| · [data-insp] | each-onclick | GET `/api/admin/qc/inspections/:p` (via showInspection) → qc.js · any signed-in user<br>POST `/api/admin/documents` (via showInspection) → suite.js · any signed-in user<br>POST `/api/admin/ai/qc/:p/summary` (via showInspection) → ai.js · any signed-in user<br>POST `/api/admin/qc/inspections/:p/corrective` (via showInspection) → qc.js · any signed-in user<br>POST `/api/admin/qc/inspections/:p/reinspect` (via showInspection) → qc.js · any signed-in user<br>POST `/api/admin/qc/inspections/:p/accept` (via showInspection) → qc.js · any signed-in user | stays on page (message) |  |  |
| Issue row (open) [data-iss] | each-onclick | — | opens: Issue |  |  |
| · ${x.score == null ? 'in progress' : x.s [data-ri] | each-onclick | GET `/api/admin/qc/inspections/:p` (via showInspection) → qc.js · any signed-in user<br>POST `/api/admin/documents` (via showInspection) → suite.js · any signed-in user<br>POST `/api/admin/ai/qc/:p/summary` (via showInspection) → ai.js · any signed-in user<br>POST `/api/admin/qc/inspections/:p/corrective` (via showInspection) → qc.js · any signed-in user<br>POST `/api/admin/qc/inspections/:p/reinspect` (via showInspection) → qc.js · any signed-in user<br>POST `/api/admin/qc/inspections/:p/accept` (via showInspection) → qc.js · any signed-in user | stays on page (message) |  |  |
| Edit [data-te] | each-onclick | PUT `/api/admin/qc/templates/:p` → qc.js · module check (owner/manager) | opens: Form<br>refreshes list |  |  |
| #documentsRows [data-dsel] | each-onclick | GET `/api/admin/docs/:p` (via showDoc) → docs2.js · any signed-in user<br>POST `/api/admin/docs/:p/revision` (via showDoc) → docs2.js · any signed-in user<br>POST `/api/admin/ai/documents/:p/blueprint` (via showDoc) → ai.js · any signed-in user<br>POST `/api/admin/docs/:p/takeoff` (via showDoc) → docs2.js · any signed-in user<br>PATCH `/api/admin/docs/:p` (via showDoc) → docs2.js · module check (owner/manager)<br>PUT `/api/admin/docs/:p/sheets` (via showDoc) → docs2.js · any signed-in user | stays on page (message) |  |  |
| Takeoff [data-totake] | each-onclick | — | opens: Takeoff |  |  |
| #docSide [data-dopen] | each-onclick | GET `/api/admin/docs/:p` (via showDoc) → docs2.js · any signed-in user<br>POST `/api/admin/docs/:p/revision` (via showDoc) → docs2.js · any signed-in user<br>POST `/api/admin/ai/documents/:p/blueprint` (via showDoc) → ai.js · any signed-in user<br>POST `/api/admin/docs/:p/takeoff` (via showDoc) → docs2.js · any signed-in user<br>PATCH `/api/admin/docs/:p` (via showDoc) → docs2.js · module check (owner/manager)<br>PUT `/api/admin/docs/:p/sheets` (via showDoc) → docs2.js · any signed-in user | stays on page (message) |  |  |
| Takeoff row (open) [data-tko] | each-onclick | — | page: takeoffs |  |  |
| Lead # [data-ilead] | each-onclick | — | page: leads<br>opens: Lead |  |  |
| Customer # [data-icust] | each-onclick | — | page: customers<br>opens: CustomerPage |  |  |
| Remove [data-unblock] | each-onclick | DELETE `/api/admin/email-suppression/:p` → emailsuppress.js · module check (owner/manager) | refreshes list | yes |  |
| Pause [data-to] | each-onclick | — | opens: Takeoff |  |  |
| Price [data-price] | each-onclick | — | opens: Pricing |  |  |
| #prForm input[type=checkbox] | each-onchange | PUT `/api/admin/takeoffs/:p/adjustments` (via save) → engine.js · any signed-in user | stays on page (message) |  |  |
| Tab buttons #issTabs | each-onclick | — | refreshes list |  |  |
| Issue link (open) [data-issue] | each-onclick | — | opens: Issue |  |  |
| #drawerRoot [data-ty] | each-onclick | POST `/api/admin/issues/:p/customer-update` (via draw) → issues.js · any signed-in user<br>POST `/api/admin/issues/:p/schedule-visit` (via draw) → issues.js · any signed-in user | stays on page (message) |  |  |
| #tkind button | each-onclick | POST `/api/admin/issues/:p/customer-update` (via draw) → issues.js · any signed-in user<br>POST `/api/admin/issues/:p/schedule-visit` (via draw) → issues.js · any signed-in user | stays on page (message) |  |  |
| Tab buttons #pjTabs | each-onclick | — | refreshes list |  |  |
| #rows-projects [data-pj] | each-onclick | GET `/api/admin/pm/projects/:p` (via drawPjSide) → pm.js · any signed-in user | stays on page (message) |  |  |
| Schedule work [data-w] | each-onclick | — | opens: Project |  |  |
| #pjWork [data-wt] | each-onclick | POST `/api/admin/customers` (via drawWork) → ops.js · any signed-in user<br>PATCH `/api/admin/pm/projects/:p` (via drawWork) → pm.js · module check (owner/manager)<br>POST `/api/admin/pm/projects/:p/status` (via drawWork) → pm.js · any signed-in user<br>POST `/api/admin/pm/projects/:p/readiness` (via drawWork) → pm.js · any signed-in user<br>POST `/api/admin/pm/projects/:p/approve-dispatch` (via drawWork) → pm.js · module check (owner/manager)<br>POST `/api/admin/pm/projects/:p/signoff` (via drawWork) → pm.js · module check (owner/manager)<br>POST `/api/admin/pm/projects/:p/billing-handoff` (via drawWork) → pm.js · module check (owner/manager)<br>POST `/api/admin/pm/projects/:p/work-orders` (via drawWork) → pm.js · any signed-in user<br>POST `/api/admin/pm/projects/:p/plan` (via drawWork) → pm.js · any signed-in user<br>POST `/api/admin/pm/projects/:p/tasks` (via drawWork) → pm.js · any signed-in user<br>PATCH `/api/admin/pm/tasks/:p` (via drawWork) → pm.js · module check (owner/manager)<br>GET `/api/admin/qc/templates` (via drawWork) → qc.js · any signed-in user<br>POST `/api/admin/qc/inspections` (via drawWork) → qc.js · any signed-in user<br>POST `/api/admin/pm/projects/:p/costs` (via drawWork) → pm.js · any signed-in user<br>POST `/api/admin/pm/projects/:p/updates` (via drawWork) → pm.js · any signed-in user | stays on page (message) |  |  |
| Readiness item [data-rk] | each-onchange | POST `/api/admin/pm/projects/:p/readiness` → pm.js · any signed-in user | stays on page (message) |  |  |
| Mark done [data-ts] | each-onclick | PATCH `/api/admin/pm/tasks/:p` → pm.js · module check (owner/manager) | stays on page (message) |  |  |
| Accept [data-ta] | each-onclick | PATCH `/api/admin/pm/tasks/:p` → pm.js · module check (owner/manager) | stays on page (message) |  |  |
| Issue row (open) [data-iss] | each-onclick | — | opens: Issue |  |  |
| Edit [data-wedit] | each-onclick | — | opens: Form<br>refreshes list |  |  |
| Hide / Show [data-wvis] | each-onclick | — | refreshes list |  |  |
| ↑ [data-wmove] | each-onclick | POST `/api/admin/site-media/reorder` → sitemedia.js · central gate: owner,manager,staff | refreshes list |  |  |
| Delete [data-wdel] | each-onclick | DELETE `/api/admin/site-media/:p` → sitemedia.js · central gate: owner,manager,staff | refreshes list | yes |  |
| Cleaning scope row (open) [data-scope] | each-onclick | — | opens: Scope |  |  |
| Form: Sign in | listen-submit | GET `/api/admin/me` (via start) → admin-ext.js · module check (owner/manager)<br>GET `/api/admin/people` (via start) → admin-ext.js · any signed-in user<br>GET `/api/admin/phone/settings` (via initPhone) → calls2.js · any signed-in user<br>GET `/api/admin/voice/token` (via initPhone) → calls2.js · any signed-in user<br>GET `/api/admin/customers` (via initPhone) → ops.js · any signed-in user<br>POST `/api/admin/login/mfa` → mfa.js · public<br>POST `/api/admin/login` → server.js · public | refreshes list |  |  |
| Sign out | listen-click | POST `/api/admin/logout` (via signOut) → admin-ext.js · any signed-in user | stays on page (message) |  |  |
| Set up two-step sign-in | listen-click | POST `/api/admin/mfa/setup` → mfa.js · any signed-in user | stays on page (message) |  |  |
| Cancel | listen-click | POST `/api/admin/mfa/cancel` → mfa.js · any signed-in user | stays on page (message) |  |  |
| Turn on | listen-click | POST `/api/admin/mfa/enable` → mfa.js · any signed-in user | stays on page (message) |  |  |
| Turn off two-step sign-in | listen-click | POST `/api/admin/mfa/disable` → mfa.js · any signed-in user | refreshes list |  |  |
| select: Period | listen-change | PUT `/api/admin/prefs/:p` (via savePref) → command.js · any signed-in user | refreshes list |  |  |
| Export CSV | listen-click | — | download/new tab |  |  |
| New customer | listen-click | — | opens: Customer |  |  |
| Export CSV | listen-click | — | download/new tab |  |  |
| Generate estimate with AI | listen-click | POST `/api/admin/ai/estimates/generate` → ai.js · any signed-in user | opens: Bid<br>refreshes list |  |  |
| Refresh | listen-click | — | refreshes list |  |  |
| Export CSV | listen-click | — | download/new tab |  |  |
| Form: Change password | listen-submit | POST `/api/admin/account/password` → admin-ext.js · module check (owner/manager) | stays on page (message) |  |  |
| Form: Save rules | listen-submit | PUT `/api/admin/approval-rules` → approvals.js · module check (owner/manager) | stays on page (message) |  |  |
| Run automations now | listen-click | POST `/api/admin/automation/run` → ops.js · any signed-in user | refreshes list |  |  |
| Back up now | listen-click | POST `/api/admin/backups` → ops.js · central gate: owner | refreshes list |  |  |
| Form: Give access | listen-submit | POST `/api/admin/users` → admin-ext.js · central gate: owner | refreshes list |  |  |
| Log call | listen-click | GET `/api/admin/calls` (via logCall) → suite.js · any signed-in user<br>POST `/api/admin/calls` (via logCall) → suite.js · any signed-in user | stays on page (message) |  |  |
| Follow-ups due | listen-change | PUT `/api/admin/prefs/:p` (via savePref) → command.js · any signed-in user | stays on page (message) |  |  |
| Voicemails | listen-change | PUT `/api/admin/prefs/:p` (via savePref) → command.js · any signed-in user | stays on page (message) |  |  |
| Schedule job | listen-click | PATCH `/api/admin/visits/:p` (via scheduleVisit) → suite.js · any signed-in user<br>POST `/api/admin/visits` (via scheduleVisit) → suite.js · any signed-in user | stays on page (message) |  |  |
| Crew messages | listen-click | — | opens: CrewMessages |  |  |
| select: Range | listen-change | — | refreshes list |  |  |
| select: View | listen-change | — | refreshes list |  |  |
| Apply | listen-click | GET `/api/admin/reports/finance` (via drawRep2) → reports2.js · central gate: owner,manager<br>GET `/api/admin/reports/monthly` (via drawRep2) → reports2.js · central gate: owner,manager<br>GET `/api/admin/reports/aging` (via drawRep2) → reports2.js · central gate: owner,manager<br>GET `/api/admin/reports/labor` (via drawRep2) → reports2.js · central gate: owner,manager<br>GET `/api/admin/reports/schedules` (via drawRep2) → reports2.js · central gate: owner,manager<br>POST `/api/admin/reports/schedules` (via drawRep2) → reports2.js · central gate: owner,manager<br>POST `/api/admin/reports/schedules/:p/send` (via drawRep2) → reports2.js · central gate: owner,manager<br>DELETE `/api/admin/reports/schedules/:p` (via drawRep2) → reports2.js · module check (owner/manager) | stays on page (message) |  |  |
| New inspection | listen-click | GET `/api/admin/qc/templates` (via newInspection) → qc.js · any signed-in user<br>GET `/api/admin/customers` (via newInspection) → ops.js · any signed-in user<br>GET `/api/admin/customers/:p/links` (via newInspection) → crm.js · any signed-in user<br>POST `/api/admin/qc/inspections` (via newInspection) → qc.js · any signed-in user | stays on page (message) |  |  |
| Export CSV | listen-click | — | download/new tab |  |  |
| Upload files | listen-click | POST `/api/admin/documents` (via uploadDocs) → suite.js · any signed-in user | stays on page (message) |  |  |
| #wqAtt | listen-click | GET `/api/admin/inbox/:p/attachments/:p` → m365.js · any signed-in user | download/new tab |  |  |
| #wqDepts | listen-click | GET `/api/admin/work-queue` (via wqRender) → workqueue.js · any signed-in user | stays on page (message) |  |  |
| #wqBuckets | listen-click | GET `/api/admin/work-queue` (via wqRender) → workqueue.js · any signed-in user | stays on page (message) |  |  |
| select: Owner | listen-change | GET `/api/admin/work-queue` (via wqRender) → workqueue.js · any signed-in user | stays on page (message) |  |  |
| #wqRows | listen-click | POST `/api/admin/tasks/:p/work` (via wqAct) → workqueue.js · any signed-in user<br>POST `/api/admin/work-queue/estimates/:p/work` (via wqAct) → workqueue.js · any signed-in user<br>POST `/api/admin/work-queue/conversations/:p/work` (via wqAct) → workqueue.js · any signed-in user<br>POST `/api/admin/work-queue/invoices/:p/work` (via wqAct) → workqueue.js · any signed-in user<br>POST `/api/admin/leads/:p/work` (via wqAct) → leadstage.js · module check (owner/manager) | stays on page (message) |  |  |
| End-of-day report | listen-click | — | opens: Closeout |  |  |
| New takeoff | listen-click | — | opens: Takeoff |  |  |
| select: Period | listen-change | — | refreshes list |  |  |
| Ask | listen-click | POST `/api/admin/ai/reports/ask` → ai.js · any signed-in user | stays on page (message) |  |  |
| Create new item | listen-click | — | opens: Issue |  |  |
| Export CSV | listen-click | — | download/new tab |  |  |
| Export CSV | listen-click | — | download/new tab |  |  |
| Add scope item | listen-click | — | opens: Scope |  |  |
| Import price book | listen-click | POST `/api/admin/scopes/import-pricebook` → scopes.js · any signed-in user | refreshes list | yes |  |

## Server routes with no admin control (34)
Not necessarily dead: some serve the public site, crews, webhooks, exports or scheduled jobs. Review before removing anything.

- GET /api/admin/roles (admin-ext.js)
- GET /api/admin/vendors (aging.js)
- POST /api/admin/vendors (aging.js)
- GET /api/admin/approvals/pending (approvals.js)
- GET /api/admin/ledger/audit (audit.js)
- GET /api/admin/automation/ai-settings (autobid.js)
- PUT /api/admin/automation/ai-settings (autobid.js)
- GET /api/admin/bank/lines (bank.js)
- POST /api/admin/bank/lines/:p/match (bank.js)
- POST /api/admin/test-call (calls2.js)
- GET /api/admin/ledger/compare (compare.js)
- PUT /api/admin/quality/settings (complaints.js)
- GET /api/admin/quality/settings (complaints.js)
- GET /api/admin/contract-value (contract-value.js)
- POST /api/admin/ledger/payroll-payment (expenses.js)
- GET /api/admin/ledger/sales-tax (exports.js)
- PUT /api/admin/followups/auto-sms (followups.js)
- POST /api/admin/email/test (followups.js)
- POST /api/admin/insurance/check-expiry (insurance.js)
- GET /api/admin/integrity (integrity.js)
- GET /api/admin/invoices/needs-refund (invoices2.js)
- PUT /api/admin/issues/config (issues.js)
- POST /api/admin/issues/run-reminders (issues.js)
- GET /api/admin/ledger/accounts (ledger.js)
- GET /api/admin/ledger/trial-balance (ledger.js)
- GET /api/admin/system-health (monitoring.js)
- GET /api/admin/financial-summary (server.js)
- GET /api/admin/blocked-intake (spam-screen.js)
- POST /api/admin/time-entries/:p/task (task-costs.js)
- POST /api/admin/project-costs/:p/task (task-costs.js)
- GET /api/admin/work-items (work-engine.js)
- GET /api/admin/work-items/:p (work-engine.js)
- POST /api/admin/work-items (work-engine.js)
- POST /api/admin/work-items/:p/:p (work-engine.js)

## Dangling calls
None — every button calls a route that exists.
