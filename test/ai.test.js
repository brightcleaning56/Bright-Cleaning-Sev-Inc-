import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { ingestPermits, normalizePermit } from '../src/permits.js';
import { createRequest } from '../src/marketplace.js';
import { saveDocument } from '../src/documents.js';
import { analyzeDocument, verifyAnalysis, parseModelJson } from '../src/ai.js';
import { commandCenter, mapPoints } from '../src/leads.js';

config.docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-ai-'));
const D = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

test('coordinates: negative longitudes are kept (regression: every US longitude was dropped)', () => {
  const p = normalizePermit({ permitId: 'X', address: '1 A St', permitType: 'Commercial New', description: 'new office', lat: '47.61', lng: '-122.33' }, { id: 's', jurisdiction: 'sea', city: 'Seattle', state: 'WA', url: 'u' });
  assert.equal(p.lat, 47.61); assert.equal(p.lng, -122.33);
  assert.equal(normalizePermit({ permitId: 'Y', address: 'a', description: 'new office', permitType: 'Commercial', lat: 0, lng: 0 }, { id: 's', jurisdiction: 'j', url: 'u' }).lat, null);
});

test('command center: real counts only, territory-scoped; map returns one point per located site', () => {
  const store = new Store(null);
  const SEA = { id: 'sea', jurisdiction: 'sea', city: 'Seattle', state: 'WA', url: 'u' };
  ingestPermits(store, SEA, [
    { permitId: 'S1', address: '400 Pine St', permitType: 'New', description: 'New commercial office building', issuedDate: D(-5), status: 'Issued', valuation: '9000000', lat: 47.61, lng: -122.33 },
    { permitId: 'S2', address: '400 Pine Street', permitType: 'Addition/Alteration', description: 'Tenant improvement office', issuedDate: D(-3), status: 'Issued', valuation: '200000', lat: 47.61, lng: -122.33 },
    { permitId: 'S3', address: '9 Elm St', permitType: 'Addition/Alteration', description: 'Retail tenant improvement', issuedDate: D(-2), status: 'Issued' },
  ]);
  ingestPermits(store, { id: 'aus', jurisdiction: 'aus', city: 'Austin', state: 'TX', url: 'u' }, [{ permitId: 'T1', address: '1 Congress Ave', permitType: 'Commercial New', description: 'New office building', issuedDate: D(-1), status: 'Issued', valuation: '5000000', lat: 30.27, lng: -97.74 }]);
  store.put('sources', { key: 'seattle-wa', adapter: 'socrata', enabled: true, city: 'Seattle', state: 'WA', lastSuccessAt: new Date().toISOString() });
  store.put('sources', { key: 'austin-tx', adapter: 'socrata', enabled: true, city: 'Austin', state: 'TX' });
  const org = store.put('orgs', { slug: 'o', kind: 'subscriber', status: 'active', territories: ['WA'], subscription: { plan: 'local', status: 'active' } });
  const k = commandCenter(store, org).kpis;
  assert.deepEqual([k.activeSites, k.activePermits, k.newSitesThisMonth, k.reportedValue, k.locatedOnMap], [2, 3, 2, 9200000, 2]);
  assert.deepEqual(k.coverage.map(c => c.city), ['Seattle']); // Austin is outside this territory
  const m = mapPoints(store, org, new URLSearchParams(''));
  assert.equal(m.total, 1); assert.equal(m.points[0].valuation, 9000000); // two permits, one site, largest shown
});

function planRoom() {
  const store = new Store(null);
  const gc = store.put('orgs', { slug: 'gc', name: 'GC', kind: 'buyer', status: 'active' });
  const user = { email: 'pm@gc.test', id: 'u' };
  const { request } = createRequest(store, gc, user, { title: 'Office', address: '1 A', city: 'Ankeny', state: 'IA', projectType: 'office', trades: ['electrical'], dueDate: D(9) });
  const doc = saveDocument(store, gc, user, request.id, { name: 'A2.1 Level 1 Floor Plan.pdf', buffer: Buffer.from('%PDF-1.4\n%x\n%%EOF') }).document;
  return { store, gc, user, doc };
}

test('AI analyzer: off without a key, says exactly what to do', async () => {
  const w = planRoom(); config.anthropicKey = '';
  assert.match((await analyzeDocument(w.store, w.gc, w.user, w.doc.id)).error, /ANTHROPIC_API_KEY/);
});

