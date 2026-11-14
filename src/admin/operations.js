// Super Admin Phase 4 (parts that need no owner credentials): subscriptions (view + clearly labeled manual adjustments —
// never a payment), data sources (status, freshness, pause/resume, probe/retry/resync via existing code), AI usage and
// per-company limits. Stripe reconciliation, invoices, refunds and AI cost/accuracy stay BLOCKED until real credentials.
import { now } from '../store.js';
import { config } from '../config.js';
import { CATALOG, entitlementsFor, usage, planKey } from '../entitlements.js';
import { adminAudit } from './rbac.js';
import { sourceComplianceIssues } from '../sources/registry.js';
import { paginate } from './service.js';

const fail = (code, error) => ({ ok: false, code, error });
const needReason = r => String(r || '').trim().length >= 5;
const qv = (q, k) => typeof q.get === 'function' ? q.get(k) : (Object.prototype.hasOwnProperty.call(q, k) ? q[k] : null);
const by = f => (a, b) => (f(a) < f(b) ? -1 : f(a) > f(b) ? 1 : 0), byDesc = f => (a, b) => -by(f)(a, b);
const STRIPE = () => config.stripeSecret ? 'configured — reconciliation not built' : 'not connected';

// ---------- subscriptions ----------
function subRow(store, o) {
  const e = entitlementsFor(o), u = usage(store, o), sub = o.subscription || {};
  return { orgId: o.id, company: o.legal?.name || o.name, line: e.line || (o.kind === 'buyer' ? 'publisher' : 'subscriber'), plan: e.plan, planName: e.name || e.plan, listPrice: e.monthly ?? null,
    status: sub.status || (e.monthly === 0 ? 'free' : 'none'), access: e.ok ? 'active' : 'restricted: ' + e.reason, trialEndsAt: sub.trialEndsAt || null,
    paymentState: sub.source === 'manual' ? 'none — manual adjustment (not paid)' : sub.stripeSubscriptionId ? 'Stripe (unreconciled)' : 'none',
    seats: `${u.seatsUsed} of ${e.seats ?? '—'}`, aiToday: `${u.aiToday} of ${aiAllowanceFor(o)}`, adjustments: (o.subscriptionAdjustments || []).length };
}
export function listSubscriptions(store, q) {
  const f = k => qv(q, k) || '';
  const rows = store.list('orgs', o => o.subscription?.plan !== 'internal').map(o => subRow(store, o)).filter(r => (!f('plan') || r.plan === f('plan')) && (!f('line') || r.line === f('line')) && (!f('q') || r.company.toLowerCase().includes(f('q').toLowerCase())));
  const res = paginate(rows, q, { company: by(r => r.company.toLowerCase()), plan: by(r => r.plan) }, 'company');
  return res.ok ? { ...res, stripe: STRIPE(), revenue: { value: null, unavailable: config.stripeSecret ? 'reconciliation not built — no verified revenue' : 'Stripe not connected — no verified payments' }, catalog: Object.entries(CATALOG).map(([k, v]) => ({ key: k, ...v, priceStatus: 'proposed — confirm before charging' })) } : res;
}
/** Manual adjustment (comp plan, trial extension). Grants access only; payment state stays "none — manual". Audited, step-up. */
export function adjustSubscription(store, ctx, orgId, { action, plan, days, reason }) {
  const o = store.get('orgs', orgId); if (!o) return fail(404, 'company not found');
  if (!needReason(reason)) return fail(400, 'a reason is required (5+ characters)');
  if (o.subscription?.plan === 'internal') return fail(409, 'the platform company has no subscription');
  const before = { ...(o.subscription || {}) };
  if (action === 'set_plan') {
    const k = planKey(plan); const def = CATALOG[k];
    if (!def || k === 'internal' || k === 'trial') return fail(400, 'choose a catalog plan');
    if (def.line !== (o.kind === 'buyer' ? 'publisher' : 'subscriber')) return fail(400, `${def.name} is a ${def.line} plan; this company is a ${o.kind === 'buyer' ? 'publisher' : 'subscriber'}`);
    o.subscription = { plan: k, status: 'active', source: 'manual', paymentState: 'none', adjustedBy: ctx.user.email, adjustedAt: now() };
  } else if (action === 'extend_trial') {
    const n = Number(days); if (!(n >= 1 && n <= 60)) return fail(400, 'extend a trial by 1–60 days');
    if (o.subscription?.plan !== 'trial') return fail(409, 'company is not on a trial');
    const base = Math.max(Date.now(), Date.parse(o.subscription.trialEndsAt || 0) || 0);
    o.subscription = { ...o.subscription, trialEndsAt: new Date(base + n * 864e5).toISOString(), status: 'trialing' };
  } else return fail(400, 'action must be set_plan or extend_trial');
  o.subscriptionAdjustments = [...(o.subscriptionAdjustments || []), { action, plan: o.subscription.plan, days: days || null, reason, by: ctx.user.email, at: now() }];
  store.put('orgs', o);
  adminAudit(store, ctx, { action: 'admin.billing.adjust', target: orgId, orgId, reason, before: { plan: before.plan || null, status: before.status || null, trialEndsAt: before.trialEndsAt || null }, after: { plan: o.subscription.plan, status: o.subscription.status, trialEndsAt: o.subscription.trialEndsAt || null, payment: 'none — manual' } });
  return { ok: true, subscription: subRow(store, o) };
}

