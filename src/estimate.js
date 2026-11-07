import { now } from './store.js';

export const UNITS = ['sqft', 'hour', 'each', 'visit', 'window', 'linear_ft'];
export const CATEGORIES = ['post_construction', 'janitorial', 'windows', 'pressure_washing', 'parking_lot', 'floor_care', 'other'];

const NUMERIC = ['productionRate', 'laborRate', 'payrollBurdenPct', 'equipmentPerUnit', 'suppliesPerUnit',
  'mobilization', 'overheadPct', 'contingencyPct', 'targetMarginPct', 'minimumPrice'];

export function validateRateCard(rc) {
  const e = [];
  if (!rc.serviceName) e.push('serviceName required');
  if (!CATEGORIES.includes(rc.category)) e.push(`category must be one of ${CATEGORIES.join(', ')}`);
  if (!UNITS.includes(rc.unit)) e.push(`unit must be one of ${UNITS.join(', ')}`);
  for (const k of NUMERIC) if (!(typeof rc[k] === 'number' && Number.isFinite(rc[k]) && rc[k] >= 0)) e.push(`${k} must be a non-negative number`);
  if (rc.productionRate === 0) e.push('productionRate must be > 0');
  for (const k of ['payrollBurdenPct', 'overheadPct', 'contingencyPct']) if (rc[k] > 1) e.push(`${k} is a fraction (0.25 = 25%)`);
  if (rc.targetMarginPct >= 0.9) e.push('targetMarginPct must be < 0.9 (fraction)');
  if (!rc.effectiveDate || Number.isNaN(Date.parse(rc.effectiveDate))) e.push('effectiveDate required');
  return e;
}

/** Create a new DRAFT version. Approved versions are immutable; edits create a new version. */
export function draftRateCard(store, orgId, input, actor) {
  const errors = validateRateCard(input);
  if (errors.length) return { ok: false, errors };
  const serviceKey = input.serviceKey || slug(input.serviceName);
  const prior = store.tlist('rateCards', orgId, r => r.serviceKey === serviceKey);
  const version = prior.reduce((m, r) => Math.max(m, r.version), 0) + 1;
  const rc = store.tput('rateCards', orgId, {
    ...pick(input, ['serviceName', 'category', 'unit', 'effectiveDate', 'appliesTo', ...NUMERIC]),
    serviceKey, version, status: 'draft',
    createdBy: actor, approvedBy: null, approvedAt: null,
  });
  store.audit({ actor, orgId, action: 'ratecard.draft', target: rc.id, detail: { version } });
  return { ok: true, rateCard: rc };
}

/** Only an org owner can approve. Approving retires the prior approved version. */
export function approveRateCard(store, orgId, id, actor, actorRole) {
  if (actorRole !== 'owner') return { ok: false, errors: ['only the company owner can approve pricing'] };
  const rc = store.tget('rateCards', orgId, id);
  if (!rc) return { ok: false, errors: ['not found'] };
  if (rc.status !== 'draft') return { ok: false, errors: [`cannot approve a ${rc.status} card`] };
  for (const old of store.tlist('rateCards', orgId, r => r.serviceKey === rc.serviceKey && r.status === 'approved')) {
    old.status = 'retired'; store.tput('rateCards', orgId, old);
  }
  Object.assign(rc, { status: 'approved', approvedBy: actor, approvedAt: now() });
  store.tput('rateCards', orgId, rc);
  store.audit({ actor, orgId, action: 'ratecard.approve', target: id, detail: { version: rc.version } });
  return { ok: true, rateCard: rc };
}

export function activeRateCards(store, orgId) {
  const today = Date.now();
  return store.tlist('rateCards', orgId, r => r.status === 'approved' && Date.parse(r.effectiveDate) <= today);
}

// Round half-up to cents on the decimal value (avoids 3784.275 → 3784.27 from binary floating point).
const r2 = n => Number(Math.round(Number(n + 'e2')) + 'e-2');

/** Pure cost-plus estimate for one service line. Every intermediate is returned for audit. */
export function estimateLine(rc, units) {
  if (rc.status !== 'approved') throw new Error('rate card not approved');
  if (!(units > 0)) throw new Error('units must be > 0 (no measured quantity, no estimate)');
  const laborHours = units / rc.productionRate;
  const labor = laborHours * rc.laborRate * (1 + rc.payrollBurdenPct);
  const equipment = units * rc.equipmentPerUnit;
  const supplies = units * rc.suppliesPerUnit;
  const direct = labor + equipment + supplies + rc.mobilization;
  const overhead = direct * rc.overheadPct;
  const contingency = (direct + overhead) * rc.contingencyPct;
  const cost = direct + overhead + contingency;
  const marginPrice = cost / (1 - rc.targetMarginPct);
  const price = Math.max(marginPrice, rc.minimumPrice);
  return {
    rateCardId: rc.id, rateCardVersion: rc.version, service: rc.serviceName, unit: rc.unit, units,
    laborHours: r2(laborHours), labor: r2(labor), equipment: r2(equipment), supplies: r2(supplies),
    mobilization: r2(rc.mobilization), overhead: r2(overhead), contingency: r2(contingency),
    cost: r2(cost), price: r2(price), minimumApplied: price === rc.minimumPrice && marginPrice < rc.minimumPrice,
    effectiveMargin: r2((price - cost) / price),
  };
}

/**
 * Estimate every applicable sqft service for a project.
 * opts.categories limits to requested service categories (buyer requests).
 * opts.frequencyPerMonth turns janitorial lines into a monthly recurring price (property managers).
 */
export function estimateOpportunity(cards, permit, opts = {}) {
  const lines = [];
  const missing = [];
  for (const rc of cards) {
    if (rc.appliesTo?.length && !rc.appliesTo.includes(permit.projectType)) continue;
    if (opts.categories?.length && !opts.categories.includes(rc.category)) continue;
    if (rc.unit !== 'sqft') continue; // only sqft lines can be auto-quantified
    if (!permit.squareFeet) { missing.push('squareFeet'); continue; }
    const line = estimateLine(rc, permit.squareFeet);
    if (rc.category === 'janitorial' && opts.frequencyPerMonth > 0) {
      line.perVisit = line.price;
      line.visitsPerMonth = opts.frequencyPerMonth;
      line.price = r2(line.perVisit * opts.frequencyPerMonth);
      line.recurring = 'monthly';
    }
    lines.push(line);
  }
  const total = r2(lines.reduce((s, l) => s + l.price, 0));
  return { lines, total, recurring: lines.some(l => l.recurring) ? 'monthly' : null, missing: [...new Set(missing)] };
}

function pick(o, keys) { return Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]])); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
