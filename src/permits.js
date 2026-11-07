import crypto from 'node:crypto';

export const PERMIT_STATUSES = ['applied', 'approved', 'issued', 'finaled', 'expired', 'unknown'];
export const PROJECT_TYPES = ['office', 'retail', 'warehouse', 'industrial', 'multifamily',
  'medical', 'education', 'hospitality', 'restaurant', 'institutional', 'mixed_use', 'other_commercial'];

const TYPE_RULES = [
  ['warehouse', /warehouse|distribution|logistics|fulfil/],
  ['industrial', /industrial|manufactur|plant\b|factory/],
  ['multifamily', /apartment|multi-?family|multifam|townhome|condo|\bmf\b/],
  ['medical', /medical|clinic|hospital|dental|surgery|healthcare/],
  ['education', /school|university|college|campus|classroom|daycare|child care/],
  ['hospitality', /hotel|motel|lodging|inn\b/],
  ['restaurant', /restaurant|cafe|coffee|bar & grill|kitchen|food service/],
  ['retail', /retail|store|shop|strip center|grocery|mercantile/],
  ['office', /office|bank|headquarters|corporate/],
  ['institutional', /church|worship|library|fire station|police|government|civic/],
  ['mixed_use', /mixed[- ]use/],
];

// Building-code occupancy groups and city class labels -> BUILDINTEL project types.
// [type, building-code group (matched case-sensitively on the original text), plain words (case-insensitive)]
const OCCUPANCY_RULES = [
  ['multifamily', /\bR-?2\b|\bMFD\b|\b3to4\b/, /multi-?family|apartment|condo|five or more family|3 or more family/], // MFD/3to4: Minneapolis codes ['medical', /\bI-?2\b/, /hospital|medical|clinic/],
  ['education', /\bE\b/, /educational|school/], ['warehouse', /\bS-?[12]\b/, /storage|warehouse/], ['industrial', /\bF-?[12]\b/, /factory|industrial|manufactur/],
  ['restaurant', /\bA-?2\b/, /restaurant|food service/], ['institutional', /\bA-?[1345]\b/, /assembly|institutional|church|civic/],
  ['retail', /\bM\b/, /mercantile|retail|stores?\b|customer service/], ['office', /\bB\b/, /business|office/], ['hospitality', /\bR-?1\b/, /hotel|motel/],
];
export function classifyOccupancy(occ = '') {
  const raw = String(occ || '').trim();
  if (!raw || /^(commercial|other|none|n\/a)$/i.test(raw)) return null;
  for (const [type, code, words] of OCCUPANCY_RULES) if (code.test(raw) || words.test(raw.toLowerCase())) return type;
  return null;
}

const RESIDENTIAL = /single[- ]family|one[- ]family|two[- ]family|detached dwelling|accessory dwelling|\badu\b|\bdadu\b|townhouse|rowhouse|\bsfd?\b|residential|duplex|fence|deck|pool|garage|roof(ing)? only|solar|reroof|water heater/;
const COMMERCIAL_HINT = /commercial|comm-|\bcom\b|tenant finish|tenant improvement|\bti\b|build-?out|shell|new building|addition/;

export function classify(text = '') {
  const t = String(text).toLowerCase();
  for (const [type, re] of TYPE_RULES) if (re.test(t)) return type;
  return 'other_commercial';
}

export function isCommercial(raw) {
  const t = [raw.permitType, raw.workClass, raw.description, raw.landUse, raw.occupancy, raw.permitId].join(' ').toLowerCase();
  if (/single family|duplex|one- and two-family|vacant land|sign permit/i.test(String(raw.occupancy || ''))) return false;
  // Clear house wording wins over generic hints like "addition" unless the text names a commercial use.
  if (/single[- ]family|one[- ]family|two[- ]family|duplex|detached dwelling|accessory dwelling|\badu\b|\bdadu\b|townhouse|rowhouse/.test(t)
    && !/commercial|tenant|office|retail|restaurant|warehouse|mixed[- ]use|multi-?family|apartment|hotel|medical|school/.test(t)) return false;
  if (RESIDENTIAL.test(t) && !COMMERCIAL_HINT.test(t)) return false;
  return COMMERCIAL_HINT.test(t) || TYPE_RULES.some(([, re]) => re.test(t));
}

// Work that ends in a clean: new builds, additions, tenant finishes. Not fences, signs, repairs.
export function needsCleaning(raw) {
  const t = [raw.permitType, raw.workClass, raw.description].join(' ').toLowerCase();
  if (/\bsign\b|fence|demolition only|irrigation|sprinkler only|antenna|tower|repair only/.test(t)) return false;
  return /new|addition|alteration|remodel|tenant|finish|build-?out|renovat|shell|interior/.test(t);
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Coordinates may be negative (all US longitudes are); 0,0 is treated as missing.
const coord = (v, max) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) && n !== 0 && Math.abs(n) <= max ? n : null; };

// Portals use $0/$1 as "unknown"; anything under $100 is not a real construction value.
const realValue = v => { const n = num(v); return n != null && n >= 100 ? n : null; };

