// Plan room: drawings, specifications and addenda that a GC / owner uploads for the bidders it invites.
// Rights are explicit on every file: uploaded by the project's GC, viewable only by that GC and invited bidders.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { now } from './store.js';
import { sign, unsign } from './security.js';
import { entitled, rightsOf } from './planroom.js';

// Sheet prefixes used by most US drawing sets. Two-letter prefixes are checked first (FP before F, ID before I).
const DISCIPLINES = [['FP', 'Fire protection'], ['ID', 'Interior design'], ['LS', 'Life safety'], ['EL', 'Electrical'],
  ['A', 'Architectural'], ['S', 'Structural'], ['C', 'Civil & site'], ['M', 'Mechanical'], ['E', 'Electrical'], ['P', 'Plumbing'],
  ['L', 'Landscape'], ['G', 'General'], ['T', 'Telecom & technology'], ['Q', 'Equipment'], ['D', 'Demolition']];

/** "A2.1 - Level 1 Floor Plan.pdf" → { sheet: 'A2.1', discipline: 'Architectural', kind: 'drawing' }. Never guesses beyond the file name. */
export function classifyDocument(name) {
  const base = String(name || '').replace(/\.[a-z0-9]+$/i, '').trim();
  if (/spec|project manual|division \d|volume \d/i.test(base)) return { sheet: null, discipline: 'Specifications', kind: 'specification', title: base };
  const m = base.match(/^([A-Z]{1,2})[-\s]?(\d{1,3}(?:[.-]\d{1,3})?[A-Z]?)(?=[\s_\-–:]|$)[\s_\-–:]*(.*)$/i);
  if (m) {
    const prefix = m[1].toUpperCase();
    const hit = DISCIPLINES.find(([p]) => p === prefix) || DISCIPLINES.find(([p]) => prefix.startsWith(p));
    if (hit) return { sheet: `${prefix}${m[2].replace('-', '.')}`, discipline: hit[1], kind: 'drawing', title: (m[3] || base).replace(/_/g, ' ').trim() };
  }
  return { sheet: null, discipline: 'Other documents', kind: 'other', title: base };
}

export function canView(store, org, doc) {
  return entitled(store, org, doc);   // one rights rule everywhere: GC uploads → GC + invited bidders; licensed → entitlement
}

