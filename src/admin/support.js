// Super Admin Phase 5: support cases. Internal notes are for staff only. Customer-visible notes are the only
// notes a company ever sees. Every change is audited. Status moves follow a fixed set of transitions.
import { adminAudit } from './rbac.js';
import { paginate } from './service.js';

export const CASE_STATUSES = ['open', 'waiting_customer', 'resolved', 'closed'];
export const CASE_PRIORITIES = ['low', 'normal', 'high'];
const TRANSITIONS = {
  open: ['waiting_customer', 'resolved', 'closed'],
  waiting_customer: ['open', 'resolved', 'closed'],
  resolved: ['open', 'closed'],
  closed: [],
};
const fail = (code, error) => ({ ok: false, code, error });
const now = () => new Date().toISOString();
const text = (v, max) => String(v ?? '').trim().slice(0, max);

function caseRow(store, c) {
  const company = store.get('orgs', c.companyId);
  return {
    id: c.id, subject: c.subject, status: c.status, priority: c.priority,
    companyId: c.companyId, company: company?.name || null,
    assignee: c.assignee || null, createdBy: c.createdBy, createdAt: c.createdAt, updatedAt: c.updatedAt,
    noteCount: (c.notes || []).length,
  };
}

export function createCase(store, ctx, { companyId, subject, body, priority = 'normal' }) {
  if (!store.get('orgs', companyId)) return fail(404, 'company not found');
  const s = text(subject, 200);
  if (s.length < 5) return fail(400, 'subject is required (5+ characters)');
  if (!CASE_PRIORITIES.includes(priority)) return fail(400, `priority must be one of ${CASE_PRIORITIES.join(', ')}`);
  const notes = [];
  if (text(body, 4000)) notes.push({ id: 'n1', at: now(), by: ctx.user.email, visibility: 'customer', body: text(body, 4000) });
  const c = store.put('supportCases', { companyId, subject: s, status: 'open', priority, createdBy: ctx.user.email,
    assignee: null, notes, history: [{ at: now(), by: ctx.user.email, action: 'created' }] });
  adminAudit(store, ctx, { action: 'admin.support.create', target: c.id, orgId: companyId, detail: { priority } });
  return { ok: true, case: caseRow(store, c) };
}

export function listCases(store, q) {
  const status = q.get ? q.get('status') : q.status;
  const rows = store.list('supportCases', c => !status || c.status === status).map(c => caseRow(store, c));
  return paginate(rows, q, { updated: (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''), created: (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') }, 'updated');
}

// Staff see both kinds of note.
export function caseDetail(store, id) {
  const c = store.get('supportCases', id);
  if (!c) return fail(404, 'case not found');
  return { ok: true, case: { ...caseRow(store, c), notes: c.notes || [], history: c.history || [] } };
}

// What a company is allowed to see: its own case, customer-visible notes only, never internal notes or history.
export function customerView(store, id, companyId) {
  const c = store.get('supportCases', id);
  if (!c || c.companyId !== companyId) return fail(404, 'case not found');
  return { ok: true, case: { id: c.id, subject: c.subject, status: c.status, updatedAt: c.updatedAt,
    notes: (c.notes || []).filter(n => n.visibility === 'customer').map(n => ({ at: n.at, by: n.by, body: n.body })) } };
}

export function addNote(store, ctx, id, { visibility, body }) {
  const c = store.get('supportCases', id);
  if (!c) return fail(404, 'case not found');
  if (!['internal', 'customer'].includes(visibility)) return fail(400, 'visibility must be internal or customer');
  const b = text(body, 4000);
  if (!b) return fail(400, 'note text required');
  c.notes = [...(c.notes || []), { id: 'n' + ((c.notes || []).length + 1), at: now(), by: ctx.user.email, visibility, body: b }];
  c.history = [...(c.history || []), { at: now(), by: ctx.user.email, action: `note.${visibility}` }];
  store.put('supportCases', c);
  adminAudit(store, ctx, { action: 'admin.support.note', target: id, orgId: c.companyId, detail: { visibility } });
  return { ok: true, case: caseRow(store, c) };
}

export function setStatus(store, ctx, id, { status, reason }) {
  const c = store.get('supportCases', id);
  if (!c) return fail(404, 'case not found');
  if (!CASE_STATUSES.includes(status)) return fail(400, `status must be one of ${CASE_STATUSES.join(', ')}`);
  if (status === c.status) return fail(409, 'the case is already in that status');
  if (!(TRANSITIONS[c.status] || []).includes(status)) return fail(409, `a ${c.status} case cannot move to ${status}`);
  if (text(reason, 500).length < 5) return fail(400, 'a reason is required (5+ characters)');
  const before = c.status;
  c.status = status; c.updatedAt = now();
  c.history = [...(c.history || []), { at: now(), by: ctx.user.email, action: `status.${before}_to_${status}`, reason: text(reason, 500) }];
  store.put('supportCases', c);
  adminAudit(store, ctx, { action: 'admin.support.status', target: id, orgId: c.companyId, reason, before: { status: before }, after: { status } });
  return { ok: true, case: caseRow(store, c) };
}

export function assign(store, ctx, id, { assignee }) {
  const c = store.get('supportCases', id);
  if (!c) return fail(404, 'case not found');
  const a = text(assignee, 200);
  if (!a) return fail(400, 'assignee is required');
  c.assignee = a; c.updatedAt = now();
  c.history = [...(c.history || []), { at: now(), by: ctx.user.email, action: `assigned:${a}` }];
  store.put('supportCases', c);
  adminAudit(store, ctx, { action: 'admin.support.assign', target: id, orgId: c.companyId, detail: { assignee: a } });
  return { ok: true, case: caseRow(store, c) };
}
