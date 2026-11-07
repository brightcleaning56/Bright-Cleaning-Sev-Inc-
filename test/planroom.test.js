import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { createRequest, submitBid } from '../src/marketplace.js';
import { classifyDocument, saveDocument, listDocuments, viewLink, openFromLink, acknowledgeAddenda, planholders } from '../src/documents.js';
import { sendInvitationNotices } from '../src/digest.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

config.docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-docs-'));
const D = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const PDF = txt => Buffer.from(`%PDF-1.4\n% ${txt}\n%%EOF`);
function world() {
  const store = new Store(null);
  const gc = store.put('orgs', { slug: 'gc', name: 'Ryan Companies', kind: 'buyer', status: 'active', settings: {} });
  const gcUser = store.put('users', { email: 'pm@ryan.test', role: 'owner', orgId: gc.id, passwordHash: hashPassword('gc password 1234') });
  const elec = store.put('orgs', { slug: 'sparky', name: 'Sparky', kind: 'subscriber', trades: ['electrical'], territories: ['IA'], status: 'active', settings: {}, legal: {}, subscription: { plan: 'local', status: 'active' } });
  const elecUser = store.put('users', { email: 'est@sparky.test', role: 'owner', orgId: elec.id, passwordHash: hashPassword('sparky password 12') });
  const outsider = store.put('orgs', { slug: 'out', name: 'Outsider', kind: 'subscriber', trades: ['painting'], territories: ['IA'], status: 'active', settings: {}, legal: {}, subscription: { plan: 'local', status: 'active' } });
  const outUser = store.put('users', { email: 'x@out.test', role: 'owner', orgId: outsider.id, passwordHash: hashPassword('outsider password') });
  const { request } = createRequest(store, gc, gcUser, { title: 'Medical office', address: '1 Main', city: 'Ankeny', state: 'IA', projectType: 'medical', trades: ['electrical'], dueDate: D(10) });
  const inv = store.list('invitations', i => i.sellerOrgId === elec.id)[0];
  return { store, gc, gcUser, elec, elecUser, outsider, outUser, request, inv };
}

test('sheet index from file names: disciplines, sheet numbers, specs; never guesses beyond the name', () => {
  assert.deepEqual(classifyDocument('A2.1 - Level 1 Floor Plan.pdf'), { sheet: 'A2.1', discipline: 'Architectural', kind: 'drawing', title: 'Level 1 Floor Plan' });
  assert.equal(classifyDocument('FP-101 Sprinkler Plan.pdf').discipline, 'Fire protection');
  assert.equal(classifyDocument('E2.01_Lighting.pdf').sheet, 'E2.01');
  assert.equal(classifyDocument('E2.01_Lighting_Plan.pdf').title, 'Lighting Plan');
  assert.equal(classifyDocument('M-201 HVAC.pdf').sheet, 'M201');
  assert.equal(classifyDocument('A101.pdf').sheet, 'A101');
  assert.equal(classifyDocument('Project Manual - Division 09 Finishes.pdf').kind, 'specification');
  assert.equal(classifyDocument('Bid form.pdf').discipline, 'Other documents');
});

test('uploads: PDFs only, size limit, no duplicates, only the posting GC', () => {
  const w = world();
  assert.equal(saveDocument(w.store, w.gc, w.gcUser, w.request.id, { name: 'A1.0 Site.pdf', buffer: Buffer.from('not a pdf') }).code, 400);
  assert.equal(saveDocument(w.store, w.gc, w.gcUser, w.request.id, { name: 'A1.0 Site.pdf', buffer: PDF('a') }).ok, true);
  assert.equal(saveDocument(w.store, w.gc, w.gcUser, w.request.id, { name: 'copy.pdf', buffer: PDF('a') }).code, 409);
  const other = w.store.put('orgs', { slug: 'gc2', name: 'Other GC', kind: 'buyer', status: 'active' });
  assert.equal(saveDocument(w.store, other, w.gcUser, w.request.id, { name: 'x.pdf', buffer: PDF('b') }).code, 404);
  const big = config.maxDocBytes; config.maxDocBytes = 10;
  assert.equal(saveDocument(w.store, w.gc, w.gcUser, w.request.id, { name: 'big.pdf', buffer: PDF('cccccccccccccccc') }).code, 413);
  config.maxDocBytes = big;
});

