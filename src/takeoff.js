// Takeoff → estimate → bid. Quantities come only from VERIFIED drawing analyses (or are typed in by the estimator),
// every line keeps its source, and the bid that goes out states each quantity and where it came from.
import { now } from './store.js';
import { estimateLine } from './estimate.js';
import { submitBid } from './marketplace.js';

// Round half-up to cents on the decimal value (avoids 3784.275 → 3784.27 from binary floating point).
const r2 = n => Number(Math.round(Number(n + 'e2')) + 'e-2');
// Percentages of money computed in integer cents × basis points: exact, then rounded half-up to the cent.
const pctOf = (amount, pct) => Math.round(Math.round(amount * 100) * Math.round(pct * 10000) / 10000) / 100;
const UNITS = ['SF', 'LF', 'EA', 'HR', 'LS', 'SY', 'CY'];

export function computeEstimate(store, orgId, e) {
  let manual = 0, rated = 0;
  const lines = e.lines.map(l => {
    if (l.kind === 'ratecard') {
      const rc = store.tget('rateCards', orgId, l.rateCardId);
      if (!rc || rc.status !== 'approved') return { ...l, price: 0, error: 'rate card not approved' };
      const est = estimateLine(rc, l.qty); rated += est.price;
      return { ...l, price: est.price, detail: { cost: est.cost, laborHours: est.laborHours } };
    }
    const qty = l.qty * (1 + (l.wastePct || 0));
    const price = r2(qty * ((l.laborUnit || 0) + (l.materialUnit || 0))); manual += price;
    return { ...l, price };
  });
  manual = r2(manual);
  const overhead = pctOf(manual, e.overheadPct || 0);
  const profit = pctOf(r2(manual + overhead), e.profitPct || 0);
  return { ...e, lines, totals: { manualSubtotal: r2(manual), overhead, profit, rateCardSubtotal: r2(rated), total: r2(manual + overhead + profit + rated) } };
}

function validateLines(lines) {
  const errs = [];
  if (!Array.isArray(lines) || !lines.length) return ['add at least one line'];
  lines.forEach((l, i) => {
    const n = `line ${i + 1}`;
    if (!l.description) errs.push(`${n}: description required`);
    if (!(Number(l.qty) > 0)) errs.push(`${n}: quantity must be greater than 0`);
    if (l.kind === 'ratecard') { if (!l.rateCardId) errs.push(`${n}: choose a rate card`); return; }
    if (!UNITS.includes(l.unit)) errs.push(`${n}: unit must be one of ${UNITS.join(', ')}`);
    for (const k of ['laborUnit', 'materialUnit']) if (!(Number(l[k] ?? 0) >= 0)) errs.push(`${n}: ${k} must be 0 or more`);
    if (l.wastePct !== undefined && !(Number(l.wastePct) >= 0 && Number(l.wastePct) <= 0.5)) errs.push(`${n}: waste is a fraction between 0 and 0.5 (0.05 = 5%)`);
  });
  return errs;
}

/** Start from a verified analysis: one line per room with a printed area, carrying its room + sheet as the source. */
export function startFromAnalysis(store, org, user, { analysisId, invitationId, description }) {
  const a = store.tget('analyses', org.id, analysisId);
  if (!a) return { ok: false, code: 404, error: 'analysis not found' };
  if (a.status !== 'verified') return { ok: false, code: 409, error: 'confirm the AI analysis against the drawing before using its quantities' };
  const inv = invitationId ? store.get('invitations', invitationId) : null;
  if (invitationId && (!inv || inv.sellerOrgId !== org.id)) return { ok: false, code: 404, error: 'invitation not found' };
  const rooms = a.result.rooms.filter(r => r.basis === 'printed' && r.areaSqFt > 0);
  if (!rooms.length) return { ok: false, code: 400, error: 'this analysis has no printed areas to take off — add quantities manually instead' };
  const e = store.tput('estimates', org.id, {
    requestId: a.requestId, invitationId: invitationId || null, analysisId: a.id, title: description || `Takeoff from ${a.documentName}`,
    lines: rooms.map(r => ({ kind: 'manual', description: [r.number, r.name].filter(Boolean).join(' ') || 'Room', qty: r.areaSqFt, unit: 'SF',
      laborUnit: 0, materialUnit: 0, wastePct: 0, source: { type: 'drawing', sheet: r.sheet, room: r.number || r.name, documentId: a.documentId, analysisId: a.id, verifiedBy: a.verifiedBy } })),
    overheadPct: 0.1, profitPct: 0.1, status: 'draft', createdBy: user.email,
  });
  store.audit({ actor: user.email, orgId: org.id, action: 'estimate.create', target: e.id, detail: { fromAnalysis: a.id, lines: rooms.length } });
  return { ok: true, estimate: computeEstimate(store, org.id, e) };
}