/** Store one uploaded file. Only PDFs; content is checked, not just the name. */
export function saveDocument(store, buyerOrg, user, requestId, { name, buffer, addendum, note }) {
  const r = store.get('bidRequests', requestId);
  if (!r || r.buyerOrgId !== buyerOrg.id) return { ok: false, code: 404, error: 'request not found' };
  if (!['open', 'draft'].includes(r.status)) return { ok: false, code: 409, error: 'request is closed' };   // drafts can be prepared before publishing
  if (!buffer?.length) return { ok: false, code: 400, error: 'empty file' };
  if (buffer.length > config.maxDocBytes) return { ok: false, code: 413, error: `file is larger than ${Math.round(config.maxDocBytes / 1048576)} MB` };
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') return { ok: false, code: 400, error: 'only PDF files are accepted' };
  const cleanName = String(name || 'document.pdf').replace(/[^\w.\- ()&#,]+/g, '_').slice(0, 160);
  let addendumNumber = 0;
  if (addendum) {
    // Uploads marked as an addendum within 10 minutes of each other join the same addendum.
    const last = (r.addenda || []).at(-1);
    if (last && Date.now() - Date.parse(last.at) < 10 * 60e3 && last.by === user.email) addendumNumber = last.number;
    else { addendumNumber = (r.addendumCount || 0) + 1; r.addendumCount = addendumNumber; r.addenda = [...(r.addenda || []), { number: addendumNumber, note: String(note || '').slice(0, 1000), at: now(), by: user.email }]; store.put('bidRequests', r); }
  }
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (store.list('documents', d => d.requestId === r.id && d.sha256 === sha256).length) return { ok: false, code: 409, error: 'this exact file is already in the plan room' };
  const meta = classifyDocument(cleanName);
  const doc = store.put('documents', { requestId: r.id, buyerOrgId: buyerOrg.id, name: cleanName, ...meta, size: buffer.length, sha256, addendum: addendumNumber,
    rights: 'Uploaded by the project GC/owner. Viewable by the GC and invited bidders only. Do not redistribute.', uploadedBy: user.email, uploadedAt: now() });
  fs.mkdirSync(config.docDir, { recursive: true });
  fs.writeFileSync(path.join(config.docDir, `${doc.id}.pdf`), buffer);
  store.audit({ actor: user.email, orgId: buyerOrg.id, action: 'document.upload', target: doc.id, detail: { requestId: r.id, addendum: addendumNumber, sha256 } });
  return { ok: true, document: publicDoc(doc) };
}

export const publicDoc = d => ({ id: d.id, name: d.name, sheet: d.sheet, discipline: d.discipline, kind: d.kind, title: d.title, size: d.size, addendum: d.addendum, uploadedAt: d.uploadedAt, rights: d.rights, access: rightsOf(d) });

export function listDocuments(store, org, requestId) {
  const docs = store.list('documents', d => d.requestId === requestId && !d.removed);
  if (!docs.length) return [];
  if (!canView(store, org, docs[0])) return null;
    return docs.sort((a, b) => a.discipline.localeCompare(b.discipline) || String(a.sheet || '').localeCompare(String(b.sheet || ''), undefined, { numeric: true })
    || (a.addendum || 0) - (b.addendum || 0) || a.name.localeCompare(b.name)).map(publicDoc); // original sheet first, then its addenda in order
}

/** Short-lived signed link so the browser's own PDF viewer can open the file in a new tab. */
export function viewLink(store, org, user, docId) {
  const d = store.get('documents', docId);
  if (!d || d.removed || !canView(store, org, d)) return { ok: false, code: 404, error: 'not found' };
  return { ok: true, url: `/docs/${sign({ d: d.id, o: org.id, u: user.id, x: Date.now() + 10 * 60e3 })}` };
}

/** Serve a file from a signed link; records the bidder as a planholder (who opened the plans, when). */
export function openFromLink(store, token) {
  const p = unsign(token);
  if (!p?.d || !(p.x > Date.now())) return { ok: false, code: 403, error: 'link expired — open the document again from BUILDINTEL' };
  const d = store.get('documents', p.d); const org = store.get('orgs', p.o);
  if (!d || d.removed || !canView(store, org, d)) return { ok: false, code: 404, error: 'not found' };
  const inv = store.list('invitations', i => i.requestId === d.requestId && i.sellerOrgId === org.id)[0];
  if (inv) { inv.viewedAt ||= now(); inv.lastViewedAt = now(); inv.docsOpened = [...new Set([...(inv.docsOpened || []), d.id])]; store.put('invitations', inv); }
  const file = path.join(config.docDir, `${d.id}.pdf`);
  if (!fs.existsSync(file)) return { ok: false, code: 410, error: 'file is no longer available' };
  return { ok: true, file, name: d.name };
}

/** Bidders must acknowledge every addendum before they can bid or revise. */
export function acknowledgeAddenda(store, org, user, invitationId) {
  const inv = store.get('invitations', invitationId);
  if (!inv || inv.sellerOrgId !== org.id) return { ok: false, code: 404, error: 'not found' };
  const r = store.get('bidRequests', inv.requestId);
  inv.ackAddendum = r.addendumCount || 0; inv.ackAt = now(); inv.ackBy = user.email; store.put('invitations', inv);
  store.audit({ actor: user.email, orgId: org.id, action: 'addenda.acknowledge', target: inv.id, detail: { through: inv.ackAddendum } });
  return { ok: true, acknowledgedThrough: inv.ackAddendum };
}

export function planholders(store, buyerOrg, requestId) {
  const r = store.get('bidRequests', requestId);
  if (!r || r.buyerOrgId !== buyerOrg.id) return null;
  return store.list('invitations', i => i.requestId === r.id).map(i => {
    const o = store.get('orgs', i.sellerOrgId) || {};
    return { company: o.legal?.name || o.name, trades: o.trades || [], intent: i.intent, viewedPlans: !!i.viewedAt, lastViewedAt: i.lastViewedAt || null,
      filesOpened: (i.docsOpened || []).length, acknowledgedThrough: i.ackAddendum || 0, addenda: r.addendumCount || 0, bid: !!i.submissionId };
  }).sort((a, b) => Number(b.bid) - Number(a.bid) || Number(b.viewedPlans) - Number(a.viewedPlans));
}
