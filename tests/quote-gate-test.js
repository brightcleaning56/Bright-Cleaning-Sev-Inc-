// Checks the quote gate for new company copies. Run: node tests/quote-gate-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const { quoteBlocked, sync } = require('../setup-gate');

const db = new Database(':memory:');
db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
db.exec('CREATE TABLE estimates(id INTEGER PRIMARY KEY AUTOINCREMENT, customer_name TEXT)');
const insert = () => db.prepare("INSERT INTO estimates(customer_name) VALUES('test')").run();
const pendingEnv = { COMPANY_SETUP_PENDING: 'on' };
let passed = 0;
const ok = (name) => { passed++; console.log('ok - ' + name); };

assert.strictEqual(quoteBlocked(db, {}), false); ok('an existing copy (no setup flag) is never blocked');
assert.strictEqual(quoteBlocked(db, pendingEnv), true); ok('a new copy is blocked until labor is saved');

sync(db, pendingEnv);
assert.throws(insert, /labor rates and margins/); ok('estimates cannot be inserted by any path while the gate is up');

db.prepare("INSERT INTO settings(key,value,updated_at) VALUES('labor_confirmed','1','now')").run();
sync(db, pendingEnv);
insert(); ok('saving labor assumptions removes the gate for every path');

assert.strictEqual(quoteBlocked(db, pendingEnv), false); ok('quotes are unblocked after confirmation');
console.log(`\n${passed} checks passed`);
