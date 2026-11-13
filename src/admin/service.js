// Super Admin service: real queries and audited actions over the existing records. Reuses publishing.js (publisher
// decisions), core.js (projects), entitlements.js (plans) and the store's audit log — no second implementation.
import crypto from 'node:crypto';
import { now } from '../store.js';
import { config } from '../config.js';
import { entitlementsFor } from '../entitlements.js';
import { decideVerification, RELATIONSHIPS } from '../publishing.js';
import { PLATFORM_ROLES, platformRolesOf, adminAudit, redact } from './rbac.js';

const fail = (code, error) => ({ ok: false, code, error });
const needReason = r => String(r || '').trim().length >= 5;

// ---------- pagination: capped limit, allow-listed sort, stable order ----------
// Read a query value without ever touching built-in properties (URLSearchParams.prototype.sort is a method!).
const qv = (q, k) => typeof q.get === 'function' ? q.get(k) : (Object.prototype.hasOwnProperty.call(q, k) ? q[k] : null);
export function paginate(items, q, sorts, defSort) {
  const limit = Math.min(100, Math.max(1, Number(qv(q, 'limit')) || 25));
  const offset = Math.max(0, Number(qv(q, 'cursor')) || 0);
  const key = qv(q, 'sort') || defSort;
  if (!Object.prototype.hasOwnProperty.call(sorts, key)) return fail(400, `sort must be one of: ${Object.keys(sorts).join(', ')}`);
  const sorted = [...items].sort((a, b) => sorts[key](a, b) || String(a.id).localeCompare(String(b.id)));
  const page = sorted.slice(offset, offset + limit);
  return { ok: true, items: page, total: items.length, nextCursor: offset + limit < items.length ? String(offset + limit) : null, asOf: now(), sort: key };
}
const by = f => (a, b) => (f(a) < f(b) ? -1 : f(a) > f(b) ? 1 : 0);
const byDesc = f => (a, b) => -by(f)(a, b);

