// Platform roles and permissions for the Super Admin portal. Independent of company roles: a company owner, publisher
// admin or estimator never satisfies a platform check. Deny by default; denied attempts are audited.
export const PERMISSIONS = ['admin.dashboard.read', 'admin.company.read', 'admin.company.verify', 'admin.company.suspend', 'admin.user.read', 'admin.user.manage',
  'admin.roles.manage', 'admin.publisher.review', 'admin.project.read', 'admin.project.correct', 'admin.project.merge', 'admin.bid.read', 'admin.bid.investigate',
  'admin.document.access.revoke', 'admin.billing.read', 'admin.billing.manage', 'admin.source.manage', 'admin.ai.manage', 'admin.support.manage', 'admin.audit.read',
  'admin.security.manage', 'admin.system.manage', 'admin.release.manage'];
const P = s => PERMISSIONS.filter(p => s.some(x => x.endsWith('*') ? p.startsWith(x.slice(0, -1)) : p === x));
export const PLATFORM_ROLES = {
  platform_owner: { name: 'Platform owner', permissions: PERMISSIONS },
  platform_admin: { name: 'Platform admin', permissions: PERMISSIONS.filter(p => p !== 'admin.roles.manage' && p !== 'admin.security.manage') },
  verification_reviewer: { name: 'Verification reviewer', permissions: P(['admin.dashboard.read', 'admin.company.read', 'admin.company.verify', 'admin.publisher.review', 'admin.user.read', 'admin.audit.read']) },
  marketplace_ops: { name: 'Marketplace operations', permissions: P(['admin.dashboard.read', 'admin.company.read', 'admin.project.*', 'admin.bid.*', 'admin.document.access.revoke', 'admin.user.read']) },
  billing_admin: { name: 'Billing admin', permissions: P(['admin.dashboard.read', 'admin.company.read', 'admin.billing.*']) },
  data_ops: { name: 'Data operations', permissions: P(['admin.dashboard.read', 'admin.project.*', 'admin.source.manage', 'admin.ai.manage']) },
  support_agent: { name: 'Support agent', permissions: P(['admin.dashboard.read', 'admin.company.read', 'admin.user.read', 'admin.support.manage']) },
  security_auditor: { name: 'Security auditor (read-only)', permissions: P(['admin.dashboard.read', 'admin.audit.read', 'admin.company.read', 'admin.user.read']) },
  read_only_analyst: { name: 'Read-only analyst', permissions: P(['admin.dashboard.read', 'admin.company.read', 'admin.project.read', 'admin.bid.read', 'admin.billing.read']) },
};
/** Platform roles come from the persisted user record only (never from the client). The original owner account
 *  (role "platform_owner") keeps full authority. */
export const platformRolesOf = u => [...new Set([...(u?.role === 'platform_owner' ? ['platform_owner'] : []), ...(Array.isArray(u?.platformRoles) ? u.platformRoles : [])])].filter(r => PLATFORM_ROLES[r]);
export const permissionsOf = u => new Set(platformRolesOf(u).flatMap(r => PLATFORM_ROLES[r].permissions));
export const hasPerm = (u, perm) => permissionsOf(u).has(perm);
export const isPlatformStaff = u => platformRolesOf(u).length > 0;

const SECRET = /pass(word)?|secret|token|api.?key|hash|signature|card|iban|routing/i;
/** Redact secret-looking fields from audit summaries (recursively, bounded). */
export function redact(v, depth = 0) {
  if (v == null || depth > 4) return v;
  if (Array.isArray(v)) return v.slice(0, 50).map(x => redact(x, depth + 1));
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET.test(k) ? '[redacted]' : redact(x, depth + 1)]));
  return typeof v === 'string' && v.length > 500 ? v.slice(0, 500) + '…' : v;
}
/** Structured, append-only admin audit event. */
export function adminAudit(store, ctx, { action, target, orgId = null, reason, before, after, outcome = 'success', detail }) {
  store.audit({ actor: ctx.user?.email || 'system', orgId, action, target,
    detail: redact({ requestId: ctx.requestId, outcome, reason: reason || undefined, before, after, ...(detail || {}) }) });
}