test('AI analyzer: only printed areas survive, every item keeps its sheet, starts unverified, can be confirmed', async () => {
  const w = planRoom(); config.anthropicKey = 'test-key';
  let sent;
  const reply = { rooms: [
      { number: '101', name: 'LOBBY', level: 'Level 1', areaSqFt: 2450, basis: 'printed', sheet: 'A2.1' },
      { number: '102', name: 'OPEN OFFICE', level: 'Level 1', areaSqFt: 12460, basis: 'estimated', sheet: 'A2.1' }, // not printed → must be dropped
      { number: '103', name: 'RESTROOM', level: 'Level 1', areaSqFt: null, basis: 'not_stated', sheet: 'A2.1' }],
    sheets: [{ sheet: 'A2.1', title: 'LEVEL 1 FLOOR PLAN', level: 'Level 1', scale: '1/8" = 1\'-0"' }],
    finishes: [{ item: 'Carpet tile CPT-1', location: 'Offices', sheet: 'A6.1' }], scopes: [], notes: ['See A6.1 finish schedule'], confidence: 'medium' };
  const fetchImpl = async (url, opts) => { sent = { url, body: JSON.parse(opts.body), headers: opts.headers }; return { ok: true, json: async () => ({ content: [{ type: 'text', text: '```json\n' + JSON.stringify(reply) + '\n```' }], usage: { input_tokens: 1 } }) }; };
  const r = await analyzeDocument(w.store, w.gc, w.user, w.doc.id, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages'); assert.equal(sent.headers['x-api-key'], 'test-key');
  assert.equal(sent.body.messages[0].content[0].type, 'document');
  const res = r.analysis.result;
  assert.equal(r.analysis.status, 'unverified');
  assert.deepEqual(res.rooms.map(x => [x.number, x.areaSqFt, x.basis]), [['101', 2450, 'printed'], ['102', null, 'not_stated'], ['103', null, 'not_stated']]);
  assert.equal(res.totals.printedAreaSqFt, 2450);
  assert.ok(res.rooms.every(x => x.sheet === 'A2.1'));
  const other = w.store.put('orgs', { slug: 'x', kind: 'subscriber', status: 'active' });
  assert.equal(verifyAnalysis(w.store, other, w.user, r.analysis.id).code, 404); // another company can't see or confirm it
  assert.equal(verifyAnalysis(w.store, w.gc, w.user, r.analysis.id).analysis.status, 'verified');
  config.anthropicKey = '';
});

test('AI analyzer: no access to plan rooms you are not invited to; daily limit; bad model output handled', async () => {
  const w = planRoom(); config.anthropicKey = 'k';
  const outsider = w.store.put('orgs', { slug: 'o', kind: 'subscriber', status: 'active' });
  assert.equal((await analyzeDocument(w.store, outsider, w.user, w.doc.id)).code, 404);
  const bad = await analyzeDocument(w.store, w.gc, w.user, w.doc.id, { fetchImpl: async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'Sorry, I cannot read this.' }] }) }) });
  assert.match(bad.error, /could not be read/);
  assert.throws(() => parseModelJson('no json here'));
  const lim = config.aiDailyLimit; config.aiDailyLimit = 0;
  assert.equal((await analyzeDocument(w.store, w.gc, w.user, w.doc.id)).code, 429);
  config.aiDailyLimit = lim; config.anthropicKey = '';
});

test('accuracy scoring: recall, exact printed areas, and invented areas counted against the model', async () => {
  const { scoreReading } = await import('../src/ai.js');
  const truth = { rooms: [{ number: '101', areaSqFt: 2450 }, { number: '102', areaSqFt: 1200 }, { number: '103', areaSqFt: null }, { number: '104', areaSqFt: 300 }] };
  const got = { rooms: [{ number: '101', areaSqFt: 2450 }, { number: '102', areaSqFt: 1250 }, { number: '103', areaSqFt: 800 }, { number: '999', areaSqFt: null }] };
  const s = scoreReading(got, truth);
  assert.deepEqual([s.roomsFound, s.roomRecall, s.extraRooms, s.areasExact, s.printedAreas, s.inventedAreas], [3, 0.75, 1, 1, 3, 1]);
});