// ---------- company view ----------
const companyType = o => o.kind === 'buyer' ? 'publisher' : o.subscription?.plan === 'internal' ? 'platform company' : 'subscriber';
export function verificationOf(o) {
  if (o.kind === 'buyer') return o.subscription?.plan === 'internal' ? 'verified' : o.publisher?.status || 'unverified';
  return o.status === 'pending_verification' ? 'email_unconfirmed' : 'email_confirmed';     // subscribers: account identity only
}
function companyRow(store, o) {
  const e = entitlementsFor(o);
  const members = store.list('users', u => u.orgId === o.id);
  return { id: o.id, name: o.legal?.name || o.name, type: companyType(o), buyerKind: o.buyerKind || null, verification: verificationOf(o),
    status: o.status === 'suspended' ? 'suspended' : o.status === 'pending_verification' ? 'pending' : 'active',
    primaryMarket: (o.territories || [])[0] || null, trades: o.trades || [], plan: e.plan, planName: e.name || e.plan, subscriptionStatus: o.subscription?.status || (e.monthly === 0 ? 'free' : 'none'),
    members: members.length, createdAt: o.createdAt, lastActivity: members.map(u => u.lastLoginAt).filter(Boolean).sort().pop() || null, version: o.version || 0 };
}
export function listCompanies(store, q) {
  const f = k => qv(q, k) || '';
  const text = f('q').toLowerCase();
  const rows = store.list('orgs').map(o => companyRow(store, o)).filter(r =>
    (!text || `${r.name} ${r.id}`.toLowerCase().includes(text)) && (!f('type') || r.type === f('type')) && (!f('verification') || r.verification === f('verification'))
    && (!f('status') || r.status === f('status')) && (!f('plan') || r.plan === f('plan')) && (!f('market') || r.primaryMarket === f('market').toUpperCase()));
  return paginate(rows, q, { name: by(r => r.name.toLowerCase()), created: byDesc(r => r.createdAt || ''), activity: byDesc(r => r.lastActivity || ''), members: byDesc(r => r.members) }, 'name');
}
export function companyDetail(store, id) {
  const o = store.get('orgs', id); if (!o) return fail(404, 'company not found');
  const users = store.list('users', u => u.orgId === id);
  const pubs = store.list('publications', p => p.publisherOrgId === id);
  const reqs = store.list('bidRequests', r => r.buyerOrgId === id);
  const inv = store.list('invitations', i => i.sellerOrgId === id);
  const subs = store.list('submissions', s => s.sellerOrgId === id);
  const auditTrail = (store.data.audit || []).filter(a => a.orgId === id || a.target === id).slice(-100).reverse();
  return { ok: true, company: {
    ...companyRow(store, o), legal: redact(o.legal || null), territories: o.territories || [],
    verificationDetail: o.kind === 'buyer' ? { status: verificationOf(o), documents: (o.publisher?.documents || []).map(d => ({ id: d.id, name: d.name, kind: d.kind, size: d.size, sha256: d.sha256, uploadedAt: d.uploadedAt, uploadedBy: d.uploadedBy })), history: o.publisher?.history || [], evidence: o.publisher?.evidence || null, requestedAt: o.publisher?.requestedAt || null, decidedBy: o.publisher?.decidedBy || null, decidedAt: o.publisher?.decidedAt || null, note: o.publisher?.note || null }
      : { status: verificationOf(o), note: 'Subscriber accounts confirm their email; business verification applies to publishers.' },
    members: users.map(u => ({ id: u.id, email: u.email, role: u.role, permissions: u.permissions || null, disabled: !!u.disabled, lastLoginAt: u.lastLoginAt || null, platformRoles: platformRolesOf(u) })),
    credentials: store.tlist ? store.tlist('credentials', id).map(c => ({ id: c.id, kind: c.kind, status: c.status, expiresOn: c.expiresOn || null })) : [],
    publications: pubs.map(p => ({ id: p.id, title: p.title, status: p.status, relationship: p.authority?.relationship, authorityReview: p.authority?.review || null, projectId: p.projectId })),
    marketplace: { packagesPosted: reqs.length, openPackages: reqs.filter(r => r.status === 'open').length, invitationsReceived: inv.length, bidsSubmitted: subs.length },
    subscription: { ...entitlementsFor(o), status: o.subscription?.status || null, trialEndsAt: o.subscription?.trialEndsAt || null, stripe: config.stripeSecret ? 'configured' : 'not connected' },
    restrictions: o.restrictions || [], notes: store.list('adminNotes', n => n.targetType === 'company' && n.targetId === id).sort(byDesc(n => n.createdAt)),
    activity: auditTrail } };
}

