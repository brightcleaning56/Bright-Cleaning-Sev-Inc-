// Insurance certificates and licenses. An upload is "on file", never "verified": verification means
// someone confirmed it with the carrier or issuing authority, and who/when/how is recorded.
import { now } from './store.js';

export const CRED_TYPES = ['coi', 'license', 'certification'];
export const COVERAGES = ['general_liability', 'workers_comp', 'commercial_auto', 'umbrella', 'professional'];
const DAY = 864e5;

export function validateCredential(c) {
  const e = [];
  if (!CRED_TYPES.includes(c.type)) e.push(`type must be ${CRED_TYPES.join('|')}`);
  if (!c.issuer) e.push('issuer required (insurance carrier, state board or city)');
  if (!c.number) e.push('policy or license number required');
  if (!c.expiresAt || Number.isNaN(Date.parse(c.expiresAt))) e.push('expiresAt required');
  if (c.type === 'coi') {
    if (!Array.isArray(c.coverages) || !c.coverages.length) e.push('coverages required for a certificate of insurance');
    else for (const cv of c.coverages) {
      if (!COVERAGES.includes(cv.type)) e.push(`coverage type must be one of ${COVERAGES.join(', ')}`);
      if (!(cv.limit > 0)) e.push(`${cv.type}: limit must be a positive number`);
    }
  }
  if (c.type === 'license' && !c.classification) e.push('license classification required');
  return e;
}

export function addCredential(store, orgId, input, actor) {
  const errors = validateCredential(input);
  if (errors.length) return { ok: false, errors };
  const rec = store.tput('credentials', orgId, {
    type: input.type, issuer: input.issuer, number: input.number, classification: input.classification || null,
    coverages: input.coverages || [], additionalInsuredAvailable: !!input.additionalInsuredAvailable,
    effectiveDate: input.effectiveDate || null, expiresAt: input.expiresAt, documentRef: input.documentRef || null,
    verification: { status: 'on_file' }, addedBy: actor,
  });
  store.audit({ actor, orgId, action: 'credential.add', target: rec.id, detail: { type: rec.type } });
  return { ok: true, credential: rec };
}

/** Platform owner records an independent check (call to agent, state license lookup, etc.). */
export function verifyCredential(store, orgId, id, actor, { method, evidence }) {
  const c = store.tget('credentials', orgId, id);
  if (!c) return { ok: false, errors: ['not found'] };
  if (!method || !evidence) return { ok: false, errors: ['method and evidence required (e.g. "called agent", "state lookup URL")'] };
  c.verification = { status: 'verified_with_issuer', verifiedBy: actor, verifiedAt: now(), method, evidence };
  store.tput('credentials', orgId, c);
  store.audit({ actor, orgId, action: 'credential.verify', target: id, detail: { method } });
  return { ok: true, credential: c };
}

export const isCurrent = (c, at = Date.now()) => Date.parse(c.expiresAt) > at;

/** Blocks bidding when the org requires current general liability coverage and has none. */
export function credentialBlockers(store, org) {
  if (org.settings?.requireCurrentCOI === false) return [];
  const gl = store.tlist('credentials', org.id, c => c.type === 'coi' && isCurrent(c) && c.coverages.some(v => v.type === 'general_liability'));
  return gl.length ? [] : ['no current certificate of insurance with general liability on file'];
}

export function expiringSoon(store, orgId, days = 30) {
  const limit = Date.now() + days * DAY;
  return store.tlist('credentials', orgId, c => Date.parse(c.expiresAt) <= limit)
    .map(c => ({ id: c.id, type: c.type, issuer: c.issuer, number: c.number, expiresAt: c.expiresAt, expired: !isCurrent(c) }));
}

/** What a proposal may say. Only independently verified items are called verified. */
export function proposalCredentialText(store, org) {
  const cur = store.tlist('credentials', org.id, c => isCurrent(c));
  if (!cur.length) return '';
  const lines = cur.map(c => {
    const what = c.type === 'coi' ? `Insurance (${c.coverages.map(v => v.type.replace(/_/g, ' ')).join(', ')}), ${c.issuer}` : `${c.type === 'license' ? 'License' : 'Certification'} ${c.classification ? '(' + c.classification + ') ' : ''}${c.number}, ${c.issuer}`;
    return c.verification?.status === 'verified_with_issuer'
      ? `${what} — verified with issuer ${c.verification.verifiedAt.slice(0, 10)}`
      : `${what} — certificate on file, available on request`;
  });
  return lines.join('; ');
}
