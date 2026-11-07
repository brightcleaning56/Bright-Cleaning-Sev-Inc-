// National Plan Room foundation: drawing sets → sheets → revisions (project-linked), full-text search inside PDFs,
// revision comparison, and an explicit rights model that licensed document sources can plug into later.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { now } from './store.js';
import { normName } from './domain.js';

const MAX_PAGES = 400, MAX_CHARS = 500_000;          // text is held in memory until phase 3 — keep it bounded

// ---------- rights ----------
/** Rights for a document. GC uploads: the GC and its invited bidders. Licensed sources: an active entitlement for that
 *  provider, inside the company's territory, before expiry. No licensed documents exist until an agreement is signed. */
export function rightsOf(d) {
  if (d.license) return { source: 'licensed', provider: d.license.provider, audience: `companies with an active ${d.license.provider} entitlement in ${d.license.state || 'the project state'}`, redistribution: false, download: !!d.license.download, expiresAt: d.license.expiresAt || null };
  return { source: 'gc_upload', audience: 'the project GC/owner and invited bidders', redistribution: false, download: true, expiresAt: null };
}
export function entitled(store, org, d) {
  if (!org || !d || d.removed) return false;
  if (d.quarantined) return false;                                                    // quarantined by BUILDINTEL: nobody opens it
  if (d.requestId && (store.get('bidRequests', d.requestId)?.revokedOrgs || []).includes(org.id)) return false;   // access revoked by BUILDINTEL
  if (d.license) {
    const ent = (org.entitlements || []).find(e => e.provider === d.license.provider && (!e.expiresAt || Date.parse(e.expiresAt) > Date.now()));
    const st = String(d.license.state || '').toUpperCase();
    const territory = org.subscription?.plan === 'internal' || (org.territories || []).includes(st);
    return !!ent && territory && (!d.license.expiresAt || Date.parse(d.license.expiresAt) > Date.now());
  }
  if (d.buyerOrgId === org.id) return true;
  return store.list('invitations', i => i.requestId === d.requestId && i.sellerOrgId === org.id).length > 0;
}

// ---------- text ----------
export async function extractText(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  const pages = []; let chars = 0;
  for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGES) && chars < MAX_CHARS; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    // Rebuild lines: pdf.js marks line ends (hasEOL); items on one line are joined with spaces.
    let line = '', lines = [];
    for (const it of tc.items) { line += (line && !line.endsWith(' ') ? ' ' : '') + it.str; if (it.hasEOL) { lines.push(line.trim()); line = ''; } }
    if (line.trim()) lines.push(line.trim());
    const txt = lines.filter(Boolean).join('\n').slice(0, MAX_CHARS - chars); chars += txt.length; pages.push(txt);
  }
  return { pages, numPages: doc.numPages, chars, truncated: doc.numPages > MAX_PAGES || chars >= MAX_CHARS };
}

export async function indexDocument(store, docId) {
  const d = store.get('documents', docId); if (!d || d.removed) return null;
  const file = path.join(config.docDir, `${d.id}.pdf`);
  try {
    const t = await extractText(fs.readFileSync(file));
    return store.put('documentText', { id: d.id, documentId: d.id, pages: t.pages, numPages: t.numPages, chars: t.chars, truncated: t.truncated, extractedAt: now(), error: null });
  } catch (e) { return store.put('documentText', { id: d.id, documentId: d.id, pages: [], numPages: 0, chars: 0, extractedAt: now(), error: String(e.message).slice(0, 200) }); }
}

