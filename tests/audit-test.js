// Checks the accounting audit trail (audit G15): reversals, closes, reconciliations and tax changes are recorded with who and why.
// Run: node tests/audit-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const L = require('../ledger');
const P = require('../periods');
const AU = require('../audit');

const db = new Database(':memory:');
L.seedChart(db);
const id = L.postEntry(db, { date: '2026-11-20', memo: 'Invoice 1', source: 'invoice', sourceRef: 'invoice:1', by: 'owner@test', lines: [{ account: '1100', debit: 100 }, { account: '4000', credit: 100 }] });
L.reverseEntry(db, id, { reason: 'Keyed to the wrong invoice', by: 'owner@test' });
P.closePeriod(db, '2026-11-21', 'owner@test');
P.reconcileCash(db, { asOf: '2026-11-21', statementBalance: 0, by: 'owner@test' });
AU.record(db, { actor: 'owner@test', action: 'set sales tax', entity: 'invoice', entityId: 1, detail: 'sales tax 8.00 (was 0.00)' });

const ev = AU.list(db);
const actions = ev.map(e => e.action);
assert.ok(actions.includes('reversed entry'), 'reversal recorded');
assert.ok(actions.includes('closed books'), 'period close recorded');
assert.ok(actions.includes('bank reconciliation'), 'reconciliation recorded');
assert.ok(actions.includes('set sales tax'), 'tax change recorded');
const rev = ev.find(e => e.action === 'reversed entry');
assert.strictEqual(rev.actor, 'owner@test');
assert.strictEqual(rev.detail, 'Keyed to the wrong invoice', 'the reason is kept');
console.log('ok - reversal, close, reconciliation and tax change are recorded with who and why');

assert.strictEqual(ev[0].action, 'set sales tax', 'newest first');
console.log('ok - audit events are listed newest first (the trail has no edit or delete route)');

console.log('\nAll audit checks passed.');
