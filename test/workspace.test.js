import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { ingestPermits } from '../src/permits.js';
import { createRequest } from '../src/marketplace.js';
import { saveDocument } from '../src/documents.js';
import { projectDetail, marketActivity, commandCenter } from '../src/leads.js';
import { startForProject, proposalHtml, updateEstimate } from '../src/takeoff.js';
import { draftRateCard, approveRateCard } from '../src/estimate.js';
import { RATE } from './_fixtures.js';

config.docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-ws-'));
const D = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
function world() {
  const store = new Store(null);
  const SEA = { id: 'sea', jurisdiction: 'sea', city: 'Seattle', state: 'WA', url: 'u' };
  ingestPermits(store, SEA, [{ permitId: 'S1', address: '400 Pine St', permitType: 'New', description: 'New office building <img src=x onerror=alert(1)>', issuedDate: D(-10), status: 'Issued', valuation: '48500000', squareFeet: '128000' },
    { permitId: 'S2', address: '9 Elm St', permitType: 'Addition/Alteration', description: 'Retail tenant improvement', issuedDate: D(-40), status: 'Issued', valuation: '200000' }]);
  const gc = store.put('orgs', { slug: 'gc', name: 'Acme GC', kind: 'buyer', status: 'active' });
  const sub = store.put('orgs', { slug: 'em', name: 'Emerald', kind: 'subscriber', trades: ['glazing'], territories: ['WA'], status: 'active', legal: { name: 'Emerald Glass LLC', postalAddress: '10 Pike St' }, settings: {}, subscription: { plan: 'local', status: 'active' } });
  const other = store.put('orgs', { slug: 'ot', name: 'Other', kind: 'subscriber', trades: ['roofing'], territories: ['WA'], status: 'active', settings: {}, subscription: { plan: 'local', status: 'active' } });
  const p = store.list('permits', x => x.permitId === 'S1')[0];
  return { store, gc, sub, other, p };
}

test('a permit shows bid packages and drawings at the same site only to invited companies', () => {
  const w = world();
  const { request } = createRequest(w.store, w.gc, { email: 'pm@acme.test' }, { title: 'Glazing package', address: '400 Pine Street', city: 'Seattle', state: 'WA', projectType: 'office', trades: ['glazing'], dueDate: D(26) });
  saveDocument(w.store, w.gc, { email: 'pm@acme.test' }, request.id, { name: 'A2.1 Floor Plan.pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF') });
  const mine = projectDetail(w.store, w.sub, w.p.id).project;
  assert.equal(mine.bidPackages.length, 1); assert.equal(mine.drawings.length, 1); assert.equal(mine.drawings[0].sheet, 'A2.1');
  assert.ok(mine.bidPackages[0].invitationId);
  const theirs = projectDetail(w.store, w.other, w.p.id).project; // roofer: not invited
  assert.equal(theirs.bidPackages.length, 0); assert.equal(theirs.drawings.length, 0);
});

test('Build Estimate on a permit: prices permit square footage with approved rates; reuses the draft; proposal escapes text', () => {
  const w = world();
  const rc = draftRateCard(w.store, w.sub.id, RATE, 'o').rateCard; approveRateCard(w.store, w.sub.id, rc.id, 'o', 'owner');
  const e = startForProject(w.store, w.sub, { email: 'a@em.test' }, { permitId: w.p.id }).estimate;
  assert.equal(e.lines.length, 1); assert.equal(e.lines[0].qty, 128000); assert.equal(e.lines[0].source.type, 'permit');
  assert.ok(e.totals.total > 0);
  assert.equal(startForProject(w.store, w.sub, { email: 'a@em.test' }, { permitId: w.p.id }).estimate.id, e.id); // same draft, not a duplicate
  const html = proposalHtml(w.store, w.sub, e.id);
  assert.match(html, /Emerald Glass LLC/); assert.match(html, /400 Pine St, Seattle, WA/); assert.match(html, /square footage in the public permit record/);
  updateEstimate(w.store, w.sub, { email: 'a' }, e.id, { lines: [{ kind: 'manual', description: '<script>x</script>', qty: 1, unit: 'LS', laborUnit: 100 }] });
  assert.ok(!proposalHtml(w.store, w.sub, e.id).includes('<script>x'));
  assert.equal(proposalHtml(w.store, w.other, e.id), null); // other companies can't read it
});

test('market activity and KPI trend are counted from real permits in the territory', () => {
  const w = world();
  const m = marketActivity(w.store, w.sub);
  assert.equal(m.totalPermits, 2);
  assert.deepEqual(m.byCity.map(c => [c.key, c.permits]), [['Seattle, WA', 2]]);
  assert.equal(m.byType.find(t => t.key === 'office').value, 48500000);
  const k = commandCenter(w.store, w.sub).kpis;
  assert.equal(k.newSitesThisMonth, 2); assert.equal(k.newSitesPrevMonth, 0); // both first seen now
  assert.equal(marketActivity(w.store, { ...w.sub, territories: ['TX'] }).totalPermits, 0);
});