// ---------- drawing model ----------
const sheetKey = d => d.sheet ? d.sheet.toUpperCase() : 'DOC:' + (normName(d.title || d.name) || d.id);
export function syncDocument(store, d) {
  if (!d || d.removed) return null;
  const link = store.get('projectLinks', `bid_request:${d.requestId}`);
  const projectId = link ? (store.get('projectAliases', link.projectId)?.projectId || link.projectId) : null;
  const req = store.get('bidRequests', d.requestId) || {};
  const setId = `${d.requestId}:${d.discipline}`;
  const set = store.get('drawingSets', setId);
  store.put('drawingSets', { ...(set || {}), id: setId, projectId, requestId: d.requestId, discipline: d.discipline, name: `${d.discipline} — ${req.title || 'bid package'}`, source: 'gc_upload', rights: rightsOf(d), buyerOrgId: d.buyerOrgId });
  const shId = `${setId}:${sheetKey(d)}`;
  const sh = store.get('drawingSheets', shId);
  store.put('drawingSheets', { ...(sh || {}), id: shId, setId, projectId, sheet: d.sheet || null, title: d.title || d.name, kind: d.kind });
  if (!store.get('drawingRevisions', d.id)) store.put('drawingRevisions', { id: d.id, sheetId: shId, setId, projectId, documentId: d.id, addendum: d.addendum || 0, uploadedAt: d.uploadedAt });
  // Revision numbers: original first, then addenda in order; the newest is current.
  const revs = store.list('drawingRevisions', r => r.sheetId === shId).sort((a, b) => a.addendum - b.addendum || String(a.uploadedAt).localeCompare(String(b.uploadedAt)));
  revs.forEach((r, i) => { const label = r.addendum ? `Addendum ${r.addendum}` : i === 0 ? 'Original' : `Reissue ${i}`; if (r.seq !== i + 1 || r.label !== label) { r.seq = i + 1; r.label = label; store.put('drawingRevisions', r); } });
  const cur = store.get('drawingSheets', shId); cur.currentRevisionId = revs.at(-1).id; cur.revisionCount = revs.length; store.put('drawingSheets', cur);
  return { setId, sheetId: shId };
}

/** Keep the drawing model and the text index current. Text extraction is bounded per run. */
export async function syncPlanRoom(store, { maxIndex = 25 } = {}) {
  let synced = 0, indexed = 0;
  for (const d of store.list('documents', x => !x.removed)) {
    const rev = store.get('drawingRevisions', d.id);
    const link = store.get('projectLinks', `bid_request:${d.requestId}`);
    if (!rev || (link && rev.projectId !== link.projectId)) { syncDocument(store, d); synced++; }
  }
  for (const d of store.list('documents', x => !x.removed && !store.get('documentText', x.id)).slice(0, maxIndex)) { await indexDocument(store, d.id); indexed++; }
  return { synced, indexed, pendingText: store.list('documents', x => !x.removed && !store.get('documentText', x.id)).length };
}

// ---------- read: sets, search, compare ----------
export function listSets(store, org, { projectId } = {}) {
  const docs = store.list('documents', d => entitled(store, org, d));
  const sheets = new Map();
  for (const d of docs) { const r = store.get('drawingRevisions', d.id); if (r) (sheets.get(r.sheetId) || sheets.set(r.sheetId, []).get(r.sheetId)).push({ r, d }); }
  const sets = new Map();
  for (const [shId, items] of sheets) {
    const sh = store.get('drawingSheets', shId); if (!sh || (projectId && sh.projectId !== projectId)) continue;
    const set = store.get('drawingSets', sh.setId);
    const g = sets.get(sh.setId) || sets.set(sh.setId, { id: set.id, name: set.name, discipline: set.discipline, projectId: set.projectId, projectName: store.get('projects', set.projectId)?.name || null, rights: set.rights, sheets: [] }).get(sh.setId);
    const revisions = items.sort((a, b) => a.r.seq - b.r.seq).map(({ r, d }) => ({ documentId: d.id, label: r.label, seq: r.seq, addendum: r.addendum, uploadedAt: r.uploadedAt, name: d.name }));
    g.sheets.push({ id: shId, sheet: sh.sheet, title: sh.title, kind: sh.kind, revisions, current: revisions.at(-1) });
  }
  return [...sets.values()].map(s => ({ ...s, sheets: s.sheets.sort((a, b) => String(a.sheet || a.title).localeCompare(String(b.sheet || b.title), undefined, { numeric: true })) }))
    .sort((a, b) => String(a.projectName || '').localeCompare(String(b.projectName || '')) || a.discipline.localeCompare(b.discipline));
}

