// Checks held payments and the shared sync (decision: the ledger posts on its own; payments with no issued invoice are held).
// Run: node tests/held-payments-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const L = require('../ledger');
const IL = require('../invoice-ledger');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE invoices(id INTEGER PRIMARY KEY, invoice_number TEXT, amount REAL, tax_amount REAL DEFAULT 0, status TEXT, issue_date TEXT, due_date TEXT, created_at TEXT, paid_amount REAL DEFAULT 0);
  CREATE TABLE payments(id INTEGER PRIMARY KEY, invoice_id INTEGER, amount REAL, received_at TEXT);
`);
L.seedChart(db);
db.prepare("INSERT INTO invoices(id,invoice_number,amount,status,issue_date) VALUES(1,'INV-1',1000,'Draft','2026-11-20')").run();
db.prepare("INSERT INTO payments VALUES(1,1,400,'2026-11-21T10:00:00Z')").run(); // invoice is a draft: held
db.prepare("INSERT INTO payments VALUES(2,99,250,'2026-11-21T11:00:00Z')").run(); // no such invoice: held

const first = IL.runSync(db, 'owner@test');
assert.strictEqual(first.payments_posted, 0, 'nothing posts while the invoice is a draft');
assert.strictEqual(first.payments_held.length, 2, 'both payments are held');
assert.ok(first.payments_held.some(h => /Draft|draft/.test(h.reason) || /is Draft/.test(h.reason)), 'the reason names the draft');
assert.ok(first.payments_held.some(h => /does not exist|No invoice/.test(h.reason)), 'the reason names the missing invoice');
assert.strictEqual(L.trialBalance(db).accounts.find(a => a.code === '1000').balance, 0, 'cash is untouched');
console.log('ok - payments with no issued invoice are held with a reason, not posted');

// Issuing the invoice lets the held payment post on the next run, and only once.
db.prepare("UPDATE invoices SET status='Sent' WHERE id=1").run();
const second = IL.runSync(db, 'automatic');
assert.strictEqual(second.payments_posted, 1, 'the draft payment posts once its invoice is issued');
assert.strictEqual(second.payments_held.length, 1, 'the payment with no invoice is still held');
const third = IL.runSync(db, 'automatic');
assert.strictEqual(third.payments_posted, 0, 'running again posts nothing new');
assert.strictEqual(L.trialBalance(db).accounts.find(a => a.code === '1000').balance, 400);
assert.strictEqual(L.trialBalance(db).balanced, true);
console.log('ok - held payment posts once the invoice is issued; the sync is safe to repeat');

// The removal route: owner only (checked in the access rules); refuses a payment on the ledger; needs a reason; audited.
process.env.LEDGER_AUTO_SYNC_MS = '0';
const routes = {};
IL.mount({ post: (p, m, h) => { routes['POST ' + p] = h; }, get: (p, m, h) => { routes['GET ' + p] = h; }, delete: (p, m, h) => { routes['DELETE ' + p] = h; } }, { db, auth: (q, s, n) => n() });
const call = (id, body) => { let out; const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; } }; routes['DELETE /api/admin/payments/:id']({ params: { id: String(id) }, body, user: { email: 'owner@test' } }, res); return out; };
db.prepare("INSERT INTO payments(id,invoice_id,amount,received_at) VALUES(4,88,40,'2026-11-28T10:00:00Z')").run();
assert.strictEqual(call(4, {}).code, 400, 'a reason is required');
assert.strictEqual(call(4, { reason: 'test row' }).code, 200, 'held payment removed with a reason');
assert.strictEqual(call(4, { reason: 'again' }).code, 404, 'gone');
assert.strictEqual(call(1, { reason: 'try' }).code, 409, 'a payment on the ledger is refused');
assert.ok(require('../audit').list(db).some(e => e.action === 'deleted unposted payment' && /test row/.test(e.detail)), 'removal is in the audit trail');
console.log('ok - removal route: reason required, posted payments refused, removal audited');


console.log('\nAll held-payment checks passed.');