function normStatus(s) {
  const t = String(s || '').toLowerCase();
  if (/issu/.test(t)) return 'issued';
  if (/approv/.test(t)) return 'approved';
  if (/final|complete|closed/.test(t)) return 'finaled';
  if (/expir|void|cancel|withdr/.test(t)) return 'expired';
  if (/appl|review|submit|intake|pending/.test(t)) return 'applied';
  return 'unknown';
}

export function dedupeKey(p) {
  const addr = String(p.address || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return crypto.createHash('sha1').update(`${p.jurisdiction}|${p.permitId}|${addr}`).digest('hex');
}

/**
 * Normalize a raw source record into a BUILDINTEL permit.
 * Never invents values: anything missing stays null and lowers confidence.
 */
export function normalizePermit(raw, source) {
  const p = {
    permitId: raw.permitId ? String(raw.permitId).trim() : null,
    projectName: raw.projectName || null,
    address: raw.address ? String(raw.address).trim() : null,
    city: raw.city || source.city || null,
    state: raw.state || source.state || null,
    zip: raw.zip || null,
    jurisdiction: source.jurisdiction,
    owner: raw.owner || null,
    description: raw.description || null,
    permitType: raw.permitType || null,
    projectType: classifyOccupancy(raw.occupancy) || classify([raw.description, raw.permitType, raw.landUse, raw.projectName].join(' ')),
    squareFeet: num(raw.squareFeet),
    squareFeetBasis: num(raw.squareFeet) ? 'reported' : null,
    status: normStatus(raw.status || (raw.issuedDate ? 'issued' : '')),
    occupancy: raw.occupancy || null, workClass: raw.workClass || null,
    contractorOnPermit: raw.contractor && !/^\s*blanket\b/i.test(raw.contractor) ? raw.contractor : null, // named on permit ≠ awarded contract; Seattle "BLANKET: <building>" is not a contractor
    architect: raw.architect || null,
    valuation: realValue(raw.valuation),
    valuationBasis: realValue(raw.valuation) ? 'reported' : null,
    permitDate: raw.issuedDate || raw.appliedDate || null,
    lat: coord(raw.lat, 90), lng: coord(raw.lng, 180),
    sourceId: source.id,
    sourceUrl: raw.sourceUrl || source.url,
    lastVerifiedAt: new Date().toISOString(),
    commercial: isCommercial(raw),
    cleaningRelevant: needsCleaning(raw),
  };
  p.dedupeKey = dedupeKey(p);
  p.confidence = confidence(p);
  return p;
}

export function confidence(p) {
  const core = [p.permitId, p.address, p.permitDate, p.sourceUrl].every(Boolean);
  if (!core) return 'unconfirmed';
  return p.squareFeet || p.valuation ? 'verified' : 'probable';
}

export function validatePermit(p) {
  const errors = [];
  if (!p.permitId) errors.push('missing permitId');
  if (!p.address) errors.push('missing address');
  if (!p.jurisdiction) errors.push('missing jurisdiction');
  if (!p.sourceId || !p.sourceUrl) errors.push('missing source provenance');
  if (p.permitDate && Number.isNaN(Date.parse(p.permitDate))) errors.push('bad permitDate');
  if (!PERMIT_STATUSES.includes(p.status)) errors.push('bad status');
  return { ok: errors.length === 0, errors };
}

/** Upsert permits into the store with deduplication. Returns counts. */
export function ingestPermits(store, source, rawRecords) {
  const index = new Map(store.list('permits').map(p => [p.dedupeKey, p]));
  const out = { received: rawRecords.length, inserted: 0, updated: 0, rejected: 0, skippedNonCommercial: 0, errors: [] };
  for (const raw of rawRecords) {
    const p = normalizePermit(raw, source);
    const v = validatePermit(p);
    if (!v.ok) { out.rejected++; if (out.errors.length < 20) out.errors.push({ permitId: p.permitId, errors: v.errors }); continue; }
    const existing = index.get(p.dedupeKey);
    if (!p.commercial) {
      // A stored record that no longer qualifies (e.g. now recognized as a house) is downgraded, not left behind.
      if (existing && existing.commercial) { Object.assign(existing, { commercial: false, projectType: p.projectType, occupancy: p.occupancy }); store.put('permits', existing); out.downgraded = (out.downgraded || 0) + 1; }
      out.skippedNonCommercial++; continue;
    }
    const at = new Date().toISOString();
    if (existing) {
      // Stage tracking: every status change is kept, so subscribers see how a project moves.
      const history = existing.statusHistory || [{ status: existing.status, at: existing.firstSeenAt || existing.createdAt }];
      const changed = existing.status !== p.status;
      if (changed) history.push({ status: p.status, at });
      Object.assign(existing, p, { id: existing.id, createdAt: existing.createdAt, firstSeenAt: existing.firstSeenAt || existing.createdAt, archived: false,
        statusHistory: history, changedAt: changed ? at : (existing.changedAt || existing.createdAt) });
      store.put('permits', existing); out.updated++;
      if (changed) out.statusChanges = (out.statusChanges || 0) + 1;
    } else {
      const rec = store.put('permits', { ...p, firstSeenAt: at, changedAt: at, statusHistory: [{ status: p.status, at }] });
      index.set(p.dedupeKey, rec); out.inserted++;
    }
  }
  return out;
}