export function searchDocuments(store, org, q, { limit = 50 } = {}) {
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(t => t.length >= 2).slice(0, 8);
  if (!terms.length) return [];
  const out = [];
  for (const d of store.list('documents', x => entitled(store, org, x))) {
    const t = store.get('documentText', d.id);
    const meta = `${d.sheet || ''} ${d.title || ''} ${d.name} ${d.discipline}`.toLowerCase();
    const pages = t?.pages || [];
    // A document matches when every term appears in its name/sheet or its text; report the best page.
    const all = meta + ' ' + pages.join(' ').toLowerCase();
    if (!terms.every(term => all.includes(term))) continue;
    let best = { page: null, hits: 0, line: '' };
    pages.forEach((txt, i) => { const low = txt.toLowerCase(); const hits = terms.reduce((n, term) => n + (low.split(term).length - 1), 0);
      if (hits > best.hits) best = { page: i + 1, hits, line: txt.split('\n').find(l => terms.some(term => l.toLowerCase().includes(term))) || '' }; });
    const req = store.get('bidRequests', d.requestId) || {};
    const rev = store.get('drawingRevisions', d.id);
    out.push({ documentId: d.id, name: d.name, sheet: d.sheet, title: d.title, discipline: d.discipline, revision: rev?.label || null,
      projectId: rev?.projectId || null, projectName: store.get('projects', rev?.projectId || '')?.name || null, request: req.title || null,
      page: best.page, snippet: best.line.slice(0, 220), score: best.hits + terms.filter(term => meta.includes(term)).length * 2, textIndexed: !!t && !t.error });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Lines added and removed between two revisions of the same sheet (text layer, page by page). */
export function compareRevisions(store, org, fromId, toId) {
  const a = store.get('documents', fromId), b = store.get('documents', toId);
  if (!entitled(store, org, a) || !entitled(store, org, b)) return { ok: false, code: 404, error: 'not found' };
  const ra = store.get('drawingRevisions', a.id), rb = store.get('drawingRevisions', b.id);
  if (!ra || !rb || ra.sheetId !== rb.sheetId) return { ok: false, code: 400, error: 'choose two revisions of the same sheet' };
  const ta = store.get('documentText', a.id), tb = store.get('documentText', b.id);
  if (!ta || !tb) return { ok: false, code: 409, error: 'text not indexed yet — try again shortly' };
  const pages = [];
  for (let i = 0; i < Math.max(ta.pages.length, tb.pages.length); i++) {
    const A = (ta.pages[i] || '').split('\n').filter(Boolean), B = (tb.pages[i] || '').split('\n').filter(Boolean);
    const d = diffLines(A, B);
    if (d.added.length || d.removed.length) pages.push({ page: i + 1, ...d });
  }
  return { ok: true, from: { documentId: a.id, label: ra.label }, to: { documentId: b.id, label: rb.label }, pagesChanged: pages.length,
    pageCount: { from: ta.numPages, to: tb.numPages }, pages, note: 'Compares the text on the sheets (notes, labels, schedules). Graphic-only changes need a visual check.' };
}

/** Longest-common-subsequence line diff (bounded). */
export function diffLines(A, B) {
  if (A.length * B.length > 4e6) { const sa = new Set(A), sb = new Set(B); return { added: B.filter(l => !sa.has(l)), removed: A.filter(l => !sb.has(l)), approximate: true }; }
  const m = A.length, n = B.length, L = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const added = [], removed = []; let i = 0, j = 0;
  while (i < m && j < n) { if (A[i] === B[j]) { i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) removed.push(A[i++]); else added.push(B[j++]); }
  while (i < m) removed.push(A[i++]); while (j < n) added.push(B[j++]);
  return { added, removed };
}
