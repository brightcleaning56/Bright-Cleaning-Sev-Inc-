// One subscription per company, one catalog, explicit entitlements. Two product lines:
//   subscriber — companies that discover projects and bid;  publisher — owners/developers/GCs/CMs that publish projects.
// Prices are PROPOSED launch prices (from the v5 business-model review) — the owner confirms before charging.
// Document access is a separate check (planroom.entitled): a paid plan never by itself opens restricted plans.
import { ALL_STATES } from './billing.js';

export const CATALOG = {
  // subscriber line
  free:         { line: 'subscriber', name: 'Free', monthly: 0, markets: 0, seats: 1, discovery: false, savedSearches: 0, exportsPerMonth: 0, contactDetails: false, aiPerDay: 0, takeoff: 'basic' },
  trial:        { line: 'subscriber', name: 'Free trial (14 days)', monthly: 0, markets: 1, seats: 1, discovery: true, savedSearches: 3, exportsPerMonth: 0, contactDetails: true, aiPerDay: 3, takeoff: 'basic' },
  local:        { line: 'subscriber', name: 'Local', monthly: 99, markets: 1, seats: 2, discovery: true, savedSearches: 10, exportsPerMonth: 500, contactDetails: true, aiPerDay: 5, takeoff: 'basic' },
  professional: { line: 'subscriber', name: 'Professional', monthly: 199, markets: 3, seats: 3, discovery: true, savedSearches: 25, exportsPerMonth: 2500, contactDetails: true, aiPerDay: 15, takeoff: 'advanced' },
  growth:       { line: 'subscriber', name: 'Growth', monthly: 349, markets: 51, seats: 10, discovery: true, savedSearches: 100, exportsPerMonth: 20000, contactDetails: true, aiPerDay: 50, takeoff: 'advanced' },
  enterprise:   { line: 'subscriber', name: 'Enterprise', monthly: null, markets: 51, seats: 100, discovery: true, savedSearches: 1000, exportsPerMonth: 100000, contactDetails: true, aiPerDay: 500, takeoff: 'advanced' },
  // publisher line (basic publishing stays free: projects attract the subscribers who pay)
  publisher_basic:    { line: 'publisher', name: 'Publisher Basic', monthly: 0, seats: 3, activePublications: 3, publisherTools: 'basic', aiPerDay: 5 },
  publisher_pro:      { line: 'publisher', name: 'Publisher Pro', monthly: 149, seats: 5, activePublications: 15, publisherTools: 'pro', aiPerDay: 20 },
  publisher_business: { line: 'publisher', name: 'Publisher Business', monthly: 399, seats: 15, activePublications: 100, publisherTools: 'business', aiPerDay: 50 },
  // platform-owned company
  internal: { line: 'internal', name: 'Internal (platform-owned company)', monthly: 0, markets: 51, seats: 50, discovery: true, savedSearches: 1000, exportsPerMonth: 100000, contactDetails: true, aiPerDay: 500, takeoff: 'advanced', activePublications: 1000, publisherTools: 'business' },
};
export const PRICE_STATUS = 'proposed — confirm before charging';
// Plans sold before the catalog was unified map onto the new ones (nothing existing breaks).
const LEGACY = { regional: 'professional', national: 'growth', starter: 'local', business: 'growth' };
export const planKey = p => LEGACY[p] || p;

/** Entitlements for a company right now (plan, status, trial expiry). */
export function entitlementsFor(org) {
  const sub = org?.subscription || {};
  const key = planKey(sub.plan || (org?.kind === 'buyer' ? 'publisher_basic' : 'free'));
  const plan = CATALOG[key];
  if (!plan) return { ok: false, reason: 'unknown plan', plan: key };
  const free = plan.monthly === 0 && key !== 'trial';
  if (key === 'trial' && sub.trialEndsAt && Date.parse(sub.trialEndsAt) < Date.now()) return { ok: false, reason: 'trial ended — choose a plan to keep access', plan: key, ...CATALOG.free };
  if (!free && key !== 'internal' && !['active', 'trialing'].includes(sub.status)) return { ok: false, reason: `subscription ${sub.status || 'none'}`, plan: key, ...CATALOG.free };
  return { ok: true, plan: key, ...plan };
}

