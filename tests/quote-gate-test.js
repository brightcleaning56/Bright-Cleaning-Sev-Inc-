// Checks the quote gate for new company copies. Run: node tests/quote-gate-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const { quoteBlocked } = require('../setup-gate');

const db = new Database(':memory:');
db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
let passed = 0;
const ok = (name) => { passed++; console.log('ok - ' + name); };

assert.strictEqual(quoteBlocked(db, {}), false); ok('an existing copy (no setup flag) is never blocked');
assert.strictEqual(quoteBlocked(db, { COMPANY_SETUP_PENDING: 'on' }), true); ok('a new copy is blocked until labor is saved');
db.prepare("INSERT INTO settings(key,value,updated_at) VALUES('labor_confirmed','1','now')").run();
assert.strictEqual(quoteBlocked(db, { COMPANY_SETUP_PENDING: 'on' }), false); ok('saving labor assumptions unblocks quotes');
console.log(`\n${passed} checks passed`);