export function updateEstimate(store, org, user, id, b) {
  const e = store.tget('estimates', org.id, id);
  if (!e) return { ok: false, code: 404, error: 'not found' };
  if (e.status === 'submitted') return { ok: false, code: 409, error: 'already submitted as a bid — start a new estimate to change it' };
  if (b.lines !== undefined) {
    const lines = b.lines.map((l, i) => {
      const prev = e.lines[i];
      // A line taken from a drawing keeps its source; changing its quantity marks it as adjusted by the estimator.
      const source = l.source === null ? { type: 'manual' } : (prev?.source && ['drawing', 'measurement'].includes(prev.source.type) ? { ...prev.source, adjusted: Number(l.qty) !== prev.qty || prev.source.adjusted || false } : (l.source || { type: 'manual' }));
      return { kind: l.kind === 'ratecard' ? 'ratecard' : 'manual', description: String(l.description || '').slice(0, 200), qty: Number(l.qty), unit: l.kind === 'ratecard' ? 'SF' : l.unit,
        laborUnit: Number(l.laborUnit || 0), materialUnit: Number(l.materialUnit || 0), wastePct: Number(l.wastePct || 0), rateCardId: l.rateCardId || null, source };
    });
    const errs = validateLines(lines); if (errs.length) return { ok: false, code: 400, error: errs.join('; ') };
    e.lines = lines;
  }
  for (const k of ['overheadPct', 'profitPct']) if (b[k] !== undefined) {
    const v = Number(b[k]); if (!(v >= 0 && v <= 1)) return { ok: false, code: 400, error: `${k} is a fraction between 0 and 1 (0.1 = 10%)` }; e[k] = v;
  }
  store.tput('estimates', org.id, e);
  return { ok: true, estimate: computeEstimate(store, org.id, e) };
}

/** Submit the estimate as the company's bid on its invitation. The bid text lists quantities with their sources. */
export function submitEstimateAsBid(store, org, user, id, { exclusions, validDays } = {}) {
  const e0 = store.tget('estimates', org.id, id);
  if (!e0) return { ok: false, code: 404, error: 'not found' };
  if (!e0.invitationId) return { ok: false, code: 400, error: 'this estimate is not linked to a bid invitation' };
  const e = computeEstimate(store, org.id, e0);
  if (!(e.totals.total > 0)) return { ok: false, code: 400, error: 'the estimate total is $0 — enter unit costs first' };
  if (e.lines.some(l => l.error)) return { ok: false, code: 400, error: 'a rate card line is not priced (approve the rate card)' };
  const src = l => (l.source?.type === 'drawing' ? ` [sheet ${l.source.sheet || '?'}${l.source.room ? ', room ' + l.source.room : ''}${l.source.adjusted ? ', qty adjusted by estimator' : ''}]`
    : l.source?.type === 'measurement' ? ` [measured on sheet ${l.source.sheet || '?'} p.${l.source.page || 1} at ${l.source.scale || 'calibrated scale'}${l.source.adjusted ? ', qty adjusted' : ''}]` : ' [estimator quantity]');
  const scope = ['Quantities:', ...e.lines.map(l => `• ${l.description}: ${l.qty.toLocaleString()} ${l.unit}${src(l)}`), '',
    e0.analysisId ? 'Drawing quantities were read from the plan room and confirmed against the drawings before pricing.' : ''].join('\n').trim();
  const r = submitBid(store, org, user, e.invitationId, { amount: e.totals.total, scope, exclusions, validDays });
  if (!r.ok) return r;
  e0.status = 'submitted'; e0.submittedAt = now(); e0.submissionId = r.submission.id; store.tput('estimates', org.id, e0);
  store.audit({ actor: user.email, orgId: org.id, action: 'estimate.submit', target: id, detail: { amount: e.totals.total } });
  return { ok: true, submission: r.submission, total: e.totals.total };
}

/** Estimate without a drawing analysis: the estimator types every quantity (marked as estimator quantities in the bid). */
export function startManual(store, org, user, { invitationId }) {
  const inv = store.get('invitations', invitationId);
  if (!inv || inv.sellerOrgId !== org.id) return { ok: false, code: 404, error: 'invitation not found' };
  const e = store.tput('estimates', org.id, { requestId: inv.requestId, invitationId, analysisId: null, title: 'Manual estimate', lines: [], overheadPct: 0.1, profitPct: 0.1, status: 'draft', createdBy: user.email });
  return { ok: true, estimate: computeEstimate(store, org.id, e) };
}

/** Estimate for a permit project (no bid invitation): price it, print a proposal, send it with "Contact the GC". */
export function startForProject(store, org, user, { permitId }) {
  const p = store.get('permits', permitId);
  if (!p) return { ok: false, code: 404, error: 'project not found' };
  const prior = store.tlist('estimates', org.id, e => e.permitId === permitId && e.status !== 'submitted')[0];
  if (prior) return { ok: true, estimate: computeEstimate(store, org.id, prior) };
  const cards = store.tlist('rateCards', org.id, r => r.status === 'approved' && r.unit === 'sqft');
  const lines = p.squareFeet && cards.length
    ? cards.map(rc => ({ kind: 'ratecard', description: rc.serviceName, qty: p.squareFeet, unit: 'SF', rateCardId: rc.id, source: { type: 'permit', note: 'square footage from the permit record' } }))
    : [];
  const e = store.tput('estimates', org.id, { permitId, requestId: null, invitationId: null, analysisId: null, title: p.projectName || p.description || 'Project estimate',
    lines, overheadPct: 0.1, profitPct: 0.1, status: 'draft', createdBy: user.email });
  return { ok: true, estimate: computeEstimate(store, org.id, e) };
}