// ---------- company actions ----------
export function companyVerificationDecision(store, ctx, id, { decision, reason }) {
  const o = store.get('orgs', id); if (!o) return fail(404, 'company not found');
  if (o.kind !== 'buyer') return fail(409, 'business verification applies to publisher companies');
  if (!['approve', 'reject', 'request_info'].includes(decision)) return fail(400, 'decision must be approve, reject or request_info');
  if (!needReason(reason)) return fail(400, 'record how it was checked or what is missing (5+ characters)');
  const before = o.publisher?.status || 'unverified';
  if (decision === 'request_info') { o.publisher = { ...(o.publisher || {}), status: 'more_info_requested', note: reason, decidedBy: ctx.user.email, decidedAt: now() }; store.put('orgs', o); }
  else { const r = decideVerification(store, ctx.user, id, { status: decision === 'approve' ? 'verified' : 'rejected', note: reason }); if (!r.ok) return r; }
  adminAudit(store, ctx, { action: 'admin.company.verification', target: id, orgId: id, reason, before: { status: before }, after: { status: store.get('orgs', id).publisher.status } });
  return { ok: true, company: companyRow(store, store.get('orgs', id)) };
}
export function companyStatus(store, ctx, id, { status, reason }) {
  const o = store.get('orgs', id); if (!o) return fail(404, 'company not found');
  if (!['suspended', 'active'].includes(status)) return fail(400, 'status must be suspended or active');
  if (!needReason(reason)) return fail(400, 'a reason is required (5+ characters)');
  if (o.subscription?.plan === 'internal' && status === 'suspended') return fail(409, 'the platform-owned company cannot be suspended');
  const before = o.status;
  if (status === 'suspended') { if (o.status === 'suspended') return fail(409, 'already suspended'); o.suspendedFromStatus = o.status; o.status = 'suspended'; }
  else { if (o.status !== 'suspended') return fail(409, 'company is not suspended'); o.status = o.suspendedFromStatus || 'active'; delete o.suspendedFromStatus; }
  o.restrictions = [...(o.restrictions || []), { type: status === 'suspended' ? 'suspension' : 'reinstatement', reason, by: ctx.user.email, at: now() }];
  store.put('orgs', o);
  // Suspension ends every member's sessions; members are blocked from all company routes until reinstated.
  let revoked = 0; if (status === 'suspended') for (const u of store.list('users', u => u.orgId === id)) revoked += revokeAllSessions(store, u.id);
  adminAudit(store, ctx, { action: status === 'suspended' ? 'admin.company.suspend' : 'admin.company.reactivate', target: id, orgId: id, reason, before: { status: before }, after: { status: o.status }, detail: { sessionsRevoked: revoked } });
  return { ok: true, company: companyRow(store, o), sessionsRevoked: revoked };
}
export function addNote(store, ctx, targetType, targetId, body) {
  if (!String(body || '').trim()) return fail(400, 'note text required');
  const n = store.put('adminNotes', { targetType, targetId, author: ctx.user.email, body: String(body).slice(0, 4000), createdAt: now() });
  adminAudit(store, ctx, { action: 'admin.note.add', target: `${targetType}:${targetId}` });
  return { ok: true, note: n };
}

// ---------- publication authority (project-specific; separate from company verification) ----------
export function authorityQueue(store, q) {
  const rows = store.list('publications', p => ['construction_manager', 'architect_for_owner', 'agent_for_owner'].includes(p.authority?.relationship))
    .map(p => ({ id: p.id, title: p.title, publisher: p.publisherName, publisherOrgId: p.publisherOrgId, relationship: RELATIONSHIPS[p.authority.relationship], evidence: p.authority.evidence, onBehalfOf: p.authority.onBehalfOf || null, review: p.authority.review || 'pending', status: p.status, createdAt: p.createdAt }));
  return paginate(rows.filter(r => !qv(q, 'review') || r.review === qv(q, 'review')), q, { created: byDesc(r => r.createdAt || '') }, 'created');
}
export function authorityDecision(store, ctx, pubId, { decision, reason }) {
  const p = store.get('publications', pubId); if (!p) return fail(404, 'publication not found');
  if (!['approved', 'rejected'].includes(decision)) return fail(400, 'decision must be approved or rejected');
  if (!needReason(reason)) return fail(400, 'record how the authorization was checked (5+ characters)');
  const before = p.authority?.review || 'pending';
  p.authority = { ...p.authority, review: decision, reviewedBy: ctx.user.email, reviewedAt: now(), reviewNote: reason }; store.put('publications', p);
  adminAudit(store, ctx, { action: 'admin.publisher.authority', target: pubId, orgId: p.publisherOrgId, reason, before: { review: before }, after: { review: decision } });
  return { ok: true, publication: { id: p.id, review: decision } };
}

// ---------- users ----------
const userRow = (store, u) => { const o = store.get('orgs', u.orgId) || {};
  return { id: u.id, email: u.email, name: u.name || null, company: o.legal?.name || o.name || null, orgId: u.orgId, companyRole: u.role === 'platform_owner' ? 'owner' : u.role,
    platformRoles: platformRolesOf(u), state: u.disabled ? 'disabled' : 'active', mfa: u.mfa?.sealed ? 'enabled' : 'not enrolled', lastLoginAt: u.lastLoginAt || null,
    activeSessions: store.list('sessions', s => s.userId === u.id && Date.parse(s.expiresAt) > Date.now()).length, createdAt: u.createdAt }; };
