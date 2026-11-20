// Checks the contract value report: amendments and renewals are not double counted; superseded versions are excluded.
// Run: node tests/contract-value-test.js
const assert = require('assert');
const { contractValueReport, summary } = require('../contract-value');

const rows = [
  { id: 1, kind: 'Contract', value: 50000, status: 'Superseded', signature_status: 'Executed', superseded_by: 5 },
  { id: 2, kind: 'Amendment', value: 5000, status: 'Active', signature_status: 'Executed' },
  { id: 3, kind: 'Renewal', value: 40000, status: 'Active', signature_status: 'Signed' },
  { id: 5, kind: 'Contract', value: 48000, status: 'Active', signature_status: 'Executed' },
  { id: 6, kind: 'Contract', value: 9000, status: 'Draft', signature_status: 'Not sent' },
  { id: 7, kind: 'Renewal', value: 12000, status: 'Closed', signature_status: 'Executed', archived_at: '2026-01-01' }
];
const r = contractValueReport(rows);
// Originals: #5 (48,000, the current version; #1 is its superseded earlier version). Renewal: #3 (40,000). Amendment #2 is listed, not added. #6 is unsigned. #7 is archived.
assert.strictEqual(r.parts.originals.value, 48000, 'original is counted once, at its current version');
assert.strictEqual(r.parts.renewals.value, 40000, 'signed renewal counted');
assert.strictEqual(r.contracted_value, 88000, 'contracted value = originals + renewals');
assert.strictEqual(r.parts.amendments_listed_not_added.value, 5000, 'amendment shown but not added');
assert.strictEqual(r.superseded_excluded.value, 50000, 'superseded version excluded');
// Dashboards today add every signed row: 50,000 + 5,000 + 40,000 + 48,000 + 48,000 + 12,000 (archived) = 155,000.
assert.strictEqual(r.dashboard_sum_today, 155000, 'today\'s dashboard sum (every signed row)');
assert.strictEqual(r.overstatement_on_dashboard, 67000, 'gap between today\'s dashboard and the report');
console.log('ok - report counts each contract once, lists amendments, excludes superseded and archived rows');
console.log('   contracted', r.contracted_value, '| dashboard today', r.dashboard_sum_today, '| gap', r.overstatement_on_dashboard);

const empty = contractValueReport([]);
assert.strictEqual(empty.contracted_value, 0);
assert.strictEqual(empty.overstatement_on_dashboard, 0);
console.log('ok - no contracts gives zero');
const sm = summary(rows);
assert.strictEqual(sm.value, 88000, 'screens show the same contracted value');
assert.strictEqual(sm.count, 2, 'two contracts make it up (original and renewal)');
console.log('ok - the shared summary used by the screens matches the report');
console.log('\nAll contract-value checks passed.');