// ---------- data sources ----------
function sourceRow(store, s) {
  const permits = store.list('permits', p => p.sourceId === s.id);
  const runs = store.list('jobs', j => j.type === 'collect' && j.sourceId === s.id);
  const hrs = s.lastSuccessAt ? Math.round((Date.now() - Date.parse(s.lastSuccessAt)) / 36e5) : null;
  return { id: s.id, key: s.key, name: s.name, jurisdiction: [s.city, s.state].filter(Boolean).join(', ') || s.state || 'national', adapter: s.adapter || s.method,
    enabled: !!s.enabled, compliance: sourceComplianceIssues(s), authorized: sourceComplianceIssues(s).length === 0,   // the collector's own rule termsUrl: s.termsUrl || null, lastSuccessAt: s.lastSuccessAt || null, lastFailureAt: s.lastFailureAt || null, lastError: s.lastError || null,
    freshness: hrs == null ? 'never pulled' : hrs < 26 ? `fresh (${hrs} h)` : `stale (${hrs} h)`, lastRecordDate: s.lastRecordDate || null, lastProbe: s.lastProbe || null,
    records: { active: permits.filter(p => !p.archived).length, archived: permits.filter(p => p.archived).length },
    runs: { total: runs.length, failed: runs.filter(j => j.status === 'failed').length }, schedule: s.enabled ? 'hourly with the collection cycle' : 'paused' };
}
export function listSources(store, q) {
  const rows = store.list('sources').map(s => sourceRow(store, s)).filter(r => !qv(q, 'state') || (qv(q, 'state') === 'failing' ? r.lastError : qv(q, 'state') === 'paused' ? !r.enabled : r.enabled && !r.lastError));
  return paginate(rows, q, { name: by(r => String(r.name).toLowerCase()), freshness: byDesc(r => r.lastSuccessAt || '') }, 'name');
}
export function sourceDetail(store, id) {
  const s = store.get('sources', id); if (!s) return fail(404, 'source not found');
  return { ok: true, source: { ...sourceRow(store, s), authorization: s.authorization || null, notes: s.notes || null,
    importRuns: store.list('jobs', j => j.type === 'collect' && j.sourceId === id).sort(byDesc(j => j.createdAt)).slice(0, 25)
      .map(j => ({ at: j.createdAt, status: j.status, received: j.result?.received ?? null, inserted: j.result?.inserted ?? null, updated: j.result?.updated ?? null, rejected: j.result?.rejected ?? null, skipped: j.result?.skippedNonCommercial ?? null, error: j.error || null })) } };
}
export function setSourceEnabled(store, ctx, id, { enabled, reason }) {
  const s = store.get('sources', id); if (!s) return fail(404, 'source not found');
  if (!needReason(reason)) return fail(400, 'a reason is required (5+ characters)');
  if (!!s.enabled === !!enabled) return fail(409, enabled ? 'already running' : 'already paused');
  const issues = sourceComplianceIssues(s);            // same rule the collector applies — never "running" but silently skipped
  if (enabled && issues.length) return fail(409, 'this source cannot run until its terms review is complete: ' + issues.join('; '));
  s.enabled = !!enabled; store.put('sources', s);
  adminAudit(store, ctx, { action: enabled ? 'admin.source.resume' : 'admin.source.pause', target: id, reason });
  return { ok: true, source: sourceRow(store, s) };
}

// ---------- AI usage ----------
export function aiAllowanceFor(o) { const e = entitlementsFor(o); const plan = e.ok ? (e.aiPerDay ?? 0) : 0; return o.aiLimitOverride != null ? Math.min(plan, o.aiLimitOverride) : plan; }
export function aiUsage(store, q) {
  const day = new Date().toISOString().slice(0, 10), month = day.slice(0, 7);
  const rows = store.list('orgs', o => o.subscription?.plan !== 'internal' || true).map(o => {
    const a = store.tlist('analyses', o.id);
    return { orgId: o.id, company: o.legal?.name || o.name, today: a.filter(x => String(x.createdAt).startsWith(day)).length, thisMonth: a.filter(x => String(x.createdAt).startsWith(month)).length,
      confirmed: a.filter(x => x.status === 'verified').length, unconfirmed: a.filter(x => x.status !== 'verified').length, allowance: aiAllowanceFor(o), override: o.aiLimitOverride ?? null, planAllowance: entitlementsFor(o).ok ? (entitlementsFor(o).aiPerDay ?? 0) : 0 };
  }).filter(r => qv(q, 'active') !== 'true' || r.thisMonth > 0);
  const res = paginate(rows, q, { month: byDesc(r => r.thisMonth), company: by(r => r.company.toLowerCase()) }, 'month');
  return res.ok ? { ...res, provider: config.anthropicKey ? 'configured' : 'not connected', cost: { value: null, unavailable: 'no metered cost records yet' }, accuracy: { value: null, unavailable: 'accuracy run on ≥100 real sheets is BLOCKED on the owner (AI key + labeled sheets)' } } : res;
}
/** Lower (or pause, 0) a company's daily AI allowance below its plan; null removes the override. */
export function setAiLimit(store, ctx, orgId, { limit, reason }) {
  const o = store.get('orgs', orgId); if (!o) return fail(404, 'company not found');
  if (!needReason(reason)) return fail(400, 'a reason is required (5+ characters)');
  const v = limit === null || limit === '' ? null : Number(limit);
  if (v !== null && !(Number.isInteger(v) && v >= 0 && v <= 1000)) return fail(400, 'limit must be a whole number 0–1000, or empty to remove');
  const before = o.aiLimitOverride ?? null; if (before === v) return fail(409, 'no change');
  o.aiLimitOverride = v; store.put('orgs', o);
  adminAudit(store, ctx, { action: 'admin.ai.limit', target: orgId, orgId, reason, before: { override: before }, after: { override: v } });
  return { ok: true, allowance: aiAllowanceFor(o) };
}