export function listUsers(store, q) {
  const f = k => qv(q, k) || '';
  const text = f('q').toLowerCase();
  const rows = store.list('users').map(u => userRow(store, u)).filter(r => (!text || `${r.email} ${r.name || ''} ${r.company || ''}`.toLowerCase().includes(text))
    && (!f('state') || r.state === f('state')) && (!f('orgId') || r.orgId === f('orgId')) && (!f('platform') || (f('platform') === 'staff' ? r.platformRoles.length : !r.platformRoles.length)));
  return paginate(rows, q, { email: by(r => r.email), lastLogin: byDesc(r => r.lastLoginAt || ''), created: byDesc(r => r.createdAt || '') }, 'email');
}
export function userDetail(store, id) {
  const u = store.get('users', id); if (!u) return fail(404, 'user not found');
  return { ok: true, user: { ...userRow(store, u), permissions: u.permissions || null,
    loginHistory: (store.data.audit || []).filter(a => a.actor === u.email && /^auth\./.test(a.action)).slice(-20).reverse().map(a => ({ at: a.at, action: a.action })) } };
}
export function revokeAllSessions(store, userId) { let n = 0; for (const s of store.list('sessions', s => s.userId === userId)) { store.remove('sessions', s.id); n++; } return n; }
export function userStatus(store, ctx, id, { state, reason }) {
  const u = store.get('users', id); if (!u) return fail(404, 'user not found');
  if (!['disabled', 'active'].includes(state)) return fail(400, 'state must be disabled or active');
  if (!needReason(reason)) return fail(400, 'a reason is required (5+ characters)');
  if (u.id === ctx.user.id) return fail(409, 'you cannot change your own account state');
  if (platformRolesOf(u).includes('platform_owner') && !platformRolesOf(ctx.user).includes('platform_owner')) return fail(403, 'only a platform owner can change another platform owner');
  const before = u.disabled ? 'disabled' : 'active';
  u.disabled = state === 'disabled'; store.put('users', u);
  const revoked = u.disabled ? revokeAllSessions(store, u.id) : 0;
  adminAudit(store, ctx, { action: 'admin.user.' + (u.disabled ? 'disable' : 'reactivate'), target: id, orgId: u.orgId, reason, before: { state: before }, after: { state }, detail: { sessionsRevoked: revoked } });
  return { ok: true, user: userRow(store, u), sessionsRevoked: revoked };
}
export function userRevokeSessions(store, ctx, id, { reason }) {
  const u = store.get('users', id); if (!u) return fail(404, 'user not found');
  if (!needReason(reason)) return fail(400, 'a reason is required (5+ characters)');
  const n = revokeAllSessions(store, id);
  adminAudit(store, ctx, { action: 'admin.user.revoke_sessions', target: id, orgId: u.orgId, reason, detail: { sessionsRevoked: n } });
  return { ok: true, sessionsRevoked: n };
}
/** Grant or revoke a platform role. Only platform owners may grant/revoke platform_owner; nobody changes their own roles. */
export function setPlatformRole(store, ctx, id, { role, grant, reason }) {
  const u = store.get('users', id); if (!u) return fail(404, 'user not found');
  if (!PLATFORM_ROLES[role]) return fail(400, 'unknown platform role');
  if (!needReason(reason)) return fail(400, 'a reason is required (5+ characters)');
  if (u.id === ctx.user.id) return fail(409, 'you cannot change your own platform roles');
  if (role === 'platform_owner' && !platformRolesOf(ctx.user).includes('platform_owner')) return fail(403, 'only a platform owner can grant or revoke platform owner');
  if (role === 'platform_owner' && !grant && u.role === 'platform_owner') return fail(409, 'the original owner account keeps platform owner; transfer ownership is a separate procedure');
  const before = platformRolesOf(u);
  if (grant && before.includes(role)) return fail(409, 'the user already has that role');
  if (!grant && !before.includes(role)) return fail(409, 'the user does not have that role');   // no-op changes are refused, not audited as changes
  const set = new Set(Array.isArray(u.platformRoles) ? u.platformRoles : []); grant ? set.add(role) : set.delete(role);
  u.platformRoles = [...set]; store.put('users', u);
  adminAudit(store, ctx, { action: grant ? 'admin.roles.grant' : 'admin.roles.revoke', target: id, orgId: u.orgId, reason, before: { platformRoles: before }, after: { platformRoles: platformRolesOf(u) }, detail: { role } });
  return { ok: true, user: userRow(store, u) };
}

