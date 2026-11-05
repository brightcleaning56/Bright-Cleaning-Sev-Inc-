// Bright Clean roles: one place for who may do what. Enforced on the server (central gate in server.js);
// the admin UI only shows the pages a role can use. Cleaners use their private crew page; customers use their
// proposal/contract/invoice links — neither has an admin login.
const ROLES = {
  owner: { label: 'Owner', desc: 'Everything, including users, roles, backups and company settings.' },
  manager: { label: 'Manager', desc: 'All operations, approvals and finance. Cannot manage users, roles or backups.' },
  supervisor: { label: 'Supervisor', desc: 'Field operations: schedule and dispatch, quality and complaints (corrective work, reinspections), issues, calls, projects, customers and documents. No pricing, proposals, contracts, invoices or financial reports.' },
  inspector: { label: 'Inspector', desc: 'Quality only: inspections, reinspections and complaint notes, with read-only schedule, customers and documents.' },
  staff: { label: 'Office staff', desc: 'Day-to-day office work. Approvals, payments, financial reports and settings stay with managers.' }
};
const ALL_VIEWS = null; // null = every page
const VIEWS = {
  owner: ALL_VIEWS, manager: ALL_VIEWS, staff: ALL_VIEWS,
  supervisor: ['overview', 'issues', 'calls', 'customers', 'schedule', 'quality', 'projects', 'documents', 'scopes', 'settings'],
  inspector: ['quality', 'schedule', 'customers', 'documents', 'settings']
};
const HOME = { inspector: 'quality' };
// Supervisor: everything a staff member may do EXCEPT money, sales and system administration.
const SUPERVISOR_DENY = [
  /^\/api\/admin\/(invoices|next-invoice-number|financial-summary|estimates|bids|leads|approvals|approval-rules|templates|contracts|contracts2|takeoffs|emails|inbox|email-undeliverable|reports|ai|ai-receptionist|automation|backups|users|system-health|audit-log|m365)(\/|$)/,
  /^\/api\/admin\/(dashboard|command-center|command-center\/divisions)$/,
  /^\/api\/admin\/pm\/.*cost/, /^\/api\/admin\/customers\/\d+\/(invoices|billing|statement)/,
  [/^(PUT|PATCH|POST|DELETE)$/, /^\/api\/admin\/(settings|phone\/settings|phone\/callback-owner|issues\/config|quality\/settings)(\/|$)/]
];
// Inspector: an explicit allow-list; anything not listed is refused.
const INSPECTOR_ALLOW = [
  [/^GET$/, /^\/api\/admin\/(me|prefs|qc|quality|inspections|visits|dispatch\/board|documents|docs|employees|holidays|scopes)(\/|$)/],
  [/^GET$/, /^\/api\/admin\/customers(\/\d+)?$/], [/^GET$/, /^\/api\/admin\/autopilot\/activity$/],
  [/^(POST|PATCH|PUT)$/, /^\/api\/admin\/(qc|inspections)(\/|$)/],
  [/^POST$/, /^\/api\/admin\/quality\/complaints\/\d+\/(reinspection|notes|customer-contact)$/],
  [/^(PUT)$/, /^\/api\/admin\/prefs\/[a-z_]+$/], [/^POST$/, /^\/api\/admin\/(events\/ticket|account\/password|account\/sign-out-everywhere)$/]
];
function check(role, method, path) {
  if (role === 'supervisor') {
    for (const r of SUPERVISOR_DENY) { const [m, p] = Array.isArray(r) ? r : [null, r]; if ((!m || m.test(method)) && p.test(path)) return 'Supervisors do not have access to this (pricing, sales, finance and system settings stay with managers).'; }
    return null;
  }
  if (role === 'inspector') return INSPECTOR_ALLOW.some(([m, p]) => m.test(method) && p.test(path)) ? null : 'Inspectors only have access to quality and inspections.';
  return null;
}
const isRole = r => Object.prototype.hasOwnProperty.call(ROLES, r);
// Operational authority (dispatch crews, move complaint cases, schedule corrective work).
const canRunOperations = r => ['owner', 'manager', 'supervisor'].includes(r);
const canInspect = r => ['owner', 'manager', 'supervisor', 'inspector'].includes(r);
const seesMoney = r => ['owner', 'manager', 'staff'].includes(r);
module.exports = { ROLES, VIEWS, HOME, check, isRole, canRunOperations, canInspect, seesMoney };
