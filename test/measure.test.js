import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { createRequest, submitBid } from '../src/marketplace.js';
import { saveDocument } from '../src/documents.js';
import { resolveScale, measureValue, saveMeasurement, listMeasurements, deleteMeasurement } from '../src/measure.js';
import { startFromMeasurements, updateEstimate, submitEstimateAsBid } from '../src/takeoff.js';
config.docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-ms-'));
const D = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const SQ = [[100, 100], [820, 100], [820, 820], [100, 820]]; // 720 × 720 PDF points = 10" × 10" on paper

test('scales and geometry, checked by hand', () => {
  const eighth = resolveScale({ preset: '1/8" = 1\'-0"' }).ftPerPt;          // 8 ft per inch → 8/72 ft per point
  assert.equal(measureValue('area', SQ, eighth), 6400);                      // 80 ft × 80 ft
  assert.equal(measureValue('linear', [[100, 100], [820, 820]], eighth), 113.14); // 80·√2
  assert.equal(measureValue('linear', [[100, 100], [820, 100], [820, 820]], eighth), 160); // two 80 ft runs
  assert.equal(measureValue('area', [...SQ].reverse(), eighth), 6400);       // clockwise or not
  assert.equal(measureValue('area', SQ, resolveScale({ preset: '1" = 20\'' }).ftPerPt), 40000); // 200 ft × 200 ft
  const cal = resolveScale({ calibration: { p1: [0, 0], p2: [360, 0], lengthFt: 25 } }).ftPerPt; // 5" on paper = 25 ft
  assert.equal(measureValue('linear', [[0, 0], [720, 0]], cal), 50);
  assert.match(resolveScale({ calibration: { p1: [0, 0], p2: [2, 0], lengthFt: 10 } }).error, /too close/);
  assert.match(resolveScale(null).error, /scale/);
  assert.equal(measureValue('count', [[1, 1], [2, 2], [3, 3]], 1), 3);
});

function world() {
  const store = new Store(null);
  const gc = store.put('orgs', { slug: 'gc', name: 'GC', kind: 'buyer', status: 'active' });
  const sub = store.put('orgs', { slug: 'fl', name: 'Floors', kind: 'subscriber', trades: ['flooring'], territories: ['IA'], status: 'active', legal: { name: 'Floors LLC' }, settings: {}, subscription: { plan: 'local', status: 'active' } });
  const out = store.put('orgs', { slug: 'out', name: 'Out', kind: 'subscriber', trades: ['roofing'], territories: ['IA'], status: 'active', settings: {}, subscription: { plan: 'local', status: 'active' } });
  const { request } = createRequest(store, gc, { email: 'pm' }, { title: 'Clinic', address: '1 A', city: 'Ankeny', state: 'IA', projectType: 'medical', trades: ['flooring'], dueDate: D(9) });
  const doc = saveDocument(store, gc, { email: 'pm' }, request.id, { name: 'A2.1 Floor Plan.pdf', buffer: Buffer.from('%PDF-1.4 x') }).document;
  return { store, gc, sub, out, request, doc, user: { email: 'est@floors.test' } };
}

test('saved measurements: server computes the value, needs a scale, only invited companies, private per company', () => {
  const w = world();
  const sc = { preset: '1/8" = 1\'-0"' };
  assert.match(saveMeasurement(w.store, w.sub, w.user, w.doc.id, { kind: 'area', points: SQ }).error, /scale/);
  const m = saveMeasurement(w.store, w.sub, w.user, w.doc.id, { kind: 'area', points: SQ, scale: sc, label: 'Exam rooms LVT', value: 999999 }).measurement;
  assert.equal(m.value, 6400); assert.equal(m.unit, 'SF'); // the client's value is ignored
  assert.equal(saveMeasurement(w.store, w.sub, w.user, w.doc.id, { kind: 'area', points: [[1, 1], [2, 2]], scale: sc }).code, 400);
  assert.equal(saveMeasurement(w.store, w.sub, w.user, w.doc.id, { kind: 'linear', points: [[1, 'x']], scale: sc }).code, 400);
  assert.equal(saveMeasurement(w.store, w.out, w.user, w.doc.id, { kind: 'count', points: [[1, 1]] }).code, 404); // not invited
  assert.match(saveMeasurement(w.store, w.sub, w.user, w.doc.id, { kind: 'note', points: [[5, 5]] }).error, /text/);
  saveMeasurement(w.store, w.sub, w.user, w.doc.id, { kind: 'note', points: [[5, 5]], label: 'Verify base at reception' });
  assert.equal(listMeasurements(w.store, w.sub, w.doc.id).length, 2);
  assert.equal(listMeasurements(w.store, w.gc, w.doc.id).length, 0); // private to the company that measured
  deleteMeasurement(w.store, w.sub, m.id);
  assert.equal(listMeasurements(w.store, w.sub, w.doc.id).length, 1);
  assert.equal(deleteMeasurement(w.store, w.gc, m.id).code, 404);
});

test('measurements → estimate (linked to the invitation) → bid that cites sheet, page and scale', () => {
  const w = world(); const sc = { preset: '1/8" = 1\'-0"' };
  const area = saveMeasurement(w.store, w.sub, w.user, w.doc.id, { kind: 'area', points: SQ, scale: sc, label: 'LVT flooring', page: 1 }).measurement;
  const base = saveMeasurement(w.store, w.sub, w.user, w.doc.id, { kind: 'linear', points: [[100, 100], [820, 100], [820, 820]], scale: sc, label: 'Rubber base' }).measurement;
  const note = saveMeasurement(w.store, w.sub, w.user, w.doc.id, { kind: 'note', points: [[5, 5]], label: 'n' }).measurement;
  const e = startFromMeasurements(w.store, w.sub, w.user, { ids: [area.id, base.id, note.id] }).estimate;
  assert.deepEqual(e.lines.map(l => [l.description, l.qty, l.unit]), [['LVT flooring', 6400, 'SF'], ['Rubber base', 160, 'LF']]); // note excluded
  assert.ok(e.invitationId);
  updateEstimate(w.store, w.sub, w.user, e.id, { overheadPct: 0, profitPct: 0, lines: e.lines.map(l => ({ ...l, laborUnit: 2, materialUnit: l.unit === 'SF' ? 3 : 1 })) });
  const r = submitEstimateAsBid(w.store, w.sub, w.user, e.id);
  assert.equal(r.total, 32480); // 6400 × 5 + 160 × 3
  assert.match(w.store.get('submissions', r.submission.id).proposalHtml, /LVT flooring: 6,400 SF \[measured on sheet A2\.1 p\.1 at 1\/8&quot; = 1&#39;-0&quot;\]/);
  assert.match(startFromMeasurements(w.store, w.out, w.user, { ids: [area.id] }).error, /choose at least one/); // other company's ids are invisible
});