// ---------- dashboard: only numbers computed from stored records; the formula travels with each number ----------
export function overview(store) {
  const orgs = store.list('orgs'), users = store.list('users');
  const pubOrgs = orgs.filter(o => o.kind === 'buyer'), subOrgs = orgs.filter(o => o.kind !== 'buyer' && o.subscription?.plan !== 'internal');
  const reqs = store.list('bidRequests'), inv = store.list('invitations'), subs = store.list('submissions'), pubs = store.list('publications');
  const count = (arr, f) => arr.reduce((m, x) => (m[f(x)] = (m[f(x)] || 0) + 1, m), {});
  const card = (key, label, value, formula, drill) => ({ key, label, value, formula, drill: drill || null });
  const na = (key, label, reason) => ({ key, label, value: null, unavailable: reason });
  const plans = count(orgs.filter(o => o.subscription?.plan !== 'internal'), o => entitlementsFor(o).plan);
  return { asOf: now(), timezone: 'UTC', sections: [
    { title: 'Companies', cards: [
      card('companies', 'Companies', orgs.length, 'all company accounts', { view: 'companies' }),
      card('publishers_verified', 'Verified publishers', pubOrgs.filter(o => o.publisher?.status === 'verified').length, 'publisher companies with verification = verified', { view: 'companies', filter: { type: 'publisher', verification: 'verified' } }),
      card('publishers_pending', 'Publisher reviews waiting', pubOrgs.filter(o => o.publisher?.status === 'pending').length, 'publisher companies with verification = pending', { view: 'companies', filter: { type: 'publisher', verification: 'pending' } }),
      card('suspended', 'Suspended companies', orgs.filter(o => o.status === 'suspended').length, 'companies with status = suspended', { view: 'companies', filter: { status: 'suspended' } }),
      card('subscribers', 'Subscriber companies', subOrgs.length, 'non-publisher companies, excluding the platform company', { view: 'companies', filter: { type: 'subscriber' } }) ] },
    { title: 'Users', cards: [
      card('users', 'Users', users.length, 'all user accounts', { view: 'users' }),
      card('users_active', 'Active users', users.filter(u => !u.disabled).length, 'users not disabled', { view: 'users', filter: { state: 'active' } }),
      card('users_disabled', 'Disabled users', users.filter(u => u.disabled).length, 'users disabled', { view: 'users', filter: { state: 'disabled' } }),
      card('staff', 'Platform staff', users.filter(u => platformRolesOf(u).length).length, 'users holding a platform role', { view: 'users', filter: { platform: 'staff' } }),
      na('users_invited', 'Invited users', 'email invitations are not built yet (WS2)') ] },
    { title: 'Projects & marketplace', cards: [
      card('projects', 'Permanent projects', store.list('projects').length, 'project-core records', { view: 'projects', perm: 'admin.project.read' }),
      ...Object.entries(count(store.list('projects'), p => p.phase)).map(([ph, n]) => card('phase_' + ph, `Projects in ${ph}`, n, `projects with phase = ${ph}`, { view: 'projects', filter: { phase: ph }, perm: 'admin.project.read' })),
      card('publications', 'Publications', pubs.length, 'publisher project publications (any status)', null),
      card('packages_open', 'Open bid packages', reqs.filter(r => r.status === 'open').length, 'bid packages with status = open', { view: 'packages', filter: { status: 'open' }, perm: 'admin.bid.read' }),
      card('invitations', 'Invitations', inv.length, 'invitations sent', null),
      card('plan_opens', 'Plan opens', inv.filter(i => i.viewedAt).length, 'invitations whose plans were opened', null),
      card('will_bid', 'Will-bid responses', inv.filter(i => i.intent === 'will_bid').length, 'invitations answered will-bid', null),
      card('bids', 'Bids received', subs.length, 'bid submissions', null),
      card('awards', 'Awards', store.list('contracts').length, 'signed award contracts', null) ] },
    { title: 'Subscriptions & revenue', cards: [
      ...Object.entries(plans).map(([p, n]) => card('plan_' + p, `On ${p.replace('_', ' ')}`, n, `companies whose effective plan is ${p}`, { view: 'companies', filter: { plan: p } })),
      na('mrr', 'Monthly recurring revenue', config.stripeSecret ? 'Stripe connected but reconciliation is not built (WS5)' : 'Stripe not connected — no verified payments to report') ] },
    { title: 'Operations', cards: [
      card('ai_jobs', 'AI analyses run', store.count ? store.count('analyses') : Object.keys(store.data.analyses || {}).length, 'AI analysis records, all companies (count only — contents stay private to each company)', null),
      na('ai_cost', 'AI cost', 'no metered cost records yet (WS7)'),
      card('docs', 'Plan-room files', store.list('documents', d => !d.removed).length, 'documents not removed', { view: 'documents', perm: 'admin.bid.read' }),
      card('storage', 'Plan-room storage (MB)', Math.round(store.list('documents', d => !d.removed).reduce((n, d) => n + (d.size || 0), 0) / 1048576 * 10) / 10, 'sum of stored document sizes', null),
      card('jobs_failed', 'Failed jobs (24h)', store.list('jobs', j => j.status === 'failed' && Date.now() - Date.parse(j.createdAt) < 864e5).length, 'job records with status failed in the last 24 hours', null),
      card('email', 'Email', config.emailMode === 'live' ? 'live' : 'dry-run', 'EMAIL_MODE setting (not a delivery measurement)', null) ] },
  ] };
}

