// Contractor prequalification + bid leveling for GCs. Everything shown comes from records with a source:
// certificates and licenses the bidder filed (verified only if someone checked with the issuer), the state
// license register, and the bidder's own history on BUILDINTEL. A GC's approve/reject decision is private to that GC.
import { now } from './store.js';
import { isCurrent } from './credentials.js';
import { licenseFor } from './enrichment.js';

const cov = (creds, type) => {
  const c = creds.filter(x => x.type === 'coi' && x.coverages.some(v => v.type === type)).sort((a, b) => String(b.expiresAt).localeCompare(String(a.expiresAt)))[0];
  if (!c) return { onFile: false };
  return { onFile: true, current: isCurrent(c), expiresAt: c.expiresAt, limit: c.coverages.find(v => v.type === type).limit, carrier: c.issuer, verified: c.verification?.status === 'verified_with_issuer' };
};

/** Compares a company's certificates with a package's minimum. Each shortfall is said in plain words. */
export function insuranceCheck(ins, req) {
  if (!req) return { required: false, met: true, shortfalls: [] };
  const shortfalls = [];
  if (req.generalLiabilityMin) {
    const gl = ins.generalLiability;
    if (!gl.onFile) shortfalls.push('no general liability certificate on file');
    else if (!gl.current) shortfalls.push('general liability certificate expired');
    else if ((gl.limit || 0) < req.generalLiabilityMin) shortfalls.push(`general liability is $${Number(gl.limit || 0).toLocaleString('en-US')}, below the $${req.generalLiabilityMin.toLocaleString('en-US')} required`);
  }
  if (req.workersComp) {
    const wc = ins.workersComp;
    if (!wc.onFile) shortfalls.push('no workers comp certificate on file');
    else if (!wc.current) shortfalls.push('workers comp certificate expired');
  }
  return { required: true, met: shortfalls.length === 0, shortfalls };
}

export function prequalProfile(store, seller) {
  const creds = store.tlist('credentials', seller.id);
  const legal = seller.legal?.name || seller.name;
  const stateLicenses = (seller.territories || []).map(st => ({ state: st, rec: licenseFor(store, st, legal) })).filter(x => x.rec)
    .map(x => ({ state: x.state, number: x.rec.licenseNumber, status: x.rec.status, active: x.rec.active, checkedAt: x.rec.checkedAt, source: 'state license register' }));
  const insurance = { generalLiability: cov(creds, 'general_liability'), workersComp: cov(creds, 'workers_comp'), auto: cov(creds, 'commercial_auto'), umbrella: cov(creds, 'umbrella') };
  const licenses = creds.filter(c => c.type === 'license').map(c => ({ issuer: c.issuer, number: c.number, classification: c.classification, expiresAt: c.expiresAt, current: isCurrent(c), verified: c.verification?.status === 'verified_with_issuer', source: 'filed by company' }));
  const subs = store.list('submissions', s => s.sellerOrgId === seller.id);
  const flags = [];
  if (!insurance.generalLiability.onFile) flags.push('no general liability certificate on file');
  else if (!insurance.generalLiability.current) flags.push('general liability certificate expired');
  if (!insurance.workersComp.onFile) flags.push('no workers comp certificate on file');
  if (!licenses.some(l => l.current) && !stateLicenses.some(l => l.active)) flags.push('no current license on file');
  return { company: legal, trades: seller.trades || [], serviceStates: seller.territories || [], insurance, licenses, stateLicenses,
    history: { bidsSubmitted: subs.length, awards: subs.filter(s => s.status === 'awarded').length }, flags };
}

export function setPrequal(store, buyer, user, sellerOrgId, { status, note }) {
  if (!['approved', 'rejected', 'pending'].includes(status)) return { ok: false, code: 400, error: 'status must be approved, rejected or pending' };
  // A GC may only decide on companies that bid on, or were invited to, its own requests.
  const mine = new Set(store.list('bidRequests', r => r.buyerOrgId === buyer.id).map(r => r.id));
  if (!store.list('invitations', i => mine.has(i.requestId) && i.sellerOrgId === sellerOrgId).length) return { ok: false, code: 404, error: 'not one of your bidders' };
  const prior = store.tlist('prequal', buyer.id, p => p.sellerOrgId === sellerOrgId)[0];
  const rec = store.tput('prequal', buyer.id, { ...(prior || {}), sellerOrgId, status, note: String(note || '').slice(0, 1000), decidedBy: user.email, decidedAt: now() });
  store.audit({ actor: user.email, orgId: buyer.id, action: 'prequal.decide', target: sellerOrgId, detail: { status } });
  return { ok: true, prequal: rec };
}