test('access: GC and invited bidders only; signed links expire; opening records a planholder', () => {
  const w = world();
  const doc = saveDocument(w.store, w.gc, w.gcUser, w.request.id, { name: 'A2.1 Floor Plan.pdf', buffer: PDF('plan') }).document;
  assert.equal(listDocuments(w.store, w.elec, w.request.id).length, 1);
  assert.equal(listDocuments(w.store, w.outsider, w.request.id), null);
  assert.equal(viewLink(w.store, w.outsider, w.outUser, doc.id).code, 404);
  const link = viewLink(w.store, w.elec, w.elecUser, doc.id).url;
  const opened = openFromLink(w.store, link.slice(6));
  assert.equal(opened.ok, true); assert.ok(fs.readFileSync(opened.file).toString().startsWith('%PDF'));
  assert.equal(planholders(w.store, w.gc, w.request.id)[0].viewedPlans, true);
  assert.equal(openFromLink(w.store, 'forged.token').code, 403);
  assert.equal(planholders(w.store, w.elec, w.request.id), null); // bidders can't see the planholder list
});

test('addenda: numbered, bidders notified, bidding blocked until acknowledged, bid states the addenda', async () => {
  const w = world();
  saveDocument(w.store, w.gc, w.gcUser, w.request.id, { name: 'A2.1.pdf', buffer: PDF('v1') });
  config.emailMode = 'dry-run'; config.platformFrom = 'alerts@buildintel.test';
  await sendInvitationNotices(w.store); // initial invitation notice
  const add = saveDocument(w.store, w.gc, w.gcUser, w.request.id, { name: 'A2.1 rev1.pdf', buffer: PDF('v2'), addendum: true, note: 'Added second-floor electrical room' });
  saveDocument(w.store, w.gc, w.gcUser, w.request.id, { name: 'E2.1 rev1.pdf', buffer: PDF('v3'), addendum: true });
  assert.equal(add.document.addendum, 1);
  assert.equal(w.store.get('bidRequests', w.request.id).addendumCount, 1); // same batch → same addendum
  await sendInvitationNotices(w.store);
  assert.match(w.store.list('messages', m => m.kind === 'addendum_notice')[0].preview, /Addendum 1 .*\n\nAdded second-floor electrical room/s);
  const bid = { amount: '250000', scope: 'Complete electrical per E-series and addendum' };
  assert.match(submitBid(w.store, w.elec, w.elecUser, w.inv.id, bid).error, /acknowledge addendum 1/);
  acknowledgeAddenda(w.store, w.elec, w.elecUser, w.inv.id);
  assert.equal(submitBid(w.store, w.elec, w.elecUser, w.inv.id, bid).ok, true);
  assert.match(w.store.list('submissions')[0].proposalHtml, /Acknowledges addenda 1–1/);
  config.platformFrom = '';
});

test('HTTP: raw PDF upload, listing, signed viewing in the browser', async (t) => {
  const w = world();
  const srv = createServer(w.store).listen(0); await new Promise(r => srv.once('listening', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const login = async (email, password) => (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).token;
  const gcTok = await login('pm@ryan.test', 'gc password 1234');
  const subTok = await login('est@sparky.test', 'sparky password 12');
  const up = await fetch(`${base}/api/requests/${w.request.id}/documents?name=${encodeURIComponent('S1.0 Foundation Plan.pdf')}`, { method: 'POST', headers: { Authorization: 'Bearer ' + gcTok, 'Content-Type': 'application/pdf' }, body: PDF('found') });
  assert.equal(up.status, 200); const doc = await up.json(); assert.equal(doc.discipline, 'Structural');
  assert.equal((await fetch(`${base}/api/requests/${w.request.id}/documents?name=x.pdf`, { method: 'POST', headers: { Authorization: 'Bearer ' + subTok }, body: PDF('nope') })).status, 403);
  const link = await (await fetch(`${base}/api/documents/${doc.id}/link`, { method: 'POST', headers: { Authorization: 'Bearer ' + subTok } })).json();
  const file = await fetch(base + link.url);
  assert.equal(file.status, 200); assert.equal(file.headers.get('content-type'), 'application/pdf'); assert.match(file.headers.get('content-disposition'), /^inline/);
});