// ---------- audit search (database-backed when PostgreSQL; append-only — no edit or delete exists) ----------
export async function auditSearch(store, q) {
  const f = k => qv(q, k) || '';
  const limit = Math.min(100, Math.max(1, Number(f('limit')) || 50)), offset = Math.max(0, Number(f('cursor')) || 0);
  if (store.kind === 'postgres') {
    const w = [], args = [];
    const add = (sql, v) => { args.push(v); w.push(sql.replace('?', '$' + args.length)); };
    if (f('actor')) add('actor ILIKE ?', '%' + f('actor') + '%');
    if (f('action')) add('action LIKE ?', f('action') + '%');
    if (f('target')) add('target = ?', f('target'));
    if (f('orgId')) add('org_id = ?', f('orgId'));
    if (f('from')) add('at >= ?::timestamptz', f('from'));
    if (f('to')) add('at <= ?::timestamptz', f('to'));
    if (f('requestId')) add("detail->>'requestId' = ?", f('requestId'));
    if (f('outcome')) add("detail->>'outcome' = ?", f('outcome'));
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const total = (await store.pool.query(`SELECT count(*)::int n FROM audit ${where}`, args)).rows[0].n;
    const { rows } = await store.pool.query(`SELECT id, at, actor, org_id, action, target, detail FROM audit ${where} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`, args);
    return { ok: true, items: rows.map(r => ({ id: String(r.id), at: r.at.toISOString(), actor: r.actor, orgId: r.org_id, action: r.action, target: r.target, detail: r.detail })), total, nextCursor: offset + limit < total ? String(offset + limit) : null, asOf: now(), engine: 'postgres' };
  }
  const rows = (store.data.audit || []).filter(a => (!f('actor') || String(a.actor || '').includes(f('actor'))) && (!f('action') || String(a.action).startsWith(f('action')))
    && (!f('target') || a.target === f('target')) && (!f('orgId') || a.orgId === f('orgId')) && (!f('from') || a.at >= f('from')) && (!f('to') || a.at <= f('to'))
    && (!f('requestId') || a.detail?.requestId === f('requestId')) && (!f('outcome') || a.detail?.outcome === f('outcome'))).slice().reverse();
  return { ok: true, items: rows.slice(offset, offset + limit), total: rows.length, nextCursor: offset + limit < rows.length ? String(offset + limit) : null, asOf: now(), engine: 'memory' };
}
export const newRequestId = () => crypto.randomUUID();
