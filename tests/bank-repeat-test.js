// Checks that two identical bank lines in one statement both import, and that re-importing does not double them.
// Run: node tests/bank-repeat-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const L = require('../ledger');
const B = require('../bank');

const db = new Database(':memory:');
L.seedChart(db);
const statement = [
  'Date,Description,Amount',
  '2026-11-20,Coffee Shop,-6',
  '2026-11-20,Coffee Shop,-6',
  '2026-11-21,Fuel,-40',
].join('\n');

const first = B.importStatement(db, statement, 'owner@test');
assert.strictEqual(first.added, 3, 'both identical coffee lines are kept');
const again = B.importStatement(db, statement, 'owner@test');
assert.strictEqual(again.added, 0, 're-import adds nothing');
assert.strictEqual(again.skipped, 3, 're-import skips all three lines');
console.log('ok - identical lines in one statement both import; re-import adds nothing');