const escH = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Printable proposal from an estimate (browser "Print → Save as PDF"). */
export function proposalHtml(store, org, id) {
  const e0 = store.tget('estimates', org.id, id); if (!e0) return null;
  const e = computeEstimate(store, org.id, e0);
  const p = e0.permitId ? store.get('permits', e0.permitId) : null;
  const r = e0.requestId ? store.get('bidRequests', e0.requestId) : null;
  const where = p ? `${p.address}, ${p.city}, ${p.state}` : r ? `${r.address}, ${r.city}, ${r.state}` : '';
  const legal = org.legal || {};
  const m = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `<!doctype html><html><head><meta charset="utf-8"><title>Proposal — ${escH(e.title)}</title><style>body{font-family:Helvetica,Arial,sans-serif;max-width:760px;margin:36px auto;color:#14202e;line-height:1.5}
table{width:100%;border-collapse:collapse;margin:14px 0}td,th{padding:7px;border-bottom:1px solid #ddd;text-align:left}td.n,th.n{text-align:right}.t{font-size:20px;font-weight:700}.f{font-size:12px;color:#555}@media print{button{display:none}}</style></head><body>
<button onclick="print()">Print / Save as PDF</button><h1>${escH(legal.name || org.name)}</h1><p><strong>Proposal:</strong> ${escH(e.title)}<br><strong>Project location:</strong> ${escH(where)}${p?.contractorOnPermit ? `<br><strong>Prepared for:</strong> ${escH(p.contractorOnPermit)}` : r ? `<br><strong>Prepared for:</strong> ${escH(r.buyerName)}` : ''}<br><strong>Date:</strong> ${new Date().toISOString().slice(0, 10)}</p>
<table><tr><th>Item</th><th class="n">Quantity</th><th class="n">Price</th></tr>${e.lines.map(l => `<tr><td>${escH(l.description)}</td><td class="n">${Number(l.qty).toLocaleString()} ${escH(l.unit)}</td><td class="n">${m(l.price)}</td></tr>`).join('')}
${e.totals.overhead || e.totals.profit ? `<tr><td colspan="2">Overhead & profit</td><td class="n">${m(e.totals.overhead + e.totals.profit)}</td></tr>` : ''}<tr><td colspan="2" class="t">Total</td><td class="n t">${m(e.totals.total)}</td></tr></table>
<p class="f">${p?.squareFeet ? 'Quantities based on the square footage in the public permit record; to be confirmed against drawings or a site walk. ' : ''}Valid for 30 days. Not a contract until accepted in writing by both parties.</p>
<p>${escH(legal.name || org.name)}${legal.postalAddress ? '<br>' + escH(legal.postalAddress) : ''}${org.profile?.phone ? '<br>' + escH(org.profile.phone) : ''}</p></body></html>`;
}

/** Estimate lines from on-drawing measurements; each line keeps its sheet, page and scale. Links to the bid
 *  invitation for that plan room automatically, or to a permit project. */
export function startFromMeasurements(store, org, user, { ids, permitId }) {
  const ms = (Array.isArray(ids) ? ids : []).map(id => store.tget('measurements', org.id, id)).filter(m => m && !m.deleted && m.kind !== 'note');
  if (!ms.length) return { ok: false, code: 400, error: 'choose at least one length, area or count' };
  const reqIds = [...new Set(ms.map(m => m.requestId))];
  if (reqIds.length > 1) return { ok: false, code: 400, error: 'measurements come from different bid packages; estimate them separately' };
  const inv = store.list('invitations', i => i.requestId === reqIds[0] && i.sellerOrgId === org.id)[0] || null;
  const label = m => m.label || { linear: 'Measured length', area: 'Measured area', count: 'Counted items' }[m.kind];
  const e = store.tput('estimates', org.id, { requestId: reqIds[0], invitationId: inv?.id || null, permitId: permitId || null, analysisId: null,
    title: `Takeoff from sheet ${ms[0].sheet || ''}`.trim(),
    lines: ms.map(m => ({ kind: 'manual', description: label(m), qty: m.value, unit: m.unit, laborUnit: 0, materialUnit: 0, wastePct: 0,
      source: { type: 'measurement', sheet: m.sheet, page: m.page, scale: m.scale?.label || null, measurementId: m.id, documentId: m.documentId } })),
    overheadPct: 0.1, profitPct: 0.1, status: 'draft', createdBy: user.email });
  store.audit({ actor: user.email, orgId: org.id, action: 'estimate.create', target: e.id, detail: { fromMeasurements: ms.length } });
  return { ok: true, estimate: computeEstimate(store, org.id, e) };
}
