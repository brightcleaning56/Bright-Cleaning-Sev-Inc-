import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { createRequest } from '../src/marketplace.js';
import { saveDocument, viewLink } from '../src/documents.js';
import { linkBidRequest } from '../src/core.js';
import { syncDocument, indexDocument, syncPlanRoom, listSets, searchDocuments, compareRevisions, entitled, rightsOf, diffLines } from '../src/planroom.js';

const FIX = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'qa', 'fixtures');
const D = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
async function world() {
  config.docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-npr-'));
  const store = new Store(null);
  const gc = store.put('orgs', { slug: 'gc', name: 'Acme GC', kind: 'buyer', buyerKind: 'general_contractor', status: 'active' });
  const sub = store.put('orgs', { slug: 'el', name: 'Sparky', kind: 'subscriber', trades: ['electrical'], territories: ['WA'], status: 'active', settings: {}, subscription: { plan: 'local', status: 'active' } });
  const out = store.put('orgs', { slug: 'out', name: 'Out', kind: 'subscriber', trades: ['roofing'], territories: ['WA'], status: 'active', settings: {}, subscription: { plan: 'local', status: 'active' } });
  const { request } = createRequest(store, gc, { email: 'pm' }, { title: 'Clinic electrical', address: '1 Main St', city: 'Seattle', state: 'WA', projectType: 'medical', trades: ['electrical'], dueDate: D(9) });
  linkBidRequest(store, request);
  const up = (f, addendum) => saveDocument(store, gc, { email: 'pm' }, request.id, { name: f, buffer: fs.readFileSync(path.join(FIX, f)), addendum, note: addendum ? 'Revised lighting' : undefined }).document;
  const docs = { a21: up('A2.1 - Level 1 Floor Plan.pdf'), e201: up('E2.01_Lighting_Plan.pdf'), spec: up('Project Manual - Division 26 Electrical.pdf'), e201r: up('E2.01_Lighting_Plan rev1.pdf', true) };
  for (const d of Object.values(docs)) { syncDocument(store, store.get('documents', d.id)); await indexDocument(store, d.id); }
  return { store, gc, sub, out, request, docs };
}

test('text is extracted from real PDFs on the server', async () => {
  const w = await world();
  assert.deepEqual(w.store.get('documentText', w.docs.e201r.id).pages, ['E2.01 Lighting Plan REV 1']);
  assert.equal(w.store.get('documentText', w.docs.spec.id).pages[0], 'Division 26 Electrical');
  assert.equal(w.store.get('documentText', w.docs.a21.id).error, null);
});

test('drawing sets → sheets → revisions, linked to the project; addendum becomes the current revision', async () => {
  const w = await world();
  const sets = listSets(w.store, w.sub);
  assert.deepEqual(sets.map(s => s.discipline), ['Architectural', 'Electrical', 'Specifications']);
  assert.ok(sets.every(s => /^BI-/.test(s.projectId)));
  const e = sets.find(s => s.discipline === 'Electrical').sheets[0];
  assert.deepEqual([e.sheet, e.revisions.map(r => r.label), e.current.documentId], ['E2.01', ['Original', 'Addendum 1'], w.docs.e201r.id]);
  assert.equal(sets[0].rights.source, 'gc_upload');
  assert.equal(listSets(w.store, w.out).length, 0);                         // not invited: sees nothing
  const again = await syncPlanRoom(w.store); assert.deepEqual([again.synced, again.indexed, again.pendingText], [0, 0, 0]); // idempotent
});

test('search inside documents: all terms must match, best page and snippet, only entitled files', async () => {
  const w = await world();
  const r = searchDocuments(w.store, w.sub, 'lighting');
  assert.deepEqual(r.map(x => x.documentId).sort(), [w.docs.e201.id, w.docs.e201r.id].sort());
  assert.ok(r.every(x => x.page === 1 && /Lighting Plan/.test(x.snippet) && /^BI-/.test(x.projectId)));
  assert.deepEqual(searchDocuments(w.store, w.sub, 'lighting rev').map(x => x.documentId), [w.docs.e201r.id]);
  assert.deepEqual(searchDocuments(w.store, w.sub, 'division 26').map(x => x.documentId), [w.docs.spec.id]);
  assert.deepEqual(searchDocuments(w.store, w.out, 'lighting'), []);
  assert.deepEqual(searchDocuments(w.store, w.sub, 'a'), []);                // too short to search
});

test('revision comparison shows the changed text; same sheet only; access and indexing enforced', async () => {
  const w = await world();
  const c = compareRevisions(w.store, w.sub, w.docs.e201.id, w.docs.e201r.id);
  assert.equal(c.ok, true);
  assert.deepEqual([c.from.label, c.to.label, c.pagesChanged], ['Original', 'Addendum 1', 1]);
  assert.deepEqual([c.pages[0].added, c.pages[0].removed], [['E2.01 Lighting Plan REV 1'], ['E2.01 Lighting Plan']]);
  assert.equal(compareRevisions(w.store, w.sub, w.docs.a21.id, w.docs.e201.id).code, 400);
  assert.equal(compareRevisions(w.store, w.out, w.docs.e201.id, w.docs.e201r.id).code, 404);
  w.store.remove('documentText', w.docs.e201r.id);
  assert.equal(compareRevisions(w.store, w.sub, w.docs.e201.id, w.docs.e201r.id).code, 409);
});

test('rights model: licensed documents need an active entitlement, the territory, and an unexpired license', () => {
  const store = new Store(null);
  const lic = { id: 'x', license: { provider: 'example-provider', state: 'WA', expiresAt: D(30) } };   // shape only — no licensed feed exists
  const org = { id: 'o', territories: ['WA'], entitlements: [{ provider: 'example-provider', expiresAt: D(10) }], subscription: { plan: 'local' } };
  assert.equal(entitled(store, org, lic), true);
  assert.equal(entitled(store, { ...org, territories: ['TX'] }, lic), false);
  assert.equal(entitled(store, { ...org, entitlements: [] }, lic), false);
  assert.equal(entitled(store, { ...org, entitlements: [{ provider: 'example-provider', expiresAt: D(-1) }] }, lic), false);
  assert.equal(entitled(store, org, { ...lic, license: { ...lic.license, expiresAt: D(-1) } }), false);
  assert.equal(rightsOf(lic).redistribution, false); assert.equal(rightsOf({}).source, 'gc_upload');
});

test('one rule everywhere: viewing links follow the rights model', async () => {
  const w = await world();
  assert.ok(viewLink(w.store, w.sub, { id: 'u' }, w.docs.a21.id).url);
  assert.equal(viewLink(w.store, w.out, { id: 'u' }, w.docs.a21.id).code, 404);
});

test('line diff', () => {
  assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'c', 'd']), { added: ['d'], removed: ['b'] });
  assert.deepEqual(diffLines([], ['x']), { added: ['x'], removed: [] });
});