/** Lead-intelligence access (search, alerts, exports): same shape the rest of the app already uses. */
export function leadAccessFrom(org) {
  const e = entitlementsFor(org);
  if (!e.ok) return { ok: false, reason: e.reason };
  if (e.line === 'publisher') return { ok: false, reason: 'publisher accounts publish projects; project discovery is a subscriber plan' };
  if (!e.discovery) return { ok: false, reason: 'the Free plan receives invitations only — choose a plan for project search and alerts' };
  const states = e.markets >= 51 ? ALL_STATES : (org.territories || []).slice(0, e.markets);
  return { ok: true, plan: e.plan, name: e.name, monthly: e.monthly, states, savedSearches: e.savedSearches, exportsPerMonth: e.exportsPerMonth, contactDetails: e.contactDetails, seats: e.seats };
}

// ---------- enforcement ----------
export function seatCheck(store, org) {
  const e = entitlementsFor(org); const used = store.list('users', u => u.orgId === org.id && !u.disabled).length;
  return used < (e.seats || 1) ? { ok: true, used, limit: e.seats } : { ok: false, code: 402, error: `seat limit reached (${used} of ${e.seats} on ${e.name || e.plan}) — upgrade or disable a user`, used, limit: e.seats };
}
export function aiAllowance(org) { const e = entitlementsFor(org); const plan = e.ok ? (e.aiPerDay ?? 0) : 0; return org?.aiLimitOverride != null ? Math.min(plan, org.aiLimitOverride) : plan; }   // admin override can only lower it
export function publicationAllowance(store, org) {
  const e = entitlementsFor(org);
  const active = store.list('publications', p => p.publisherOrgId === org.id && ['published', 'in_review'].includes(p.status)).length;
  return { ok: active < (e.activePublications || 0), active, limit: e.activePublications || 0, plan: e.name || e.plan };
}
export function usage(store, org) {
  const month = new Date().toISOString().slice(0, 7), today = new Date().toISOString().slice(0, 10);
  return { seatsUsed: store.list('users', u => u.orgId === org.id && !u.disabled).length,
    aiToday: store.tlist('analyses', org.id, a => String(a.createdAt).startsWith(today)).length,
    exportRowsThisMonth: org.exportUsage?.[month] || 0,
    activePublications: store.list('publications', p => p.publisherOrgId === org.id && ['published', 'in_review'].includes(p.status)).length };
}

/** Plain-language summary of one subscriber plan, generated from the same fields the limits use. */
export function planSummary(key) {
  const p = CATALOG[key];
  if (!p || p.line !== 'subscriber' || key === 'free' || key === 'internal') return null;
  const lines = [
    p.markets === 1 ? 'Projects in 1 state' : p.markets >= 51 ? 'Projects in every state' : `Projects in up to ${p.markets} states`,
    p.seats === 1 ? '1 user' : `Up to ${p.seats} users`,
    p.savedSearches ? `${p.savedSearches} saved searches with daily email alerts` : 'No saved searches',
    p.contactDetails ? 'Verified contact details for general contractors' : 'No contact details',
    p.exportsPerMonth ? `Export up to ${p.exportsPerMonth.toLocaleString('en-US')} rows a month` : 'No exports',
    p.takeoff === 'advanced' ? 'Advanced takeoff and estimating' : 'Basic takeoff',
  ];
  const price = key === 'trial' ? 'Free for 14 days, no card' : p.monthly === 0 ? 'Free' : p.monthly == null ? 'Custom price, talk to us' : `$${p.monthly}/month`;
  return { key, name: p.name, price, priceNote: p.monthly ? PRICE_STATUS : null, lines };
}
export function planComparison() {
  return ['trial', 'local', 'professional', 'growth', 'enterprise'].map(planSummary).filter(Boolean);
}