/** Bid leveling: latest bid per company, spread vs. the low bid, addenda acknowledged, prequalification at a glance. */
export function leveling(store, buyer, requestId) {
  const r = store.get('bidRequests', requestId);
  if (!r || r.buyerOrgId !== buyer.id) return null;
  const latest = new Map();
  for (const s of store.list('submissions', s => s.requestId === r.id)) {
    const cur = latest.get(s.sellerOrgId);
    if (!cur || String(s.submittedAt) > String(cur.submittedAt)) latest.set(s.sellerOrgId, s);
  }
  const bids = [...latest.values()].sort((a, b) => a.total - b.total);
  const low = bids[0]?.total || null, totals = bids.map(b => b.total);
  const median = totals.length ? (totals.length % 2 ? totals[(totals.length - 1) / 2] : (totals[totals.length / 2 - 1] + totals[totals.length / 2]) / 2) : null;
  return {
    request: { id: r.id, title: r.title, dueDate: r.dueDate, addendumCount: r.addendumCount || 0, status: r.status },
    stats: { bids: bids.length, low, high: totals.at(-1) ?? null, median },
    rows: bids.map(s => {
      const seller = store.get('orgs', s.sellerOrgId) || {};
      const inv = store.list('invitations', i => i.requestId === r.id && i.sellerOrgId === s.sellerOrgId)[0];
      const decision = store.tlist('prequal', buyer.id, p => p.sellerOrgId === s.sellerOrgId)[0];
      return { submissionId: s.id, sellerOrgId: s.sellerOrgId, company: s.sellerName, total: s.total, recurring: s.recurring, revision: s.revision || 1, submittedAt: s.submittedAt, status: s.status,
        pctAboveLow: low ? Math.round(1000 * (s.total - low) / low) / 10 : 0, addendaAcknowledged: inv?.ackAddendum || 0, receiptId: s.receiptId || null,
        insuranceCheck: insuranceCheck(prequalProfile(store, seller).insurance, r.insuranceRequirements),
        scope: s.scope || null, exclusions: s.exclusions || null, documentUrl: s.documentUrl || null, receiptSha256: s.sha256 || null,
        revisions: [...(s.revisionHistory || []).map(h => ({ revision: h.revision, total: h.total, recurring: h.recurring, receiptId: h.receiptId, submittedAt: h.submittedAt, scope: h.scope || null })), { revision: s.revision || 1, total: s.total, recurring: s.recurring || null, receiptId: s.receiptId || null, submittedAt: s.submittedAt, current: true }],
        prequal: prequalProfile(store, seller), decision: decision ? { status: decision.status, note: decision.note, decidedAt: decision.decidedAt } : null };
    }),
  };
}

/** Bid comparison as CSV for sharing with the team. Cells that a spreadsheet could run as formulas are neutralised. */
export function levelingCsv(L) {
  const cell = v => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = ['Company', 'Bid', 'Recurring', 'Above low bid (%)', 'Revision', 'Submitted', 'Receipt', 'Addenda acknowledged', 'Meets insurance minimum', 'Insurance shortfalls', 'Scope', 'Exclusions', 'Documents link', 'Prequalification flags'];
  const rows = L.rows.map(x => [x.company, x.total, x.recurring || '', x.pctAboveLow, x.revision, x.submittedAt, x.receiptId || '',
    `${x.addendaAcknowledged} of ${L.request.addendumCount}`, x.insuranceCheck?.required ? (x.insuranceCheck.met ? 'yes' : 'no') : 'no minimum set',
    (x.insuranceCheck?.shortfalls || []).join('; '), x.scope || '', x.exclusions || '', x.documentUrl || '', (x.prequal?.flags || []).join('; ')]);
  return [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
